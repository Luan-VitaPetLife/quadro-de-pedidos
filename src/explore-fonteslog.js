// Script de diagnostico -- RODE ISSO VOCE MESMO (`npm run explore-fonteslog`), localmente.
// Ele faz login no portal da FontesLog com as credenciais do seu .env e salva:
//   - data/fonteslog-debug/pagina-pos-login.png  (screenshot)
//   - data/fonteslog-debug/pagina-pos-login.html (HTML da pagina)
//
// Isso deixa a gente ver a estrutura real do portal (sem que ninguem alem de
// voce, no seu computador, precise digitar a senha) para terminar a integracao
// em src/integrations/fonteslog.js.

import "dotenv/config";
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "data", "fonteslog-debug");
fs.mkdirSync(outDir, { recursive: true });

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

    console.log("Tentando preencher o formulario de login (melhor esforco)...");
    const userField = page.locator('input[type="text"], input[name*="login" i], input[name*="usuario" i]').first();
    const passField = page.locator('input[type="password"]').first();
    const submitButton = page.locator('button[type="submit"], input[type="submit"]').first();

    await userField.fill(login);
    await passField.fill(senha);
    await Promise.all([
      page.waitForLoadState("networkidle").catch(() => {}),
      submitButton.click(),
    ]);

    await page.waitForTimeout(2000);

    const screenshotPath = path.join(outDir, "pagina-pos-login.png");
    const htmlPath = path.join(outDir, "pagina-pos-login.html");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    fs.writeFileSync(htmlPath, await page.content(), "utf-8");

    console.log(`OK! Salvei:\n  ${screenshotPath}\n  ${htmlPath}`);
    console.log("Se o login nao funcionou (a tela salva ainda mostra o formulario de login), me avise -- vamos ajustar os seletores em src/integrations/fonteslog.js e tentar de novo.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Deu erro explorando o portal:", err);
  process.exit(1);
});
