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

export function verifyMandaeWebhook(req) {
  const expected = process.env.MANDAE_WEBHOOK_SECRET;
  if (!expected) return true; // sem segredo configurado ainda -- nao bloqueia em dev
  const got = req.get("X-Mandae-Secret");
  return got === expected;
}

// POST /webhooks/mandae/item-processado
export async function handleItemProcessado(req, res) {
  if (!verifyMandaeWebhook(req)) return res.status(401).json({ error: "assinatura invalida" });

  const body = req.body || {};
  const orderNumber = body.partnerItemId || body.reference || String(body.id);
  if (!orderNumber) return res.status(400).json({ error: "payload sem partnerItemId/reference" });

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
  if (!verifyMandaeWebhook(req)) return res.status(401).json({ error: "assinatura invalida" });

  const body = req.body || {};
  const orderNumber = body.idItemParceiro || body.trackingCode;
  if (!orderNumber) return res.status(400).json({ error: "payload sem idItemParceiro/trackingCode" });

  const events = Array.isArray(body.events) ? body.events : [];
  const latest = [...events].sort((a, b) => {
    const ta = new Date(a.timestamp || a.date).getTime();
    const tb = new Date(b.timestamp || b.date).getTime();
    return tb - ta;
  })[0];

  const mapped = latest ? mapMandaeEvent(latest) : { status: "amber", label: null };

  // So mandamos carrierStatus/carrierSeverity -- db.js recalcula o status
  // final do pedido combinando com o que ja soubermos do WMS (FontesLog).
  upsertOrder({
    orderNumber,
    trackingCode: body.trackingCode,
    carrierStatus: mapped.label,
    carrierSeverity: mapped.status,
    lastEventAt: latest?.timestamp || latest?.date || new Date().toISOString(),
  });

  console.log(`[webhook] rastreamento: pedido ${orderNumber} -> ${mapped.status} (${mapped.label})`);
  res.status(200).json({ ok: true });
}
