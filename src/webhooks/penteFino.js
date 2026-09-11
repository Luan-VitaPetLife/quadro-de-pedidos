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

import { listOrders, upsertOrder, mesclarEmCanonico, chaveNota, getOrder } from "../lib/db.js";
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

// O canonico e quem NAO tem cara de numero interno do WMS: "ATB0240367" so
// existe dentro do portal da FontesLog, e ninguem procura um pedido por ele.
function escolherCanonico(lista) {
  return lista.find((o) => !/^ATB/i.test(o.orderNumber)) || lista[0];
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
    faltandoNoQuadro: [],
    eventoAtrasado: [],
    semFonteNenhuma: [],
  };
  const corrigidos = { mesclados: 0, rastreiosAtualizados: 0, eventosPuxados: 0 };

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
      const noQuadro = getOrder(numero);

      if (!noQuadro) {
        // Pedido que ja tem rastreio ou nota deveria ter quadrado.
        if (rastreioBling || detalhe?.notaFiscal?.id) {
          achados.faltandoNoQuadro.push({
            pedido: numero,
            cliente: dados?.cliente || null,
            rastreio: rastreioBling,
            temNota: !!detalhe?.notaFiscal?.id,
          });
        }
        continue;
      }

      if (rastreioBling && noQuadro.trackingCode && rastreioBling !== noQuadro.trackingCode) {
        achados.rastreioDivergente.push({
          pedido: numero,
          noQuadro: noQuadro.trackingCode,
          noBling: rastreioBling,
        });
        // O Bling e a fonte do codigo: e ele quem fala com a transportadora.
        if (corrigir) {
          upsertOrder({ orderNumber: numero, trackingCode: rastreioBling });
          corrigidos.rastreiosAtualizados++;
        }
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
      if (!evento?.description) continue;
      if (evento.description === o.carrierStatus) continue;

      achados.eventoAtrasado.push({
        pedido: o.orderNumber,
        rastreio: o.trackingCode,
        noQuadro: o.carrierStatus || "(nenhum)",
        naMandae: evento.description,
        quando: evento.occurredAt || null,
      });
      if (corrigir) {
        upsertOrder({
          orderNumber: o.orderNumber,
          carrierStatus: evento.description,
          carrierSeverity: mapMandaeEvent(evento.description),
          coletaPrevista: coletaPrevista(tracking) || undefined,
          lastEventAt: evento.occurredAt || undefined,
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
      faltandoNoQuadro: achados.faltandoNoQuadro.length,
      eventoAtrasado: achados.eventoAtrasado.length,
      semFonteNenhuma: achados.semFonteNenhuma.length,
    },
    corrigidos: corrigir ? corrigidos : null,
    achados,
  });
}
