// Mapeia os eventos de rastreio da Mandae para o status do quadro:
// "green" (tudo certo), "amber" (aviso, ainda sem resolver), "red" (problema).
//
// IMPORTANTE: a documentacao da Mandae (docs.mandae.com.br/doc/webhook-rastreamento)
// lista uma tabela de codigos numericos (0, 1, 4, 6, 9, ...) para os eventos do
// WEBHOOK de rastreamento. Ja o endpoint GET /v3/trackings/{codigo} que estamos
// usando (consulta direta) devolveu, no exemplo da doc, eventos com um "id"
// sequencial (1, 2, 3...) e um campo "name" com o texto do evento (ex.: "Pedido
// entregue"), sem deixar claro se ha tambem um campo com o codigo numerico da
// tabela. Por isso o mapeamento abaixo casa pelo TEXTO do evento (name/description).
// Se, ao rodar de verdade, a Mandae devolver tambem um codigo numerico junto de
// cada evento, vale trocar para comparar por codigo (mais preciso que texto) --
// ver os comentarios com os codigos da tabela oficial abaixo.
//
// ACENTOS: a Mandae devolve o texto acentuado ("Endereco nao localizado" vem como
// "Endereço não localizado"). Por isso TODO texto passa por normalizar() antes de
// ser comparado, e os padroes abaixo sao escritos SEM acento de proposito. Se voce
// adicionar um padrao novo, escreva-o sem acento tambem -- um padrao acentuado
// nunca vai casar, porque o texto ja chegou sem acento aqui.

/**
 * Tira acentos e baixa a caixa, pra comparacao de texto ficar imune a
 * "Endereço" vs "endereco". NFD separa a letra do acento; a segunda etapa
 * joga fora os acentos soltos.
 */
