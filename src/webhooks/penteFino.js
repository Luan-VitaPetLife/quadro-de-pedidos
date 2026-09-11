// Pente fino: confere o quadro inteiro contra o Bling e a Mandae.
//
// Por que existe: cada integracao grava o que sabe e vai embora. Ninguem, ate
// agora, fazia a pergunta inversa -- "o que esta no quadro ainda bate com a
// realidade dos tres sistemas?". Sem essa pergunta, um erro de ponte (rastreio
// trocado, quadrado duplicado, evento que nunca chegou) fica no quadro para
// sempre, e o quadro passa a mentir com confianca.
//
// A rota SO LE por padrao. Com ?corrigir=1 ela aplica as correcoes que sao
// seguras por construcao -- mesclar duplicata e puxar evento novo -- e diz
// exatamente o que mexeu. Nada aqui apaga pedido.
//
//   GET /api/pente-fino?s=<segredo>
//   GET /api/pente-fino?s=<segredo>&dias=60&corrigir=1
//   GET /api/pente-fino?s=<segredo>&limiteMandae=80

import { listOrders, upsertOrder, mesclarEmCanonico, chaveNota, getOrder, resolverCanonico } from "../lib/db.js";
import { verifyMandaeWebhook } from "./mandae.js";

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

// Qual dos nomes fica com o quadrado.
//
// Nem todo numero identifica igual. Por ordem de quem a operacao reconhece:
//
//   1141          numero do pedido no Bling -- e o que a pessoa digita e procura
//   000218        numero da nota fiscal -- identifica, mas e o segundo nome
//   ATB0240367    numero interno do WMS -- so existe dentro do portal da FontesLog
//   VITPT000375   o proprio codigo de rastreio virou nome, porque a Mandae
//                 avisou de um envio que o quadro ainda nao conhecia
//
// Escolher errado nao perde dado (o perdedor vira apelido), mas troca o nome
// que aparece no quadrado -- e um quadrado chamado "VITPT000375" nao ajuda
// ninguem a achar o pedido.
function forcaDoNome(numero) {
  const n = String(numero);
  const prefixo = (process.env.MANDAE_PREFIXO_RASTREIO || "VITPT").toUpperCase();
  if (n.toUpperCase().startsWith(prefixo)) return 3;
  if (/^ATB/i.test(n)) return 2;
  if (/^0\d/.test(n)) return 1; // zeros a esquerda: cara de nota fiscal
  return 0;
}

function escolherCanonico(lista) {
  return [...lista].sort((a, b) => forcaDoNome(a.orderNumber) - forcaDoNome(b.orderNumber))[0];
}

