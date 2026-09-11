// Junta quadrados que sao a MESMA remessa entrando por portas diferentes.
//
// Duas remessas nunca compartilham nota fiscal nem codigo de rastreio. Se dois
// quadrados compartilham, nao ha duvida: sao o mesmo pedido, e cada um esta
// contando metade da historia -- um com o status do armazem, outro com o
// rastreio, nenhum com a historia inteira.
//
// Isto nao consulta nada: e so o banco olhando pra si mesmo. Por isso roda em
// TODO ciclo do agendador, e nao so no pente fino: uma duplicata nao precisa
// esperar a varredura diaria pra sumir.

import { listOrders, mesclarEmCanonico, chaveNota } from "./db.js";

/** Agrupa por uma chave e devolve so os grupos com mais de um ocupante. */
function repetidos(pedidos, chaveDe) {
  const grupos = new Map();
  for (const o of pedidos) {
    const k = chaveDe(o);
    if (!k) continue;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(o);
  }
  return [...grupos.entries()].filter(([, lista]) => lista.length > 1);
}

/**
 * Qual dos nomes fica com o quadrado.
 *
 * Nem todo numero identifica igual. Por ordem de quem a operacao reconhece:
 *
 *   1141          numero do pedido no Bling -- e o que a pessoa digita e procura
 *   000218        numero da nota fiscal -- identifica, mas e o segundo nome
 *   ATB0240367    numero interno do WMS -- so existe dentro do portal da FontesLog
 *   VITPT000375   o proprio codigo de rastreio virou nome, porque a Mandae
 *                 avisou de um envio que o quadro ainda nao conhecia
 *
 * Escolher errado nao perde dado (o perdedor vira apelido), mas troca o nome
 * que aparece no quadrado -- e um quadrado chamado "VITPT000375" nao ajuda
 * ninguem a achar o pedido.
 */
export function forcaDoNome(numero) {
  const n = String(numero);
  const prefixo = (process.env.MANDAE_PREFIXO_RASTREIO || "VITPT").toUpperCase();
  if (n.toUpperCase().startsWith(prefixo)) return 3;
  if (/^ATB/i.test(n)) return 2;
  if (/^0\d/.test(n)) return 1; // zeros a esquerda: cara de nota fiscal
  return 0;
}

export function escolherCanonico(lista) {
  return [...lista].sort((a, b) => forcaDoNome(a.orderNumber) - forcaDoNome(b.orderNumber))[0];
}

/**
 * Acha (e opcionalmente funde) os quadrados duplicados.
 *
 * @param {{aplicar?: boolean}} opcoes  aplicar=false so relata.
 * @returns {{porNota: Array, porRastreio: Array, mesclados: number}}
 */
export function deduplicar({ aplicar = true } = {}) {
  const quadro = listOrders();
  const resultado = { porNota: [], porRastreio: [], mesclados: 0 };

  const juntar = (lista) => {
    const canonico = escolherCanonico(lista);
    const outros = lista
      .filter((o) => o.orderNumber !== canonico.orderNumber)
      .map((o) => o.orderNumber);
    if (aplicar) resultado.mesclados += mesclarEmCanonico(canonico.orderNumber, outros).mesclados;
    return { canonico: canonico.orderNumber, absorvidos: outros };
  };

  for (const [chave, lista] of repetidos(quadro, (o) => chaveNota(o.notaFiscal))) {
    resultado.porNota.push({ nota: chave, ...juntar(lista) });
  }

  // A segunda passada le o quadro DE NOVO: a primeira pode ter apagado
  // quadrados, e agrupar por rastreio usando a lista velha tentaria mesclar
  // registro que nao existe mais.
  const depois = aplicar ? listOrders() : quadro;
  for (const [chave, lista] of repetidos(depois, (o) => o.trackingCode)) {
    resultado.porRastreio.push({ rastreio: chave, ...juntar(lista) });
  }

  return resultado;
}
