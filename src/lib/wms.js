// A leitura do WMS da FontesLog, num lugar que os dois lados alcancam.
//
// Antes isto morava dentro de src/sync-fonteslog.js, um script de linha de
// comando -- e por isso o WMS so entrava no quadro quando alguem estava na
// frente do computador pra rodar. Aqui, o agendador do servidor le sozinho.
//
// O que continua exigindo gente: o LOGIN, por causa do reCAPTCHA. Ler nao; ler
// e um GET com cookie. Ver o comentario em integrations/fonteslog.js.

import {
  buscarPedidos,
  buscarPedidosParados,
  buscarPedidosRejeitados,
  ultimoMovimento,
} from "../integrations/fonteslog.js";
import { mapFontesLogStatus } from "./statusMapping.js";
import { conferirSessao, sessaoGravadaEm, temSessao } from "../integrations/fonteslog.js";
import { getMeta, setMeta, upsertOrder } from "./db.js";

/**
 * Le as tres telas do portal e devolve um pedido por linha, ja com a cor.
 *
 * @param {{dias?: number}} opcoes
 * @returns {Promise<{pedidos: Array<object>, parados: number, rejeitados: number, lidos: number}>}
 */
export async function lerWms({ dias = 60 } = {}) {
  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - dias * 86400000);

  const pedidos = await buscarPedidos({ dataDe: inicio, dataAte: hoje });

  const porPedido = new Map();
  for (const p of pedidos) {
    porPedido.set(p.numeroPedido, {
      numeroPedido: p.numeroPedido,
      status: p.status,
      severidade: null, // deixa mapFontesLogStatus decidir pelo status seco
      // O WMS mostra "000000246 - 001" (numero - serie). E por esse numero que
      // a operacao acha a nota no Bling, entao ele vai junto pro quadro.
      notaFiscal: p.notaFiscal || null,
      ultimoMovimento: ultimoMovimento(p),
    });
  }

  // ---------------------------------------------------------------------
  // As telas de PROBLEMA, que e o motivo do quadro existir.
  //
  // A tela de Rastreamento mostra o status seco ("EM SEPARACAO"). Ja Pedidos
  // Parados e Pedidos Rejeitados trazem o MOTIVO -- e o motivo e exatamente o
  // que a pessoa precisa ler pra ir resolver. Por isso essas duas telas
  // SOBRESCREVEM o que veio do rastreamento.
  // ---------------------------------------------------------------------
  let parados = [];
  let rejeitados = [];
  try {
    parados = await buscarPedidosParados({ dataDe: inicio, dataAte: hoje });
    rejeitados = await buscarPedidosRejeitados({ dataDe: inicio, dataAte: hoje });
  } catch (err) {
    // Sessao morta e outra conversa: quem chamou precisa saber pra pedir login.
    if (err.message === "SESSAO_EXPIRADA") throw err;
    console.warn(`[wms] nao consegui ler parados/rejeitados: ${err.message}`);
  }

  for (const p of parados) {
    const anterior = porPedido.get(p.numeroPedido) || { numeroPedido: p.numeroPedido };
    porPedido.set(p.numeroPedido, {
      ...anterior,
      status: p.motivo ? `PARADO — ${p.motivo}` : "PARADO",
      notaFiscal: p.notaFiscal || anterior.notaFiscal || null,
      severidade: "amber", // aviso em aberto: alguem precisa resolver
      ultimoMovimento: anterior.ultimoMovimento || null,
    });
  }

  for (const p of rejeitados) {
    const anterior = porPedido.get(p.numeroPedido) || { numeroPedido: p.numeroPedido };
    porPedido.set(p.numeroPedido, {
      ...anterior,
      status: p.observacoes ? `REJEITADO — ${p.observacoes}` : "REJEITADO",
      notaFiscal: p.notaFiscal || anterior.notaFiscal || null,
      severidade: "red", // o WMS recusou: esse pedido nao vai ser separado
      ultimoMovimento: anterior.ultimoMovimento || null,
    });
  }

  return {
    pedidos: [...porPedido.values()],
    lidos: pedidos.length,
    parados: parados.length,
    rejeitados: rejeitados.length,
  };
}

