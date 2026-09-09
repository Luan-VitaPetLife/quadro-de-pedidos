// Rotas do fluxo OAuth do Bling.
//
// Ficam no quadro (Railway) e nao na maquina local porque o "Link de
// redirecionamento" cadastrado no app do Bling e publico:
// https://quadro.vitapetlife.com/bling/callback
//
// Diferente da FontesLog, o Bling nao tem captcha -- entao, uma vez
// autorizado, o proprio quadro consulta a API sozinho, sem ninguem por perto.

import crypto from "node:crypto";
import { urlDeAutorizacao, trocarCodePorToken, lerTokens } from "../integrations/bling.js";
import { verifyMandaeWebhook } from "./mandae.js";

// O `state` amarra o retorno do Bling ao pedido de autorizacao que NOS
// fizemos. Sem ele, qualquer pessoa poderia chamar /bling/callback com um code
// proprio e trocar os tokens do quadro pelos da conta dela.
const statesPendentes = new Map();
const VALIDADE_STATE_MS = 10 * 60 * 1000;

function limparStatesVelhos() {
  const agora = Date.now();
  for (const [s, quando] of statesPendentes) {
    if (agora - quando > VALIDADE_STATE_MS) statesPendentes.delete(s);
  }
}

// GET /bling/autorizar?s=<segredo>
// Protegido pelo mesmo segredo dos webhooks: o quadro e publico, e sem isso
// qualquer visitante poderia disparar (ou refazer) a autorizacao.
export function handleAutorizar(req, res) {
  if (!verifyMandaeWebhook(req)) {
    return res.status(401).send("Acesse com ?s=<MANDAE_WEBHOOK_SECRET> no final da URL.");
  }
  limparStatesVelhos();
  const state = crypto.randomBytes(16).toString("hex");
  statesPendentes.set(state, Date.now());
  res.redirect(urlDeAutorizacao(state));
}

// GET /bling/callback?code=...&state=...
export async function handleCallback(req, res) {
  const { code, state } = req.query;

  if (!state || !statesPendentes.has(state)) {
    return res
      .status(400)
      .send("Autorizacao invalida ou expirada (state nao confere). Comece de novo por /bling/autorizar?s=SEGREDO");
  }
  statesPendentes.delete(state);

  if (!code) {
    return res.status(400).send("O Bling nao devolveu o parametro `code`.");
  }

  try {
    // Lembrete: o `code` vale 1 minuto. Se der invalid_grant aqui, quase
    // sempre e porque a tela ficou aberta tempo demais antes de autorizar.
    const tokens = await trocarCodePorToken(String(code));
    console.log(`[bling] autorizado. Token renova em ${new Date(tokens.expiraEm).toISOString()}`);
    res.send(
      "<h2>Bling autorizado</h2>" +
        "<p>Pode fechar esta aba. O quadro ja consegue ler os pedidos.</p>" +
        `<p style="color:#666;font-size:13px">Token de acesso valido ate ${new Date(tokens.expiraEm).toLocaleString("pt-BR")}; a renovacao e automatica.</p>`
    );
  } catch (err) {
    console.error("[bling] falha ao trocar o code por token:", err.message);
    res.status(502).send(`<h2>Nao consegui concluir</h2><pre>${err.message}</pre>`);
  }
}

// GET /bling/status?s=<segredo> -- diagnostico rapido
export function handleStatus(req, res) {
  if (!verifyMandaeWebhook(req)) return res.status(401).json({ error: "segredo invalido" });
  const t = lerTokens();
  if (!t) return res.json({ autorizado: false, comoResolver: "abra /bling/autorizar?s=SEGREDO" });
  res.json({
    autorizado: true,
    obtidoEm: t.obtidoEm,
    accessTokenValidoAte: new Date(t.expiraEm).toISOString(),
    accessTokenExpirado: Date.now() >= t.expiraEm,
  });
}
