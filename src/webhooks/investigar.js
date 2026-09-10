// Rastreia um pedido (ou um cliente) nos tres sistemas de uma vez.
//
// Nasceu de um caso concreto: a cliente Raquel Faria tem 3 pedidos, um deles
// extraviado na Mandae, e o quadro mostrava so 1 -- verde. Um quadro que
// esconde extravio falha no unico proposito que tem.
//
// A pergunta que essa rota responde e "onde esse pedido esta em cada sistema, e
// por que ele nao chegou no quadro?". Sem ela, cada caso desses vira uma
// investigacao manual em tres paineis diferentes.
//
// GET /api/investigar?s=<segredo>&cliente=Raquel
// GET /api/investigar?s=<segredo>&pedido=1205
// GET /api/investigar?s=<segredo>&dias=120        (janela da busca no Bling)

import { listOrders, getOrder } from "../lib/db.js";
import { verifyMandaeWebhook } from "./mandae.js";

export async function handleInvestigar(req, res) {
  if (!verifyMandaeWebhook(req)) return res.status(401).json({ error: "segredo invalido" });

  const cliente = req.query?.cliente ? String(req.query.cliente).trim() : null;
  const pedido = req.query?.pedido ? String(req.query.pedido).trim() : null;
  const dias = Number(req.query?.dias) || 120;

  if (!cliente && !pedido) {
    return res.status(400).json({ error: "informe ?cliente=NOME ou ?pedido=NUMERO" });
  }

  const normalizar = (t) =>
    String(t || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

  try {
    const { listarPedidos, detalhePedido, extrairDoPedido } = await import("../integrations/bling.js");
    const { fetchTracking, latestEvent } = await import("../integrations/mandae.js");
    const { mapMandaeEvent } = await import("../lib/statusMapping.js");

    // ---- o que o QUADRO conhece ----
    const noQuadro = listOrders().filter((o) => {
      if (pedido) return o.orderNumber === pedido || o.trackingCode === pedido;
      return normalizar(o.customer).includes(normalizar(cliente));
    });

    // ---- o que o BLING conhece ----
    // A listagem ja traz `contato`, entao da pra filtrar sem gastar uma chamada
    // de detalhe por pedido -- so os que casam viram detalhe.
    const hoje = new Date();
    const inicio = new Date(hoje.getTime() - dias * 86400000);
    const lista = await listarPedidos({ dataDe: inicio, dataAte: hoje });

    const candidatos = lista.filter((p) => {
      if (pedido) return String(p.numero) === pedido || String(p.numeroLoja || "") === pedido;
      return normalizar(p?.contato?.nome).includes(normalizar(cliente));
    });

    const achados = [];
    for (const c of candidatos.slice(0, 25)) {
      const detalhe = await detalhePedido(c.id);
      const dados = extrairDoPedido(detalhe);
      const rastreio = dados?.trackingCode || null;

      // ---- o que a MANDAE diz desse rastreio ----
      let mandae = null;
      if (rastreio && /^VITPT/i.test(rastreio)) {
        try {
          const t = await fetchTracking(rastreio);
          const ultimo = t ? latestEvent(t) : null;
          mandae = ultimo
            ? { evento: ultimo.name || ultimo.description, quando: ultimo.timestamp || ultimo.date, cor: mapMandaeEvent(ultimo).status }
            : { evento: null, aviso: "rastreio sem eventos" };
        } catch (err) {
          mandae = { erro: err.message };
        }
      }

      const noQuadroEste = getOrder(String(detalhe?.numero ?? "")) || null;

      achados.push({
        blingNumero: detalhe?.numero ?? null,
        blingNumeroLoja: detalhe?.numeroLoja ?? null,
        data: detalhe?.data ?? null,
        situacaoBling: detalhe?.situacao?.valor ?? detalhe?.situacao ?? null,
        cliente: dados?.cliente ?? null,
        transportadora: detalhe?.transporte?.contato?.nome ?? null,
        rastreio,
        mandae,
        estaNoQuadro: !!noQuadroEste,
        // O diagnostico que interessa: se a Mandae sabe de um problema e o
        // quadro nao tem o pedido, o quadro esta escondendo um problema real.
        diagnostico: !noQuadroEste
          ? rastreio
            ? "FALTA NO QUADRO (tem rastreio: deveria estar la)"
            : "fora do quadro (sem rastreio: ainda nao despachado)"
          : noQuadroEste.carrierStatus
            ? "no quadro, com status da transportadora"
            : "no quadro, MAS SEM status da transportadora",
      });
    }

    res.json({
      procurado: pedido ? { pedido } : { cliente },
      janelaDias: dias,
      noQuadro: noQuadro.map((o) => ({
        orderNumber: o.orderNumber,
        status: o.status,
        wmsStatus: o.wmsStatus,
        carrierStatus: o.carrierStatus,
        trackingCode: o.trackingCode,
        cliente: o.customer,
      })),
      noBling: achados,
      resumo: {
        pedidosNoBling: candidatos.length,
        pedidosNoQuadro: noQuadro.length,
        faltandoNoQuadro: achados.filter((a) => a.diagnostico.startsWith("FALTA")).length,
      },
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}
