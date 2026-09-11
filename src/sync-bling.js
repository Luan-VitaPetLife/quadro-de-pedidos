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
  situacoesDeVenda,
  notaVale,
  nomeDaSituacaoDaNota,
} from "./integrations/bling.js";
import { mapTextoDaTransportadora, ehEventoFinal } from "./lib/statusMapping.js";
import { upsertOrder, mesclarEmCanonico, setMeta, getOrder, listOrders, apagarPedido, chaveNota, indicePorNota } from "./lib/db.js";

/**
 * Mapa das notas do periodo, indexado pelo ID (que e como o pedido as
 * referencia). Guarda tambem quais foram consumidas por algum pedido, pra
 * saber no fim quais precisam de quadrado proprio.
 */
/**
 * Uma remessa ENTREGUE nao muda mais.
 *
 * Cada nota custa duas chamadas (detalhe + objeto de postagem) e a API do Bling
 * anda a ~2,5 por segundo. Com o historico de 30 dias isso virou uma rodada que
 * passou de meia hora presa so na leitura das notas -- e que nao terminava, o
 * que por fora e identico a ter morrido.
 *
 * Quase tudo nesse historico e entrega concluida de semanas atras: o codigo nao
 * vai mudar, o status nao vai mudar, a natureza nao vai mudar. Reler tudo isso
 * a cada duas horas e gastar o orcamento de chamadas no que ja se sabe, em vez
 * de gastar no que esta em movimento.
 */
function jaSabidoEEncerrado(numeroNota, indice) {
  const chave = chaveNota(numeroNota);
  if (!chave) return false;
  for (const numero of indice.get(chave) || []) {
    const o = getOrder(numero);
    if (o?.trackingCode && o?.natureza && ehEventoFinal(o.carrierStatus)) return true;
  }
  return false;
}