function normalizar(texto) {
  return String(texto)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

const RED_PATTERNS = [
  /recusad/,        // Encomenda recusada pelo destinatario (codigos 4, 9, 11, 88)
  /endereco.*(nao localiz|incompleto|incorret)/, // 6, 102-108
  /tentativa de entrega/, // entrega tentada e nao concluida -- o caso classico do quadro
  /cep fora de abrangencia/, // 13
  /nao identificada no sistema/, // 41
  /nota fiscal divergente|invalida/, // 42
  /incidente.*veiculo/, // 58
  /destinatario desconhecido/, // 64
  /devolucao|devolvid/, // 66 -- casa tambem "em rota de devolucao"
  /sem documento de identificacao/, // 74
  /mudou de endereco/, // 77
  /violada|avariad/, // 78, 79, 11
  /extravi/, // 80, 81 -- casa "extravio" e "extraviado"
];

const AMBER_PATTERNS = [
  /reprogramada/, // 19
  /estabelecimento fechado/, // 21, 47
  /disponivel para retirada/, // 29
  /analise fiscal|em analise/, // 30, 84, 85
  /feriado local/, // 43
  /destinatario ausente/, // 46
  /redespachad/, // 52
  /problema operacional|na rota/, // 75
  /outro tipo de ocorrencia/, // 99
  /aguardando/,
  // A Mandae responde isso quando ainda nao ha evento nenhum. Amarelo aqui e
  // DECISAO, nao acidente: nao ha noticia, e se continuar assim por 5 dias
  // uteis o envelhecimento leva pra vermelho.
  /nenhuma atualizacao/,
];

const GREEN_PATTERNS = [
  /entrega realizada|pedido entregue/, // 1
  /processo iniciado/, // 0
  /coletad|em separacao/, // "Encomenda coletada" / "em processo de separacao": progresso normal
  /rota final|saiu para entrega/, // 31
  /em transito/, // 33
  /encomenda conferida/, // 101
  /recebeu as informacoes/, // 109
  /encomenda processada|objeto postado/, // 110
  // Textos confirmados na operacao (nao vieram da doc): a Mandae usa estes
  // com frequencia e todos sao andamento normal.
  /recebida na unidade/,   // chegou ao centro da transportadora
  /em rota/,               // em deslocamento (RED e checado antes, entao
                           // "em rota de devolucao" continua vermelho)
  /encaminhada/,           // seguiu para a proxima etapa
];

function matchesAny(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/**
 * @param {{name?: string, description?: string}} event - evento de rastreio da Mandae
 * @returns {{status: "green"|"amber"|"red", label: string}}
 */
export function mapMandaeEvent(event) {
  const original = [event?.name, event?.description].filter(Boolean).join(" ");
  if (!original) return { status: "amber", label: "Sem evento de rastreio ainda" };

  const text = normalizar(original);

  let status = "amber"; // padrao seguro para textos que ainda nao reconhecemos
  if (matchesAny(RED_PATTERNS, text)) status = "red";
  else if (matchesAny(GREEN_PATTERNS, text)) status = "green";
  else if (matchesAny(AMBER_PATTERNS, text)) status = "amber";

  // O label guarda o texto ORIGINAL (acentuado), que e o que a pessoa le no painel.
  return { status, label: event.name || event.description };
}

// Status vindos do WMS (FontesLog).
//
// Vocabulario REAL, lido da tela de Rastreamento do portal (nao da documentacao):
// EXPEDIDO, AGUARDANDO EXPEDICAO, EM SEPARACAO, CANCELADA -- e, pelo painel do
// Dashboard, tambem existem RECEBIDO, EM CONFERENCIA, CONFERIDO, PARADO e
// REJEITADO.
//
// Sobre AGUARDANDO EXPEDICAO ficar verde: e uma etapa normal do fluxo (o pedido
// foi separado e conferido, esta esperando a transportadora coletar), nao um
// problema. Um pedido que EMPACA nesse estado e pego pela regra de
// envelhecimento (aplicarEnvelhecimento), que olha o tempo parado -- nao faz
// sentido pintar de amarelo desde o primeiro minuto so porque o rotulo comeca
// com "aguardando".
export function mapFontesLogStatus(rawStatus) {
  if (!rawStatus) return null;
  const s = normalizar(rawStatus);

  // Problema declarado pelo armazem: o pedido nao vai sair sozinho.
  if (/cancel|rejeit|erro|divergen|falta|avaria|bloque/.test(s)) return "red";

  // "PARADO" e um status proprio do WMS: o armazem marcou que travou.
  if (/parado|impediment|pendente|analise/.test(s)) return "amber";

  // Fluxo normal: recebido -> em separacao -> em/pos conferencia ->
  // aguardando expedicao -> expedido.
  if (/recebid|separacao|conferenc|conferid|aguardando expedicao|expedid/.test(s)) return "green";

  // Rotulo novo que ainda nao conhecemos: amarelo, o padrao seguro.
  return "amber";
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

// ---------------------------------------------------------------------------
// Envelhecimento: pedido parado tempo demais
// ---------------------------------------------------------------------------
//
// Por que isso e necessario: as regras acima olham o ULTIMO evento conhecido.
// Um pedido que foi coletado e nunca mais se mexeu tem, como ultimo evento,
// "Encomenda coletada" -- um evento bom. Sem envelhecimento ele ficaria VERDE
// para sempre, e o quadro esconderia justamente o caso mais comum e mais caro
// da operacao: o pedido esquecido. Nao e um evento de erro que denuncia esse
// pedido, e o silencio.
//
// A contagem e em DIAS UTEIS (ver src/lib/diasUteis.js). Dia corrido acusaria
// atraso em todo fim de semana e feriado prolongado.

import { diasUteisDesde } from "./diasUteis.js";

// Eventos que encerram a vida do pedido: depois deles o silencio e esperado,
// entao envelhecer seria errado -- um pedido entregue fica verde para sempre.
const FINAL_PATTERNS = [/entrega realizada/, /(pedido|objeto|encomenda) entregue/];

export function ehEventoFinal(texto) {
  if (!texto) return false;
  const t = normalizar(texto);
  return FINAL_PATTERNS.some((re) => re.test(t));
}

/**
 * O WMS tambem tem um "fim da linha", e ele nao e a entrega.
 *
 * Depois de EXPEDIDO, o pedido saiu do armazem: a FontesLog nao vai registrar
 * mais nada, e o destino dele passa a ser assunto da transportadora. Sem essa
 * regra, todo pedido expedido ha mais de 5 dias uteis envelhecia e virava
 * vermelho -- o quadro ficava com uma parede de alarme falso onde estao
 * justamente os pedidos que o armazem despachou direitinho.
 *
 * CANCELADA tambem encerra: nao ha o que esperar de um pedido cancelado (a cor
 * dele ja e vermelha por conta propria).
 */
const WMS_FINAL = [/expedid/, /cancel/];

export function ehStatusWmsFinal(status) {
  if (!status) return false;
  const s = normalizar(status);
  return WMS_FINAL.some((re) => re.test(s));
}

export function limitesDeEnvelhecimento() {
  return {
    aviso: Number(process.env.DIAS_UTEIS_AVISO || 5),
    problema: Number(process.env.DIAS_UTEIS_PROBLEMA || 10),
  };
}

/**
 * Piora o status de um pedido que parou de dar noticias.
 *
 * So piora, nunca melhora: um pedido ja vermelho continua vermelho, e um
 * pedido entregue nunca envelhece.
 *
 * @returns {{status, diasParados, motivo: string|null}}
 */
export function aplicarEnvelhecimento({ status, lastEventAt, rotuloUltimoEvento, wmsStatus, agora = new Date() }) {
  const semMudanca = { status, diasParados: 0, motivo: null };
  if (!lastEventAt) return semMudanca;
  if (ehEventoFinal(rotuloUltimoEvento)) return semMudanca; // entregue: fim da linha

  // Expedido pelo armazem e sem nenhuma noticia da transportadora: o WMS
  // cumpriu o papel dele e nao tem mais o que registrar. Quem manda no relogio
  // a partir daqui e a Mandae -- e enquanto ela nao trouxer o primeiro evento,
  // nao ha silencio a cobrar de ninguem.
  if (ehStatusWmsFinal(wmsStatus) && !rotuloUltimoEvento) return semMudanca;
  if (status === "red") return { ...semMudanca, diasParados: diasUteisDesde(lastEventAt, agora) };

  const diasParados = diasUteisDesde(lastEventAt, agora);
  const { aviso, problema } = limitesDeEnvelhecimento();

  if (diasParados >= problema) {
    return { status: "red", diasParados, motivo: `Parado ha ${diasParados} dias uteis sem nenhum evento novo` };
  }
  if (diasParados >= aviso) {
    return { status: "amber", diasParados, motivo: `Parado ha ${diasParados} dias uteis sem nenhum evento novo` };
  }
  return { ...semMudanca, diasParados };
}
