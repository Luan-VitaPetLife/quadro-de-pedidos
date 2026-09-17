// Integracao com o portal da FontesLog (DDS WMS).
//
// COMO FUNCIONA, e por que assim:
//
// O portal nao tem API, mas as telas sao GET com tudo na query string. A de
// pedidos e:
//
//   /Pedido/Rastreamento?idCliente=389&dataDe=2026-09-01&dataAte=2026-09-09
//     &tipoData=Recepcao&idTransportadora=0&numeroPedido=0&numeroNfe=0
//     &statusPedido=TODOS
//
// Isso significa que NAO precisamos de navegador pra ler os dados: basta um
// GET com o cookie de sessao -- e e por isso que o SERVIDOR consegue ler o WMS
// sozinho, sem ninguem na frente do computador (ver lib/wms.js). O Playwright
// entra so no login, porque ali tem reCAPTCHA -- ver src/fonteslog-login.js.
//
// SOBRE A PAGINACAO: a tabela usa DataTables no lado do CLIENTE. O "Mostrar 10
// registros" e o "Anterior/Proximo" sao enfeite do JavaScript -- o HTML ja vem
// com TODAS as linhas. Confirmado na pratica: a tela exibia 10 por vez e o HTML
// trazia 66 <tr>. Logo, nao existe pagina 2 pra buscar, e nao ha risco de
// perder registro por paginacao.

import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../lib/pastaDeDados.js";

// A sessao mora junto do banco, e nao mais na pasta data/ do codigo. O motivo e
// que ela precisa existir ONDE O QUADRO RODA: no Railway isso e o Volume, o
// unico lugar que sobrevive ao deploy. Enquanto ela so existia na maquina de
// quem operava, o servidor nao tinha como ler o WMS sozinho -- era isso que
// obrigava alguem a estar na frente do computador.
export const CAMINHO_SESSAO = path.join(dataDir, "fonteslog-sessao.json");

const BASE = () => (process.env.FONTESLOG_URL || "http://portalfonteslog.ddsinformatica.com.br").replace(/\/+$/, "");
const ID_CLIENTE = () => process.env.FONTESLOG_ID_CLIENTE || "389";

