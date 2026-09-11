// Integracao com o Bling (API v3).
//
// PAPEL DO BLING NESTE PROJETO: cadastro e PONTE -- nunca status.
//
// Quem diz se o pedido esta bem ou mal sao o WMS (FontesLog) e a
// transportadora (Mandae). O Bling entra porque e o unico sistema que conhece
// as duas pontas: ele alimenta o WMS e a Mandae separadamente, entao so ele
// sabe que o pedido "1435" e o rastreio "VITPT000399" sao a mesma coisa. Alem
// da ponte, ele traz o que nenhum dos outros dois tem: cliente, loja de
// origem e cidade de destino.
//
// A `situacao` do Bling NAO deve virar cor no quadro.
//
// AUTENTICACAO (OAuth 2.0, confirmado contra a API):
//   authorize : GET  https://api.bling.com.br/Api/v3/oauth/authorize
//                    ?response_type=code&client_id=...&state=...
//   token     : POST https://api.bling.com.br/Api/v3/oauth/token
//                    header  Authorization: Basic base64(client_id:client_secret)
//                    header  Content-Type: application/x-www-form-urlencoded
//                    corpo   grant_type=authorization_code&code=...
//   O `code` vale 1 MINUTO. O access_token vale 6h e o refresh_token 30 dias.

import { getMeta, setMeta } from "../lib/db.js";

const BASE = "https://api.bling.com.br/Api/v3";

function credenciais() {
  const clientId = process.env.BLING_CLIENT_ID;
  const clientSecret = process.env.BLING_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("BLING_CLIENT_ID / BLING_CLIENT_SECRET nao configurados.");
  }
  return { clientId, clientSecret };
}

function basic() {
  const { clientId, clientSecret } = credenciais();
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

export function urlDeAutorizacao(state) {
  const { clientId } = credenciais();
  const p = new URLSearchParams({ response_type: "code", client_id: clientId, state });
  return `${BASE}/oauth/authorize?${p}`;
}

// Os tokens vivem na tabela `meta` do SQLite -- ou seja, no Volume do Railway.
// Sobrevivem a deploy e reinicio; sem isso, todo deploy exigiria reautorizar.
const CHAVE_TOKENS = "blingTokens";

export function lerTokens() {
  const bruto = getMeta(CHAVE_TOKENS);
  if (!bruto) return null;
  try {
    return JSON.parse(bruto);
  } catch {
    return null;
  }
}

function gravarTokens(resposta) {
  const tokens = {
    accessToken: resposta.access_token,
    refreshToken: resposta.refresh_token,
    // 60s de folga: melhor renovar cedo do que descobrir a expiracao no meio
    // de uma chamada e perder a requisicao.
    expiraEm: Date.now() + (Number(resposta.expires_in || 21600) - 60) * 1000,
    obtidoEm: new Date().toISOString(),
  };
  setMeta(CHAVE_TOKENS, JSON.stringify(tokens));
  return tokens;
}

async function pedirToken(corpo) {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: basic(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(corpo),
  });

  const texto = await res.text();
  if (!res.ok) {
    throw new Error(`Bling recusou o token (HTTP ${res.status}): ${texto.slice(0, 300)}`);
  }
  return gravarTokens(JSON.parse(texto));
}

/** Troca o `code` da autorizacao pelos tokens. O code expira em 1 minuto. */
export async function trocarCodePorToken(code) {
  return pedirToken({ grant_type: "authorization_code", code });
}

/** Renova o acesso usando o refresh_token (validade de 30 dias). */
export async function renovarToken(refreshToken) {
  return pedirToken({ grant_type: "refresh_token", refresh_token: refreshToken });
}

/** Devolve um access_token valido, renovando sozinho se preciso. */
export async function tokenValido() {
  const tokens = lerTokens();
  if (!tokens) throw new Error("BLING_NAO_AUTORIZADO");
  if (Date.now() < tokens.expiraEm) return tokens.accessToken;

  console.log("[bling] access_token expirou, renovando...");
  try {
    const novos = await renovarToken(tokens.refreshToken);
    return novos.accessToken;
  } catch (err) {
    // Refresh de 30 dias tambem expira. Nesse caso nao ha o que fazer sozinho:
    // alguem precisa autorizar de novo no navegador.
    throw new Error(`BLING_NAO_AUTORIZADO (falha ao renovar: ${err.message})`);
  }
}

