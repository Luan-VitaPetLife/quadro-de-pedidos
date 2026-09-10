import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { combineStatus, aplicarEnvelhecimento, avaliarPrevisao, pior, semAcompanhamento, avaliarColeta } from "./statusMapping.js";

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
    bonificacao INTEGER,
    natureza TEXT,
    previsao_entrega TEXT,
    tem_nota INTEGER,
    nota_fiscal TEXT,
    coleta_prevista TEXT,
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
// bonificacao/doacao (vem da Natureza de Operacao da NOTA) e previsao de entrega.
if (!existingCols.includes("bonificacao")) db.exec("ALTER TABLE orders ADD COLUMN bonificacao INTEGER");
if (!existingCols.includes("natureza")) db.exec("ALTER TABLE orders ADD COLUMN natureza TEXT");
if (!existingCols.includes("previsao_entrega")) db.exec("ALTER TABLE orders ADD COLUMN previsao_entrega TEXT");
if (!existingCols.includes("tem_nota")) db.exec("ALTER TABLE orders ADD COLUMN tem_nota INTEGER");
// Numero da nota fiscal -- o WMS mostra "000000246 - 001" e e por esse numero
// que a operacao acha a nota no Bling. Sem ele, achar a nota do pedido vira
// busca manual.
if (!existingCols.includes("nota_fiscal")) db.exec("ALTER TABLE orders ADD COLUMN nota_fiscal TEXT");
// Coleta agendada na Mandae. Vem disfarcada de evento com data futura.
if (!existingCols.includes("coleta_prevista")) db.exec("ALTER TABLE orders ADD COLUMN coleta_prevista TEXT");

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
  // Despacho por transportadora que nao consultamos: sabe-se que saiu, e so.
  // Nao envelhece nem entra em regra de prazo -- nao ha fonte que possa
  // desmentir ou confirmar.
  const naoAcompanhado = semAcompanhamento({
    trackingCode: r.tracking_code,
    wmsStatus: r.wms_status,
    carrierStatus: r.carrier_status,
  });

  const envelhecido = naoAcompanhado
    ? { status: "green", diasParados: 0, motivo: null }
    : aplicarEnvelhecimento({
        status: r.status,
        lastEventAt: r.last_event_at,
        rotuloUltimoEvento: r.carrier_status,
        wmsStatus: r.wms_status,
      });

  // Segunda regra de leitura: o prazo prometido. O envelhecimento pega o
  // pedido que parou; esta pega o que anda devagar demais pra data combinada.
  const previsao = naoAcompanhado
    ? { status: "green", motivo: null, diasAtePrevisao: null }
    : avaliarPrevisao({
        status: envelhecido.status,
        previsaoEntrega: r.previsao_entrega,
        rotuloUltimoEvento: r.carrier_status,
        wmsStatus: r.wms_status,
        temNota: r.tem_nota === 1,
      });

  // A COLETA AGENDADA manda em tudo.
  //
  // Entre a expedicao e o primeiro evento de rastreio existe um intervalo
  // normal: o WMS marca "PARADO" (parado esperando o caminhao) e a Mandae
  // responde "Nenhuma atualizacao disponivel". Somados, os dois pintavam de
  // amarelo um pedido que so esta aguardando o horario combinado -- e amarelo,
  // aqui, quer dizer "alguem precisa agir".
  const coleta = avaliarColeta({
    coletaPrevista: r.coleta_prevista,
    rotuloUltimoEvento: r.carrier_status,
  });

  const statusFinal = coleta.pendente ? coleta.status : pior(envelhecido.status, previsao.status);
  const motivo = coleta.pendente ? coleta.motivo : previsao.motivo || envelhecido.motivo;

  return {
    orderNumber: r.order_number,
    brand: r.brand,
    customer: r.customer,
    status: statusFinal,
    // statusBase: a cor que veio dos eventos, antes do envelhecimento. Guardar
    // as duas deixa o painel explicar POR QUE o quadrado mudou de cor.
    statusBase: r.status,
    diasParados: envelhecido.diasParados,
    motivoStatus: motivo,
    diasAtePrevisao: previsao.diasAtePrevisao,
    semAcompanhamento: naoAcompanhado,
    // *_status: texto legivel (label) vindo da fonte -- so para exibicao.
    wmsStatus: r.wms_status,
    carrierStatus: r.carrier_status,
    // *_severity: cor normalizada ("green"|"amber"|"red") que cada fonte
    // atribuiu -- e o que combineStatus() usa para decidir a cor final.
    wmsSeverity: r.wms_severity,
    carrierSeverity: r.carrier_severity,
    // Bonificacao/doacao: decidido pela NATUREZA DE OPERACAO da nota, nunca pelo
    // valor -- ha bonificacao emitida com valor cheio (NF 000222, R$129,99).
    bonificacao: r.bonificacao === 1,
    natureza: r.natureza,
    previsaoEntrega: r.previsao_entrega,
    // Nota emitida separa "ainda nao faturado" de "a caminho" -- a regra de
    // prazo muda de sentido conforme isso.
    temNota: r.tem_nota === 1,
    // Numero da nota que o WMS mostra ("000000246 - 001") -- e por ele que a
    // operacao acha a nota no Bling.
    notaFiscal: r.nota_fiscal,
    // Coleta agendada na Mandae. Vem disfarcada de evento com data futura.
    coletaPrevista: r.coleta_prevista,
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
    carrier_status, carrier_severity, bonificacao, natureza, previsao_entrega, tem_nota, nota_fiscal, coleta_prevista,
    tracking_code, city, placed_at, last_event_at, updated_at
  ) VALUES (
    @orderNumber, @brand, @customer, @status, @wmsStatus, @wmsSeverity,
    @carrierStatus, @carrierSeverity, @bonificacao, @natureza, @previsaoEntrega, @temNota, @notaFiscal, @coletaPrevista,
    @trackingCode, @city, @placedAt, @lastEventAt, @updatedAt
  )
  ON CONFLICT(order_number) DO UPDATE SET
    brand = excluded.brand,
    customer = excluded.customer,
    status = excluded.status,
    wms_status = excluded.wms_status,
    wms_severity = excluded.wms_severity,
    carrier_status = excluded.carrier_status,
    carrier_severity = excluded.carrier_severity,
    bonificacao = excluded.bonificacao,
    natureza = excluded.natureza,
    previsao_entrega = excluded.previsao_entrega,
    tem_nota = excluded.tem_nota,
    nota_fiscal = excluded.nota_fiscal,
    coleta_prevista = excluded.coleta_prevista,
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
    bonificacao: partial.bonificacao !== undefined ? (partial.bonificacao ? 1 : 0) : (existing.bonificacao ? 1 : 0),
    natureza: partial.natureza ?? existing.natureza ?? null,
    previsaoEntrega: partial.previsaoEntrega ?? existing.previsaoEntrega ?? null,
    notaFiscal: partial.notaFiscal ?? existing.notaFiscal ?? null,
    coletaPrevista: partial.coletaPrevista !== undefined ? partial.coletaPrevista : existing.coletaPrevista ?? null,
    temNota: partial.temNota !== undefined ? (partial.temNota ? 1 : 0) : (existing.temNota ? 1 : 0),
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