async function lerNotas({ dataDe, dataAte, marcar = () => {} }) {
  const naturezas = await naturezasDeOperacao();
  const lista = await listarNotas({ dataDe, dataAte });
  marcar(`${lista.length} notas na listagem`);
  const porId = new Map();
  // Montado UMA vez: percorrer o quadro inteiro por nota transformaria a
  // economia de chamadas em desperdicio de CPU.
  const indiceDeNotas = indicePorNota();

  let lidas = 0;
  let puladas = 0;
  for (const n of lista) {
    if (++lidas % 25 === 0) marcar(`nota ${lidas}/${lista.length} (${puladas} ja encerradas)`);

    // Nota de remessa ja entregue e ja conhecida: entra no mapa marcada como
    // PULADA, sem gastar as duas chamadas.
    //
    // Marcada, e nao ausente: se ela sumisse do mapa, o pedido que a referencia
    // seria lido como "pedido sem nota" -- e ai o codigo de rastreio seria
    // apagado como autoritativo e o temNota cairia. A economia teria destruido
    // justamente os quadrados que ja estavam certos.
    // Nota sem valor nunca e pulada: ela existe pra ser DESMONTADA.
    const valeEsta = notaVale(n.situacao);
    if (valeEsta && jaSabidoEEncerrado(n.numero, indiceDeNotas)) {
      puladas++;
      porId.set(String(n.id), {
        id: String(n.id),
        numero: String(n.numero ?? "").trim() || null,
        volumes: [],
        pular: true,
        // `vale` PRECISA vir junto: mais adiante a rotina que desmonta nota sem
        // valor testa `!nota.vale`, e `undefined` e falso -- sem isto toda nota
        // pulada (isto e, toda entrega ja concluida) seria desmontada.
        vale: true,
        situacao: n.situacao ?? null,
        usada: false,
      });
      continue;
    }
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
      // Nota rejeitada ou cancelada nunca virou remessa: nao da rastreio, nao
      // conta como nota emitida e nao merece quadrado.
      situacao: n.situacao ?? detalhe?.situacao ?? null,
      vale: notaVale(n.situacao ?? detalhe?.situacao),
      transportador: detalhe?.transporte?.transportador?.nome || null,
      // O id do volume e a chave do OBJETO DE POSTAGEM, que e onde o codigo de
      // rastreio realmente mora. A nota devolve so o id; o codigo vem de
      // /logisticas/objetos/{id}.
      volumes: (detalhe?.transporte?.volumes || []).map((v) => v?.id).filter(Boolean),
      usada: false,
    });
  }

  marcar(`${porId.size} notas detalhadas (${puladas} puladas); lendo objetos de postagem`);

  // O RASTREIO E O STATUS vem do objeto de postagem DA NOTA, nunca do pedido.
  //
  // Esta foi a licao do pedido 1234 (Braha Gloiber). Ele exibia
  // "VITPT000242", que a Mandae nao conhece, porque o quadro tirava o codigo de
  // `transporte.volumes[]` do PEDIDO DE VENDA. So que aquele pedido nao tem nota
  // nenhuma: e uma venda abandonada no Bling, e a etiqueta dela nunca virou
  // encomenda (objeto com situacao 8, descricao vazia, data 0000-00-00).
  //
  // A venda de verdade era o pedido 1215, com a nota 000046 e o rastreio
  // VITPT000197, entregue em 24/08. Nas palavras do Luan: a NF de saida e o
  // momento em que a remessa vai pro WMS -- antes dela, o que esta no pedido
  // nao vale como verdade.
  for (const nota of porId.values()) {
    if (nota.pular || !nota.vale) continue;
    for (const idVolume of nota.volumes) {
      const objeto = await objetoDePostagem(idVolume);
      if (!objeto) continue;
      if (!nota.rastreio && objeto.rastreio) nota.rastreio = objeto.rastreio;
      // O objeto tambem carrega o estado da entrega, com data -- e para
      // QUALQUER transportadora, nao so a Mandae.
      if (objeto.descricao && !nota.entregaDescricao) {
        nota.entregaDescricao = objeto.descricao;
        nota.entregaEm = objeto.ultimaAlteracao;
      }
      if (objeto.idPedido && !nota.idPedido) nota.idPedido = objeto.idPedido;
    }
  }

  console.log(`[bling] ${porId.size} nota(s) lida(s).`);
  return porId;
}

