import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listOrders, getMeta, dataDir, dataDirSource, db, ocultarPedido, reexibirPedido } from "./lib/db.js";
import { startScheduler } from "./scheduler.js";
import { runSync } from "./sync.js";
import { handleItemProcessado, handleRastreamento } from "./webhooks/mandae.js";
import { handleFontesLog } from "./webhooks/fonteslog.js";
import { handleEventoBling } from "./webhooks/blingEventos.js";
import { handleInvestigar } from "./webhooks/investigar.js";
import { handlePenteFino } from "./webhooks/penteFino.js";
import { anotarSaida, registrarBoot, lerDiario } from "./lib/diarioDeSaida.js";
import { handleAutorizar, handleCallback, handleStatus, handleDiagnostico, handleSincronizar, handleLimpar, handleSonda } from "./webhooks/bling.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// O corpo CRU fica guardado junto do parseado.
//
// O webhook do Bling assina o corpo com HMAC-SHA256, e assinatura se confere
// sobre os bytes exatos que chegaram -- reserializar o objeto com
// JSON.stringify daria outra string (ordem de chaves, espacos, escapes) e a
// conferencia falharia em pedidos legitimos. Sem guardar aqui, o corpo cru nao
// existe mais quando a rota roda.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.corpoCru = buf;
    },
  })
);

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
  // O quadro nunca ve os ocultos; `?ocultos=1` e a gaveta pra revisar e trazer
  // de volta.
  const todos = listOrders();
  // Duas saidas diferentes do quadro, e so uma delas e revisavel: quem foi
  // resolvido a mao aparece na gaveta; venda cancelada no Bling simplesmente
  // nao e mais assunto.
  const resolvidos = todos.filter((o) => o.oculto && !o.foraDoQuadro);
  res.json({
    orders: req.query?.ocultos === "1"
      ? resolvidos
      : todos.filter((o) => !o.oculto && !o.foraDoQuadro),
    ocultos: resolvidos.length,
  });
});

// ---------------------------------------------------------------------------
// Ocultar e trazer de volta
// ---------------------------------------------------------------------------
//
// Quem decide aqui e a pessoa, nao o sistema: extravio que ja virou pedido
// novo, venda abandonada no ERP, qualquer quadrado que ficaria vermelho pra
// sempre sem nada a fazer. Nada e apagado -- o registro continua no banco,
// continua sendo atualizado pelas sincronizacoes, e volta ao quadro na hora em
// que alguem pedir.
//
// PIN opcional: com QUADRO_PIN definido, ocultar e reexibir passam a exigi-lo.
// Sem a variavel, funciona aberto -- do mesmo jeito que o quadro inteiro, que
// esta no ar sem senha por decisao sua.
function pinOk(req) {
  const esperado = process.env.QUADRO_PIN;
  if (!esperado) return true;
  return String(req.get("X-Quadro-Pin") || req.query?.pin || "") === esperado;
}

app.post("/api/ocultar", express.json(), (req, res) => {
  if (!pinOk(req)) return res.status(401).json({ error: "pin invalido" });
  const numero = String(req.body?.orderNumber || "").trim();
  if (!numero) return res.status(400).json({ error: "informe orderNumber" });
  const o = ocultarPedido(numero, req.body?.motivo);
  if (!o) return res.status(404).json({ error: "pedido nao encontrado" });
  console.log(`[quadro] pedido ${numero} ocultado${req.body?.motivo ? ` (${req.body.motivo})` : ""}.`);
  res.json({ ok: true, pedido: o });
});

app.post("/api/reexibir", express.json(), (req, res) => {
  if (!pinOk(req)) return res.status(401).json({ error: "pin invalido" });
  const numero = String(req.body?.orderNumber || "").trim();
  if (!numero) return res.status(400).json({ error: "informe orderNumber" });
  const o = reexibirPedido(numero);
  if (!o) return res.status(404).json({ error: "pedido nao encontrado" });
  console.log(`[quadro] pedido ${numero} trazido de volta ao quadro.`);
  res.json({ ok: true, pedido: o });
});

app.get("/api/pin-exigido", (req, res) => res.json({ exigido: !!process.env.QUADRO_PIN }));