/** Monta o header Cookie a partir da sessao salva pelo login manual. */
export function carregarCookies() {
  if (!fs.existsSync(CAMINHO_SESSAO)) {
    throw new Error(
      `Sessao da FontesLog nao encontrada (${CAMINHO_SESSAO}). Rode \`npm run fonteslog-login\` primeiro.`
    );
  }
  const estado = JSON.parse(fs.readFileSync(CAMINHO_SESSAO, "utf-8"));
  const doPortal = (estado.cookies || []).filter((c) => c.domain.includes("ddsinformatica"));
  if (doPortal.length === 0) {
    throw new Error("A sessao salva nao tem cookie do portal FontesLog. Rode `npm run fonteslog-login` de novo.");
  }
  return doPortal.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Ha uma sessao salva? (nao diz se ela ainda vale -- pra isso, `conferirSessao`) */
export function temSessao() {
  return fs.existsSync(CAMINHO_SESSAO);
}

/** Quando a sessao salva foi gravada. */
export function sessaoGravadaEm() {
  if (!temSessao()) return null;
  return fs.statSync(CAMINHO_SESSAO).mtime.toISOString();
}

/**
 * Grava a sessao que veio do login manual.
 *
 * Recusa o que nao tem cookie do portal. Isso importa mais do que parece: quem
 * chama isto e o envio de uma sessao nova, e sobrescrever uma sessao QUE FUNCIONA
 * com um arquivo vazio derrubaria a leitura do WMS ate alguem perceber -- um
 * login que deu errado nao pode ter o poder de apagar um login que deu certo.
 *
 * @param {{cookies?: Array<{name: string, value: string, domain: string}>}} estado
 */
export function salvarSessao(estado) {
  const cookies = (estado?.cookies || []).filter((c) => String(c?.domain || "").includes("ddsinformatica"));
  if (!cookies.length) throw new Error("SESSAO_SEM_COOKIE_DO_PORTAL");
  fs.writeFileSync(CAMINHO_SESSAO, JSON.stringify(estado, null, 2), "utf-8");
  return cookies.length;
}

/**
 * Bate no portal pra saber se a sessao salva ainda esta de pe.
 *
 * Alem de responder, ESSE PEDIDO SEGURA A SESSAO VIVA -- e o mecanismo inteiro
 * da automacao. O cookie do portal (`ASP.NET_SessionId`) nao tem data de
 * validade: quem decide quando ele morre e o servidor, por inatividade, na
 * janela padrao de 20 minutos. Enquanto alguem pedir uma tela de tempos em
 * tempos, a janela e reiniciada e a sessao nao expira. Foi isso que transformou
 * "vale por 20 minutos" em "vale por dias".
 *
 * @returns {Promise<{viva: boolean, motivo?: string}>}
 */
export async function conferirSessao() {
  if (!temSessao()) return { viva: false, motivo: "nenhuma sessao salva" };
  try {
    // A tela mais barata que existe atras do login: um dia so, sem resultado.
    const hoje = paraISO(new Date());
    await buscarTela("/Pedido/Rastreamento", {
      idCliente: ID_CLIENTE(),
      idTransportadora: "0",
      dataDe: hoje,
      dataAte: hoje,
      tipoData: "Recepcao",
      numeroPedido: "0",
      numeroNfe: "0",
      statusPedido: "TODOS",
    });
    return { viva: true };
  } catch (err) {
    if (err.message === "SESSAO_EXPIRADA") return { viva: false, motivo: "sessao expirada" };
    // Portal fora do ar nao e sessao morta. Confundir os dois faria o quadro
    // pedir um login manual que nao resolveria nada.
    return { viva: false, motivo: `portal indisponivel: ${err.message}`, indisponivel: true };
  }
}

// O portal e ASP.NET e escapa acento como entidade numerica: "PROJETO NATÁLIA"
// chega no HTML como "PROJETO NAT&#193;LIA". Sem decodificar, o numero do
// pedido ia pro quadro literalmente com o "&#193;" no meio -- e como o numero
// do pedido e a CHAVE do registro, isso quebraria qualquer cruzamento futuro
// com o mesmo pedido vindo de outra fonte.
const ENTIDADES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodificarEntidades(texto) {
  return texto
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&(\w+);/g, (inteiro, nome) => (nome in ENTIDADES ? ENTIDADES[nome] : inteiro));
}

