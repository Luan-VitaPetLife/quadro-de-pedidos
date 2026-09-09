import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { combineStatus, aplicarEnvelhecimento } from "./statusMapping.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Onde fica o arquivo do banco. O disco do container no Railway e efemero:
// tudo que estiver fora de um Volume some a cada deploy. A ordem abaixo tenta
// o caminho seguro primeiro:
//
//   1. DATA_DIR              -- voce mandou explicitamente; manda mais que tudo.
//   2. RAILWAY_VOLUME_MOUNT_PATH -- o Railway define sozinho quando ha um Volume
//      anexado ao servico. Usar isso significa que o banco cai no volume sem
//      ninguem precisar lembrar de configurar variavel nenhuma.
//   3. a pasta data/ do projeto -- o padrao de quando se roda local.
export const dataDir = path.resolve(
  process.env.DATA_DIR ||
    process.env.RAILWAY_VOLUME_MOUNT_PATH ||
    path.join(__dirname, "..", "..", "data")
);

// De onde veio o caminho -- o server usa isso pra avisar, na subida, se o banco
// esta num lugar que nao sobrevive ao proximo deploy.
export const dataDirSource = process.env.DATA_DIR
  ? "DATA_DIR"
  : process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? "RAILWAY_VOLUME_MOUNT_PATH"
    : "padrao-local";
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "orders.sqlite");
console.log(`[db] banco em ${dbPath}`);
export const db = new Database(dbPath);
// Obs.: journal_mode = WAL exige mmap/locking que alguns discos de rede ou
// pastas sincronizadas (OneDrive, bridges de VM, etc.) nao suportam bem.
// DELETE (o padrao do SQLite) e mais lento sob alta concorrencia, mas e
// muito mais compativel com esses ambientes -- e o suficiente para este uso.
db.pragma("journal_mode = DELETE");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    order_number TEXT PRIMARY KEY,
    brand TEXT,
    customer TEXT,
    status TEXT NOT NULL DEFAULT 'amber',
    wms_status TEXT,
    wms_severity TEXT,
    carrier_status TEXT,
    carrier_severity TEXT,
    tracking_code TEXT,
    city TEXT,
    placed_at TEXT,
    last_event_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migracao leve: bancos criados antes das colunas *_severity existirem.
const existingCols = db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name);
if (!existingCols.includes("wms_severity")) {
  db.exec("ALTER TABLE orders ADD COLUMN wms_severity TEXT");
}
if (!existingCols.includes("carrier_severity")) {
  db.exec("ALTER TABLE orders ADD COLUMN carrier_severity TEXT");
}

const getStmt = db.prepare("SELECT * FROM orders WHERE order_number = ?");

function rowToOrder(r) {
  if (!r) return null;

  // O envelhecimento e calculado AQUI, na leitura -- nao na gravacao.
  //
  // Isso e essencial: o gatilho do envelhecimento e a AUSENCIA de eventos.
  // Um pedido parado, por definicao, nao recebe webhook nenhum, e a
  // sincronizacao de reforco so regrava quando algo mudou. Se a cor fosse
  // decidida na gravacao, o pedido esquecido nunca seria reavaliado e ficaria
  // verde para sempre -- exatamente o caso que a regra existe para pegar.
  // Calculando na leitura, o quadrado amarela sozinho com o passar dos dias,
  // sem depender de nada acontecer.
  const envelhecido = aplicarEnvelhecimento({
    status: r.status,
    lastEventAt: r.last_event_at,
    rotuloUltimoEvento: r.carrier_status,
  });

  return {
    orderNumber: r.order_number,
    brand: r.brand,
    customer: r.customer,
    status: envelhecido.status,
    // statusBase: a cor que veio dos eventos, antes do envelhecimento. Guardar
    // as duas deixa o painel explicar POR QUE o quadrado mudou de cor.
    statusBase: r.status,
    diasParados: envelhecido.diasParados,
    motivoStatus: envelhecido.motivo,
    // *_status: texto legivel (label) vindo da fonte -- so para exibicao.
    wmsStatus: r.wms_status,
    carrierStatus: r.carrier_status,
    // *_severity: cor normalizada ("green"|"amber"|"red") que cada fonte
    // atribuiu -- e o que combineStatus() usa para decidir a cor final.
    wmsSeverity: r.wms_severity,
    carrierSeverity: r.carrier_severity,
    trackingCode: r.tracking_code,
    city: r.city,
    placedAt: r.placed_at,
    lastEventAt: r.last_event_at,
    updatedAt: r.updated_at,
  };
}

