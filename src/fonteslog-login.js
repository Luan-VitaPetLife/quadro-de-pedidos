// Login MANUAL no portal da FontesLog, com a sessao salva pra reuso.
//
//   npm run fonteslog-login
//
// Por que manual: o portal (DDS WMS, ASP.NET) exige reCAPTCHA no login --
// hoje /Login/ExibirCaptcha responde {"MostrarRecaptcha":true}. Robo nenhum
// passa por ali, e nao e pra passar: o captcha existe exatamente pra barrar
// automacao. O que da pra fazer, de forma legitima, e VOCE logar uma vez com
// as suas credenciais e a gente guardar a sessao resultante -- do mesmo jeito
// que o seu navegador guarda quando voce marca "continuar conectado".
//
// O script abre o navegador VISIVEL, ja preenche o CNPJ e a senha do .env, e
// espera voce resolver o captcha e clicar em Entrar. Assim que entrar, ele:
//   - salva a sessao em data/fonteslog-sessao.json (pro scraper reusar depois)
//   - salva screenshot e HTML da tela pos-login
//   - lista os links/menus encontrados, que e o que falta pra achar a tela de
//     pedidos e escrever a consulta automatica
//
// A sessao vale ate o portal expirar o cookie. Quando expirar, e so rodar isso
// de novo. NAO comite data/fonteslog-sessao.json -- ela vale como sua senha.

import "dotenv/config";
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const debugDir = path.join(dataDir, "fonteslog-debug");
export const CAMINHO_SESSAO = path.join(dataDir, "fonteslog-sessao.json");

fs.mkdirSync(debugDir, { recursive: true });

const ESPERA_MAX_MS = 5 * 60 * 1000; // 5 minutos pra voce logar com calma

async function main() {
  const url = process.env.FONTESLOG_URL;
  const login = process.env.FONTESLOG_LOGIN;
  const senha = process.env.FONTESLOG_SENHA;
  if (!url || !login || !senha) {
    console.error("Preencha FONTESLOG_URL, FONTESLOG_LOGIN e FONTESLOG_SENHA no .env.");
    process.exit(1);
  }

  console.log("\nAbrindo o navegador... (ele vai aparecer na sua tela, isso e proposital)\n");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Marca "Cliente" (seu login e CNPJ) e preenche os campos, pra voce so ter
    // que resolver o captcha. O onclick do radio troca o formulario visivel.
    await page.locator("#tipoAcessoCliente").click({ force: true }).catch(() => {});
    await page.evaluate(() => typeof AlteraTipoAcesso === "function" && AlteraTipoAcesso()).catch(() => {});
    await page.locator("#cpf").fill(login).catch(() => {});
    await page.locator('#frmLoginCliente input[name="senha"]').fill(senha).catch(() => {});

    console.log("=".repeat(64));
    console.log("  AGORA E COM VOCE, na janela do navegador:");
    console.log("    1. CNPJ e senha ja estao preenchidos (confira)");
    console.log('    2. Resolva o "I\'m not a robot"');
    console.log('    3. Clique em "Entrar"');
    console.log("");
    console.log("  Estou esperando. Assim que voce entrar, eu sigo sozinho.");
    console.log("=".repeat(64));
    console.log("");

    // Espera sair da tela de login. O portal e ASP.NET MVC: ao logar, sai de
    // "/" ou "/Login/..." para alguma outra rota -- que e justamente o nome
    // que a gente ainda nao conhece e precisa descobrir.
    const inicio = Date.now();
    let entrou = false;
    while (Date.now() - inicio < ESPERA_MAX_MS) {
      const atual = page.url();
      const temFormLogin = await page.locator("#frmLoginCliente").count().catch(() => 0);
      if (!/\/(Login)?\/?$/i.test(new URL(atual).pathname) || temFormLogin === 0) {
        entrou = true;
        break;
      }
      await page.waitForTimeout(1000);
    }

    if (!entrou) {
      console.log("Passaram 5 minutos e a tela de login ainda esta ai. Vou salvar assim mesmo pra gente olhar.\n");
    } else {
      console.log(`Entrou! Estou em: ${page.url()}\n`);
      await page.waitForTimeout(2500); // deixa a tela carregar por completo
    }

    // ---- salva a sessao ----
    await context.storageState({ path: CAMINHO_SESSAO });
    console.log(`Sessao salva em: ${CAMINHO_SESSAO}`);

    // ---- salva a tela ----
    const png = path.join(debugDir, "pagina-pos-login.png");
    const html = path.join(debugDir, "pagina-pos-login.html");
    await page.screenshot({ path: png, fullPage: true });
    fs.writeFileSync(html, await page.content(), "utf-8");
    console.log(`Screenshot:      ${png}`);
    console.log(`HTML:            ${html}`);

    // ---- mapeia a navegacao: e isso que diz onde ficam os pedidos ----
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .map((a) => ({ texto: (a.textContent || "").trim().replace(/\s+/g, " "), href: a.getAttribute("href") }))
        .filter((l) => l.texto && l.href && !l.href.startsWith("javascript"))
    );

    const vistos = new Set();
    const unicos = links.filter((l) => !vistos.has(l.href) && vistos.add(l.href));
    fs.writeFileSync(path.join(debugDir, "menu-pos-login.json"), JSON.stringify(unicos, null, 2), "utf-8");

    console.log(`\n=== ${unicos.length} link(s) encontrado(s) na tela ===`);
    for (const l of unicos.slice(0, 60)) {
      console.log(`  ${String(l.texto).slice(0, 45).padEnd(47)} ${l.href}`);
    }

    console.log("\nPronto. Me mande o print da tela e a lista de links acima --");
    console.log("com isso eu escrevo a consulta automatica dos pedidos.\n");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("\nDeu erro:", err.message, "\n");
  process.exit(1);
});
