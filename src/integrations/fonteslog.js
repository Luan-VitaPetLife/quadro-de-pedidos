// Integracao com o portal da FontesLog (WMS): "DDS WMS - Portal de Consulta"
// (http://portalfonteslog.ddsinformatica.com.br/).
//
// AINDA NAO TERMINADA DE PROPOSITO: a FontesLog nao tem API publica, entao a
// unica forma de puxar status daqui e automatizando o navegador (Playwright).
// Ja sabemos o formulario de login (ver `npm run explore-fonteslog`): um
// seletor "Tipo de Acesso" que precisa ser marcado como "Cliente", e os
// campos "CPF/CNPJ do Tomador" / "Senha do Tomador" + botao "Entrar". Falta
// mapear como a lista/consulta de pedidos aparece depois de logado -- rode
// `npm run explore-fonteslog` e me mande o resultado (screenshot/HTML em
// data/fonteslog-debug/) pra terminarmos fetchOrderStatus() abaixo.

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

// Tenta uma lista de estrategias de localizacao, na ordem, e usa a primeira
// que encontrar algo na pagina -- resiliente a pequenas diferencas no HTML
// real (label vs placeholder vs texto solto etc.).
async function firstMatch(page, locators) {
  for (const loc of locators) {
    try {
      if ((await loc.count()) > 0) return loc.first();
    } catch {
      // ignora e tenta o proximo
    }
  }
  return null;
}

export async function login(page) {
  const url = process.env.FONTESLOG_URL;
  const loginValue = process.env.FONTESLOG_LOGIN;
  const senha = process.env.FONTESLOG_SENHA;
  if (!url || !loginValue || !senha) {
    throw new Error("FONTESLOG_URL / FONTESLOG_LOGIN / FONTESLOG_SENHA nao configurados (.env)");
  }

  await page.goto(url, { waitUntil: "networkidle" });

  // "Tipo de Acesso": Armazem / Cliente -- precisa marcar Cliente.
  const clienteRadio = await firstMatch(page, [
    page.getByRole("radio", { name: /cliente/i }),
    page.getByLabel(/cliente/i),
    page.locator('input[type="radio"]').nth(1),
  ]);
  if (clienteRadio) {
    await clienteRadio.check({ force: true }).catch(() => clienteRadio.click());
  }

  const userField = await firstMatch(page, [
    page.getByPlaceholder(/cpf\/cnpj/i),
    page.getByLabel(/cpf\/cnpj/i),
    page.locator('input[type="text"], input[type="tel"]').first(),
  ]);
  const passField = await firstMatch(page, [
    page.getByPlaceholder(/senha/i),
    page.getByLabel(/senha/i),
    page.locator('input[type="password"]').first(),
  ]);
  const submitButton = await firstMatch(page, [
    page.getByRole("button", { name: /entrar/i }),
    page.locator('button[type="submit"], input[type="submit"]'),
  ]);

  if (!userField || !passField || !submitButton) {
    throw new Error("Nao encontrei os campos de login esperados (CPF/CNPJ, senha ou botao Entrar) -- portal pode ter mudado.");
  }

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
