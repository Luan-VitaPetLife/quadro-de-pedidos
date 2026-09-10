// Handlers dos webhooks da Mandae. Configurados no painel da Mandae em
// Configuracoes da conta -> API -> Webhooks (mesma tela do token).
//
// "Item processado": dispara quando a Mandae expede a encomenda -- e a
// nossa porta de entrada pra saber que um pedido novo existe, sem precisar
// consultar Shopify nem nenhum outro sistema.
// "Rastreamento": dispara a cada novo evento de rastreio de um pedido ja
// conhecido -- e o que mantem o status (verde/amarelo/vermelho) atualizado
// em tempo real.

import { upsertOrder } from "../lib/db.js";
import { mapMandaeEvent } from "../lib/statusMapping.js";
import { coletaPrevista } from "../integrations/mandae.js";

/**
 * Pega o primeiro candidato que seja um identificador de verdade.
 *
 * Cuidado que motivou essa funcao: `a || b || String(c)` com os tres campos
 * vazios produz a STRING "undefined", que e truthy -- a guarda `if (!id)`
 * passava batido e o quadro ganhava um quadrado chamado "undefined".
 */
function primeiroIdentificador(...candidatos) {
  for (const c of candidatos) {
    if (c === null || c === undefined) continue;
    const s = String(c).trim();
    if (s && s !== "undefined" && s !== "null") return s;
  }
  return null;
}

/**
 * Confere se a chamada e mesmo da Mandae.
 *
 * Aceita o segredo por DOIS caminhos, de proposito:
 *
 *   1. header "X-Mandae-Secret" -- o jeito preferido, e o que o painel da
 *      Mandae oferece para o webhook de RASTREAMENTO.
 *   2. query string "?s=<segredo>" na propria URL -- necessario porque o painel
 *      da Mandae NAO tem campos de header para o webhook de ITEM PROCESSADO:
 *      so da pra cadastrar a URL. Como a URL e livre, o segredo viaja nela.
 *
 * Sem o caminho 2, o item-processado seria recusado com 401 e nenhum pedido
 * chegaria a ser criado -- o quadro ficaria permanentemente vazio.
 */
export function verifyMandaeWebhook(req) {
  const expected = process.env.MANDAE_WEBHOOK_SECRET;
  if (!expected) return true; // sem segredo configurado ainda -- nao bloqueia em dev
  const doHeader = req.get("X-Mandae-Secret");
  const daUrl = req.query?.s;
  return doHeader === expected || daUrl === expected;
}

/**
 * Loga uma chamada recusada por segredo invalido.
 *
 * Por que isso importa: sem esse log, "a Mandae chamou e foi rejeitada" e
 * "a Mandae nunca chamou" produzem exatamente o mesmo sintoma -- quadro vazio
 * e log em branco. Registrando a recusa, o log distingue os dois casos na hora.
 *
 * Mostra os NOMES dos headers recebidos (nunca os valores) porque a causa mais
 * provavel de recusa e o painel da Mandae mandar o segredo com outro nome de
 * header: aqui da pra ver qual nome chegou e corrigir a configuracao.
 */
function logarRecusa(req, rota) {
  const nomes = Object.keys(req.headers || {}).filter(
    (h) => !["host", "connection", "content-length", "accept", "accept-encoding", "user-agent"].includes(h)
  );
  const temHeader = req.get("X-Mandae-Secret") !== undefined;
  const temQuery = req.query?.s !== undefined;
  let motivo;
  if (temHeader) {
    motivo = "o header X-Mandae-Secret veio, mas com valor diferente do MANDAE_WEBHOOK_SECRET configurado.";
  } else if (temQuery) {
    motivo = "veio ?s= na URL, mas com valor diferente do MANDAE_WEBHOOK_SECRET configurado.";
  } else {
    motivo =
      "nao veio nem o header X-Mandae-Secret nem ?s= na URL. Se for o webhook de item-processado, " +
      "cadastre a URL com ?s=<MANDAE_WEBHOOK_SECRET> no final -- o painel da Mandae nao tem campo de header pra ele.";
  }
  console.warn(`[webhook] ${rota} RECUSADO (401): ${motivo} Headers recebidos: ${nomes.join(", ")}`);
}

/**
 * Registra que a chamada foi aceita e quais campos vieram no corpo. Serve pra
 * conferir, no primeiro webhook real, se os nomes de campo que o codigo procura
 * (partnerItemId, idItemParceiro, events...) batem com os que a Mandae manda de
 * verdade -- foram tirados da documentacao, nunca de uma chamada real.
 */
function logarAceite(rota, body) {
  console.log(`[webhook] ${rota} aceito. Campos no corpo: ${Object.keys(body || {}).join(", ") || "(vazio)"}`);
}

// POST /webhooks/mandae/item-processado
export async function handleItemProcessado(req, res) {
  if (!verifyMandaeWebhook(req)) {
    logarRecusa(req, "item-processado");
    return res.status(401).json({ error: "assinatura invalida" });
  }

  const body = req.body || {};
  logarAceite("item-processado", body);
  const orderNumber = primeiroIdentificador(body.partnerItemId, body.reference, body.id);
  if (!orderNumber) {
    console.warn("[webhook] item processado ignorado -- payload sem identificador:", JSON.stringify(body).slice(0, 500));
    return res.status(400).json({ error: "payload sem partnerItemId/reference/id" });
  }

  // Acabou de ser expedido -- ainda sem evento de rastreio, entao tratamos
  // como aviso (amber) ate o primeiro evento de rastreamento chegar.
  upsertOrder({
    orderNumber,
    trackingCode: body.trackingCode,
    carrierStatus: "Encomenda expedida pela Mandaê",
    carrierSeverity: "amber",
    lastEventAt: new Date().toISOString(),
  });

  console.log(`[webhook] item processado: pedido ${orderNumber} / rastreio ${body.trackingCode}`);
  res.status(200).json({ ok: true });
}

// POST /webhooks/mandae/rastreamento
export async function handleRastreamento(req, res) {
  if (!verifyMandaeWebhook(req)) {
    logarRecusa(req, "rastreamento");
    return res.status(401).json({ error: "assinatura invalida" });
  }

  const body = req.body || {};
  logarAceite("rastreamento", body);
  const orderNumber = primeiroIdentificador(body.idItemParceiro, body.trackingCode);
  if (!orderNumber) {
    console.warn("[webhook] rastreamento ignorado -- payload sem identificador:", JSON.stringify(body).slice(0, 500));
    return res.status(400).json({ error: "payload sem idItemParceiro/trackingCode" });
  }

  const events = Array.isArray(body.events) ? body.events : [];
  const latest = [...events].sort((a, b) => {
    const ta = new Date(a.timestamp || a.date).getTime();
    const tb = new Date(b.timestamp || b.date).getTime();
    return tb - ta;
  })[0];

  const mapped = latest ? mapMandaeEvent(latest) : { status: "amber", label: null };
  // Coleta agendada vem disfarcada de evento: data futura e "name" nulo.
  const agendada = coletaPrevista(body);

  // So mandamos carrierStatus/carrierSeverity -- db.js recalcula o status
  // final do pedido combinando com o que ja soubermos do WMS (FontesLog).
  upsertOrder({
    orderNumber,
    trackingCode: body.trackingCode,
    carrierStatus: mapped.label,
    carrierSeverity: mapped.status,
    coletaPrevista: agendada,
    lastEventAt: latest?.timestamp || latest?.date || new Date().toISOString(),
  });

  console.log(`[webhook] rastreamento: pedido ${orderNumber} -> ${mapped.status} (${mapped.label})`);
  res.status(200).json({ ok: true });
}
