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

function limpar(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrai as linhas da tabela de rastreamento.
 * Devolve objetos com as colunas nomeadas, na ordem em que o portal as manda.
 */
export function parsearRastreamento(html) {
  if (/frmLoginCliente|frmLoginArmazem/.test(html)) {
    throw new Error("SESSAO_EXPIRADA");
  }

  const tabela = (html.match(/<table[\s\S]*?<\/table>/i) || [])[0];
  if (!tabela) return [];

  const corpo = (tabela.match(/<tbody[\s\S]*?<\/tbody>/i) || [""])[0];
  const linhas = [...corpo.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

  const pedidos = [];
  for (const [, conteudo] of linhas) {
    const celulas = [...conteudo.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => limpar(m[1]));
    if (celulas.length < 6) continue; // linha de "sem registros" e afins

    const [numeroPedido, status, cliente, notaFiscal, emissao, recepcao, separacao, inicioConf, fimConf, expedicao, previsaoSla] = celulas;
    if (!numeroPedido) continue;

    pedidos.push({
      numeroPedido,
      status,
      cliente,
      notaFiscal,
      emissao,
      recepcao,
      separacao,
      inicioConferencia: inicioConf,
      fimConferencia: fimConf,
      expedicao,
      previsaoSla,
    });
  }
  return pedidos;
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