function limpar(html) {
  return decodificarEntidades(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Le QUALQUER uma das tabelas do portal e devolve as linhas ja mapeadas por
 * NOME de coluna, nao por posicao.
 *
 * Mapear por nome importa porque as telas nao usam a mesma ordem: em
 * Rastreamento o "Numero Pedido" e a primeira coluna; em Pedidos Rejeitados e
 * a ULTIMA. Por posicao, um ajuste de layout da DDS trocaria os dados de lugar
 * em silencio -- e a gente so descobriria pelo quadro exibindo bobagem.
 */
export function parsearTabela(html) {
  if (/frmLoginCliente|frmLoginArmazem/.test(html)) throw new Error("SESSAO_EXPIRADA");

  const tabela = (html.match(/<table[\s\S]*?<\/table>/i) || [])[0];
  if (!tabela) return [];

  const colunas = [...tabela.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
    .map((m) => chave(limpar(m[1])))
    .filter(Boolean);

  const corpo = (tabela.match(/<tbody[\s\S]*?<\/tbody>/i) || [""])[0];
  const linhas = [];

  for (const [, conteudo] of corpo.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const celulas = [...conteudo.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => limpar(m[1]));
    if (celulas.length < 2) continue; // pula a linha "Sem registros na tabela"
    const registro = {};
    colunas.forEach((nome, i) => {
      registro[nome] = celulas[i] ?? "";
    });
    linhas.push(registro);
  }
  return linhas;
}

/** "Numero Pedido" -> numeroPedido | "Data/Hora da Recepcao" -> dataHoraDaRecepcao */
function chave(rotulo) {
  const limpo = rotulo
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .trim();
  if (!limpo) return "";
  const partes = limpo.split(/\s+/);
  return partes[0].toLowerCase() + partes.slice(1).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join("");
}

/** A tela de rastreamento e so uma das tabelas; mantido pelo nome de antes. */
export function parsearRastreamento(html) {
  return parsearTabela(html).filter((l) => l.numeroPedido);
}

/**
 * O ultimo carimbo de tempo que o WMS registrou para o pedido -- serve de
 * "lastEventAt" no quadro, e e o que faz a regra de envelhecimento funcionar
 * tambem para o lado do armazem.
 */
export function ultimoMovimento(pedido) {
  const candidatos = [pedido.expedicao, pedido.fimConferencia, pedido.inicioConferencia, pedido.separacao, pedido.recepcao, pedido.emissao];
  for (const c of candidatos) {
    if (!c) continue;
    // "08/09/2026 18:04:29" -> ISO local (sem fuso: o portal mostra hora de Brasilia)
    const m = c.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
    if (m) {
      const [, d, mes, a, hh = "00", mm = "00", ss = "00"] = m;
      return `${a}-${mes}-${d}T${hh}:${mm}:${ss}`;
    }
  }
  return null;
}

function paraISO(data) {
  if (data instanceof Date) return data.toISOString().slice(0, 10);
  return String(data).slice(0, 10);
}

/**
 * Busca os pedidos no portal, no intervalo pedido.
 * @param {{dataDe: Date|string, dataAte: Date|string, status?: string}} opcoes
 */
export async function buscarPedidos({ dataDe, dataAte, status = "TODOS" } = {}) {
  const cookie = carregarCookies();
  const params = new URLSearchParams({
    idCliente: ID_CLIENTE(),
    idTransportadora: "0",
    dataDe: paraISO(dataDe),
    dataAte: paraISO(dataAte),
    tipoData: "Recepcao",
    numeroPedido: "0",
    numeroNfe: "0",
    statusPedido: status,
  });

  const url = `${BASE()}/Pedido/Rastreamento?${params}`;
  const res = await fetch(url, {
    headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0 (quadro-de-pedidos)" },
    redirect: "manual",
  });

  // O portal responde 302 para "/" quando a sessao morreu.
  if (res.status >= 300 && res.status < 400) throw new Error("SESSAO_EXPIRADA");
  if (!res.ok) throw new Error(`FontesLog respondeu ${res.status}`);

  return parsearRastreamento(await res.text());
}

/** GET autenticado numa tela do portal, ja tratando sessao morta. */
async function buscarTela(rota, params) {
  const cookie = carregarCookies();
  const res = await fetch(`${BASE()}${rota}?${new URLSearchParams(params)}`, {
    headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0 (quadro-de-pedidos)" },
    redirect: "manual",
  });
  // O portal responde 302 para "/" quando a sessao morreu.
  if (res.status >= 300 && res.status < 400) throw new Error("SESSAO_EXPIRADA");
  if (!res.ok) throw new Error(`FontesLog respondeu ${res.status} em ${rota}`);
  return parsearTabela(await res.text());
}

/**
 * Pedidos PARADOS: o armazem travou o pedido e registrou um MOTIVO.
 *
 * Essa tela e a unica que diz POR QUE o pedido travou -- a de Rastreamento
 * mostraria so o status seco. E o motivo e justamente o que a pessoa precisa
 * ler pra ir resolver.
 *
 * Colunas: Numero Pedido, Data/Hora da Recepcao, Cliente, Qtde Itens,
 *          Nota Fiscal, Serie NF, Motivo
 */
export async function buscarPedidosParados({ dataDe, dataAte } = {}) {
  const linhas = await buscarTela("/Pedido/PedidosParados", {
    idCliente: ID_CLIENTE(),
    dataDe: paraISO(dataDe),
    dataAte: paraISO(dataAte),
  });
  return linhas
    .filter((l) => l.numeroPedido)
    .map((l) => ({
      numeroPedido: l.numeroPedido,
      motivo: l.motivo || "",
      // A tela separa numero e serie em duas colunas; a de Rastreamento ja
      // devolve junto ("000000246 - 001"). Juntar aqui deixa o quadro com um
      // formato so, senao a mesma nota aparece como "263" e como "000000263 - 001".
      notaFiscal: [l.notaFiscal, l.serieNf].filter(Boolean).join(" - ") || "",
      recepcao: l.dataHoraDaRecepcao || "",
    }));
}

/**
 * Pedidos REJEITADOS: o WMS recusou o pedido -- ele nao vai ser separado.
 *
 * ATENCAO ao layout: aqui o "Numero Pedido" e a ULTIMA coluna, e a primeira e
 * o "Codigo". Por isso o parser mapeia por nome de cabecalho.
 *
 * Colunas: Codigo, Data/Hora Processamento, CNPJ Emitente, Emitente,
 *          Nota Fiscal, Serie NF, Observacoes, Numero Pedido
 */
export async function buscarPedidosRejeitados({ dataDe, dataAte } = {}) {
  const linhas = await buscarTela("/Pedido/PedidosRejeitados", {
    idCliente: ID_CLIENTE(),
    dataDe: paraISO(dataDe),
    dataAte: paraISO(dataAte),
  });
  return linhas
    .filter((l) => l.numeroPedido)
    .map((l) => ({
      numeroPedido: l.numeroPedido,
      observacoes: l.observacoes || "",
      // A tela separa numero e serie em duas colunas; a de Rastreamento ja
      // devolve junto ("000000246 - 001"). Juntar aqui deixa o quadro com um
      // formato so, senao a mesma nota aparece como "263" e como "000000263 - 001".
      notaFiscal: [l.notaFiscal, l.serieNf].filter(Boolean).join(" - ") || "",
      processamento: l.dataHoraProcessamento || "",
    }));
}

// ---------------------------------------------------------------------------
// Religamento automatico
// ---------------------------------------------------------------------------
//
// ATENCAO, porque aqui existiu um comentario dizendo o CONTRARIO do que esta
// escrito agora, e ele parou o assunto por meses:
//
// A versao anterior afirmava que refazer o login por HTTP era impossivel -- que
// o portal exigia um token de captcha valido, e que um POST em
// /Login/AcessarCliente com credenciais corretas respondia 302 para
// "/?cnpjLogin=<cnpj>", ou seja, a volta pra tela de login.
//
// O 302 era real. A causa, nao: o teste rodava com a SENHA ERRADA. O dotenv
// trata "#" como inicio de comentario, e a senha termina em "#" -- entao
// process.env.FONTESLOG_SENHA chegava truncada no ultimo caractere. O portal
// respondia exatamente o que responde pra qualquer senha errada, e a leitura
// disso virou uma lei da natureza. Com a senha inteira (aspas no .env), o mesmo
// POST responde 302 para /HomeArmazem/Dashboard e a tela protegida seguinte
// responde 200: entrou.
//
// A licao, mais util que o resultado: um teste negativo prova pouco quando uma
// das entradas nao foi conferida.
//
// O QUE AINDA PRECISA DE GENTE. O login so passa enquanto existe o cookie
// `recaptcha_verificado`, que o portal grava quando ALGUEM resolve o captcha, e
// que vale ~5 dias. O login NAO o renova (medido: a resposta do POST nao traz
// Set-Cookie). Entao isto aqui nao e um captcha burlado -- e a mesma sessao
// humana sendo reaproveitada enquanto ela vale, do mesmo jeito que ja fazemos
// com o ASP.NET_SessionId. Passados os ~5 dias, uma pessoa resolve um captcha
// de novo, e nao ha o que fazer quanto a isso.

/** O cookie que diz "um humano resolveu um captcha aqui" -- se ainda valer. */
function selorecaptcha() {
  if (!temSessao()) return null;
  const estado = JSON.parse(fs.readFileSync(CAMINHO_SESSAO, "utf-8"));
  const selo = (estado.cookies || []).find((c) => c.name === "recaptcha_verificado");
  if (!selo) return null;
  // expires em segundos; -1 significa cookie de sessao (sem validade propria).
  if (selo.expires > 0 && selo.expires * 1000 < Date.now()) return null;
  return selo;
}

/**
 * Refaz o login sozinho e grava a sessao nova.
 *
 * Lanca PRECISA_DE_HUMANO quando o selo do captcha nao existe mais -- e a
 * fronteira honesta do que da pra automatizar aqui.
 */
export async function religarSessao() {
  const login = process.env.FONTESLOG_LOGIN;
  const senha = process.env.FONTESLOG_SENHA;
  if (!login || !senha) throw new Error("FONTESLOG_LOGIN ou FONTESLOG_SENHA faltando");

  const selo = selorecaptcha();
  if (!selo) throw new Error("PRECISA_DE_HUMANO");

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";
  const seloHeader = `${selo.name}=${selo.value}`;

  // 1. Sessao nova, ja levando o selo: sem ele o portal desenha o captcha.
  const inicial = await fetch(`${BASE()}/`, { headers: { "User-Agent": UA, Cookie: seloHeader } });
  const novo = (inicial.headers.getSetCookie?.() || [])
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("ASP.NET_SessionId="));
  if (!novo) throw new Error("o portal nao abriu uma sessao nova");

  // 2. O login em si.
  const resposta = await fetch(`${BASE()}/Login/AcessarCliente`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "User-Agent": UA,
      Cookie: `${novo}; ${seloHeader}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${BASE()}/`,
      Origin: BASE(),
    },
    body: new URLSearchParams({ tipoAcesso: "cliente", cpf: login, senha }),
  });

  // 3. Voltar pra "/" e a resposta de senha errada OU de selo vencido. Os dois
  //    casos pedem gente, entao os dois viram o mesmo erro.
  const destino = resposta.headers.get("location") || "";
  if (/cnpjLogin=|^\/$/.test(destino)) throw new Error("PRECISA_DE_HUMANO");

  const [nome, ...resto] = novo.split("=");
  const cookies = [
    { name: nome, value: resto.join("="), domain: dominio(), path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" },
    { ...selo },
  ];

  // O selo e o unico bem insubstituivel que temos: ele custa uma pessoa. Se o
  // passo seguinte reprovar a sessao nova, o arquivo antigo volta inteiro --
  // senao um religamento que falhou levaria junto os dias de selo que sobravam.
  const anterior = fs.existsSync(CAMINHO_SESSAO) ? fs.readFileSync(CAMINHO_SESSAO) : null;
  salvarSessao({ cookies, origins: [] });

  // 4. A prova. Um 302 aqui significa que o passo 3 mentiu -- ja aconteceu.
  const teste = await conferirSessao();
  if (!teste.viva) {
    if (anterior) fs.writeFileSync(CAMINHO_SESSAO, anterior);
    throw new Error("PRECISA_DE_HUMANO");
  }

  return { seloValeAte: selo.expires > 0 ? new Date(selo.expires * 1000).toISOString() : null };
}

function dominio() {
  try {
    return new URL(BASE()).hostname;
  } catch {
    return "portalfonteslog.ddsinformatica.com.br";
  }
}

/** Ate quando o selo do captcha ainda permite religar sozinho. */
export function seloValeAte() {
  const selo = selorecaptcha();
  if (!selo) return null;
  return selo.expires > 0 ? new Date(selo.expires * 1000).toISOString() : null;
}