export function apagarPedido(orderNumber) {
  return db.prepare("DELETE FROM orders WHERE order_number = ?").run(String(orderNumber)).changes;
}

/**
 * Junta num unico pedido os registros que sao a MESMA venda mas entraram com
 * chaves diferentes.
 *
 * Por que isso e necessario: o Bling manda referencias diferentes para cada
 * sistema. O WMS recebe o `numero` do Bling ("1445"); a Mandae recebe o
 * `numeroLoja` do marketplace ("7416887836984") -- e as vezes nem isso, e o
 * pedido entra pelo codigo de rastreio. Resultado: a mesma venda ocupa dois ou
 * tres quadrados, cada um contando metade da historia.
 *
 * Só o Bling conhece as tres chaves ao mesmo tempo, entao e ele quem diz o que
 * mesclar. O `numero` vira o canonico: e a chave que o WMS usa e a que a
 * operacao reconhece.
 *
 * A regra de merge e conservadora -- so PREENCHE campo vazio do canonico com o
 * valor do apelido, nunca sobrescreve o que ja existe. Assim o status do WMS
 * (que mora no canonico) e o da transportadora (que mora no apelido) se somam
 * em vez de um apagar o outro.
 */
export function mesclarEmCanonico(numeroCanonico, apelidos = []) {
  const canonico = String(numeroCanonico);
  const resultado = { mesclados: 0, apelidosApagados: [] };

  for (const bruto of apelidos) {
    const apelido = String(bruto ?? "").trim();
    if (!apelido || apelido === canonico) continue;

    const linha = getOrder(apelido);
    if (!linha) continue;

    const atual = getOrder(canonico) || {};
    const preencher = {};

    for (const campo of [
      "brand", "customer", "city", "placedAt", "natureza", "previsaoEntrega", "notaFiscal", "coletaPrevista",
      "wmsStatus", "wmsSeverity", "carrierStatus", "carrierSeverity", "trackingCode",
    ]) {
      const jaTem = atual[campo] !== undefined && atual[campo] !== null && atual[campo] !== "";
      const apelidoTem = linha[campo] !== undefined && linha[campo] !== null && linha[campo] !== "";
      if (!jaTem && apelidoTem) preencher[campo] = linha[campo];
    }

    // O evento mais recente entre os dois manda: o envelhecimento conta a
    // partir dele, e usar o mais antigo faria o pedido parecer parado.
    // Bonificacao e verdade sobre a venda, nao sobre o quadrado: se QUALQUER
    // dos registros mesclados era bonificacao, o resultado e bonificacao.
    if (linha.bonificacao) preencher.bonificacao = true;
    if (linha.temNota) preencher.temNota = true;

    const datas = [atual.lastEventAt, linha.lastEventAt].filter(Boolean).sort();
    if (datas.length) preencher.lastEventAt = datas[datas.length - 1];

    upsertOrder({ orderNumber: canonico, ...preencher });
    apagarPedido(apelido);

    resultado.mesclados++;
    resultado.apelidosApagados.push(apelido);
  }

  return resultado;
}
