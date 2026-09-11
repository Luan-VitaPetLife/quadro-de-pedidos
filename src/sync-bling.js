// Sincronizacao com o Bling: cadastro, PONTE e descoberta.
//
// ORDEM DAS COISAS, e por que ela e assim:
//
// 1. Le as NOTAS primeiro e monta um mapa por ID. A nota tem a NATUREZA DE
//    OPERACAO (que decide bonificacao) e o NUMERO -- e o numero da nota e a
//    referencia que a Mandae usa, entao ele precisa virar apelido na mesclagem.
//
// 2. Le os PEDIDOS. O pedido tem o que a nota NAO tem: o codigo de rastreio
//    (`transporte.volumes[].codigoRastreamento`) e a data prevista. E traz
//    `notaFiscal: {id}` -- so o id, sem numero, que foi exatamente o que
//    quebrou a primeira tentativa de mesclagem.
//
// 3. As notas que nenhum pedido referenciou viram quadrado proprio. Sao as
//    remessas que nascem direto como nota: doacao e bonificacao.
//
// O caso que ensinou tudo isso: o pedido 1462 (VITPT000416) e a nota 000262
// eram a MESMA venda ocupando dois quadrados -- um com rastreio e outro
// dizendo "sem acompanhamento".

import {
  listarPedidos,
  detalhePedido,
  extrairDoPedido,
  nomeDaLoja,
  listarNotas,
  detalheNota,
  naturezasDeOperacao,
  ehNaturezaDeBonificacao,
  objetoDePostagem,
} from "./integrations/bling.js";
import { upsertOrder, mesclarEmCanonico, setMeta, getOrder, listOrders, apagarPedido, chaveNota, indicePorNota } from "./lib/db.js";

/**
 * Mapa das notas do periodo, indexado pelo ID (que e como o pedido as
 * referencia). Guarda tambem quais foram consumidas por algum pedido, pra
 * saber no fim quais precisam de quadrado proprio.
 */
async function lerNotas({ dataDe, dataAte }) {
  const naturezas = await naturezasDeOperacao();
  const lista = await listarNotas({ dataDe, dataAte });
  const porId = new Map();

  for (const n of lista) {
    let detalhe = null;
    try {
      detalhe = await detalheNota(n.id);
    } catch (err) {
      console.warn(`[bling] nota ${n.numero ?? n.id}: ${err.message}`);
    }
    const idNatureza = detalhe?.naturezaOperacao?.id ?? n?.naturezaOperacao?.id;
    const natureza = naturezas[String(idNatureza)] || detalhe?.naturezaOperacao?.descricao || null;

    porId.set(String(n.id), {
      id: String(n.id),
      numero: String(n.numero ?? detalhe?.numero ?? "").trim() || null,
      natureza,
      bonificacao: ehNaturezaDeBonificacao(natureza),
      cliente: detalhe?.contato?.nome || n?.contato?.nome || null,
      lojaId: detalhe?.loja?.id ?? n?.loja?.id ?? null,
      emissao: n.dataEmissao || detalhe?.dataEmissao || null,
      transportador: detalhe?.transporte?.transportador?.nome || null,
      // O id do volume e a chave do OBJETO DE POSTAGEM, que e onde o codigo de
      // rastreio realmente mora. A nota devolve so o id; o codigo vem de
      // /logisticas/objetos/{id}.
      volumes: (detalhe?.transporte?.volumes || []).map((v) => v?.id).filter(Boolean),
      usada: false,
    });
  }

  console.log(`[bling] ${porId.size} nota(s) lida(s).`);
  return porId;
}

