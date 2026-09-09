import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listOrders, getMeta } from "./lib/db.js";
import { startScheduler } from "./scheduler.js";
import { runSync } from "./sync.js";
import { handleItemProcessado, handleRastreamento } from "./webhooks/mandae.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/orders", (req, res) => {
  res.json({ orders: listOrders() });
});

app.get("/api/meta", (req, res) => {
  res.json({ lastSyncAt: getMeta("lastSyncAt") });
});

// Botao "Sincronizar agora" do quadro -- forca a reconciliacao de reforco
// (mesma logica do agendador de 2h) na hora, sem esperar o ciclo. Util pra
// testes e pra conferir a Mandae depois de mexer em algum pedido.
let syncInFlight = false;
app.post("/api/sync", async (req, res) => {
  if (syncInFlight) {
    return res.status(409).json({ error: "ja existe uma sincronizacao em andamento" });
  }
  syncInFlight = true;
  try {
    await runSync();
    res.json({ ok: true, lastSyncAt: getMeta("lastSyncAt") });
  } catch (err) {
    console.error("[api/sync] falha:", err);
    res.status(500).json({ error: "falha ao sincronizar", detail: err.message });
  } finally {
    syncInFlight = false;
  }
});

// Configurar em: painel da Mandaê -> Configurações da conta -> API -> Webhooks.
// URL pública (depois do deploy no Railway) + header customizado
// "X-Mandae-Secret" com o valor de MANDAE_WEBHOOK_SECRET.
app.post("/webhooks/mandae/item-processado", handleItemProcessado);
app.post("/webhooks/mandae/rastreamento", handleRastreamento);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[server] Radar de pedidos rodando em http://localhost:${port}`);
  startScheduler();
});
