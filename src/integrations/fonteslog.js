// Integracao com o portal da FontesLog (WMS): http://portalfonteslog.ddsinformatica.com.br/
//
// AINDA NAO TERMINADA DE PROPOSITO: a FontesLog nao tem API publica, entao a
// unica forma de puxar status daqui e automatizando o navegador (Playwright) --
// mas isso exige conhecer a estrutura real das paginas do portal (nomes dos
// campos de login, como a lista de pedidos aparece, quais textos de status
// eles usam). Ninguem aqui (nem o Claude) navegou pelo portal ainda.
//
// Passo 1: rode `npm run explore-fonteslog` (ver src/explore-fonteslog.js).
// Isso faz login com as credenciais do .env e salva um screenshot + o HTML da
// pagina em data/fonteslog-debug/. A partir dali da pra descobrir os seletores
// certos e preencher as funcoes abaixo.

import { chromium } from "playwright";

export async function withFontesLogPage(callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await login(page);
    return await callback(page);
  } finally {
    await browser.close();
  }
}

export async function login(page) {
  const url = process.env.FONTESLOG_URL;
  const loginValue = process.env.FONTESLOG_LOGIN;
  const senha = process.env.FONTESLOG_SENHA;
  if (!url || !loginValue || !senha) {
    throw new Error("FONTESLOG_URL / FONTESLOG_LOGIN / FONTESLOG_SENHA nao configurados (.env)");
  }

  await page.goto(url, { waitUntil: "networkidle" });

  // TODO: confirmar os seletores reais depois de rodar `npm run explore-fonteslog`.
  // Estes sao um chute razoavel baseado em portais DDS Informatica comuns --
  // ajustar assim que virmos o HTML real.
  const userField = page.locator('input[type="text"], input[name*="login" i], input[name*="usuario" i]').first();
  const passField = page.locator('input[type="password"]').first();
  const submitButton = page.locator('button[type="submit"], input[type="submit"]').first();

  await userField.fill(loginValue);
  await passField.fill(senha);
  await Promise.all([
    page.waitForLoadState("networkidle"),
    submitButton.click(),
  ]);
}

/**
 * TODO: implementar depois que soubermos como a lista/consulta de pedidos
 * aparece no portal (uma tabela? um campo de busca por numero de pedido?).
 * Deve devolver algo como: { status: "separado" | "despachado" | ..., raw: "texto original" }
 */
export async function fetchOrderStatus(page, orderIdentifier) {
  throw new Error(
    `fetchOrderStatus ainda nao implementado -- falta mapear a tela de pedidos do portal FontesLog (pedido ${orderIdentifier})`
  );
}