export async function handlePenteFino(req, res) {
  if (!verifyMandaeWebhook(req)) return res.status(401).json({ error: "segredo invalido" });

  const dias = Number(req.query?.dias) || 30;
  const corrigir = req.query?.corrigir === "1";
  const limiteMandae = Number(req.query?.limiteMandae) || 120;

  const achados = {
    duplicataPorNota: [],
    duplicataPorRastreio: [],
    rastreioDivergente: [],
    rastreioFaltando: [],
    faltandoNoQuadro: [],
    eventoAtrasado: [],
    semFonteNenhuma: [],
  };
  const corrigidos = { mesclados: 0, rastreiosAtualizados: 0, eventosPuxados: 0, criados: 0 };

  const quadro = listOrders();

  // -------------------------------------------------------------------
  // 1. Duplicata dentro do proprio quadro -- nao custa chamada nenhuma.
  // -------------------------------------------------------------------
  // Duas remessas nunca compartilham nota nem codigo de rastreio. Se dois
  // quadrados compartilham, sao o mesmo pedido entrando por portas diferentes.
  for (const [chave, lista] of repetidos(quadro, (o) => chaveNota(o.notaFiscal))) {
    achados.duplicataPorNota.push({ nota: chave, pedidos: lista.map((o) => o.orderNumber) });
    if (corrigir) {
      const canonico = escolherCanonico(lista);
      const outros = lista.filter((o) => o.orderNumber !== canonico.orderNumber).map((o) => o.orderNumber);
      corrigidos.mesclados += mesclarEmCanonico(canonico.orderNumber, outros).mesclados;
    }
  }

  for (const [chave, lista] of repetidos(quadro, (o) => o.trackingCode)) {
    achados.duplicataPorRastreio.push({ rastreio: chave, pedidos: lista.map((o) => o.orderNumber) });
    if (corrigir) {
      const canonico = escolherCanonico(lista);
      const outros = lista.filter((o) => o.orderNumber !== canonico.orderNumber).map((o) => o.orderNumber);
      corrigidos.mesclados += mesclarEmCanonico(canonico.orderNumber, outros).mesclados;
    }
  }

  // Quadrado que nenhuma fonte sustenta. Nao apagamos aqui -- so mostramos,
  // porque limpeza automatica ja fez pedido sumir do quadro antes.
  for (const o of quadro) {
    if (!o.wmsStatus && !o.carrierStatus && !o.trackingCode && !o.temNota) {
      achados.semFonteNenhuma.push(o.orderNumber);
    }
  }

  // -------------------------------------------------------------------
  // 2. O que o Bling diz sobre cada pedido.
  // -------------------------------------------------------------------
  let conferidosNoBling = 0;
  try {
    const { listarPedidos, detalhePedido, extrairDoPedido } = await import("../integrations/bling.js");
    const hoje = new Date();
    const inicio = new Date(hoje.getTime() - dias * 86400000);
    const lista = await listarPedidos({ dataDe: inicio, dataAte: hoje });

    for (const resumido of lista) {
      const numero = String(resumido.numero ?? "").trim();
      if (!numero) continue;

      const detalhe = await detalhePedido(resumido.id);
      const dados = extrairDoPedido(detalhe);
      conferidosNoBling++;

      const rastreioBling = dados?.trackingCode || null;
      // Pelo canonico, nao pelo numero cru: um pedido absorvido por outro
      // quadrado continua no quadro, so que sob outro nome. Sem isto, toda
      // mesclagem bem-sucedida seria denunciada aqui como pedido sumido.
      const canonico = resolverCanonico(numero);
      const noQuadro = getOrder(canonico);

      if (!noQuadro) {
        // Pedido que ja tem rastreio ou nota deveria ter quadrado. Pedido sem
        // nenhum dos dois ainda nao virou entrega -- nao e ausencia, e cedo.
        if (rastreioBling || detalhe?.notaFiscal?.id) {
          achados.faltandoNoQuadro.push({
            pedido: numero,
            cliente: dados?.cliente || null,
            rastreio: rastreioBling,
            temNota: !!detalhe?.notaFiscal?.id,
          });
          // Criar o que falta e seguro: acrescenta quadrado, nao mexe em nenhum.
          if (corrigir) {
            upsertOrder({
              orderNumber: numero,
              customer: dados?.cliente || undefined,
              city: dados?.cidade ? `${dados.cidade}${dados.uf ? " - " + dados.uf : ""}` : undefined,
              trackingCode: rastreioBling || undefined,
              placedAt: dados?.data || undefined,
              previsaoEntrega: detalhe?.dataPrevista || undefined,
              temNota: !!detalhe?.notaFiscal?.id,
            });
            corrigidos.criados++;
          }
        }
        continue;
      }

      // Quadro sem codigo e Bling com codigo: preencher e sempre ganho.
      if (rastreioBling && !noQuadro.trackingCode) {
        achados.rastreioFaltando.push({ pedido: canonico, noBling: rastreioBling });
        if (corrigir) {
          upsertOrder({ orderNumber: canonico, trackingCode: rastreioBling });
          corrigidos.rastreiosAtualizados++;
        }
        continue;
      }

      // Os dois tem codigo, e sao diferentes: SO REPORTA, nunca troca.
      //
      // O caso que ensinou isso e o pedido 1453. O quadro tinha
      // "MEL47975051107FMDOF01", que e codigo de rastreio de verdade do
      // Mercado Envios, e o Bling tinha "4Y4A5GUKFRJKPO4K3YGNYQNSZY", que e
      // identificador interno do Mercado Livre e nao rastreia nada. "O Bling e
      // a fonte" parecia obvio e teria apagado o unico codigo util que o
      // pedido tinha. Divergencia de codigo e coisa pra olho humano.
      if (rastreioBling && noQuadro.trackingCode && rastreioBling !== noQuadro.trackingCode) {
        achados.rastreioDivergente.push({
          pedido: canonico,
          noQuadro: noQuadro.trackingCode,
          noBling: rastreioBling,
          nota: "conferir a mao -- o quadro nao troca codigo sozinho",
        });
      }
    }
  } catch (err) {
    achados.erroBling = err.message;
  }

  // -------------------------------------------------------------------
  // 3. A Mandae tem evento que o quadro nao viu?
  // -------------------------------------------------------------------
  //
  // O webhook pode ter falhado, chegado fora de ordem ou nunca ter sido
  // disparado. Reconsultar e a unica forma de saber. O custo e uma chamada por
  // rastreio, entao a varredura e limitada e comeca pelos mais antigos sem
  // novidade -- que sao justamente os que mais provavelmente perderam evento.
  let conferidosNaMandae = 0;
  try {
    const { fetchTracking, latestEvent, coletaPrevista } = await import("../integrations/mandae.js");
    const { mapMandaeEvent } = await import("../lib/statusMapping.js");
    const prefixo = (process.env.MANDAE_PREFIXO_RASTREIO || "VITPT").toUpperCase();

    const candidatos = listOrders()
      .filter((o) => o.trackingCode && String(o.trackingCode).toUpperCase().startsWith(prefixo))
      .sort((a, b) => String(a.lastEventAt || "").localeCompare(String(b.lastEventAt || "")))
      .slice(0, limiteMandae);

    for (const o of candidatos) {
      let tracking;
      try {
        tracking = await fetchTracking(o.trackingCode);
      } catch {
        continue; // rastreio que a Mandae ainda nao conhece nao e divergencia
      }
      conferidosNaMandae++;
      const evento = latestEvent(tracking);
      if (!evento) continue;

      // Comparar pelo MESMO criterio com que o dado foi gravado.
      //
      // A primeira versao disto comparava `evento.description` cru contra o
      // carrierStatus e acusou 120 divergencias em 120 pedidos conferidos --
      // ou seja, nenhuma. O quadro nunca guardou a description: guarda o
      // `label` de mapMandaeEvent(), que prefere o `name` do evento. Duas
      // grandezas diferentes comparadas de igual para igual dao 100% de
      // divergencia, que e a assinatura de um alarme falso, nao de um problema.
      const mapeado = mapMandaeEvent(evento);
      const quando = evento.timestamp || evento.date || null;
      const agendada = coletaPrevista(tracking) || null;

      const mudou =
        mapeado.label !== o.carrierStatus ||
        mapeado.status !== o.carrierSeverity ||
        (quando && quando !== o.lastEventAt) ||
        agendada !== (o.coletaPrevista || null);
      if (!mudou) continue;

      achados.eventoAtrasado.push({
        pedido: o.orderNumber,
        rastreio: o.trackingCode,
        noQuadro: o.carrierStatus || "(nenhum)",
        naMandae: mapeado.label,
        quando,
      });
      if (corrigir) {
        upsertOrder({
          orderNumber: o.orderNumber,
          carrierStatus: mapeado.label,
          carrierSeverity: mapeado.status,
          coletaPrevista: agendada,
          // Nunca "agora": o relogio do envelhecimento conta a partir do evento
          // de verdade. Carimbar a hora da varredura zeraria o contador de todo
          // pedido parado -- e o parado e o motivo de o quadro existir.
          lastEventAt: quando || undefined,
        });
        corrigidos.eventosPuxados++;
      }
    }
  } catch (err) {
    achados.erroMandae = err.message;
  }

  res.json({
    quando: new Date().toISOString(),
    janelaDias: dias,
    modo: corrigir ? "conferiu e corrigiu" : "so conferiu",
    conferidos: { noQuadro: quadro.length, noBling: conferidosNoBling, naMandae: conferidosNaMandae },
    resumo: {
      duplicataPorNota: achados.duplicataPorNota.length,
      duplicataPorRastreio: achados.duplicataPorRastreio.length,
      rastreioDivergente: achados.rastreioDivergente.length,
      rastreioFaltando: achados.rastreioFaltando.length,
      faltandoNoQuadro: achados.faltandoNoQuadro.length,
      eventoAtrasado: achados.eventoAtrasado.length,
      semFonteNenhuma: achados.semFonteNenhuma.length,
    },
    corrigidos: corrigir ? corrigidos : null,
    achados,
  });
}