export function getOrder(orderNumber) {
  return rowToOrder(getStmt.get(String(orderNumber)));
}

const upsertStmt = db.prepare(`
  INSERT INTO orders (
    order_number, brand, customer, status, wms_status, wms_severity,
    carrier_status, carrier_severity, tracking_code, city, placed_at,
    last_event_at, updated_at
  ) VALUES (
    @orderNumber, @brand, @customer, @status, @wmsStatus, @wmsSeverity,
    @carrierStatus, @carrierSeverity, @trackingCode, @city, @placedAt,
    @lastEventAt, @updatedAt
  )
  ON CONFLICT(order_number) DO UPDATE SET
    brand = excluded.brand,
    customer = excluded.customer,
    status = excluded.status,
    wms_status = excluded.wms_status,
    wms_severity = excluded.wms_severity,
    carrier_status = excluded.carrier_status,
    carrier_severity = excluded.carrier_severity,
    tracking_code = excluded.tracking_code,
    city = excluded.city,
    placed_at = excluded.placed_at,
    last_event_at = excluded.last_event_at,
    updated_at = excluded.updated_at
`);

/**
 * Faz merge (nao sobrescreve) dos campos passados sobre o pedido existente
 * (se houver), recalcula o status final (pior de WMS x transportadora) e
 * grava. Cada integracao (Mandae, FontesLog) so precisa mandar o que ela
 * sabe -- nunca precisa saber o resto do registro.
 *
 * Cada fonte pode mandar dois campos por status: o "Status" (texto legivel,
 * ex.: "Pedido entregue") e o "Severity" (a cor normalizada que esse texto
 * significa: "green"|"amber"|"red"). O campo `status` final do pedido e
 * calculado automaticamente a partir do pior entre wmsSeverity e
 * carrierSeverity -- a menos que quem chamar force um `status` explicito.
 */
export function upsertOrder(partial) {
  const orderNumber = String(partial.orderNumber);
  const existing = getOrder(orderNumber) || {};

  const merged = {
    orderNumber,
    brand: partial.brand ?? existing.brand ?? null,
    customer: partial.customer ?? existing.customer ?? null,
    wmsStatus: partial.wmsStatus !== undefined ? partial.wmsStatus : existing.wmsStatus ?? null,
    wmsSeverity: partial.wmsSeverity !== undefined ? partial.wmsSeverity : existing.wmsSeverity ?? null,
    carrierStatus: partial.carrierStatus !== undefined ? partial.carrierStatus : existing.carrierStatus ?? null,
    carrierSeverity: partial.carrierSeverity !== undefined ? partial.carrierSeverity : existing.carrierSeverity ?? null,
    trackingCode: partial.trackingCode ?? existing.trackingCode ?? null,
    city: partial.city ?? existing.city ?? null,
    placedAt: partial.placedAt ?? existing.placedAt ?? null,
    lastEventAt: partial.lastEventAt ?? existing.lastEventAt ?? new Date().toISOString(),
  };

  // status: quem chamar pode forcar um valor (partial.status); por padrao
  // recalculamos a partir do pior entre wmsSeverity e carrierSeverity.
  merged.status = partial.status ?? combineStatus(merged.wmsSeverity, merged.carrierSeverity);

  upsertStmt.run({ ...merged, updatedAt: new Date().toISOString() });
  return merged;
}

export function listOrders() {
  const rows = db.prepare("SELECT * FROM orders ORDER BY last_event_at DESC").all();
  return rows.map(rowToOrder);
}

export function setMeta(key, value) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

export function getMeta(key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}