export async function runSyncBling({ dias = 30 } = {}) {
  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - dias * 86400000);

  console.log(`[bling] sincronizando os ultimos ${dias} dia(s)...`);

  // Marca onde a rodada esta.
  //
  // Sem isto, uma sincronizacao que nao termina e indistinguivel de uma que
  // morreu: por fora so se ve o carimbo final parado. Duas rodadas seguidas
  // ficaram assim hoje e eu nao tinha como saber se era lentidao ou erro,
  // porque o log do container nao esta ao meu alcance.
  const marcar = (etapa) => setMeta("sincronizacaoEtapa", `${etapa} @ ${new Date().toISOString()}`);

  marcar("lendo notas");
  const notas = await lerNotas({ dataDe: inicio, dataAte: hoje, marcar });

  marcar(`${notas.size} notas lidas; listando pedidos`);
  const lista = await listarPedidos({ dataDe: inicio, dataAte: hoje });
  console.log(`[bling] ${lista.length} pedido(s) na listagem.`);

  // Pares (quadrado canonico -> chave da nota) para mesclar no fim, quando o
  // indice ja refletir tudo que foi gravado nesta rodada.
  const paraMesclarPorNota = [];

  const situacoes = await situacoesDeVenda();
  const r = { pedidos: lista.length, comRastreio: 0, mesclados: 0, gravados: 0, criados: 0, ignorados: 0, notasSoltas: 0, bonificacoes: 0, removidos: 0, erros: 0, puladas: 0, notasSemValor: 0, porSituacao: {} };

  let n = 0;
  for (const resumido of lista) {
    try {
      if (++n % 25 === 0) marcar(`pedido ${n}/${lista.length}`);
      const detalhe = await detalhePedido(resumido.id);
      const dados = extrairDoPedido(detalhe);
      if (!dados?.numeroPedido) continue;

      const canonico = dados.numeroPedido;
      const numeroLoja = detalhe?.numeroLoja ? String(detalhe.numeroLoja).trim() : null;

      // O pedido referencia a nota SO PELO ID. Buscar o numero no mapa e o que
      // permite usa-lo como apelido -- sem isso, o quadrado criado pela Mandae
      // (que usa o numero da NF) nunca se junta ao do pedido.
      const notaBruta = detalhe?.notaFiscal?.id ? notas.get(String(detalhe.notaFiscal.id)) : null;
      if (notaBruta) notaBruta.usada = true;
      // Rejeitada ou cancelada vale o mesmo que nao existir: o pedido volta a
      // ser "ainda nao faturado", e o codigo que ele carregue e apagado.
      const nota = notaBruta && notaBruta.vale === false ? null : notaBruta;
      if (notaBruta && !nota) r.notasSemValor++;

      // O rastreio vem da NOTA, nunca do pedido. Pedido sem nota nao tem
      // rastreio nenhum -- e a etiqueta que ele por acaso carregue e lixo, como
      // provou o "VITPT000242" do pedido 1234.
      // Quem opina sobre o codigo de rastreio.
      //
      //   nota lida e valida   opina: o codigo dela vale
      //   nota rejeitada       opina: o codigo certo e NENHUM, porque essa
      //                        remessa nao aconteceu
      //   nota pulada          nao opina -- o quadrado ja tem o dado dela
      //   nota fora da janela  nao opina -- nao ter a nota em maos nao e a
      //                        mesma coisa que a nota dizer que nao ha codigo
      //   pedido sem nota      nao opina -- ver abaixo
      //
      // O "pedido sem nota" ja foi autoritativo, e apagou 47 quadrados numa
      // rodada so. Entre eles o 1470 e o 1161: um pedido do Mercado Livre feito
      // hoje, cuja etiqueta nasce antes da nota, e um da Shopee cuja nota estava
      // fora da janela de 30 dias. Os dois sao envios de verdade.
      //
      // Confundi duas coisas diferentes. "Nao tenho a nota" nao autoriza ninguem
      // a afirmar que nao existe codigo -- so a nota em maos autoriza isso. O
      // caso que me levou ate aqui (o "VITPT000242" do pedido 1234, etiqueta que
      // nunca virou encomenda) ja e coberto por outra regra, a que compara o
      // codigo com o que a transportadora conhece: o quadrado fica vermelho
      // dizendo exatamente isso, em vez de sumir sem explicacao.
      const notaOpina = !!notaBruta && !notaBruta.pular;
      const rastreio = notaOpina ? nota?.rastreio || null : undefined;

      // Situacao do pedido no Bling: e a unica fonte que sabe de cancelamento.
      const situacao = situacoes[String(detalhe?.situacao?.id)] || null;

      const apelidos = [numeroLoja, nota?.numero, rastreio].filter(Boolean);
      if (nota?.pular) r.puladas++;
      r.mesclados += mesclarEmCanonico(canonico, apelidos).mesclados;

      if (rastreio) r.comRastreio++;
      if (nota?.bonificacao) r.bonificacoes++;
      if (situacao) r.porSituacao[situacao] = (r.porSituacao[situacao] || 0) + 1;

      // Merece quadrado se ja existe, se tem nota, ou se tem etiqueta despachada
      // pelo marketplace.
      //
      // O terceiro caso volta por pedido do Luan: Mercado Livre e Shopee ficam
      // parados em pedido de venda antes da nota, e a data prevista dali e o
      // prazo pra emitir a NF. Ele quer ver justamente esses -- o problema nao e
      // estarem parados, e ultrapassarem o prazo estando parados. Sem o
      // quadrado, nao ha onde a regra de prazo aparecer.
      const jaExiste = !!getOrder(canonico);
      const etiquetaDoPedido = detalhe?.transporte?.volumes?.find((v) => v?.codigoRastreamento)?.codigoRastreamento || null;
      if (!jaExiste && !nota && !etiquetaDoPedido) {
        r.ignorados++;
        continue;
      }
      if (!jaExiste) r.criados++;

      upsertOrder({
        orderNumber: canonico,
        customer: dados.cliente || nota?.cliente || undefined,
        brand: (await nomeDaLoja(detalhe?.loja?.id)) || undefined,
        city: dados.cidade ? `${dados.cidade}${dados.uf ? " - " + dados.uf : ""}` : undefined,
        // Sem nota em maos, a etiqueta do pedido serve de provisoria: melhor um
        // codigo a conferir do que um quadrado mudo. A regra de rastreio
        // desconhecido diz depois se ele vale alguma coisa.
        trackingCode: notaOpina ? rastreio : rastreio ?? etiquetaDoPedido ?? undefined,
        // A nota manda no codigo, inclusive na AUSENCIA dele: e assim que um
        // codigo errado gravado antes (vindo do pedido) sai do quadro em vez de
        // sobreviver para sempre. Nota pulada nao manda em nada.
        trackingCodeAutoritativo: notaOpina,
        situacaoBling: situacao || undefined,
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
        // Status da entrega direto do Bling. Vale para transportadora que o
        // quadro nao consulta -- e a primeira noticia que Mercado Livre e
        // Shopee jamais deram aqui.
        carrierStatus: nota?.entregaDescricao || undefined,
        carrierSeverity: nota?.entregaDescricao
          ? mapTextoDaTransportadora(nota.entregaDescricao).status
          : undefined,
        lastEventAt: nota?.entregaEm || undefined,
        ultimoMovimentoAt: nota?.entregaEm || undefined,
      });
      if (nota?.numero) paraMesclarPorNota.push([canonico, chaveNota(nota.numero)]);
      r.gravados++;
    } catch (err) {
      r.erros++;
      console.error(`[bling] falha no pedido ${resumido?.numero ?? resumido?.id}: ${err.message}`);
      if (String(err.message).startsWith("BLING_NAO_AUTORIZADO")) throw err;
    }
  }

  marcar("notas sem pedido");
  // Notas que nenhum pedido referenciou: remessas que nasceram como nota.
  for (const nota of notas.values()) {
    if (!nota.numero) continue;

    // Nota rejeitada/cancelada que criou quadrado numa rodada anterior: o
    // quadrado e desmontado aqui. Sem isto ele sobreviveria para sempre --
    // ninguem mais escreve nele, entao nada o corrigiria. Foi o caso do
    // "000054" da Cristiane Simon, vermelho por uma etiqueta que nunca existiu.
    if (!nota.vale) {
      if (getOrder(nota.numero)) {
        upsertOrder({
          orderNumber: nota.numero,
          trackingCode: null,
          trackingCodeAutoritativo: true,
          temNota: false,
          situacaoBling: `Nota ${nomeDaSituacaoDaNota(nota.situacao) || "sem valor"}`,
        });
        r.notasSemValor++;
      }
      continue;
    }

    if (nota.usada) continue;
    const jaExiste = !!getOrder(nota.numero);
    // O rastreio e o status ja vieram do objeto de postagem em lerNotas().
    const rastreio = nota.rastreio || null;

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
      carrierStatus: nota.entregaDescricao || undefined,
      carrierSeverity: nota.entregaDescricao
        ? mapTextoDaTransportadora(nota.entregaDescricao).status
        : undefined,
      lastEventAt: nota.entregaEm || undefined,
      ultimoMovimentoAt: nota.entregaEm || undefined,
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