// ---------------------------------------------------------------------------
// Limite de requisicoes
// ---------------------------------------------------------------------------
//
// O Bling responde 429 TOO_MANY_REQUESTS quando se passa do teto por segundo
// (descoberto na pratica, disparando 31 chamadas seguidas). Isso nao e detalhe:
// a sincronizacao precisa de UMA chamada de detalhe por pedido -- o rastreio so
// existe no detalhe, a listagem nao traz -- entao 200 pedidos sao 200 chamadas.
//
// Duas defesas: um intervalo minimo entre chamadas, e repeticao com espera
// crescente se o 429 vier mesmo assim.

const INTERVALO_MIN_MS = Number(process.env.BLING_INTERVALO_MS || 400);
let ultimaChamada = 0;

function dormir(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function esperarAVez() {
  const falta = ultimaChamada + INTERVALO_MIN_MS - Date.now();
  if (falta > 0) await dormir(falta);
  ultimaChamada = Date.now();
}

async function blingFetch(caminho, params = {}, tentativa = 1) {
  const token = await tokenValido();
  const url = `${BASE}${caminho}?${new URLSearchParams(params)}`;

  await esperarAVez();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (res.status === 429) {
    if (tentativa > 4) throw new Error(`Bling seguiu recusando por excesso de requisicoes em ${caminho}`);
    const espera = 1000 * 2 ** (tentativa - 1); // 1s, 2s, 4s, 8s
    console.warn(`[bling] 429 em ${caminho}; esperando ${espera}ms e tentando de novo (${tentativa}/4)`);
    await dormir(espera);
    return blingFetch(caminho, params, tentativa + 1);
  }

  if (res.status === 401) throw new Error("BLING_NAO_AUTORIZADO");
  if (!res.ok) throw new Error(`Bling respondeu ${res.status} em ${caminho}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Lista pedidos de venda em um intervalo de datas.
 * A API pagina de 100 em 100; seguimos ate a pagina vir vazia.
 */
export async function listarPedidos({ dataDe, dataAte, maxPaginas = 50 } = {}) {
  const paraISO = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  const todos = [];

  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const dados = await blingFetch("/pedidos/vendas", {
      pagina,
      limite: 100,
      dataInicial: paraISO(dataDe),
      dataFinal: paraISO(dataAte),
    });
    const lote = dados?.data || [];
    todos.push(...lote);
    if (lote.length < 100) break; // ultima pagina
  }
  return todos;
}

// O detalhe do pedido traz a loja so como id numerico ("loja": {"id": 205761639}).
// Um id nao diz nada na tela -- o filtro de marcas do quadro so serve pra
// alguma coisa com "Shopee", "Amazon", "Coco and Luna". O nome vem de /lojas,
// e como sao poucas lojas e elas nao mudam, uma consulta por loja basta para a
// vida toda do processo.
const nomesDeLoja = new Map();

// O `loja.id` do pedido e o id de um CANAL DE VENDA -- cada integracao de
// marketplace ou loja virtual vira um canal no Bling. O endpoint e
// /canais-venda; /lojas/{id} nao existe, e por isso a primeira tentativa
// falhava em silencio e o quadro seguia mostrando "Loja 205761639".
// (Endpoint confirmado no projeto dashboard, que ja fazia essa traducao.)
let canaisCarregados = false;

async function carregarCanais() {
  if (canaisCarregados) return;
  canaisCarregados = true; // marca antes: falhar nao deve virar tentativa a cada pedido
  try {
    const dados = await blingFetch("/canais-venda", { limite: 100, pagina: 1 });
    for (const c of dados?.data || []) {
      const nome = c.descricao || c.nome || c.tipo;
      if (c.id != null && nome) nomesDeLoja.set(String(c.id), nome);
    }
    console.log(`[bling] ${nomesDeLoja.size} canal(is) de venda carregado(s).`);
  } catch (err) {
    console.warn(`[bling] nao consegui listar os canais de venda: ${err.message}`);
  }
}

export async function nomeDaLoja(id) {
  if (id == null) return null;
  const chave = String(id);
  await carregarCanais();
  if (nomesDeLoja.has(chave)) return nomesDeLoja.get(chave);

  let nome = null;
  try {
    const dados = await blingFetch(`/canais-venda/${encodeURIComponent(chave)}`);
    nome = dados?.data?.nome || dados?.data?.descricao || null;
  } catch (err) {
    // Se o endpoint nao existir ou o escopo nao cobrir, seguimos com o id.
    // Nome de loja e enfeite: nao vale derrubar a sincronizacao inteira.
    console.warn(`[bling] nao consegui o nome da loja ${chave}: ${err.message}`);
  }

  const resultado = nome || `Loja ${chave}`;
  nomesDeLoja.set(chave, resultado);
  return resultado;
}

/** Detalhe de um pedido -- e onde mora o transporte/volumes/codigoRastreamento. */
export async function detalhePedido(id) {
  const dados = await blingFetch(`/pedidos/vendas/${encodeURIComponent(id)}`);
  return dados?.data || null;
}

/**
 * Extrai do detalhe do pedido só o que o quadro usa.
 * Defensivo de proposito: a forma exata da resposta ainda nao foi vista contra
 * dado real, entao cada campo e buscado em mais de um lugar plausivel e a
 * ausencia vira null em vez de estourar.
 */
export function extrairDoPedido(pedido) {
  if (!pedido) return null;

  const volumes = pedido?.transporte?.volumes || [];
  const rastreio =
    volumes.map((v) => v?.codigoRastreamento).find(Boolean) ||
    pedido?.transporte?.codigoRastreamento ||
    null;

  return {
    numeroPedido: String(pedido.numero ?? pedido.id ?? "").trim() || null,
    idBling: pedido.id ?? null,
    trackingCode: rastreio,
    cliente: pedido?.contato?.nome || null,
    loja: pedido?.loja?.nome || (pedido?.loja?.id != null ? `Loja ${pedido.loja.id}` : null),
    cidade: pedido?.transporte?.etiqueta?.municipio || pedido?.contato?.municipio || null,
    uf: pedido?.transporte?.etiqueta?.uf || null,
    data: pedido?.data || null,
  };
}

// ---------------------------------------------------------------------------
// Notas fiscais
// ---------------------------------------------------------------------------
//
// Por que o quadro precisa olhar NOTA e nao so PEDIDO DE VENDA:
//
// 1. A Mandae recebe, como referencia do parceiro, o NUMERO DA NOTA em varios
//    casos -- e por isso que o quadro tinha quadrados chamados "000222" e
//    "000218". Sem ler a nota, nao da pra ligar esses ao pedido.
//
// 2. Existe saida que nasce como NOTA, sem pedido de venda nenhum -- doacao e
//    bonificacao costumam ser assim. Quem le so pedido de venda nunca enxerga
//    essas remessas, e elas somem do radar mesmo tendo sido despachadas.
//
// 3. A NATUREZA DE OPERACAO (o que diz se e bonificacao) e campo de NOTA, nao
//    de pedido.

export async function listarNotas({ dataDe, dataAte, maxPaginas = 50 } = {}) {
  const paraISO = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  const todas = [];

  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const dados = await blingFetch("/nfe", {
      pagina,
      limite: 100,
      dataEmissaoInicial: paraISO(dataDe),
      dataEmissaoFinal: paraISO(dataAte),
    });
    const lote = dados?.data || [];
    todas.push(...lote);
    if (lote.length < 100) break;
  }
  return todas;
}

export async function detalheNota(id) {
  const dados = await blingFetch(`/nfe/${encodeURIComponent(id)}`);
  return dados?.data || null;
}

// Nome de cada natureza de operacao, por id.
//
// A comparacao e pelo NOME e nao pelo id numerico: id e identificador interno
// da conta, e prende-lo no codigo quebraria em silencio se a natureza fosse
// recriada. (Mesma decisao tomada no projeto dashboard.)
let naturezasCache = null;

export async function naturezasDeOperacao() {
  if (naturezasCache) return naturezasCache;
  const mapa = {};
  try {
    const dados = await blingFetch("/naturezas-operacoes", { limite: 100, pagina: 1 });
    for (const n of dados?.data || []) mapa[String(n.id)] = n.descricao || n.nome || "";
  } catch (err) {
    console.warn(`[bling] nao consegui listar as naturezas de operacao: ${err.message}`);
    // NAO cacheia o fracasso: uma falha passageira (token renovando, rate
    // limit, servidor ocupado) congelaria o mapa vazio ate o proximo deploy, e
    // toda sincronizacao seguinte gravaria "sem natureza" achando que sabia.
    return mapa;
  }
  naturezasCache = mapa;
  return mapa;
}

// ---------------------------------------------------------------------------
// Situacoes do pedido de venda
// ---------------------------------------------------------------------------
//
// O quadro lia tudo do pedido MENOS se ele ainda esta de pe. O pedido 1481 da
// Andressa estava CANCELADO no Bling e aparecia verde -- o quadro afirmando que
// esta tudo bem com uma venda que nao existe mais.
//
// A lista nao esta escrita aqui de proposito: alem das situacoes de fabrica, a
// conta tem situacoes proprias ("Aguardando Coleta", "Em devolucao") que so o
// Bling conhece. Perguntar e mais barato que manter uma copia desatualizada.
//
// 98310 e o modulo "Vendas" (Pedidos de Venda) nesta conta.
let situacoesCache = null;

export async function situacoesDeVenda() {
  if (situacoesCache) return situacoesCache;
  const mapa = {};
  try {
    const dados = await blingFetch("/situacoes/modulos/98310", { limite: 100 });
    for (const s of dados?.data || []) mapa[String(s.id)] = s.nome || "";
  } catch (err) {
    console.warn(`[bling] nao consegui listar as situacoes de venda: ${err.message}`);
    return mapa; // mesma razao: fracasso nao vira verdade permanente
  }
  // Resposta vazia tambem nao se cacheia: sem as situacoes, todo pedido seria
  // gravado como "situacao desconhecida" e o cancelamento voltaria a passar
  // despercebido -- que e exatamente o defeito que esta funcao veio corrigir.
  if (!Object.keys(mapa).length) return mapa;
  situacoesCache = mapa;
  return mapa;
}

// ---------------------------------------------------------------------------
// Situacao da NOTA FISCAL
// ---------------------------------------------------------------------------
//
// A nota tem situacao propria, e ela nao aparece em /situacoes/modulos -- aquilo
// e o vocabulario dos PEDIDOS. Aqui os codigos sao numeros fixos da API, e eu
// nao quis confiar em memoria pra traduzi-los. O que decidiu foi o dado:
//
//   4  REJEITADA   A Luciene Bento tem tres notas no mesmo dia: 000274 as
//                  14h41 (situacao 4), 000276 as 14h47 (situacao 4) e 000277
//                  as 14h48 (situacao 5). Duas rejeicoes e uma reemissao que
//                  deu certo -- o padrao nao deixa duvida sobre o que e o 4.
//                  A nota 000054 da Cristiane Simon, que o Luan apontou como
//                  rejeitada no Bling, tambem e 4.
//   2  CANCELADA   A nota 001206 e do pedido 1481, que esta cancelado.
//   5  AUTORIZADA  77 das 100 notas da amostra. A 000046 aparece como
//                  "Autorizada" no painel do Bling.
//   6  AUTORIZADA  outras 20 da amostra, na serie 001xxx.
//
// Nota rejeitada ou cancelada NUNCA virou remessa. O codigo de etiqueta que ela
// carrega e lixo -- foi assim que o quadrado "000054" ficou vermelho exibindo
// VITPT000210, uma etiqueta que a transportadora nunca recebeu porque nunca
// houve encomenda.
const NOTA_SEM_VALOR = new Set([2, 4]);

export function notaVale(situacao) {
  return !NOTA_SEM_VALOR.has(Number(situacao));
}

export function nomeDaSituacaoDaNota(situacao) {
  return { 2: "Cancelada", 4: "Rejeitada", 5: "Autorizada", 6: "Autorizada" }[Number(situacao)] || null;
}

/**
 * Decide se a natureza e de BONIFICACAO/DOACAO (saida sem receita).
 *
 * "saida" E "bonificac", nao so "bonificac": a conta tem as duas naturezas,
 * "Saida em bonificacao" e "Entrada de bonificacao". Casar so por "bonifica"
 * contaria mercadoria ENTRANDO como se tivesse sido doada -- o numero
 * exatamente ao contrario. (Regra herdada do projeto dashboard.)
 */
export function ehNaturezaDeBonificacao(nome) {
  const n = String(nome || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
  return /\bsaida\b/.test(n) && /bonificac/.test(n);
}

/**
 * GET cru em qualquer caminho da API do Bling. Usado so pela rota de sonda,
 * pra descobrir formato de resposta contra a API real em vez de adivinhar.
 */
export async function sondarCaminho(caminho, params = {}) {
  return blingFetch(caminho, params);
}

/**
 * Objeto de postagem (o "volume") -- e AQUI que mora o codigo de rastreio.
 *
 * Descoberto sondando a API: nem o pedido nem a nota expoem o rastreio de
 * forma confiavel. O pedido as vezes traz em transporte.volumes[].codigoRastreamento,
 * mas a NOTA so devolve volumes:[{id}] -- e remessa de bonificacao costuma
 * nascer como nota, sem pedido nenhum. Sao esses os quadrados que ficavam
 * "pontilhados", sem rastreio e sem informacao.
 *
 * GET /logisticas/objetos/{idVolume} devolve:
 *   rastreamento.codigo, servico.nome, e os vinculos pedidoVenda.id e
 *   notaFiscal.id -- ou seja, tambem serve de ponte entre os dois.
 */
export async function objetoDePostagem(idVolume) {
  if (!idVolume) return null;
  try {
    const dados = await blingFetch(`/logisticas/objetos/${encodeURIComponent(idVolume)}`);
    const o = dados?.data;
    if (!o) return null;
    // O objeto de postagem nao guarda so o codigo: guarda o ESTADO da entrega,
    // com data. E a unica fonte de status que vale para TODAS as
    // transportadoras -- inclusive Mercado Livre e Shopee, que o quadro tratava
    // como "sem acompanhamento" por nao ter integracao propria. Amostra real:
    // "UF57UJY7WNKSLBSWYDCAZUM7T4 -> A transportadora ja informou sobre a
    // chegada do item".
    //
    // `situacao` 8 com descricao vazia e data "0000-00-00" e etiqueta criada
    // sem nada ter acontecido -- devolvemos a descricao como null, porque
    // string vazia aqui viraria um rotulo em branco no painel.
    const r = o?.rastreamento || {};
    const alteracao = r.ultimaAlteracao && !String(r.ultimaAlteracao).startsWith("0000")
      ? String(r.ultimaAlteracao).replace(" ", "T")
      : null;
    return {
      rastreio: r.codigo || null,
      descricao: r.descricao || null,
      situacao: r.situacao ?? null,
      ultimaAlteracao: alteracao,
      servico: o?.servico?.nome || null,
      idPedido: o?.pedidoVenda?.id ?? null,
      idNota: o?.notaFiscal?.id ?? null,
    };
  } catch (err) {
    // Volume sem objeto de postagem e situacao normal (remessa nao despachada
    // por logistica integrada). Nao vale derrubar a sincronizacao por isso.
    console.warn(`[bling] objeto de postagem ${idVolume}: ${err.message}`);
    return null;
  }
}
