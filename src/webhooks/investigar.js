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
    const bling = await import("../integrations/bling.js");
    const { listarPedidos, detalhePedido, extrairDoPedido, listarNotas, detalheNota, naturezasDeOperacao, ehNaturezaDeBonificacao } = bling;
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
        // Sonda decisiva: o pedido conhece a NOTA dele? E com que formato de
        // numero? A mesclagem depende disso pra unir o quadrado do pedido ao
        // que a nota (ou a Mandae, que usa o numero da NF) criou.
        notaFiscalDoPedido: detalhe?.notaFiscal ?? null,
        volumesDoPedido: detalhe?.transporte?.volumes ?? null,
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


    // ---- o que as NOTAS FISCAIS dizem ----
    //
    // Olhar nota, e nao so pedido de venda, foi o que destravou o caso da
    // Raquel Faria: ela tem 3 NOTAS e apenas 1 pedido de venda. Saida de
    // doacao/bonificacao costuma nascer direto como nota, sem pedido -- e quem
    // le so pedido nunca enxerga essas remessas.
    const naturezas = await naturezasDeOperacao();
    const notas = await listarNotas({ dataDe: inicio, dataAte: hoje });

    const notasCandidatas = notas.filter((n) => {
      if (pedido) return String(n.numero) === pedido;
      return normalizar(n?.contato?.nome).includes(normalizar(cliente));
    });

    const notasAchadas = [];
    for (const n of notasCandidatas.slice(0, 25)) {
      let detalhe = null;
      try {
        detalhe = await detalheNota(n.id);
      } catch {
        /* segue com o resumo da listagem */
      }
      const idNatureza = detalhe?.naturezaOperacao?.id ?? n?.naturezaOperacao?.id;
      const nomeNatureza = naturezas[String(idNatureza)] || null;
      const numeroNota = String(n.numero ?? detalhe?.numero ?? "");

      notasAchadas.push({
        numero: numeroNota,
        emissao: n.dataEmissao ?? detalhe?.dataEmissao ?? null,
        valor: n.valorNota ?? detalhe?.valorNota ?? null,
        situacao: n.situacao ?? detalhe?.situacao ?? null,
        cliente: n?.contato?.nome ?? detalhe?.contato?.nome ?? null,
        natureza: nomeNatureza,
        ehBonificacao: ehNaturezaDeBonificacao(nomeNatureza),
        // A Mandae recebe o numero da nota como referencia do parceiro em
        // varios casos -- e por isso que o quadro tem quadrados "000222".
        estaNoQuadroPeloNumeroDaNota: !!getOrder(numeroNota),
        // Sonda: a nota carrega rastreio/transportadora? So o dado real responde.
        camposDaNota: detalhe ? Object.keys(detalhe) : null,
        transporteDaNota: detalhe?.transporte ?? null,
        // Sonda: onde exatamente mora o rastreio na nota? O Bling mostra
        // "Objetos de postagem -> Tracking" na tela, mas a primeira leitura da
        // API so trouxe volumes:[{id}]. Dump completo pra achar o campo.
        volumesCrus: detalhe?.transporte?.volumes ?? null,
        numeroPedidoLoja: detalhe?.numeroPedidoLoja ?? null,
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
      notasFiscais: notasAchadas,
      resumo: {
        pedidosNoBling: candidatos.length,
        pedidosNoQuadro: noQuadro.length,
        faltandoNoQuadro: achados.filter((a) => a.diagnostico.startsWith("FALTA")).length,
        notasEncontradas: notasCandidatas.length,
        notasForaDoQuadro: notasAchadas.filter((n) => !n.estaNoQuadroPeloNumeroDaNota).length,
      },
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}