/**
 * Grava no quadro os pedidos lidos do WMS.
 *
 * Usado pelos DOIS caminhos de entrada -- o agendador do servidor e a rota
 * /webhooks/fonteslog, que a maquina de quem opera ainda usa. Uma implementacao
 * so porque duas se separam com o tempo, e o dia em que se separassem o quadro
 * mostraria coisas diferentes dependendo de quem leu.
 *
 * @param {Array<object>} pedidos
 */
export function gravarPedidosWms(pedidos = []) {
  let gravados = 0;
  const ignorados = [];
  // O WMS nao cria pedido: ele so sabe de remessas que o Bling ja mandou pra
  // ele. Numero que nao casa com nada vira orfao, e o pente fino mostra.
  const naoCasaram = [];

  for (const p of pedidos) {
    const orderNumber = String(p.numeroPedido || "").trim();
    if (!orderNumber) {
      ignorados.push(p);
      continue;
    }

    // So mandamos os campos do WMS. O db.js recalcula a cor final combinando
    // com o que a Mandae ja souber do mesmo pedido -- e por isso que o pedido
    // aparece como UM quadrado, e nao dois.
    //
    // A severidade pode vir decidida da origem (`severidade`). Isso existe
    // porque as telas de Parados e Rejeitados trazem um MOTIVO em texto livre,
    // e deduzir a cor de um texto livre e pedir acidente: "PARADO: falta de
    // estoque" casaria com a regra de "falta" e viraria vermelho, quando parado
    // e amarelo. Quem leu a tela sabe a cor; mapFontesLogStatus fica so para o
    // status seco do rastreamento.
    const gravou = upsertOrder({
      orderNumber,
      wmsStatus: p.status || null,
      notaFiscal: p.notaFiscal || undefined,
      wmsSeverity: p.severidade || mapFontesLogStatus(p.status),
      lastEventAt: p.ultimoMovimento || undefined,
      // "ATB0240367" e nome que so existe dentro do portal da FontesLog. Se a
      // nota dessa remessa ja tem quadrado, e nele que este status entra --
      // senao o mesmo pedido aparece duas vezes, um lado com o status do
      // armazem e outro com o rastreio, cada um contando metade da historia.
      numeroProvisorio: true,
      fonte: "wms",
    });
    if (gravou) gravados++;
    else naoCasaram.push(orderNumber);
  }

  return { gravados, naoCasaram, ignorados: ignorados.length };
}

// ---------------------------------------------------------------------------
// O ciclo automatico, e o estado que o quadro mostra quando ele para
// ---------------------------------------------------------------------------
//
// A parte que nao da pra automatizar e o LOGIN: o portal exige reCAPTCHA, que
// existe exatamente pra impedir robo de entrar. Ja foi tentado por HTTP e nao
// passa -- o registro da tentativa esta no fim de integrations/fonteslog.js.
//
// Entao o desenho aceita o limite em vez de fingir que ele nao existe: o
// servidor le sozinho enquanto a sessao vive, mantem essa sessao viva o maximo
// que consegue, e quando ela morre DIZ EM VOZ ALTA, em vez de mostrar dados
// velhos como se fossem de agora. Dado velho sem aviso e pior do que dado
// nenhum: o quadro continua verde e ninguem vai olhar.

function anotarEstado(estado, detalhe = "") {
  if (getMeta("wmsSessaoEstado") !== estado) {
    setMeta("wmsSessaoEstado", estado);
    setMeta("wmsSessaoDesde", new Date().toISOString());
  }
  setMeta("wmsSessaoDetalhe", detalhe);
}

/**
 * Um ciclo de leitura do WMS, do jeito que o agendador chama.
 *
 * Nunca lanca: uma falha aqui nao pode derrubar o ciclo que ainda tem Bling e
 * Mandae pra sincronizar.
 */
