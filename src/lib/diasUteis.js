// Contagem de dias UTEIS no calendario brasileiro.
//
// Por que isso existe: o quadro precisa saber ha quanto tempo um pedido esta
// parado, e dia corrido mente. Um pedido coletado num sabado, com feriado na
// segunda, so pode andar na terca -- contar 3 dias de atraso ai seria acusar
// a operacao de uma parada que nunca existiu.
//
// Fuso: as datas da Mandae vem como "2026-09-08T18:10:55", sem indicacao de
// fuso, ou seja, ja no horario de Brasilia. Por isso, quando a string nao traz
// fuso, pegamos a data direto dos 10 primeiros caracteres em vez de deixar o
// Date interpretar (num servidor em UTC, como o do Railway, "18:10" viraria
// outro dia perto da meia-noite).

const FUSO = "America/Sao_Paulo";

/**
 * Domingo de Pascoa do ano (algoritmo de Meeus/Jones/Butcher). Serve de ancora
 * para os feriados moveis: Carnaval, Sexta-feira Santa e Corpus Christi.
 */
function domingoDePascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(ano, mes - 1, dia);
}

const DIA = 86400000;

function paraChave(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Feriados nacionais do ano, como Set de "YYYY-MM-DD".
 *
 * Inclui Carnaval (segunda e terca) e Corpus Christi. Juridicamente esses sao
 * ponto facultativo, nao feriado nacional -- mas transportadora e centro de
 * distribuicao param neles, e o que interessa aqui e quando a operacao anda de
 * verdade, nao o que diz a lei. Se a sua operacao trabalhar nesses dias, e so
 * tirar as tres linhas marcadas.
 */
export function feriadosBrasil(ano) {
  const pascoa = domingoDePascoa(ano);
  const fixos = [
    [0, 1],   // Confraternizacao Universal
    [3, 21],  // Tiradentes
    [4, 1],   // Dia do Trabalho
    [8, 7],   // Independencia
    [9, 12],  // Nossa Senhora Aparecida
    [10, 2],  // Finados
    [10, 15], // Proclamacao da Republica
    [10, 20], // Consciencia Negra (nacional desde a Lei 14.759/2023)
    [11, 25], // Natal
  ];

  const dias = fixos.map(([m, d]) => paraChave(Date.UTC(ano, m, d)));
  dias.push(paraChave(pascoa - 48 * DIA)); // Carnaval (segunda)   <- ponto facultativo
  dias.push(paraChave(pascoa - 47 * DIA)); // Carnaval (terca)     <- ponto facultativo
  dias.push(paraChave(pascoa - 2 * DIA));  // Sexta-feira Santa
  dias.push(paraChave(pascoa + 60 * DIA)); // Corpus Christi       <- ponto facultativo

  return new Set(dias);
}

const cacheFeriados = new Map();
function feriadosDoAno(ano) {
  if (!cacheFeriados.has(ano)) cacheFeriados.set(ano, feriadosBrasil(ano));
  return cacheFeriados.get(ano);
}

/** "YYYY-MM-DD" e dia util? (nao e sabado, domingo nem feriado) */
export function ehDiaUtil(chave) {
  const [a, m, d] = chave.split("-").map(Number);
  const ms = Date.UTC(a, m - 1, d);
  const semana = new Date(ms).getUTCDay(); // 0 = domingo, 6 = sabado
  if (semana === 0 || semana === 6) return false;
  return !feriadosDoAno(a).has(chave);
}

/**
 * Converte um instante (Date, ou string ISO da Mandae) para a data do
 * calendario "YYYY-MM-DD" no horario de Brasilia.
 */
export function dataLocal(valor) {
  if (typeof valor === "string") {
    // Sem fuso na string ("2026-09-08T18:10:55" ou "2026-09-08 18:10"): a
    // Mandae ja manda em horario de Brasilia, entao a data e o proprio prefixo.
    if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(valor) && !/(Z|[+-]\d{2}:?\d{2})$/.test(valor)) {
      return valor.slice(0, 10);
    }
  }
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  // Com fuso explicito: converte de verdade para o calendario de Brasilia.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Quantos dias uteis se passaram DEPOIS de `desde`, ate `ate` (inclusive).
 *
 * O dia do proprio evento nao conta: um pedido que andou hoje nao esta parado
 * ha nenhum dia. Coletado no sabado 05 e olhando na terca 08, com feriado na
 * segunda 07, o resultado e 1 -- a terca.
 */
export function diasUteisDesde(desde, ate = new Date()) {
  const inicio = dataLocal(desde);
  const fim = dataLocal(ate);
  if (!inicio || !fim || fim < inicio) return 0;

  let contador = 0;
  const [ai, mi, di] = inicio.split("-").map(Number);
  let ms = Date.UTC(ai, mi - 1, di) + DIA; // comeca no dia seguinte ao evento

  // Trava de seguranca: um pedido muito antigo nao deve custar um laco enorme.
  for (let i = 0; i < 400; i++) {
    const chave = paraChave(ms);
    if (chave > fim) break;
    if (ehDiaUtil(chave)) contador++;
    ms += DIA;
  }
  return contador;
}
