// Sincroniza as NOTAS FISCAIS do Bling.
//
// Por que uma rotina propria, separada dos pedidos de venda:
//
// Nem toda remessa nasce de um pedido de venda. Doacao e bonificacao costumam
// sair direto como NOTA -- o caso que expos isso foi a cliente Raquel Faria,
// com 3 notas e apenas 1 pedido. Quem le so pedido de venda nunca enxerga
// essas remessas, e elas somem do radar mesmo tendo sido despachadas.
//
// Alem disso:
//   - a NATUREZA DE OPERACAO, que decide se e bonificacao, e campo de NOTA;
//   - a Mandae recebe o NUMERO DA NOTA como referencia do parceiro em varios
//     casos, entao a nota e o webhook dela caem na MESMA chave e se fundem
//     sozinhos, sem precisar de mesclagem.
//
// A nota NAO traz codigo de rastreio (seus `volumes` so tem id), mas traz o
// `transportador` -- e transportador definido significa que a remessa saiu.

import {
  listarNotas,
  detalheNota,
  naturezasDeOperacao,
  ehNaturezaDeBonificacao,
  nomeDaLoja,
} from "./integrations/bling.js";
import { upsertOrder, getOrder, setMeta } from "./lib/db.js";

export async function runSyncNotas({ dias = 30 } = {}) {
  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - dias * 86400000);

  console.log(`[notas] lendo notas fiscais dos ultimos ${dias} dia(s)...`);
  const naturezas = await naturezasDeOperacao();
  const notas = await listarNotas({ dataDe: inicio, dataAte: hoje });
  console.log(`[notas] ${notas.length} nota(s) na listagem.`);

  const resumo = { lidas: notas.length, bonificacoes: 0, criadas: 0, atualizadas: 0, semTransportador: 0, erros: 0 };

  for (const n of notas) {
    try {
      const detalhe = await detalheNota(n.id);
      const numero = String(n.numero ?? detalhe?.numero ?? "").trim();
      if (!numero) continue;

      const idNatureza = detalhe?.naturezaOperacao?.id ?? n?.naturezaOperacao?.id;
      const natureza = naturezas[String(idNatureza)] || detalhe?.naturezaOperacao?.descricao || null;
      const bonificacao = ehNaturezaDeBonificacao(natureza);
      if (bonificacao) resumo.bonificacoes++;

      const transportador = detalhe?.transporte?.transportador?.nome || null;
      const jaExiste = !!getOrder(numero);

      // Sem transportador a remessa ainda nao saiu: nao vira quadrado novo.
      // (Se ja existe um quadrado com essa chave, seguimos enriquecendo.)
      if (!jaExiste && !transportador) {
        resumo.semTransportador++;
        continue;
      }
      if (!jaExiste) resumo.criadas++;

      upsertOrder({
        orderNumber: numero,
        customer: detalhe?.contato?.nome || n?.contato?.nome || undefined,
        brand: (await nomeDaLoja(detalhe?.loja?.id ?? n?.loja?.id)) || undefined,
        natureza: natureza || undefined,
        bonificacao: bonificacao || undefined,
        placedAt: n.dataEmissao || detalhe?.dataEmissao || undefined,
        lastEventAt: n.dataEmissao || detalhe?.dataEmissao || undefined,
      });
      resumo.atualizadas++;
    } catch (err) {
      resumo.erros++;
      console.error(`[notas] falha na nota ${n?.numero ?? n?.id}: ${err.message}`);
      if (String(err.message).startsWith("BLING_NAO_AUTORIZADO")) throw err;
    }
  }

  setMeta("lastNotasSyncAt", new Date().toISOString());
  console.log(
    `[notas] concluido: ${resumo.atualizadas} gravada(s), ${resumo.criadas} nova(s) no radar, ` +
      `${resumo.bonificacoes} bonificacao(oes), ${resumo.semTransportador} sem transportador, ` +
      `${resumo.erros} erro(s).`
  );
  return resumo;
}
