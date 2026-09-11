import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { combineStatus, aplicarEnvelhecimento, avaliarPrevisao, pior, semAcompanhamento, avaliarColeta, combinarComHandover, aguardandoPrimeiroEvento, avaliarRastreioDesconhecido, corDaSituacao, ehSituacaoFinal, ehUltimoTrecho } from "./statusMapping.js";

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
    apelidos TEXT,
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
// Numeros que este pedido ja teve em outros sistemas e foram mesclados aqui.
// Sem guardar, quem procurasse pelo numero do WMS nao acharia mais o pedido.
if (!existingCols.includes("apelidos")) db.exec("ALTER TABLE orders ADD COLUMN apelidos TEXT");

// Quando a transportadora responde 404 para o codigo: a etiqueta existe no
// Bling e a Mandae nunca recebeu a encomenda. Nos primeiros dias isso e normal
// (a etiqueta nasce antes da coleta); depois de uma semana e um envio que nao
// aconteceu -- e o quadro mostrava seis desses, tres em VERDE.
if (!existingCols.includes("rastreio_desconhecido")) db.exec("ALTER TABLE orders ADD COLUMN rastreio_desconhecido INTEGER");

// A data do ultimo MOVIMENTO, que nao e a data do ultimo evento.
//
// "Ocorrencia respondida" e um evento: entra no historico, carimba a hora. Mas
// a encomenda nao andou um metro por causa dele. O pedido 1239 parou em rota no
// dia 27/08, teve a ocorrencia respondida em 11/09, e o envelhecimento -- que
// contava do ultimo evento -- dizia "0 dias parados" sobre uma encomenda parada
// ha duas semanas. Separar as duas datas e o que faz o silencio voltar a ser
// audivel.
if (!existingCols.includes("ultimo_movimento_at")) db.exec("ALTER TABLE orders ADD COLUMN ultimo_movimento_at TEXT");

// A situacao do pedido no Bling ("Cancelado", "Em devolucao", "Entregue").
//
// O quadro lia do pedido tudo MENOS se ele ainda estava de pe. O pedido 1481 da
// Andressa estava cancelado e aparecia verde -- o quadro afirmando que esta
// tudo bem com uma venda que nao existe mais. Nem o WMS nem a transportadora
// sabem disso: cancelamento acontece no ERP, e so o ERP conta.
if (!existingCols.includes("situacao_bling")) db.exec("ALTER TABLE orders ADD COLUMN situacao_bling TEXT");

