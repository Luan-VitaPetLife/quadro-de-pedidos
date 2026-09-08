import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "orders.sqlite");
export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    order_number TEXT PRIMARY KEY,
    brand TEXT,
    customer TEXT,
    status TEXT NOT NULL DEFAULT 'amber',
    wms_status TEXT,
    carrier_status TEXT,
    carrier_event_code INTEGER,
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

const upsertStmt = db.prepare(`
  INSERT INTO orders (
    order_number, brand, customer, status, wms_status, carrier_status,
    carrier_event_code, tracking_code, city, placed_at, last_event_at, updated_at
  ) VALUES (
    @orderNumber, @brand, @customer, @status, @wmsStatus, @carrierStatus,
    @carrierEventCode, @trackingCode, @city, @placedAt, @lastEventAt, @updatedAt
  )
  ON CONFLICT(order_number) DO UPDATE SET
    brand = excluded.brand,
    customer = excluded.customer,
    status = excluded.status,
    wms_status = excluded.wms_status,
    carrier_status = excluded.carrier_status,
    carrier_event_code = excluded.carrier_event_code,
    tracking_code = excluded.tracking_code,
    city = excluded.city,
    placed_at = excluded.placed_at,
    last_event_at = excluded.last_event_at,
    updated_at = excluded.updated_at
`);

export function upsertOrder(order) {
  upsertStmt.run({
    orderNumber: String(order.orderNumber),
    brand: order.brand ?? null,
    customer: order.customer ?? null,
    status: order.status ?? "amber",
    wmsStatus: order.wmsStatus ?? null,
    carrierStatus: order.carrierStatus ?? null,
    carrierEventCode: order.carrierEventCode ?? null,
    trackingCode: order.trackingCode ?? null,
    city: order.city ?? null,
    placedAt: order.placedAt ?? null,
    lastEventAt: order.lastEventAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

export function listOrders() {
  const rows = db.prepare("SELECT * FROM orders ORDER BY last_event_at DESC").all();
  return rows.map((r) => ({
    orderNumber: r.order_number,
    brand: r.brand,
    customer: r.customer,
    status: r.status,
    wmsStatus: r.wms_status,
    carrierStatus: r.carrier_status,
    carrierEventCode: r.carrier_event_code,
    trackingCode: r.tracking_code,
    city: r.city,
    placedAt: r.placed_at,
    lastEventAt: r.last_event_at,
    updatedAt: r.updated_at,
  }));
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
