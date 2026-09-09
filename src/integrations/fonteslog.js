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
// GET com o cookie de sessao. O Playwright entra so no login (uma vez a cada
// poucos dias), porque ali tem reCAPTCHA -- ver src/fonteslog-login.js.
//
// SOBRE A PAGINACAO: a tabela usa DataTables no lado do CLIENTE. O "Mostrar 10
// registros" e o "Anterior/Proximo" sao enfeite do JavaScript -- o HTML ja vem
// com TODAS as linhas. Confirmado na pratica: a tela exibia 10 por vez e o HTML
// trazia 66 <tr>. Logo, nao existe pagina 2 pra buscar, e nao ha risco de
// perder registro por paginacao.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CAMINHO_SESSAO = path.join(__dirname, "..", "..", "data", "fonteslog-sessao.json");

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
      notaFiscal: l.notaFiscal || "",
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
      notaFiscal: l.notaFiscal || "",
      processamento: l.dataHoraProcessamento || "",
    }));
}