// Ocultar: a decisao humana sobre o que o sistema nao consegue decidir.
//
// Existe caso que nenhuma regra resolve bem. Uma encomenda extraviada tem como
// ultimo registro o proprio extravio e nunca mais recebe nada -- refaz-se o
// pedido e o quadrado antigo ficaria vermelho para sempre, sem que isso
// signifique algo a fazer. Um pedido abandonado no ERP, idem.
//
// Tentar adivinhar esses casos foi o que me fez apagar 47 quadrados numa
// rodada e ressuscitar outro na seguinte. Quem sabe se aquele extravio ja virou
// pedido novo e a pessoa que trabalha ali, nao uma heuristica. Entao o sistema
// para de tentar e oferece a alavanca.
//
// Guarda a DATA em vez de um sim/nao porque "quando foi escondido" e a unica
// coisa que permite conferir depois se a decisao ainda faz sentido.
if (!existingCols.includes("oculto_em")) db.exec("ALTER TABLE orders ADD COLUMN oculto_em TEXT");
if (!existingCols.includes("oculto_motivo")) db.exec("ALTER TABLE orders ADD COLUMN oculto_motivo TEXT");

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
  // A situacao do pedido no ERP.
  //
  // Fica acima de tudo porque responde uma pergunta anterior a todas as outras:
  // esta venda ainda existe? Cancelamento nao aparece no WMS nem na
  // transportadora -- acontece no Bling, e so o Bling conta.
  const doBling = corDaSituacao(r.situacao_bling);
  const situacaoEncerra = ehSituacaoFinal(r.situacao_bling);

  const naoAcompanhado = semAcompanhamento({
    trackingCode: r.tracking_code,
    wmsStatus: r.wms_status,
    carrierStatus: r.carrier_status,
  });

  // A cor base e recalculada na LEITURA, nao herdada da gravacao: a regra do
  // handover depende dos rotulos das duas fontes, e recalcular aqui faz os
  // registros antigos se corrigirem sozinhos, sem precisar reescrever o banco.
  // Nota emitida e etiqueta criada, primeiro evento ainda nao: nao e duvida,
  // e o comeco normal da viagem. Sem isto o pedido nasce amarelo e fica assim
  // ate a transportadora bipar a primeira vez.
  const esperandoPrimeiro = aguardandoPrimeiroEvento({
    temNota: r.tem_nota === 1,
    trackingCode: r.tracking_code,
    wmsStatus: r.wms_status,
    carrierStatus: r.carrier_status,
  });

  const base = esperandoPrimeiro
    ? "green"
    : combinarComHandover({
        wmsSeverity: r.wms_severity,
        wmsStatus: r.wms_status,
        carrierSeverity: r.carrier_severity,
        carrierStatus: r.carrier_status,
      });

  const envelhecido = naoAcompanhado
    ? { status: "green", diasParados: 0, motivo: null }
    : situacaoEncerra
    ? { status: base, diasParados: 0, motivo: null }
    : aplicarEnvelhecimento({
        status: base,
        // O MOVIMENTO, nao o ultimo evento: responder uma ocorrencia carimba
        // hora sem a encomenda andar, e contar dali zerava o relogio de um
        // pedido parado ha semanas.
        lastEventAt: r.ultimo_movimento_at || r.last_event_at,
        rotuloUltimoEvento: r.carrier_status,
        wmsStatus: r.wms_status,
        // Houve noticia DEPOIS do ultimo movimento? Se houve, foi conversa
        // (ocorrencia), e conversa depois do ultimo trecho quer dizer que
        // alguem esta atras da encomenda.
        semNoticiaPosterior:
          !r.ultimo_movimento_at || !r.last_event_at || r.last_event_at <= r.ultimo_movimento_at,
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

  // Etiqueta que a transportadora nunca recebeu. Fica por ULTIMO e manda em
  // tudo -- inclusive na coleta agendada -- porque nao adianta discutir prazo
  // de um envio que nao existe.
  const fantasma = avaliarRastreioDesconhecido({
    rastreioDesconhecido: r.rastreio_desconhecido === 1,
    placedAt: r.placed_at,
  });

  let statusFinal = coleta.pendente ? coleta.status : pior(envelhecido.status, previsao.status);
  let motivo = coleta.pendente ? coleta.motivo : previsao.motivo || envelhecido.motivo;
  if (fantasma.pendente) {
    statusFinal = pior(statusFinal, fantasma.status);
    motivo = fantasma.motivo;
  }
  if (doBling) {
    statusFinal = pior(statusFinal, doBling);
    if (doBling !== "green") motivo = `Pedido ${String(r.situacao_bling).toLowerCase()} no Bling`;
  }

  return {
    orderNumber: r.order_number,
    brand: r.brand,
    customer: r.customer,
    status: statusFinal,
    // statusBase: a cor que veio dos eventos, antes do envelhecimento. Guardar
    // as duas deixa o painel explicar POR QUE o quadrado mudou de cor.
    statusBase: base,
    diasParados: envelhecido.diasParados,
    motivoStatus: motivo,
    diasAtePrevisao: previsao.diasAtePrevisao,
    semAcompanhamento: naoAcompanhado,
    situacaoBling: r.situacao_bling || null,
    oculto: !!r.oculto_em,
    ocultoEm: r.oculto_em || null,
    ocultoMotivo: r.oculto_motivo || null,
    // Pedido cancelado ou entregue nao tem proximo passo. O quadro mostra a
    // cor certa, mas ele nao deve voltar todo dia como pendencia de outro dia:
    // nao ha nada a resolver, e a pendencia que nunca sai ensina a ignorar o
    // quadro.
    encerrado: situacaoEncerra,
    aguardandoPrimeiroEvento:
      esperandoPrimeiro && r.rastreio_desconhecido !== 1 && !situacaoEncerra,
    // Ultimo trecho ha dias, sem ocorrencia nenhuma: o painel explica que a
    // entrega e provavel mas nao foi confirmada por ninguem.
    entregaNaoConfirmada:
      ehUltimoTrecho(r.carrier_status) &&
      (!r.last_event_at || !r.ultimo_movimento_at || r.last_event_at <= r.ultimo_movimento_at) &&
      envelhecido.diasParados >= 2,
    rastreioDesconhecido: r.rastreio_desconhecido === 1,
    ultimoMovimentoAt: r.ultimo_movimento_at || null,
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
    apelidos: r.apelidos ? r.apelidos.split(",").filter(Boolean) : [],
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
    carrier_status, carrier_severity, bonificacao, natureza, previsao_entrega, tem_nota, nota_fiscal, coleta_prevista, apelidos,
    tracking_code, city, placed_at, last_event_at, rastreio_desconhecido, ultimo_movimento_at, situacao_bling, updated_at
  ) VALUES (
    @orderNumber, @brand, @customer, @status, @wmsStatus, @wmsSeverity,
    @carrierStatus, @carrierSeverity, @bonificacao, @natureza, @previsaoEntrega, @temNota, @notaFiscal, @coletaPrevista, @apelidos,
    @trackingCode, @city, @placedAt, @lastEventAt, @rastreioDesconhecido, @ultimoMovimentoAt, @situacaoBling, @updatedAt
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
    apelidos = excluded.apelidos,
    tracking_code = excluded.tracking_code,
    city = excluded.city,
    placed_at = excluded.placed_at,
    last_event_at = excluded.last_event_at,
    rastreio_desconhecido = excluded.rastreio_desconhecido,
    ultimo_movimento_at = excluded.ultimo_movimento_at,
    situacao_bling = excluded.situacao_bling,
    updated_at = excluded.updated_at
`);

// ---------------------------------------------------------------------------
// Apelido resolvido na ESCRITA
// ---------------------------------------------------------------------------
//
// Mesclar nao basta. O WMS continua listando a remessa pelo numero dele
// ("ATB0240367"), entao a proxima leitura do portal recriava o quadrado que o
// Bling tinha acabado de unir -- um ciclo sem fim: o Bling une, o WMS recria.
//
// Se ja foi estabelecido que ATB0240367 E o pedido 000258, entao qualquer
// escrita sobre ATB0240367 e uma escrita sobre 000258. Resolver aqui, no unico
// ponto por onde toda gravacao passa, vale para o WMS, para os webhooks da
// Mandae e para o que vier depois.
let cacheApelidos = null;

function mapaDeApelidos() {
  if (cacheApelidos) return cacheApelidos;
  cacheApelidos = new Map();
  const linhas = db.prepare("SELECT order_number, apelidos FROM orders WHERE apelidos IS NOT NULL AND apelidos != ''").all();
  for (const l of linhas) {
    for (const a of String(l.apelidos).split(",")) {
      const chave = a.trim();
      if (chave && chave !== l.order_number) cacheApelidos.set(chave, l.order_number);
    }
  }
  return cacheApelidos;
}

function invalidarApelidos() {
  cacheApelidos = null;
}

// O portal do WMS escapa acento como entidade numerica, e ja aconteceu de o
// MESMO pedido chegar as vezes cru ("PROJETO NAT&#193;LIA") e as vezes decodificado
// ("PROJETO NATALIA" com acento), virando dois quadrados. O numero do pedido e a
// CHAVE do registro: se ele pode chegar em duas grafias, a normalizacao tem que
// morar aqui, na porta de entrada, e nao em cada integracao.
function decodificarNumero(texto) {
  return texto
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)));
}

/** Se este numero ja foi absorvido por outro pedido, devolve o dono. */
export function resolverCanonico(numero) {
  const n = decodificarNumero(String(numero)).replace(/\s+/g, " ").trim();
  // Uma volta so: o dono de um apelido nunca e, ele proprio, apelido de
  // terceiro -- a mesclagem sempre grava o canonico do momento.
  return mapaDeApelidos().get(n) || n;
}

// ---------------------------------------------------------------------------
// Quem e o dono de uma nota fiscal
// ---------------------------------------------------------------------------
//
// O WMS batiza cada remessa com um numero proprio -- "ATB0240367" -- que nao
// existe em lugar nenhum alem do portal dele. O unico elo entre esse numero e o
// pedido do Bling e a NOTA FISCAL: o portal mostra "258 - 001", o Bling mostra
// "000274", e chaveNota() reduz os dois ao mesmo numero.
//
// Ate agora essa ligacao so acontecia na sincronizacao do Bling, DEPOIS do
// estrago: o WMS criava o quadrado ATB, ele ficava la duplicando o pedido ate a
// proxima rodada, e so entao era absorvido. Resolver na hora da escrita fecha a
// janela -- o quadrado duplicado nunca chega a existir.

let cacheNotas = null;

function mapaDeNotas() {
  if (cacheNotas) return cacheNotas;
  cacheNotas = new Map();
  for (const l of db.prepare("SELECT order_number, nota_fiscal FROM orders WHERE nota_fiscal IS NOT NULL").all()) {
    const chave = chaveNota(l.nota_fiscal);
    if (!chave) continue;
    // O primeiro a registrar a nota e o dono. Na pratica o Bling chega antes
    // (roda sozinho de 2 em 2 horas) e o WMS e manual, entao o dono tende a ser
    // o numero do pedido -- que e justamente o que a operacao reconhece.
    if (!cacheNotas.has(chave)) cacheNotas.set(chave, l.order_number);
  }
  return cacheNotas;
}

function invalidarNotas() {
  cacheNotas = null;
}

/** Quem ja ocupa o quadrado desta nota fiscal, se nao for o proprio numero. */
export function donoDaNota(notaFiscal, excluir) {
  const chave = chaveNota(notaFiscal);
  if (!chave) return null;
  const dono = mapaDeNotas().get(chave);
  return dono && dono !== excluir ? dono : null;
}

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
  let orderNumber = resolverCanonico(partial.orderNumber);
  let apelidoNovo = null;

  // `numeroProvisorio` e a fonte declarando: "este numero e invencao minha".
  //
  // So o WMS usa. A direcao da mesclagem precisa ser dita por quem escreve e
  // nao adivinhada aqui: se o db tentasse deduzir sozinho quem e o canonico,
  // uma hora inverteria e o quadro passaria a se chamar "ATB0240367" em vez do
  // numero do pedido -- que e o que a operacao procura.
  if (partial.numeroProvisorio && partial.notaFiscal) {
    const dono = donoDaNota(partial.notaFiscal, orderNumber);
    if (dono) {
      if (getOrder(orderNumber)) {
        // O quadrado provisorio ja existia (rodada anterior): funde e some.
        mesclarEmCanonico(dono, [orderNumber]);
      } else {
        // Ainda nao existe: nem chega a nascer. Guarda o numero como apelido
        // pra quem tiver "ATB0240367" na mao continuar achando o pedido.
        apelidoNovo = orderNumber;
      }
      orderNumber = dono;
    }
  }

  // O outro lado da mesma moeda: `canonicoDaNota` e o Bling dizendo "este e o
  // nome de verdade desta nota". Se alguem ja esta ocupando o quadrado dela --
  // tipicamente um ATB que o WMS criou antes do Bling passar por aqui -- ele e
  // absorvido agora, e nao so na proxima sincronizacao.
  const absorver = partial.canonicoDaNota && partial.notaFiscal
    ? donoDaNota(partial.notaFiscal, orderNumber)
    : null;

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
    // O codigo recusado acima nao se perde: vira apelido, entao quem tiver ele
    // na mao ainda acha o pedido.
    apelidos: [...new Set([
      ...(existing.apelidos || []),
      ...(partial.apelidos || []),
      ...(apelidoNovo ? [apelidoNovo] : []),
      ...(partial.trackingCode && existing.trackingCode && partial.trackingCode !== existing.trackingCode
        ? [partial.trackingCode]
        : []),
    ])].join(",") || null,
    temNota: partial.temNota !== undefined ? (partial.temNota ? 1 : 0) : (existing.temNota ? 1 : 0),
    // Codigo de rastreio JA EXISTENTE nao e trocado por outro numa gravacao
    // de rotina -- so preenchido quando nao havia nenhum.
    //
    // O caso que ensinou: o pedido 1453 tinha "MEL47975051107FMDOF01", codigo
    // do Mercado Envios, e uma sincronizacao do Bling o substituiu por
    // "4Y4A5GUKFRJKPO4K3YGNYQNSZY", que e identificador interno do Mercado
    // Livre e nao rastreia nada. Trocar etiqueta e evento raro e deliberado;
    // integracao gravando identificador por cima de codigo bom e corriqueiro.
    // Na duvida, o quadro fica com o que ja tinha e o pente fino reporta a
    // divergencia pra alguem olhar.
    // `trackingCodeAutoritativo` e a NOTA falando: so ela sabe o codigo de
    // verdade, inclusive quando o codigo certo e "nenhum". Sem essa porta, um
    // codigo errado gravado antes (o "VITPT000242" do pedido 1234) ficaria no
    // quadro para sempre, porque a regra conservadora abaixo nunca sobrescreve.
    trackingCode: partial.trackingCodeAutoritativo
      ? partial.trackingCode ?? null
      : existing.trackingCode ?? partial.trackingCode ?? null,
    city: partial.city ?? existing.city ?? null,
    placedAt: partial.placedAt ?? existing.placedAt ?? null,
    situacaoBling: partial.situacaoBling ?? existing.situacaoBling ?? null,
    rastreioDesconhecido:
      partial.rastreioDesconhecido !== undefined
        ? (partial.rastreioDesconhecido ? 1 : 0)
        : (existing.rastreioDesconhecido ? 1 : 0),
    // Quando um pedido nasce no quadro sem evento nenhum, o relogio comeca na
    // DATA DO PEDIDO, nao na hora em que o quadro soube dele.
    //
    // Sem isto, um pedido de 19/08 descoberto hoje aparecia como "1 dia util
    // sem novidade" -- o quadro media a propria memoria em vez da idade do
    // pedido, e um pedido esquecido ha tres semanas passava por recem-chegado.
    lastEventAt:
      partial.lastEventAt ?? existing.lastEventAt ?? partial.placedAt ?? new Date().toISOString(),
  };

  // O movimento acompanha o evento, a menos que quem gravou saiba distinguir os
  // dois (a reconsulta da Mandae sabe: ela ve o historico inteiro).
  merged.ultimoMovimentoAt =
    partial.ultimoMovimentoAt ?? existing.ultimoMovimentoAt ?? merged.lastEventAt;

  // status: quem chamar pode forcar um valor (partial.status); por padrao
  // recalculamos a partir do pior entre wmsSeverity e carrierSeverity.
  merged.status = partial.status ?? combineStatus(merged.wmsSeverity, merged.carrierSeverity);

  upsertStmt.run({ ...merged, updatedAt: new Date().toISOString() });
  if (apelidoNovo) invalidarApelidos();
  if (merged.notaFiscal !== (existing.notaFiscal ?? null)) invalidarNotas();

  // Depois da gravacao, nunca antes: mesclar exige que o quadrado canonico ja
  // exista pra receber o que o outro sabia.
  if (absorver) {
    mesclarEmCanonico(orderNumber, [absorver]);
    invalidarNotas();
    return getOrder(orderNumber) || merged;
  }
  return merged;
}

/**
 * Por padrao devolve TUDO, ocultos inclusive.
 *
 * A sincronizacao, a deduplicacao e o pente fino precisam enxergar o quadrado
 * escondido: se ele sumisse dessas rotinas, o proximo ciclo o criaria de novo
 * com outro nome e o "ocultar" viraria uma briga sem fim. Quem filtra e a
 * leitura do quadro, no fim da linha.
 */
export function listOrders({ apenasVisiveis = false } = {}) {
  const rows = db.prepare("SELECT * FROM orders ORDER BY last_event_at DESC").all();
  const todos = rows.map(rowToOrder);
  return apenasVisiveis ? todos.filter((o) => !o.oculto) : todos;
}

/** Tira o quadrado do quadro sem apagar nada: e reversivel e fica registrado. */
export function ocultarPedido(orderNumber, motivo) {
  const numero = resolverCanonico(orderNumber);
  const n = db
    .prepare("UPDATE orders SET oculto_em = ?, oculto_motivo = ? WHERE order_number = ?")
    .run(new Date().toISOString(), motivo || null, numero).changes;
  return n > 0 ? getOrder(numero) : null;
}

export function reexibirPedido(orderNumber) {
  const numero = resolverCanonico(orderNumber);
  const n = db
    .prepare("UPDATE orders SET oculto_em = NULL, oculto_motivo = NULL WHERE order_number = ?")
    .run(numero).changes;
  return n > 0 ? getOrder(numero) : null;
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
  const n = db.prepare("DELETE FROM orders WHERE order_number = ?").run(String(orderNumber)).changes;
  invalidarApelidos();
  return n;
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

    // O numero absorvido continua valendo em ALGUM sistema: "ATB0240367" e
    // como o WMS chama essa remessa, e quem vier do portal vai procurar por
    // ele. Guardar o apelido mantem o pedido encontravel pelo numero que a
    // pessoa tem na mao, mesmo que o quadrado agora se chame outra coisa.
    preencher.apelidos = [...(linha.apelidos || []), apelido];

    upsertOrder({ orderNumber: canonico, ...preencher });
    apagarPedido(apelido);

    invalidarApelidos();
    resultado.mesclados++;
    resultado.apelidosApagados.push(apelido);
  }

  return resultado;
}

/**
 * Chave de comparacao de nota fiscal.
 *
 * Cada sistema escreve a mesma nota de um jeito: o WMS mostra "258 - 001"
 * (numero e serie em colunas separadas, que juntamos na leitura) e o Bling
 * mostra "000258" (com zeros a esquerda). Comparar o texto cru nunca casa, e
 * foi por isso que a mesma remessa ocupava dois quadrados -- "ATB0240367",
 * vindo do WMS, e "000258", vindo da nota.
 *
 * A chave e so o NUMERO, sem zeros a esquerda e sem a serie.
 */
export function chaveNota(texto) {
  if (!texto) return null;
  const numero = String(texto).split("-")[0].replace(/\D/g, "");
  if (!numero) return null;
  const semZeros = numero.replace(/^0+/, "");
  return semZeros || null;
}

/** Indice chave-da-nota -> numeros de pedido que a usam. */
export function indicePorNota() {
  const mapa = new Map();
  for (const o of listOrders()) {
    const k = chaveNota(o.notaFiscal);
    if (!k) continue;
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(o.orderNumber);
  }
  return mapa;
}

/**
 * Conserta registros gravados ANTES de a normalizacao existir: quadrados cujo
 * numero ainda carrega a entidade crua ("PROJETO NAT&#193;LIA"). Roda uma vez na
 * subida, funde cada um no quadrado de grafia correta e some.
 *
 * Nao basta corrigir a porta de entrada: o registro velho nao recebe escrita
 * nenhuma (o WMS agora escreve no nome decodificado), entao ele ficaria la
 * parado para sempre, verde e sem cliente, dizendo respeito a um pedido que ja
 * tem quadrado proprio.
 */
export function normalizarNumerosEscapados() {
  let corrigidos = 0;
  for (const o of listOrders()) {
    const bruto = o.orderNumber;
    const limpo = decodificarNumero(String(bruto)).replace(/\s+/g, " ").trim();
    if (limpo === bruto) continue;
    mesclarEmCanonico(limpo, [bruto]);
    corrigidos++;
  }
  if (corrigidos) console.log(`[db] ${corrigidos} numero(s) escapado(s) normalizado(s).`);
  return corrigidos;
}

normalizarNumerosEscapados();
