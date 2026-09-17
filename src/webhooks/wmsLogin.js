// Entrar na FontesLog PELO QUADRO, sem terminal.
//
// POR QUE ESTA TELA E ASSIM (e nao um botao que faz tudo sozinho):
//
// O login do portal exige reCAPTCHA v2, e a chave da DDS tem verificacao de
// origem LIGADA -- medido: servindo o mesmo `data-sitekey` de outro dominio, o
// widget responde "ERRO para o proprietario do site: dominio invalido para a
// chave do site". Isso mata a ideia de espelhar a tela de login dentro do
// quadro: o captcha so renderiza no dominio do proprio portal. Forcar a origem
// seria burlar a protecao anti-robo, que e exatamente o que ela existe pra
// impedir -- ver o registro no fim de integrations/fonteslog.js.
//
// Entao a pessoa loga no portal, no dominio do portal, como sempre. O que esta
// tela faz e tirar do caminho tudo o que NAO e o captcha: entrega o CNPJ e a
// senha prontos, lembra de marcar "Cliente", e recebe a sessao resultante --
// que ate ontem exigia clonar o repositorio, instalar o Playwright e rodar
// `npm run fonteslog-login` de uma maquina especifica.
//
// O cookie `ASP.NET_SessionId` e httpOnly: nenhum JavaScript da pagina o le,
// nem o nosso. Por isso o ultimo passo e colar -- nao por preguica de
// automatizar, mas porque o navegador nao deixa, e nao deve deixar.
//
// SOBRE O PIN: o quadro e publico de proposito (sem senha, pra qualquer pessoa
// do time abrir). A senha do portal nao pode herdar isso -- servida numa rota
// aberta, ela estaria publicada na internet. WMS_LOGIN_PIN fecha SO esta tela,
// sem fechar o quadro.

import fs from "node:fs";
import { CAMINHO_SESSAO, salvarSessao, conferirSessao } from "../integrations/fonteslog.js";

/**
 * Grava a sessao, confere no portal, e DESFAZ se ela nao abrir.
 *
 * Um login que deu errado nao pode derrubar um login que deu certo: sem esta
 * volta atras, um envio ruim deixaria o WMS parado ate alguem reparar.
 *
 * @param {object} estado storageState do Playwright (ou equivalente montado)
 * @returns {Promise<{ok: true} | {ok: false, error: string, detalhe?: string, anteriorRestaurada?: boolean}>}
 */
export async function aplicarSessao(estado) {
  const anterior = fs.existsSync(CAMINHO_SESSAO) ? fs.readFileSync(CAMINHO_SESSAO) : null;

  try {
    salvarSessao(estado);
  } catch (err) {
    if (err.message === "SESSAO_SEM_COOKIE_DO_PORTAL") {
      return { ok: false, error: "essa sessao nao tem cookie do portal FontesLog" };
    }
    throw err;
  }

  const teste = await conferirSessao();
  if (!teste.viva) {
    if (anterior) fs.writeFileSync(CAMINHO_SESSAO, anterior);
    else fs.rmSync(CAMINHO_SESSAO, { force: true });
    return {
      ok: false,
      error: "a sessao enviada nao abre o portal",
      detalhe: teste.motivo,
      anteriorRestaurada: !!anterior,
    };
  }

  return { ok: true };
}

/** Le na hora, sem esperar o ciclo: quem acabou de logar esta olhando o quadro. */
export function lerWmsAgora() {
  import("../lib/wms.js")
    .then(({ sincronizarWms }) => sincronizarWms({ dias: Number(process.env.BLING_DIAS || 60) }))
    .catch((err) => console.error("[wms] leitura pos-login falhou:", err.message));
}

// ---------------------------------------------------------------------------
// O PIN
// ---------------------------------------------------------------------------
//
// Contagem de erros em memoria. Nao precisa sobreviver a deploy: o objetivo e
// so impedir que alguem chute 10.000 PINs de quatro digitos numa tarde. Um
// processo que reinicia zera a contagem, e tudo bem -- reiniciar o servidor a
// cada 5 tentativas nao e ataque pratico.

const ESPERA_MS = 10 * 60 * 1000;
const MAX_ERROS = 5;
const erros = new Map(); // ip -> { contagem, ate }

function bloqueado(ip) {
  const reg = erros.get(ip);
  if (!reg) return false;
  if (Date.now() > reg.ate) {
    erros.delete(ip);
    return false;
  }
  return reg.contagem >= MAX_ERROS;
}

function anotarErro(ip) {
  const reg = erros.get(ip) || { contagem: 0, ate: 0 };
  reg.contagem += 1;
  reg.ate = Date.now() + ESPERA_MS;
  erros.set(ip, reg);
}

/**
 * Confere o PIN. Devolve null quando passou, ou o corpo do erro pra responder.
 *
 * Sem WMS_LOGIN_PIN no ambiente a tela fica FECHADA, nao aberta. Um segredo que
 * ninguem configurou nao pode virar "entra qualquer um" -- seria o contrario do
 * que a variavel existe pra fazer.
 */
