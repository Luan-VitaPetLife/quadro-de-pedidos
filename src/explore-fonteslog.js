// Script de diagnostico -- RODE ISSO VOCE MESMO (`npm run explore-fonteslog`), localmente.
// Ele faz login no portal da FontesLog com as credenciais do seu .env e salva:
//   - data/fonteslog-debug/pagina-antes-login.png  (screenshot do formulario, antes de logar)
//   - data/fonteslog-debug/pagina-pos-login.png    (screenshot depois de logar)
//   - data/fonteslog-debug/pagina-pos-login.html   (HTML da pagina pos-login)
//
// Isso deixa a gente ver a estrutura real do portal (sem que ninguem alem de
// voce, no seu computador, precise digitar a senha) para terminar a integracao
// em src/integrations/fonteslog.js.
//
// O portal e o "DDS WMS - Portal de Consulta": tem um seletor "Tipo de Acesso"
// (Armazem / Cliente) -- precisa marcar "Cliente" -- e os campos se chamam
// "CPF/CNPJ do Tomador" e "Senha do Tomador", com um botao "Entrar".

import "dotenv/config";
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "data", "fonteslog-debug");
fs.mkdirSync(outDir, { recursive: true });

// Tenta uma lista de estrategias de localizacao, na ordem, e usa a primeira
// que encontrar algo na pagina. Deixa a automacao resiliente a pequenas
// diferencas no HTML real (label vs placeholder vs texto solto etc.).
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

async function main() {
  const url = process.env.FONTESLOG_URL;
  const login = process.env.FONTESLOG_LOGIN;
  const senha = process.env.FONTESLOG_SENHA;
  if (!url || !login || !senha) {
    console.error("Preencha FONTESLOG_URL, FONTESLOG_LOGIN e FONTESLOG_SENHA no seu .env antes de rodar isso.");
    process.exit(1);
  }

  console.log(`Abrindo ${url} ...`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle" });

    await page.screenshot({ path: path.join(outDir, "pagina-antes-login.png"), fullPage: true });
    console.log("Salvei o formulario de login (antes de preencher) em data/fonteslog-debug/pagina-antes-login.png");

    console.log('Marcando "Cliente" em Tipo de Acesso...');
    const clienteRadio = await firstMatch(page, [
      page.getByRole("radio", { name: /cliente/i }),
      page.getByLabel(/cliente/i),
      page.locator('input[type="radio"]').nth(1), // Armazem costuma vir primeiro, Cliente depois
    ]);
    if (clienteRadio) {
      await clienteRadio.check({ force: true }).catch(() => clienteRadio.click());
    } else {
      console.warn('Nao encontrei o radio "Cliente" -- seguindo sem marcar (pode dar errado).');
    }

    console.log("Preenchendo CPF/CNPJ do Tomador e Senha do Tomador...");
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
      console.warn("Nao encontrei todos os campos esperados (usuario/senha/botao) -- vou salvar a pagina mesmo assim pra gente olhar o HTML real.");
    } else {
      await userField.fill(login);
      await passField.fill(senha);
      await Promise.all([
        page.waitForLoadState("networkidle").catch(() => {}),
        submitButton.click(),
      ]);
    }

    await page.waitForTimeout(2000);

    const screenshotPath = path.join(outDir, "pagina-pos-login.png");
    const htmlPath = path.join(outDir, "pagina-pos-login.html");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    fs.writeFileSync(htmlPath, await page.content(), "utf-8");

    console.log(`OK! Salvei:\n  ${screenshotPath}\n  ${htmlPath}`);
    console.log("Se a tela salva ainda mostra o formulario de login (nao entrou de verdade), me avise -- vamos ajustar os seletores em src/integrations/fonteslog.js e tentar de novo.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Deu erro explorando o portal:", err);
  process.exit(1);
});