// POST /api/reconstruir?s=<segredo>&confirmar=APAGAR-E-RELER&dias=30
//
// Apaga o quadro e le tudo de novo. Existe como rota porque o banco de verdade
// mora num volume do Railway, fora do alcance de quem roda o script na propria
// maquina.
//
// Exige a palavra por extenso alem do segredo: o segredo ja abre todas as
// outras rotas, e esta e a unica que apaga. Uma URL a mais no historico do
// navegador nao deveria poder zerar o quadro.
let reconstrucaoEmCurso = false;
app.post("/api/reconstruir", async (req, res) => {
  const esperado = process.env.MANDAE_WEBHOOK_SECRET;
  if (esperado && req.query?.s !== esperado) return res.status(401).json({ error: "segredo invalido" });
  if (req.query?.confirmar !== "APAGAR-E-RELER") {
    return res.status(400).json({ error: "faltou confirmar=APAGAR-E-RELER" });
  }
  if (reconstrucaoEmCurso) return res.status(409).json({ error: "ja existe uma reconstrucao em andamento" });

  const dias = Number(req.query?.dias) || 60;
  reconstrucaoEmCurso = true;
  res.json({ ok: true, iniciada: true, dias, acompanhe: "/bling/status" });

  const { setMeta } = await import("./lib/db.js");
  setMeta("reconstrucaoComecouEm", new Date().toISOString());
  setMeta("reconstrucaoErro", "");
  try {
    const { reconstruirQuadro } = await import("./lib/reconstrucao.js");
    const { comTravaDeSincronizacao } = await import("./lib/travaDeSincronizacao.js");
    // Pela mesma trava da sincronizacao: reconstruir enquanto um ciclo grava
    // seria apagar debaixo dos pes de quem esta escrevendo.
    const { rodou, resultado } = await comTravaDeSincronizacao(() =>
      reconstruirQuadro({ dias, aoAndar: (t) => setMeta("reconstrucaoEtapa", `${t} @ ${new Date().toISOString()}`) })
    );
    if (!rodou) setMeta("reconstrucaoErro", "havia uma sincronizacao em andamento");
    else setMeta("reconstrucaoResultado", JSON.stringify(resultado));
  } catch (err) {
    console.error("[reconstrucao] falhou:", err.message);
    setMeta("reconstrucaoErro", `${err.message} (em ${new Date().toISOString()})`);
  } finally {
    reconstrucaoEmCurso = false;
    setMeta("reconstrucaoTerminouEm", new Date().toISOString());
  }
});

// POST /api/fonteslog/sessao?s=<segredo>   corpo: o storageState do Playwright
//
// E por aqui que o login manual chega ao servidor. O captcha exige uma pessoa,
// mas exige uma pessoa UMA VEZ -- depois disso quem le o portal e o quadro, a
// cada ciclo, com o pulso segurando a sessao viva. Sem esta rota a sessao ficava
// presa na maquina de quem logou, e era isso que obrigava alguem a estar aqui.
//
// A sessao vale como senha: so entra com o segredo, e so por HTTPS.
app.post("/api/fonteslog/sessao", express.json({ limit: "1mb" }), async (req, res) => {
  const esperado = process.env.MANDAE_WEBHOOK_SECRET;
  if (esperado && req.query?.s !== esperado) return res.status(401).json({ error: "segredo invalido" });

  const { CAMINHO_SESSAO, salvarSessao, conferirSessao } = await import("./integrations/fonteslog.js");
  const fs = await import("node:fs");

  // Guarda a que esta valendo ANTES de escrever por cima.
  //
  // Um login que deu errado nao pode derrubar um login que deu certo: se a
  // sessao nova nao passar no teste, a antiga volta e o quadro continua lendo.
  // Sem isso, um envio ruim deixaria o WMS parado ate alguem reparar.
  const anterior = fs.existsSync(CAMINHO_SESSAO) ? fs.readFileSync(CAMINHO_SESSAO) : null;

  try {
    salvarSessao(req.body);
  } catch (err) {
    if (err.message === "SESSAO_SEM_COOKIE_DO_PORTAL") {
      return res.status(400).json({ error: "essa sessao nao tem cookie do portal FontesLog" });
    }
    throw err;
  }

  const teste = await conferirSessao();
  if (!teste.viva) {
    if (anterior) fs.writeFileSync(CAMINHO_SESSAO, anterior);
    else fs.rmSync(CAMINHO_SESSAO, { force: true });
    return res.status(400).json({
      error: "a sessao enviada nao abre o portal",
      detalhe: teste.motivo,
      anteriorRestaurada: !!anterior,
    });
  }

  res.json({ ok: true, valendo: true, lendoAgora: true });

  // Le na hora, sem esperar o proximo ciclo: quem acabou de logar esta olhando
  // o quadro pra ver se funcionou.
  const { sincronizarWms } = await import("./lib/wms.js");
  sincronizarWms({ dias: Number(process.env.BLING_DIAS || 60) }).catch((err) =>
    console.error("[wms] leitura pos-login falhou:", err.message)
  );
});