function conferirPin(req) {
  const esperado = process.env.WMS_LOGIN_PIN;
  if (!esperado) {
    return { status: 503, corpo: { error: "O servidor ainda nao tem WMS_LOGIN_PIN configurado." } };
  }

  const ip = req.ip || "?";
  if (bloqueado(ip)) {
    return { status: 429, corpo: { error: "PIN errado vezes demais. Tente de novo em alguns minutos." } };
  }

  if (String(req.body?.pin || "") !== String(esperado)) {
    anotarErro(ip);
    return { status: 401, corpo: { error: "PIN incorreto." } };
  }

  erros.delete(ip);
  return null;
}

/** POST /api/fonteslog/entrar/credenciais -- o que a pessoa precisa pra logar. */
export function handleCredenciais(req, res) {
  const barrado = conferirPin(req);
  if (barrado) return res.status(barrado.status).json(barrado.corpo);

  const login = process.env.FONTESLOG_LOGIN;
  const senha = process.env.FONTESLOG_SENHA;
  if (!login || !senha) {
    return res.status(503).json({ error: "FONTESLOG_LOGIN ou FONTESLOG_SENHA faltam no servidor." });
  }

  res.json({ url: urlDoPortal(), login, senha });
}

function urlDoPortal() {
  return (process.env.FONTESLOG_URL || "http://portalfonteslog.ddsinformatica.com.br").replace(/\/+$/, "") + "/";
}

// ---------------------------------------------------------------------------
// A sessao colada
// ---------------------------------------------------------------------------

/** O dominio do portal, tirado da URL configurada -- e o que `carregarCookies` filtra. */
function dominioDoPortal() {
  try {
    return new URL(urlDoPortal()).hostname;
  } catch {
    return "portalfonteslog.ddsinformatica.com.br";
  }
}

/**
 * Aceita o que a pessoa conseguir colar, e nao um formato so.
 *
 * Dependendo de onde ela copiar, vem coisa diferente: o valor puro do DevTools
 * (hcjvwx0nhmecmlvsgge0asdq), o par solto (ASP.NET_SessionId=...), ou a linha
 * inteira do cabecalho Cookie, com ponto e virgula separando varios. Exigir um
 * formato exato aqui transformaria "colei errado" no novo motivo de nao
 * conseguir entrar -- e a tela existe justamente pra tirar obstaculo do caminho.
 */
export function extrairCookies(texto) {
  const cru = String(texto || "").trim();
  if (!cru) return [];

  const dominio = dominioDoPortal();
  const achados = new Map();

  for (const [, nome, valor] of cru.matchAll(/([A-Za-z_][\w.$-]*)\s*=\s*([^;,'"\s]+)/g)) {
    achados.set(nome, valor);
  }

  // Valor puro, sem nome nenhum: so pode ser o proprio SessionId.
  if (achados.size === 0 && /^[A-Za-z0-9]{16,64}$/.test(cru)) {
    achados.set("ASP.NET_SessionId", cru);
  }

  if (!achados.has("ASP.NET_SessionId")) return [];

  return [...achados].map(([name, value]) => ({
    name,
    value,
    domain: dominio,
    path: "/",
    expires: -1,
    httpOnly: name === "ASP.NET_SessionId",
    secure: false,
    sameSite: "Lax",
  }));
}

/**
 * POST /api/fonteslog/entrar/religar -- o caminho normal, de um clique.
 *
 * Refaz o login por HTTP com as credenciais do servidor. So falha quando o selo
 * do captcha venceu -- e ai, e so ai, alguem precisa resolver um captcha.
 */
export async function handleReligar(req, res) {
  const barrado = conferirPin(req);
  if (barrado) return res.status(barrado.status).json(barrado.corpo);

  const { religarSessao } = await import("../integrations/fonteslog.js");
  try {
    const { seloValeAte } = await religarSessao();
    res.json({ ok: true, seloValeAte });
    lerWmsAgora();
  } catch (err) {
    if (err.message === "PRECISA_DE_HUMANO") {
      return res.status(409).json({ error: "PRECISA_DE_HUMANO" });
    }
    res.status(502).json({ error: "O portal nao respondeu como esperado.", detalhe: err.message });
  }
}

/** POST /api/fonteslog/entrar/sessao -- recebe o cookie colado e liga o WMS. */
export async function handleSessaoColada(req, res) {
  const barrado = conferirPin(req);
  if (barrado) return res.status(barrado.status).json(barrado.corpo);

  const cookies = extrairCookies(req.body?.texto);
  if (!cookies.length) {
    return res.status(400).json({
      error: "Nao achei o ASP.NET_SessionId no que voce colou.",
      detalhe: "Cole o valor do cookie, ou a linha inteira do Cookie.",
    });
  }

  const resultado = await aplicarSessao({ cookies, origins: [] });
  if (!resultado.ok) return res.status(400).json(resultado);

  res.json({ ok: true, lendoAgora: true });
  lerWmsAgora();
}
