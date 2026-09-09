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

// O quadro esta publico de proposito (decisao de operacao: sem senha, pra
// qualquer pessoa do time abrir direto). Isso NAO significa que ele deva
// aparecer no Google -- o noindex evita que buscadores indexem a URL e os
// dados de pedido junto com ela. Tirar daqui se um dia quiser o oposto.
app.use((req, res, next) => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  next();
});
app.get("/robots.txt", (req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));

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

/**
 * Confere na subida o que so daria erro (ou pior: silencio) muito depois.
 * Roda uma vez, escreve no log do Railway e nao derruba o processo.
 */
function checarConfiguracao() {
  if (!process.env.MANDAE_TOKEN) {
    console.warn("[config] MANDAE_TOKEN vazio -- a sincronizacao de reforco vai falhar em todo pedido.");
  }
  if (!process.env.MANDAE_WEBHOOK_SECRET) {
    console.warn(
      "[config] MANDAE_WEBHOOK_SECRET vazio -- os webhooks estao ACEITANDO QUALQUER CHAMADA. " +
        "Qualquer pessoa que descubra a URL consegue inventar pedidos no quadro. Defina a variavel."
    );
  }
  if (!process.env.DATA_DIR && process.env.RAILWAY_ENVIRONMENT) {
    console.warn(
      "[config] Rodando no Railway sem DATA_DIR -- o banco esta no disco efemero e VAI SUMIR no proximo deploy. " +
        "Crie um Volume e aponte DATA_DIR para o mount path dele."
    );
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[server] Radar de pedidos rodando na porta ${port}`);
  checarConfiguracao();
  startScheduler();
});
