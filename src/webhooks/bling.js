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
    // Distinguir "faltou" de "esta errado" evita a volta inteira ao suporte.
    // O engano mais comum e colar a URL de exemplo com a palavra SEGREDO no
    // lugar do valor -- entao esse caso ganha aviso proprio.
    const informado = req.query?.s;
    let motivo;
    if (!informado) {
      motivo = "Faltou o ?s= no final da URL.";
    } else if (/^(SEGREDO|SEU_SEGREDO|MANDAE_WEBHOOK_SECRET|<.*>)$/i.test(String(informado))) {
      motivo =
        "Voce colou a palavra de exemplo em vez do valor. Substitua por aquilo que esta " +
        "em MANDAE_WEBHOOK_SECRET (o mesmo valor que voce configurou no painel da Mandae).";
    } else {
      motivo = "O valor do ?s= nao confere com o MANDAE_WEBHOOK_SECRET configurado no servidor.";
    }
    return res
      .status(401)
      .send(`<h2>Nao autorizado</h2><p>${motivo}</p><p style="color:#666;font-size:13px">Formato: /bling/autorizar?s=VALOR_DO_SEGREDO</p>`);
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
      .send("Autorizacao invalida ou expirada (state nao confere). Comece de novo por /bling/autorizar?s= seguido do valor do segredo.");
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
  if (!t) return res.json({ autorizado: false, comoResolver: "abra /bling/autorizar?s= seguido do valor de MANDAE_WEBHOOK_SECRET" });
  res.json({
    autorizado: true,
    obtidoEm: t.obtidoEm,
    accessTokenValidoAte: new Date(t.expiraEm).toISOString(),
    accessTokenExpirado: Date.now() >= t.expiraEm,
  });
}

// GET /bling/diagnostico?s=<segredo>
//
// Existe pra responder UMA pergunta que so o dado real responde: o Bling
// guarda o codigo de rastreio dos pedidos que saem pela Mandae? A forma exata
// da resposta nao esta na documentacao que da pra ler de fora, entao esta rota
// devolve a estrutura crua de um pedido e o resultado da extracao em varios,
// pra conferir campo a campo em vez de adivinhar.
export async function handleDiagnostico(req, res) {
  if (!verifyMandaeWebhook(req)) return res.status(401).json({ error: "segredo invalido" });

  try {
    const { listarPedidos, detalhePedido, extrairDoPedido } = await import("../integrations/bling.js");

    const hoje = new Date();
    const inicio = new Date(hoje.getTime() - 30 * 86400000);
    const lista = await listarPedidos({ dataDe: inicio, dataAte: hoje, maxPaginas: 1 });

    if (lista.length === 0) {
      return res.json({ pedidosNoPeriodo: 0, aviso: "Nenhum pedido nos ultimos 30 dias." });
    }

    // Detalhe de alguns: o rastreio costuma existir so no detalhe, nao na lista.
    // Mapa numero x numeroLoja x rastreio. E o que revela QUAL dos dois numeros
    // o WMS usa como "Numero Pedido" -- coisa que nao da pra deduzir, so
    // comparando com os numeros que ja estao no quadro.
    const mapa = [];
    for (const p of lista.slice(0, 10)) {
      const det = await detalhePedido(p.id);
      mapa.push({
        numero: det?.numero ?? null,
        numeroLoja: det?.numeroLoja ?? null,
        loja: det?.loja?.id ?? null,
        transportadora: det?.transporte?.contato?.nome ?? null,
        rastreio: (det?.transporte?.volumes || []).map((v) => v?.codigoRastreamento).find(Boolean) || null,
        extraido: extrairDoPedido(det),
      });
    }



    res.json({
      pedidosNoPeriodo: lista.length,
      camposDaLista: Object.keys(lista[0] || {}),
      quantosComRastreio: mapa.filter((m) => m.rastreio).length,
      mapa,
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// POST /bling/sincronizar?s=<segredo>
//
// Dispara a leitura do Bling na hora. A sincronizacao pode demorar (uma
// chamada por pedido, com intervalo pra respeitar o limite do Bling), entao
// responde na hora e segue trabalhando em segundo plano -- se esperasse, o
// proxy do Railway cortaria a conexao antes do fim.
let sincronizacaoEmCurso = false;

export async function handleSincronizar(req, res) {
  if (!verifyMandaeWebhook(req)) return res.status(401).json({ error: "segredo invalido" });
  if (sincronizacaoEmCurso) {
    return res.status(409).json({ error: "ja existe uma sincronizacao do Bling em andamento" });
  }

  const dias = Number(req.query?.dias) || 30;
  sincronizacaoEmCurso = true;
  res.json({ ok: true, iniciada: true, dias, acompanhe: "veja os logs do Railway ou /bling/status" });

  try {
    const { runSyncBling } = await import("../sync-bling.js");
    await runSyncBling({ dias });
  } catch (err) {
    console.error("[bling] sincronizacao falhou:", err.message);
  } finally {
    sincronizacaoEmCurso = false;
  }
}

// POST /bling/limpar?s=<segredo>
//
// Remove os pedidos que nao tem status de nenhuma das duas fontes. A limpeza
// tambem acontece no fim de cada sincronizacao, mas ali ela depende do ciclo
// inteiro terminar -- que leva minutos e pode ser interrompido por um deploy.
// Esta rota faz so a limpeza, na hora, e responde quantos saiu.
export async function handleLimpar(req, res) {
  if (!verifyMandaeWebhook(req)) return res.status(401).json({ error: "segredo invalido" });
  try {
    const { limparPedidosSemStatus } = await import("../sync-bling.js");
    const removidos = limparPedidosSemStatus();
    console.log(`[bling] limpeza manual: ${removidos} pedido(s) sem status removido(s).`);
    res.json({ ok: true, removidos });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}
