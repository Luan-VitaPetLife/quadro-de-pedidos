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
import { fetchTracking, latestEvent, coletaPrevista } from "./integrations/mandae.js";
import { mapMandaeEvent } from "./lib/statusMapping.js";
import { upsertOrder, listOrders, setMeta } from "./lib/db.js";

async function reconcileOneOrder(order) {
  if (!order.trackingCode) return;

  // So consulta a Mandae para rastreios DELA. A operacao usa varias
  // transportadoras -- Mercado Envios manda "MEL479...", Shopee manda
  // "PPNGG6JL...", e perguntar por esses codigos so gera 404 e gasta chamada.
  // O prefixo vem do painel da Mandae (Configuracoes -> API -> Prefixo
  // Rastreamento) e e configuravel porque um dia pode mudar.
  const prefixo = process.env.MANDAE_PREFIXO_RASTREIO || "VITPT";
  if (!String(order.trackingCode).toUpperCase().startsWith(prefixo.toUpperCase())) return;

  try {
    const tracking = await fetchTracking(order.trackingCode);
    const event = latestEvent(tracking);
    if (!event) return;

    const mapped = mapMandaeEvent(event);
    // Coleta agendada: a Mandae a devolve disfarcada de evento com data futura.
    const agendada = coletaPrevista(tracking);
    const lastEventAt = event.timestamp || event.date || order.lastEventAt;

    // Nada novo desde o ultimo evento que ja temos -- evita grava-lo de novo
    // e "empurrar" updatedAt sem necessidade.
    //
    // A coleta prevista entra na comparacao de proposito. Ela nao vem de um
    // evento novo: e a mesma resposta da Mandae lida de outro jeito. Sem isto,
    // a guarda barrava a gravacao e o campo nunca era preenchido nos pedidos
    // que ja estavam no quadro -- que sao justamente os que precisavam dele.
    const mudou =
      lastEventAt !== order.lastEventAt ||
      mapped.status !== order.carrierSeverity ||
      (agendada || null) !== (order.coletaPrevista || null);
    if (!mudou) return;

    upsertOrder({
      orderNumber: order.orderNumber,
      trackingCode: order.trackingCode,
      carrierStatus: mapped.label,
      carrierSeverity: mapped.status,
      coletaPrevista: agendada,
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
