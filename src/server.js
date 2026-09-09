import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listOrders, getMeta, dataDir, dataDirSource } from "./lib/db.js";
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
  if (process.env.RAILWAY_ENVIRONMENT && dataDirSource === "padrao-local") {
    console.warn(
      `[config] Rodando no Railway com o banco em ${dataDir}, que NAO e um Volume -- ` +
        "esse disco e efemero e o historico VAI SUMIR no proximo deploy. " +
        "Anexe um Volume ao servico (ou defina DATA_DIR apontando pro mount path dele)."
    );
  } else if (process.env.RAILWAY_ENVIRONMENT) {
    console.log(`[config] banco no Volume (${dataDirSource}): ${dataDir}`);
  }
}

const port = Number(process.env.PORT) || 3000;

// HOST 0.0.0.0 e obrigatorio em container. Sem o segundo argumento, o Node
// escuta em "::" -- e se o proxy do Railway tentar alcancar o container por
// IPv4, a conexao morre e a borda devolve 502 "Application failed to respond",
// mesmo com o processo vivo e saudavel (que foi exatamente o que aconteceu).
const host = process.env.HOST || "0.0.0.0";

app.listen(port, host, () => {
  console.log(`[server] Radar de pedidos escutando em http://${host}:${port}`);
  // Deixa explicito de onde veio a porta: se PORT nao existir no ambiente, o
  // proxy do Railway quase certamente esta mirando outra porta -- e essa e a
  // primeira coisa a conferir num 502.
  console.log(
    process.env.PORT
      ? `[server] porta veio da variavel PORT (${process.env.PORT}).`
      : "[server] ATENCAO: variavel PORT ausente -- usando 3000 como padrao. " +
          "No Railway, confira em Settings -> Networking se a porta alvo do dominio e 3000."
  );
  checarConfiguracao();
  startScheduler();
});