export async function sincronizarWms({ dias = 60 } = {}) {
  if (!temSessao()) {
    anotarEstado("ausente", "nunca houve login neste servidor");
    return { ok: false, motivo: "ausente" };
  }

  try {
    const { pedidos, lidos, parados, rejeitados } = await lerWms({ dias });
    const { gravados, naoCasaram } = gravarPedidosWms(pedidos);

    anotarEstado("ok");
    setMeta("wmsUltimaLeituraEm", new Date().toISOString());
    setMeta(
      "wmsUltimoResultado",
      JSON.stringify({ lidos, parados, rejeitados, gravados, semCorrespondencia: naoCasaram.length })
    );
    console.log(
      `[wms] ${lidos} pedido(s) lidos, ${gravados} gravado(s), ${parados} parado(s), ${rejeitados} rejeitado(s).`
    );
    return { ok: true, lidos, gravados, parados, rejeitados };
  } catch (err) {
    if (err.message === "SESSAO_EXPIRADA") {
      anotarEstado("expirada", `expirou; o login foi feito em ${sessaoGravadaEm() || "?"}`);
      console.warn("[wms] a sessao da FontesLog expirou -- precisa de `npm run fonteslog-login`.");
      return { ok: false, motivo: "expirada" };
    }
    anotarEstado("indisponivel", err.message);
    console.error("[wms] falha ao ler o portal:", err.message);
    return { ok: false, motivo: "indisponivel", erro: err.message };
  }
}

/**
 * O pulso que mantem a sessao de pe entre um ciclo e outro.
 *
 * Isto e o coracao da automacao, e o motivo e uma particularidade do portal: o
 * cookie `ASP.NET_SessionId` nao tem data de validade. Quem decide quando ele
 * morre e o servidor, por INATIVIDADE -- a janela padrao do ASP.NET e 20
 * minutos, e ela reinicia a cada pedido. Um ciclo de sincronizacao de 2 horas
 * deixaria a sessao morrer sozinha entre um ciclo e outro, e o login manual
 * viraria rotina diaria. Batendo numa tela barata a cada poucos minutos, a
 * janela nunca fecha.
 *
 * O que ainda derruba, e contra o que nao ha jeito: o portal reiniciar (a
 * sessao vive na memoria do servidor deles) ou a propria DDS expirar por tempo
 * absoluto. Ai e login manual mesmo.
 */
export async function pulsarSessaoWms() {
  if (!temSessao()) {
    anotarEstado("ausente", "nunca houve login neste servidor");
    return { viva: false };
  }
  const r = await conferirSessao();
  if (r.viva) {
    anotarEstado("ok");
    setMeta("wmsUltimoPulsoEm", new Date().toISOString());
  } else if (r.indisponivel) {
    // Portal fora do ar nao e sessao morta -- pedir login nao resolveria.
    anotarEstado("indisponivel", r.motivo);
  } else {
    anotarEstado("expirada", `expirou; o login foi feito em ${sessaoGravadaEm() || "?"}`);
  }
  return r;
}

/** O que o quadro precisa saber pra avisar que o WMS parou. */
export function estadoDoWms() {
  let ultimo = null;
  try {
    ultimo = JSON.parse(getMeta("wmsUltimoResultado") || "null");
  } catch {
    ultimo = null;
  }
  return {
    estado: getMeta("wmsSessaoEstado") || (temSessao() ? "desconhecido" : "ausente"),
    desde: getMeta("wmsSessaoDesde") || null,
    detalhe: getMeta("wmsSessaoDetalhe") || "",
    ultimaLeituraEm: getMeta("wmsUltimaLeituraEm") || null,
    ultimoPulsoEm: getMeta("wmsUltimoPulsoEm") || null,
    loginFeitoEm: sessaoGravadaEm(),
    ultimoResultado: ultimo,
  };
}
