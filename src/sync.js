// Roda uma sincronizacao: le a lista de pedidos, busca o status na Mandae (e,
// quando estiver pronto, na FontesLog), calcula o status final e grava no banco.
//
// Fonte de pedidos: por enquanto le data/orders-source.json. O proximo passo e
// trocar isso por uma consulta direta a API do Shopify (precisa de um token de
// app privado do Shopify -- Configuracoes > Apps > Desenvolver apps, na loja).
// Ate la, atualize esse JSON manualmente ou plugue outra fonte em getOrderList().

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTracking, latestEvent } from "./integrations/mandae.js";
import { mapMandaeEvent, combineStatus } from "./lib/statusMapping.js";
import { upsertOrder, setMeta } from "./lib/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getOrderList() {
  const sourcePath = path.join(__dirname, "..", "data", "orders-source.json");
  if (!fs.existsSync(sourcePath)) return [];
  return JSON.parse(fs.readFileSync(sourcePath, "utf-8"));
}

async function syncOneOrder(order) {
  let carrierStatus = null;
  let carrierLabel = null;
  let lastEventAt = order.placedAt || null;

  if (order.trackingCode) {
    try {
      const tracking = await fetchTracking(order.trackingCode);
      const event = latestEvent(tracking);
      if (event) {
        const mapped = mapMandaeEvent(event);
        carrierStatus = mapped.status;
        carrierLabel = mapped.label;
        lastEventAt = event.timestamp || event.date || lastEventAt;
      }
    } catch (err) {
      console.error(`[mandae] falha ao consultar ${order.trackingCode}:`, err.message);
    }
  }

  // WMS (FontesLog) ainda nao implementado -- ver src/integrations/fonteslog.js.
  const wmsStatus = null;
  const wmsLabel = null;

  const finalStatus = combineStatus(wmsStatus, carrierStatus);

  upsertOrder({
    orderNumber: order.orderNumber,
    brand: order.brand,
    customer: order.customer,
    status: finalStatus,
    wmsStatus: wmsLabel,
    carrierStatus: carrierLabel,
    trackingCode: order.trackingCode,
    city: order.city,
    placedAt: order.placedAt,
    lastEventAt,
  });
}

export async function runSync() {
  const orders = getOrderList();
  console.log(`[sync] iniciando sincronizacao de ${orders.length} pedido(s)...`);
  for (const order of orders) {
    if (!order.orderNumber) continue;
    await syncOneOrder(order);
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
