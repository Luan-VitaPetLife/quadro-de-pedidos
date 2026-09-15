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
// Ao final, a sessao e ENVIADA AO QUADRO (BOARD_URL), e e ali que ela passa a
// trabalhar: o servidor le o portal a cada ciclo e mantem a sessao viva com um
// pulso de poucos minutos. Por isso voce nao precisa mais ficar na frente do
// computador -- e nem estar na mesma maquina da proxima vez. Rode isto de onde
// estiver, resolva o captcha, e o quadro volta a ler sozinho.
//
// A sessao vale ate o portal expirar o cookie. Quando expirar, o quadro avisa
// em cima da tela. NAO comite data/fonteslog-sessao.json -- ela vale como sua senha.

import "dotenv/config";
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAMINHO_SESSAO } from "./integrations/fonteslog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const debugDir = path.join(__dirname, "..", "data", "fonteslog-debug");

fs.mkdirSync(debugDir, { recursive: true });

const ESPERA_MAX_MS = 5 * 60 * 1000; // 5 minutos pra voce logar com calma

/**
 * Manda a sessao recem-criada pro quadro.
 *
 * Sem isto, a sessao ficaria so nesta maquina -- e uma sessao que so existe
 * aqui obriga alguem a estar aqui. Depois deste envio, quem le o portal e o
 * servidor, sozinho, ate a sessao expirar.
 */
async function enviarAoQuadro() {
  const boardUrl = (process.env.BOARD_URL || "").replace(/\/+$/, "");
  const segredo = process.env.MANDAE_WEBHOOK_SECRET;

  if (!boardUrl || !segredo) {
    console.log("\nBOARD_URL ou MANDAE_WEBHOOK_SECRET vazios no .env: a sessao ficou so nesta maquina.");
    console.log("Preencha os dois pra que o quadro passe a ler o WMS sozinho.\n");
    return;
  }

  const estado = JSON.parse(fs.readFileSync(CAMINHO_SESSAO, "utf-8"));
  console.log(`\nEntregando a sessao a ${boardUrl} ...`);

  try {
    const res = await fetch(`${boardUrl}/api/fonteslog/sessao?s=${encodeURIComponent(segredo)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(estado),
    });
    const corpo = await res.text();
    if (!res.ok) {
      console.error(`\nO quadro recusou a sessao (HTTP ${res.status}): ${corpo}`);
      console.error("A sessao continua salva aqui; da pra usar `npm run sync-fonteslog` enquanto isso.\n");
      return;
    }
    console.log("\nPronto. O quadro ja esta lendo o WMS sozinho, e vai manter essa sessao viva.");
    console.log("Voce so precisa repetir isto quando o quadro avisar que a sessao caiu.\n");
  } catch (err) {
    console.error(`\nNao consegui falar com o quadro: ${err.message}`);
    console.error("A sessao continua salva aqui; da pra usar `npm run sync-fonteslog` enquanto isso.\n");
  }
}

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

    // ---- entrega a sessao ao quadro: e o passo que tira voce do circuito ----
    await enviarAoQuadro();
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("\nDeu erro:", err.message, "\n");
  process.exit(1);
});
