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

export async function nomeDaLoja(id) {
  if (id == null) return null;
  const chave = String(id);
  if (nomesDeLoja.has(chave)) return nomesDeLoja.get(chave);

  let nome = null;
  try {
    const dados = await blingFetch(`/lojas/${encodeURIComponent(chave)}`);
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
