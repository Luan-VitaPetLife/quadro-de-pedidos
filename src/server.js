import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listOrders, getMeta } from "./lib/db.js";
import { startScheduler } from "./scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/orders", (req, res) => {
  res.json({ orders: listOrders() });
});

app.get("/api/meta", (req, res) => {
  res.json({ lastSyncAt: getMeta("lastSyncAt") });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[server] Radar de pedidos rodando em http://localhost:${port}`);
  startScheduler();
});
