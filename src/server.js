import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listOrders, getMeta } from "./lib/db.js";
import { startScheduler } from "./scheduler.js";
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