app.get("/api/meta", async (req, res) => {
  const { estadoDoWms } = await import("./lib/wms.js");
  res.json({ lastSyncAt: getMeta("lastSyncAt"), wms: estadoDoWms() });
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

// Entrada alternativa do WMS: recebe o que alguem leu na propria maquina.
// O caminho normal e o servidor ler sozinho -- ver src/lib/wms.js.
app.post("/webhooks/fonteslog", handleFontesLog);

// Configurar em: Bling -> Area do integrador -> seu app -> aba Webhooks.
// URL: https://quadro.vitapetlife.com/webhooks/bling
// Recursos: Pedido de venda e Nota fiscal, acoes "criado" e "alterado".
// A autenticacao e por assinatura HMAC no header X-Bling-Signature-256, com o
// client secret do app -- nao ha segredo a preencher no painel.
app.post("/webhooks/bling", handleEventoBling);

// OAuth do Bling. O /bling/callback e o "Link de redirecionamento" cadastrado
// no app criado na Area do integrador do Bling.
app.get("/bling/autorizar", handleAutorizar);
app.get("/bling/callback", handleCallback);
app.get("/bling/status", handleStatus);
app.get("/bling/diagnostico", handleDiagnostico);
app.post("/bling/sincronizar", handleSincronizar);
app.post("/bling/limpar", handleLimpar);
app.get("/bling/sonda", handleSonda);

// Rastreia um pedido/cliente nos tres sistemas -- a ferramenta de cacar pedido perdido.
app.get("/api/investigar", handleInvestigar);

// Pente fino: confere o quadro INTEIRO contra o Bling e a Mandae e lista as
// divergencias. Com ?corrigir=1 aplica as correcoes seguras.
app.get("/api/pente-fino", handlePenteFino);

// Diagnostico do PROCESSO: como a instancia anterior terminou, quantas vezes
// ja subiu neste volume, ha quanto tempo esta de pe. E o que responde "por que
// o Railway diz que caiu?" sem depender do log do container que morreu.
app.get("/api/diagnostico", (req, res) => {
  const esperado = process.env.MANDAE_WEBHOOK_SECRET;
  if (esperado && req.query?.s !== esperado) return res.status(401).json({ error: "segredo invalido" });
  const d = lerDiario();
  res.json({
    agora: new Date().toISOString(),
    subiuEm: d?.subiuEm ?? null,
    dePeHaSegundos: Math.round(process.uptime()),
    bootsNesteVolume: d?.boots ?? null,
    instanciaAnterior: d?.anterior ?? null,
    memoriaMB: Math.round(process.memoryUsage().rss / 1048576),
    node: process.version,
    // Como esta chegando a noticia do Bling.
    //
    // Sem isto, "o webhook esta configurado e funcionando" e "o webhook nunca
    // foi configurado" sao indistinguiveis por fora -- os dois mostram um quadro
    // atualizado, porque a via rapida cobre os dois casos. A diferenca esta em
    // SEGUNDOS contra MINUTOS, e so da pra saber olhando se algum evento chegou.
    bling: {
      ultimaLeitura: getMeta("lastBlingSyncAt") || null,
      webhookUltimoEm: getMeta("blingWebhookUltimoEm") || null,
      webhookUltimoEvento: getMeta("blingWebhookUltimoEvento") || null,
      webhookUltimaRecusa: getMeta("blingWebhookUltimaRecusa") || null,
    },
    // Qual commit esta realmente no ar.
    //
    // Sem isto eu disparei uma sincronizacao achando que a versao nova ja
    // estava rodando -- o "esta de pe ha poucos segundos" tambem e verdade
    // para o REINICIO ANTERIOR, entao esperar por ele nao prova nada. O
    // resultado foi eu interpretar dado velho como se fosse da regra nova.
    commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || null,
  });
});

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

  const { boots, anterior } = registrarBoot();
  console.log(`[diario] boot numero ${boots} neste volume.`);
  if (anterior) {
    const detalhe = anterior.detalhe ? `: ${anterior.detalhe}` : "";
    console.log(
      `[diario] a instancia anterior terminou como "${anterior.motivo}"${detalhe} (${anterior.em || "sem data"}).`
    );
  }

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
  anotarSaida(`sinal:${sinal}`);

  // Prazo maximo. Se algo travar (conexao pendurada, escrita longa), e melhor
  // sair a forca do que o orquestrador nos matar -- morte por timeout volta a
  // contar como crash, que e justamente o que estamos evitando.
  const prazo = setTimeout(() => {
    console.warn("[server] demorou demais pra fechar; saindo assim mesmo.");
    anotarSaida("timeout-no-encerramento");
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
  anotarSaida("unhandledRejection", motivo?.stack || motivo);
});
process.on("uncaughtException", (err) => {
  console.error("[server] excecao nao tratada:", err);
  anotarSaida("uncaughtException", err?.stack || err?.message);
  process.exit(1); // aqui a saida e 1 de proposito: isso E uma falha de verdade
});
