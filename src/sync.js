// Sincronizacao periodica (rede de seguranca).
//
// A porta de entrada principal dos pedidos agora sao os WEBHOOKS da Mandae
// (ver src/webhooks/mandae.js): "item processado" cria o pedido assim que a
// Mandae expede a encomenda, e "rastreamento" atualiza o status a cada novo
// evento, em tempo real -- sem depender de Shopify nem de nenhuma lista
// manual de pedidos.
//
// Essa sincronizacao (rodada a cada SYNC_INTERVAL_MINUTES pelo scheduler)
// serve só de reforço: re-consulta na API da Mandae o rastreio de cada
// pedido que já conhecemos (via listOrders()), caso algum webhook tenha
// falhado ou se perdido. Quando a integração com a FontesLog estiver pronta
// (ver src/integrations/fonteslog.js), ela entra aqui também.

import "dotenv/config";
import { fetchTracking, latestEvent } from "./integrations/mandae.js";
import { mapMandaeEvent } from "./lib/statusMapping.js";
import { upsertOrder, listOrders, setMeta } from "./lib/db.js";

async function reconcileOneOrder(order) {
  if (!order.trackingCode) return;

  try {
    const tracking = await fetchTracking(order.trackingCode);
    const event = latestEvent(tracking);
    if (!event) return;

    const mapped = mapMandaeEvent(event);
    const lastEventAt = event.timestamp || event.date || order.lastEventAt;

    // Nada novo desde o ultimo evento que ja temos -- evita grava-lo de novo
    // e "empurrar" updatedAt sem necessidade.
    if (lastEventAt === order.lastEventAt && mapped.status === order.carrierSeverity) return;

    upsertOrder({
      orderNumber: order.orderNumber,
      trackingCode: order.trackingCode,
      carrierStatus: mapped.label,
      carrierSeverity: mapped.status,
      lastEventAt,
    });
  } catch (err) {
    console.error(`[sync] falha ao reconciliar ${order.orderNumber} (${order.trackingCode}):`, err.message);
  }
}

export async function runSync() {
  const orders = listOrders();
  console.log(`[sync] reconciliando ${orders.length} pedido(s) conhecido(s) com a Mandaê...`);
  for (const order of orders) {
    await reconcileOneOrder(order);
  }
  setMeta("lastSyncAt", new Date().toISOString());
  console.log("[sync] concluido.");
}

// Permite rodar `node src/sync.js` direto, alem de ser chamado pelo scheduler.
if (import.meta.url === `file://${process.argv[1]}`) {
  runSync().catch((err) => {
    console.error("[sync] erro fatal:", err);
    process.exit(1);
  });
}
