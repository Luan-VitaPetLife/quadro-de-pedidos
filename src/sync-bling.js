// Sincronizacao com o Bling: cadastro e PONTE entre os outros dois sistemas.
//
// Roda DENTRO do quadro (Railway), diferente do sync da FontesLog: o Bling nao
// tem captcha, entao uma vez autorizado o proprio servidor consulta sozinho.
//
// O QUE ELA FAZ, e por que:
//
// O Bling manda referencias diferentes para cada sistema. O WMS recebe o
// `numero` do Bling ("1445"); a Mandae recebe o `numeroLoja` do marketplace
// ("7416887836984") -- e as vezes nem isso, e o pedido entra pelo codigo de
// rastreio. Resultado: a mesma venda ocupa dois ou tres quadrados.
//
// So o Bling conhece as tres chaves ao mesmo tempo. Entao esta rotina le os
// pedidos dele, adota o `numero` como chave canonica (e a que o WMS usa e a
// que a operacao reconhece) e mescla os quadrados duplicados nela. De quebra
// preenche cliente, loja e cidade, que nem o WMS nem a Mandae tem.
//
// NAO mexe em cor: quem diz se o pedido esta bem ou mal sao o WMS e a
// transportadora. A `situacao` do Bling e ignorada de proposito.

import { listarPedidos, detalhePedido, extrairDoPedido, nomeDaLoja } from "./integrations/bling.js";
import { upsertOrder, mesclarEmCanonico, setMeta, getOrder, listOrders, apagarPedido } from "./lib/db.js";

export async function runSyncBling({ dias = 30 } = {}) {
  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - dias * 86400000);

  console.log(`[bling] lendo pedidos dos ultimos ${dias} dia(s)...`);
  const lista = await listarPedidos({ dataDe: inicio, dataAte: hoje });
  console.log(`[bling] ${lista.length} pedido(s) na listagem.`);

  const resumo = { lidos: lista.length, comRastreio: 0, mesclados: 0, atualizados: 0, ignorados: 0, removidos: 0, erros: 0 };

  for (const resumido of lista) {
    try {
      // O rastreio so existe no DETALHE -- a listagem nao traz transporte.
      const detalhe = await detalhePedido(resumido.id);
      const dados = extrairDoPedido(detalhe);
      if (!dados?.numeroPedido) continue;

      const canonico = dados.numeroPedido;
      const numeroLoja = detalhe?.numeroLoja ? String(detalhe.numeroLoja).trim() : null;

      // Os quadrados que podem ser a MESMA venda entrada por outra porta.
      const apelidos = [numeroLoja, dados.trackingCode].filter(Boolean);
      const merge = mesclarEmCanonico(canonico, apelidos);
      resumo.mesclados += merge.mesclados;

      if (dados.trackingCode) resumo.comRastreio++;

      // O Bling ENRIQUECE e UNE -- nao cria quadrado.
      //
      // Aprendido na pratica: deixar o Bling criar encheu o quadro de 158
      // quadrados amarelos falsos. Sao vendas que ainda nao chegaram ao WMS,
      // ou que saem por logistica de marketplace e nunca passam por ele. Sem
      // status de nenhuma das duas fontes, combineStatus() devolve amarelo por
      // padrao -- e amarelo, no nosso quadro, significa "aviso em aberto".
      // Cento e cinquenta e oito avisos que nao existem.
      //
      // Quem decide que um pedido merece um quadrado sao o WMS e a
      // transportadora, que e onde a operacao acontece. O Bling entra depois,
      // pra dizer de quem e o pedido e pra juntar o que estava separado.
      if (!getOrder(canonico)) {
        resumo.ignorados++;
        continue;
      }

      upsertOrder({
        orderNumber: canonico,
        customer: dados.cliente || undefined,
        brand: (await nomeDaLoja(detalhe?.loja?.id)) || dados.loja || undefined,
        city: dados.cidade ? `${dados.cidade}${dados.uf ? " - " + dados.uf : ""}` : undefined,
        trackingCode: dados.trackingCode || undefined,
        placedAt: dados.data || undefined,
      });
      resumo.atualizados++;
    } catch (err) {
      resumo.erros++;
      console.error(`[bling] falha no pedido ${resumido?.numero ?? resumido?.id}: ${err.message}`);
      if (err.message.startsWith("BLING_NAO_AUTORIZADO")) throw err; // nao adianta seguir
    }
  }

  resumo.removidos = limparPedidosSemStatus();

  setMeta("lastBlingSyncAt", new Date().toISOString());
  console.log(
    `[bling] concluido: ${resumo.atualizados} enriquecido(s), ${resumo.comRastreio} com rastreio, ` +
      `${resumo.mesclados} duplicado(s) mesclado(s), ${resumo.ignorados} sem quadrado (ignorado), ` +
      `${resumo.removidos} sem status removido(s), ${resumo.erros} erro(s).`
  );
  return resumo;
}

/**
 * Remove do quadro os pedidos que nao tem status de NENHUMA das duas fontes.
 *
 * Um pedido sem wmsStatus e sem carrierStatus so pode ter vindo do cadastro do
 * Bling -- o WMS e a Mandae sempre gravam um status junto. Esses registros
 * apareciam como amarelo (o padrao de combineStatus quando nao ha severidade
 * nenhuma), fingindo um aviso que nao existe.
 *
 * Existe pra limpar o que a versao anterior desta sincronizacao criou. Como so
 * apaga registro sem nenhuma informacao de operacao, nao ha o que se perder:
 * se o pedido voltar pelo WMS ou pela Mandae, ele entra de novo com status de
 * verdade.
 */
export function limparPedidosSemStatus() {
  const semStatus = listOrders().filter((o) => !o.wmsStatus && !o.carrierStatus);
  for (const o of semStatus) apagarPedido(o.orderNumber);
  return semStatus.length;
}