export async function runSyncBling({ dias = 30 } = {}) {
  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - dias * 86400000);

  console.log(`[bling] sincronizando os ultimos ${dias} dia(s)...`);
  const notas = await lerNotas({ dataDe: inicio, dataAte: hoje });

  const lista = await listarPedidos({ dataDe: inicio, dataAte: hoje });
  console.log(`[bling] ${lista.length} pedido(s) na listagem.`);

  // Pares (quadrado canonico -> chave da nota) para mesclar no fim, quando o
  // indice ja refletir tudo que foi gravado nesta rodada.
  const paraMesclarPorNota = [];

  const r = { pedidos: lista.length, comRastreio: 0, mesclados: 0, gravados: 0, criados: 0, ignorados: 0, notasSoltas: 0, bonificacoes: 0, removidos: 0, erros: 0 };

  for (const resumido of lista) {
    try {
      const detalhe = await detalhePedido(resumido.id);
      const dados = extrairDoPedido(detalhe);
      if (!dados?.numeroPedido) continue;

      const canonico = dados.numeroPedido;
      const numeroLoja = detalhe?.numeroLoja ? String(detalhe.numeroLoja).trim() : null;

      // O pedido referencia a nota SO PELO ID. Buscar o numero no mapa e o que
      // permite usa-lo como apelido -- sem isso, o quadrado criado pela Mandae
      // (que usa o numero da NF) nunca se junta ao do pedido.
      const nota = detalhe?.notaFiscal?.id ? notas.get(String(detalhe.notaFiscal.id)) : null;
      if (nota) nota.usada = true;

      // O pedido normalmente traz o rastreio em transporte.volumes[].codigoRastreamento,
      // mas nem sempre. Quando faltar, o objeto de postagem tem -- e o quadro
      // nao pode exibir "sem rastreio" para uma remessa que tem um.
      let rastreio = dados.trackingCode;
      if (!rastreio) {
        for (const v of detalhe?.transporte?.volumes || []) {
          const objeto = await objetoDePostagem(v?.id);
          if (objeto?.rastreio) {
            rastreio = objeto.rastreio;
            break;
          }
        }
      }

      const apelidos = [numeroLoja, nota?.numero, rastreio].filter(Boolean);
      r.mesclados += mesclarEmCanonico(canonico, apelidos).mesclados;

      if (rastreio) r.comRastreio++;
      if (nota?.bonificacao) r.bonificacoes++;

      // Merece quadrado se ja existe, se foi despachado (tem rastreio) ou se
      // ja tem nota emitida. Pedido sem nada disso ainda nao virou entrega.
      const jaExiste = !!getOrder(canonico);
      if (!jaExiste && !rastreio && !nota) {
        r.ignorados++;
        continue;
      }
      if (!jaExiste) r.criados++;

      upsertOrder({
        orderNumber: canonico,
        customer: dados.cliente || nota?.cliente || undefined,
        brand: (await nomeDaLoja(detalhe?.loja?.id)) || undefined,
        city: dados.cidade ? `${dados.cidade}${dados.uf ? " - " + dados.uf : ""}` : undefined,
        trackingCode: rastreio || undefined,
        placedAt: dados.data || undefined,
        previsaoEntrega: detalhe?.dataPrevista || undefined,
        natureza: nota?.natureza || undefined,
        bonificacao: nota?.bonificacao || undefined,
        // O NUMERO da nota, e nao so o fato de existir uma.
        //
        // Guardar so `temNota` custou caro: 117 quadrados sabiam que tinham
        // nota e nao sabiam qual. Isso escondia o numero que a operacao usa pra
        // achar o pedido no sistema E deixava o quadro sem a unica chave que
        // liga um pedido do Bling a uma remessa do WMS -- que se chama
        // "ATB0240367" e so se identifica pela coluna Nota Fiscal do portal.
        notaFiscal: nota?.numero || undefined,
        // O numero do pedido do Bling e o nome que a operacao reconhece, entao
        // e ele que fica com o quadrado -- qualquer ATB que esteja ocupando o
        // lugar desta nota e absorvido na hora.
        canonicoDaNota: true,
        // Nota emitida e o marco que separa "ainda nao faturado" de "a caminho".
        // A regra de prazo usa isso: pra pedido sem nota, a data prevista e o
        // limite pra emitir a NF, nao a previsao de entrega.
        temNota: !!nota,
      });
      if (nota?.numero) paraMesclarPorNota.push([canonico, chaveNota(nota.numero)]);
      r.gravados++;
    } catch (err) {
      r.erros++;
      console.error(`[bling] falha no pedido ${resumido?.numero ?? resumido?.id}: ${err.message}`);
      if (String(err.message).startsWith("BLING_NAO_AUTORIZADO")) throw err;
    }
  }

  // Notas que nenhum pedido referenciou: remessas que nasceram como nota.
  for (const nota of notas.values()) {
    if (nota.usada || !nota.numero) continue;
    const jaExiste = !!getOrder(nota.numero);
    // Sem pedido pra dar o rastreio, busca no OBJETO DE POSTAGEM. E o que tira
    // esses quadrados do estado "pontilhado, sem informacao nenhuma": a nota so
    // devolve volumes:[{id}], mas /logisticas/objetos/{id} devolve o codigo.
    let rastreio = null;
    for (const idVolume of nota.volumes || []) {
      const objeto = await objetoDePostagem(idVolume);
      if (objeto?.rastreio) {
        rastreio = objeto.rastreio;
        break;
      }
    }

    if (!jaExiste && !nota.transportador && !rastreio) continue;
    if (!jaExiste) r.notasSoltas++;
    if (nota.bonificacao) r.bonificacoes++;
    if (rastreio) r.comRastreio++;

    upsertOrder({
      orderNumber: nota.numero,
      trackingCode: rastreio || undefined,
      customer: nota.cliente || undefined,
      brand: (await nomeDaLoja(nota.lojaId)) || undefined,
      natureza: nota.natureza || undefined,
      bonificacao: nota.bonificacao || undefined,
      notaFiscal: nota.numero,
      canonicoDaNota: true,
      placedAt: nota.emissao || undefined,
      temNota: true,
    });
    paraMesclarPorNota.push([nota.numero, chaveNota(nota.numero)]);
  }

  // ---------------------------------------------------------------------
  // Mesclagem pelo NUMERO DA NOTA
  // ---------------------------------------------------------------------
  //
  // O WMS batiza a remessa com um numero proprio -- "ATB0240367" -- que nao
  // existe no Bling nem como pedido nem como nota (verificado). O unico elo
  // entre ele e a nota "000258" e a coluna Nota Fiscal do portal, que mostra
  // "258 - 001".
  //
  // Sem isto, metade do quadro era duplicata: 88 quadrados ATB de um lado e 89
  // quadrados 0000xx do outro, cada um com metade da historia -- o ATB com o
  // status do armazem e sem rastreio, o da nota com o rastreio e sem status.
  //
  // chaveNota() normaliza os dois formatos para o mesmo numero.
  const porNota = indicePorNota();
  for (const [canonico, chave] of paraMesclarPorNota) {
    const candidatos = (porNota.get(chave) || []).filter((n) => n !== canonico);
    if (candidatos.length) r.mesclados += mesclarEmCanonico(canonico, candidatos).mesclados;
  }

  r.removidos = limparPedidosSemStatus();
  setMeta("lastBlingSyncAt", new Date().toISOString());
  setMeta("lastNotasSyncAt", new Date().toISOString());

  console.log(
    `[bling] concluido: ${r.gravados} pedido(s) gravado(s), ${r.comRastreio} com rastreio, ` +
      `${r.mesclados} duplicado(s) mesclado(s), ${r.criados} novo(s), ${r.notasSoltas} nota(s) sem pedido, ` +
      `${r.bonificacoes} bonificacao(oes), ${r.ignorados} ignorado(s), ${r.removidos} removido(s), ${r.erros} erro(s).`
  );
  return r;
}

/**
 * Remove do quadro registro que nao tem informacao nenhuma de operacao: sem
 * status das duas fontes, sem rastreio e sem nota. Se voltar por qualquer uma
 * delas, entra de novo com dado de verdade.
 */
export function limparPedidosSemStatus() {
  const semNada = listOrders().filter(
    (o) => !o.wmsStatus && !o.carrierStatus && !o.trackingCode && !o.temNota
  );
  for (const o of semNada) apagarPedido(o.orderNumber);
  return semNada.length;
}
