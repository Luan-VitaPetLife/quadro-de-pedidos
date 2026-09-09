import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listOrders, getMeta, dataDir, dataDirSource, db } from "./lib/db.js";
import { startScheduler } from "./scheduler.js";
import { runSync } from "./sync.js";
import { handleItemProcessado, handleRastreamento } from "./webhooks/mandae.js";
import { handleFontesLog } from "./webhooks/fonteslog.js";

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

// Recebe o que o script local leu do WMS da FontesLog (ver src/sync-fonteslog.js).
app.post("/webhooks/fonteslog", handleFontesLog);

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

let tarefaAgendada = null;

const servidor = app.listen(port, host, () => {
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
  tarefaAgendada = startScheduler();
});

// ---------------------------------------------------------------------------
// Encerramento gracioso
// ---------------------------------------------------------------------------
//
// Por que isso existe: a cada deploy, o Railway manda SIGTERM pro container
// antigo. Sem tratador, o Node morre com codigo 143 (128 + 15) -- e o Railway
// le qualquer saida diferente de zero como CRASH, disparando alerta por email.
// O resultado era um email de "producao quebrou" em todo deploy bem-sucedido:
// alarme falso puro, e do pior tipo, porque ensina a ignorar o alerta.
//
// Tratando o sinal, o processo fecha o que precisa e sai com 0 -- que o
// Railway entende como "encerrou porque mandei encerrar".

let encerrando = false;

function encerrar(sinal) {
  if (encerrando) return; // dois sinais seguidos nao viram dois desligamentos
  encerrando = true;
  console.log(`[server] recebi ${sinal}, encerrando com calma...`);

  // Prazo maximo. Se algo travar (conexao pendurada, escrita longa), e melhor
  // sair a forca do que o orquestrador nos matar -- morte por timeout volta a
  // contar como crash, que e justamente o que estamos evitando.
  const prazo = setTimeout(() => {
    console.warn("[server] demorou demais pra fechar; saindo assim mesmo.");
    process.exit(0);
  }, 10000);
  prazo.unref();

  try {
    tarefaAgendada?.stop();
  } catch (err) {
    console.error("[server] falha ao parar o agendador:", err.message);
  }

  servidor.close(() => {
    try {
      db.close(); // fecha o SQLite: garante que nada fique escrito pela metade
    } catch (err) {
      console.error("[server] falha ao fechar o banco:", err.message);
    }
    console.log("[server] encerrado normalmente.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => encerrar("SIGTERM")); // deploy/parada no Railway
process.on("SIGINT", () => encerrar("SIGINT")); // Ctrl+C no terminal

// Um erro solto derrubava o processo sem deixar rastro no log -- e a proxima
// pessoa a investigar so via o container reiniciando. Agora ao menos fica
// escrito o que aconteceu antes de sair.
process.on("unhandledRejection", (motivo) => {
  console.error("[server] promessa rejeitada sem tratamento:", motivo);
});
process.on("uncaughtException", (err) => {
  console.error("[server] excecao nao tratada:", err);
  process.exit(1); // aqui a saida e 1 de proposito: isso E uma falha de verdade
});
