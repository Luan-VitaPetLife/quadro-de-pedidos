// Mapeia os eventos de rastreio da Mandae para o status do quadro:
// "green" (tudo certo), "amber" (aviso, ainda sem resolver), "red" (problema).
//
// IMPORTANTE: a documentacao da Mandae (docs.mandae.com.br/doc/webhook-rastreamento)
// lista uma tabela de codigos numericos (0, 1, 4, 6, 9, ...) para os eventos do
// WEBHOOK de rastreamento. Ja o endpoint GET /v3/trackings/{codigo} que estamos
// usando (consulta direta) devolveu, no exemplo da doc, eventos com um "id"
// sequencial (1, 2, 3...) e um campo "name" com o texto do evento (ex.: "Pedido
// entregue"), sem deixar claro se ha tambem um campo com o codigo numerico da
// tabela. Por isso o mapeamento abaixo casa pelo TEXTO do evento (name/description),
// que e o que confirmamos na resposta real. Se, ao rodar de verdade, a Mandae
// devolver tambem um codigo numerico junto de cada evento, vale trocar para
// comparar por codigo (mais preciso que texto) -- ver os comentarios com os
// codigos da tabela oficial abaixo, ja deixados prontos para essa migracao.

const RED_PATTERNS = [
  /recusad/i,        // Encomenda recusada pelo destinatario (codigos 4, 9, 11, 88)
  /endereco.*(nao localiz|incompleto|incorret)/i, // 6, 102-108
  /cep fora de abrangencia/i, // 13
  /nao identificada no sistema/i, // 41
  /nota fiscal divergente|invalida/i, // 42
  /incidente.*veiculo/i, // 58
  /destinatario desconhecido/i, // 64
  /em devolucao/i, // 66
  /sem documento de identificacao/i, // 74
  /mudou de endereco/i, // 77
  /violada|avariad/i, // 78, 79, 11
  /extravio/i, // 80, 81
];

const AMBER_PATTERNS = [
  /reprogramada/i, // 19
  /estabelecimento fechado/i, // 21, 47
  /disponivel para retirada/i, // 29
  /analise fiscal|em analise/i, // 30, 84, 85
  /feriado local/i, // 43
  /destinatario ausente/i, // 46
  /redespachad/i, // 52
  /problema operacional|na rota/i, // 75
  /outro tipo de ocorrencia/i, // 99
  /aguardando/i,
];

const GREEN_PATTERNS = [
  /entrega realizada|pedido entregue/i, // 1
  /processo iniciado/i, // 0
  /rota final/i, // 31
  /em transito/i, // 33
  /encomenda conferida/i, // 101
  /recebeu as informacoes/i, // 109
  /encomenda processada/i, // 110
];

function matchesAny(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/**
 * @param {{name?: string, description?: string}} event - evento de rastreio da Mandae
 * @returns {{status: "green"|"amber"|"red", label: string}}
 */
export function mapMandaeEvent(event) {
  const text = [event?.name, event?.description].filter(Boolean).join(" ");
  if (!text) return { status: "amber", label: "Sem evento de rastreio ainda" };

  let status = "amber"; // padrao seguro para textos que ainda nao reconhecemos
  if (matchesAny(RED_PATTERNS, text)) status = "red";
  else if (matchesAny(GREEN_PATTERNS, text)) status = "green";
  else if (matchesAny(AMBER_PATTERNS, text)) status = "amber";

  return { status, label: event.name || event.description };
}

// Status vindos do WMS (FontesLog) -- ajustar assim que soubermos os rotulos reais
// que o portal usa (ver src/explore-fonteslog.js).
export function mapFontesLogStatus(rawStatus) {
  if (!rawStatus) return null;
  const s = String(rawStatus).toLowerCase();
  if (s.includes("cancel") || s.includes("erro") || s.includes("falta") || s.includes("divergen")) {
    return "red";
  }
  if (s.includes("pendente") || s.includes("aguardando") || s.includes("analise")) {
    return "amber";
  }
  return "green";
}

/**
 * Combina o status do WMS (FontesLog) com o status da transportadora (Mandae).
 * O pior dos dois prevalece: red > amber > green.
 */
export function combineStatus(wmsStatus, carrierStatus) {
  const order = { red: 0, amber: 1, green: 2 };
  const candidates = [wmsStatus, carrierStatus].filter(Boolean);
  if (candidates.length === 0) return "amber";
  return candidates.reduce((worst, s) => (order[s] < order[worst] ? s : worst));
}
