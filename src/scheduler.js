import cron from "node-cron";
import { runSync } from "./sync.js";
import { sincronizarWms } from "./lib/wms.js";

/**
 * Monta uma expressao cron valida a partir de um intervalo em MINUTOS.
 *
 * Cuidado que motivou essa funcao: o campo de minutos do cron so vai de 0 a 59.
 * `*​/120 * * * *` NAO da erro -- o node-cron expande o passo 120 dentro do
 * intervalo 0-59, sobra so o minuto 0, e o resultado e uma tarefa que roda de
 * HORA EM HORA, silenciosamente, em vez de a cada 2h. Por isso qualquer
 * intervalo de 60 minutos pra cima precisa virar passo no campo de HORAS.
 */
export function cronExpressionForMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes < 1) {
    throw new Error(`SYNC_INTERVAL_MINUTES invalido: ${minutes}`);
  }
  if (minutes < 60) {
    return `*/${Math.floor(minutes)} * * * *`;
  }
  if (minutes % 60 !== 0) {
    throw new Error(
      `SYNC_INTERVAL_MINUTES=${minutes}: acima de 60, use um multiplo de 60 (120 = 2h, 180 = 3h...).`
    );
  }
  const hours = minutes / 60;
  if (hours >= 24) return "0 0 * * *"; // uma vez por dia, meia-noite
  return `0 */${hours} * * *`;
}

/**
 * Um intervalo em minutos vindo do ambiente, preso a uma faixa segura.
 *
 * Existe porque um valor invalido numa variavel de ambiente nao pode virar uma
 * expressao cron quebrada: isso derrubaria a subida do servidor inteiro por
 * causa de um numero mal digitado.
 */
function intervaloValido(bruto, padrao, minimo, maximo) {
  const n = Number(bruto);
  if (!Number.isFinite(n) || n < minimo) return padrao;
  return Math.min(maximo, Math.floor(n));
}

export function startScheduler() {
  const minutes = Number(process.env.SYNC_INTERVAL_MINUTES || 120);
  const cronExpr = cronExpressionForMinutes(minutes);

  console.log(
    `[scheduler] sincronizacao agendada a cada ${minutes} minuto(s) -- cron "${cronExpr}".`
  );

  // A sincronizacao do Bling nao e obrigatoria: se ninguem autorizou ainda, ela
  // falha com BLING_NAO_AUTORIZADO e isso NAO e erro -- e so a integracao que
  // ainda nao existe. Registrar como erro barulhento treinaria a ignorar o log.
  async function rodarBling() {
    try {
      // 60 dias, e nao 30.
      //
      // A janela de 30 cortava o comeco do mes anterior: em 14/09, o pedido de
      // 01/08 fica a 44 dias e simplesmente nao era lido -- foi o que deixou o
      // 1119 da Olga de fora na reconstrucao. Sessenta cobre o mes corrente e o
      // anterior inteiros em qualquer dia do ano, que e como a operacao pensa.
      //
      // O custo ficou baixo depois que a leitura passou a pular nota de remessa
      // ja entregue: o historico antigo nao gasta chamada nenhuma na segunda vez.
      const dias = Number(process.env.BLING_DIAS || 60);
      const { runSyncBling } = await import("./sync-bling.js");
      const { comTravaDeSincronizacao } = await import("./lib/travaDeSincronizacao.js");
      // Pela trava, nao direto: uma sincronizacao disparada a mao pode estar
      // rodando, e duas ao mesmo tempo so dividem o orcamento de chamadas da
      // API entre si -- as duas terminam na metade da velocidade.
      const { rodou } = await comTravaDeSincronizacao(() => runSyncBling({ dias }));
      if (!rodou) console.log("[scheduler] ja havia uma sincronizacao do Bling em andamento; pulei esta.");
    } catch (err) {
      if (String(err.message).startsWith("BLING_NAO_AUTORIZADO")) {
        console.log("[scheduler] Bling ainda nao autorizado; pulando. (abra /bling/autorizar?s=SEGREDO)");
        return;
      }
      console.error("[scheduler] erro na sincronizacao do Bling:", err.message);
    }
  }

  async function ciclo() {
    // O Bling vem PRIMEIRO, e a ordem tem motivo.
    //
    // Ele e o unico que DESCOBRE pedido: mescla os duplicados, preenche o
    // cadastro e traz pro radar os despachados que nem o WMS nem o webhook
    // conheciam -- e, com eles, o codigo de rastreio. So depois disso a
    // reconsulta da Mandae tem o que perguntar: ela consulta pelo rastreio, e
    // rastreio que ela nao conhece nao existe pra ela.
    //
    // Na ordem inversa (como estava), um pedido descoberto pelo Bling ficava um
    // ciclo inteiro -- duas horas -- sem status da transportadora, aparecendo
    // como se nada se soubesse dele.
    await rodarBling();
    await runSync().catch((err) => console.error("[scheduler] erro na sincronizacao:", err));

    // O WMS, que ate agora so entrava no quadro quando alguem rodava o script
    // na propria maquina. Vem depois do Bling pelo mesmo motivo que a Mandae:
    // o WMS nao cria quadrado, so preenche o de um pedido que o Bling ja
    // conhece -- lido antes, o status do armazem chegaria antes do pedido.
    //
    // Nao lanca: sessao expirada e um estado normal aqui, e o quadro mostra.
    await sincronizarWms({ dias: Number(process.env.BLING_DIAS || 60) });

    // Por ultimo, o quadro olhando pra si mesmo: dois quadrados que dividem a
    // mesma nota ou o mesmo codigo de rastreio sao a mesma remessa, e isso se
    // decide sem consultar ninguem. Fica no fim porque as duas etapas acima
    // acabaram de trazer justamente as chaves que revelam a duplicata.
    try {
      const { deduplicar } = await import("./lib/deduplicar.js");
      const d = deduplicar({ aplicar: true });
      if (d.mesclados) {
        console.log(`[scheduler] ${d.mesclados} quadrado(s) duplicado(s) fundido(s).`);
      }
    } catch (err) {
      console.error("[scheduler] erro ao deduplicar:", err.message);
    }
  }

  const tarefa = cron.schedule(cronExpr, () => {
    ciclo();
  });

  // ---------------------------------------------------------------------
  // A via rapida do Bling
  // ---------------------------------------------------------------------
  //
  // A varredura de 2 horas existe porque ela e CARA: uma chamada de detalhe por
  // pedido, com centenas de pedidos na janela de 60 dias. Perguntar tudo de novo
  // de 3 em 3 minutos estouraria o limite de requisicoes da API e nao deixaria o
  // quadro mais fresco -- deixaria mais lento.
  //
  // Mas da pra fazer uma pergunta muito menor: "o que mudou desde a ultima
  // vez?". Medido no Bling de verdade: 4 pedidos alterados no dia inteiro, 0 na
  // ultima hora. Entao a via rapida quase nunca gasta mais que a propria
  // listagem, e um pedido que muda aparece no quadro em minutos, nao em horas.
  //
  // A JANELA OLHA MAIS PRA TRAS QUE O INTERVALO, de proposito: uma rodada pulada
  // (trava ocupada pela varredura, deploy, reinicio) abriria um buraco por onde
  // um pedido passaria sem ser visto, e ele so reapareceria horas depois. Reler
  // um punhado de pedidos e barato; perder um e o problema que o quadro existe
  // pra evitar.
  const minutosDaViaRapida = intervaloValido(process.env.BLING_VIA_RAPIDA_MINUTOS, 3, 1, 30);
  const margemDaJanela = minutosDaViaRapida * 3 + 5;

  // Deixa rastro do que a via rapida fez, em meta, e nao so no log.
  //
  // O log do container nao esta ao alcance de quem opera -- e sem rastro,
  // "rodou e nao achou nada" e "nunca rodou" produzem exatamente o mesmo
  // sintoma: um carimbo de sincronizacao parado. Foi essa duvida que me custou
  // tempo aqui, entao ela nao deveria existir de novo.
  async function anotar(chave, valor) {
    const { setMeta } = await import("./lib/db.js");
    setMeta(chave, typeof valor === "string" ? valor : JSON.stringify(valor));
  }

  /**
   * @param {{janelaMinutos?: number}} opcoes quanto olhar pra tras. O padrao
   *   serve ao ciclo de minutos; a subida pede uma janela maior, para cobrir o
   *   tempo em que o servidor esteve fora do ar.
   */
  async function viaRapida({ janelaMinutos = margemDaJanela } = {}) {
    try {
      const { momentoNoBling } = await import("./integrations/bling.js");
      const { runSyncBling } = await import("./sync-bling.js");
      const { comTravaDeSincronizacao } = await import("./lib/travaDeSincronizacao.js");

      const desde = momentoNoBling(new Date(Date.now() - janelaMinutos * 60000));
      await anotar("viaRapidaUltimaTentativaEm", new Date().toISOString());
      // Pela mesma trava da varredura: as duas escrevem nos mesmos quadrados e
      // dividiriam o orcamento de chamadas da API entre si. Quando a varredura
      // esta rodando, pular e o certo -- ela ja ve tudo que a via rapida veria.
      const { rodou, resultado } = await comTravaDeSincronizacao(() => runSyncBling({ alteradosDesde: desde }));
      if (!rodou) {
        await anotar("viaRapidaUltimoResultado", `pulei: varredura em andamento @ ${new Date().toISOString()}`);
        return;
      }
      await anotar(
        "viaRapidaUltimoResultado",
        `${resultado?.pedidos ?? "?"} na listagem, ${resultado?.gravados ?? 0} gravado(s), ` +
          `${resultado?.criados ?? 0} novo(s), desde ${desde} @ ${new Date().toISOString()}`
      );

      // Pedido novo traz rastreio novo, e rastreio novo ainda nao tem historia
      // no quadro. Sem isto ele apareceria sem status da transportadora ate a
      // varredura seguinte -- justamente o atraso que a via rapida veio cortar.
      //
      // SO nos pedidos que esta rodada mexeu. Reconciliar o quadro inteiro aqui
      // seriam centenas de chamadas a Mandae a cada poucos minutos, quase todas
      // perguntando de novo sobre pedidos que ninguem tocou.
      const tocados = resultado?.tocados || [];
      if (!tocados.length) return;
      const { runSync } = await import("./sync.js");
      await runSync({ apenas: tocados }).catch((err) => console.error("[via-rapida] Mandae:", err.message));
    } catch (err) {
      await anotar("viaRapidaUltimoErro", `${err.message} @ ${new Date().toISOString()}`).catch(() => {});
      if (String(err.message).startsWith("BLING_NAO_AUTORIZADO")) return;
      console.error("[via-rapida] erro:", err.message);
    }
  }

  // Envolvida numa seta, e nao passada direto: o node-cron chama a tarefa com a
  // data agendada, e ela cairia no lugar das opcoes de viaRapida.
  const rapida = cron.schedule(`*/${minutosDaViaRapida} * * * *`, () => viaRapida());
  console.log(
    `[scheduler] via rapida do Bling a cada ${minutosDaViaRapida} minuto(s), ` +
      `olhando ${margemDaJanela} minuto(s) pra tras.`
  );

  // A leitura do WMS, num relogio proprio e muito mais rapido que o ciclo.
  //
  // Precisa ser separada porque as duas coisas medem tempos diferentes: o ciclo
  // e caro (uma chamada por pedido no Bling) e roda de 2 em 2 horas, mas a
  // sessao do portal morre por inatividade em ~20 minutos. Sem bater la nesse
  // meio tempo, ela expiraria sozinha e o login manual viraria rotina diaria.
  //
  // E ja que o quadro PRECISA bater no portal de qualquer forma, ele le de
  // verdade: as tres telas custam tres GETs, contra um so pra dizer "ainda
  // estou aqui". Pelo mesmo preco, o status do armazem passa a ter minutos de
  // atraso em vez de duas horas. Dez minutos da margem folgada para uma rodada
  // perdida sem chegar perto do limite da sessao.
  // Preso entre 1 e 30 de proposito: acima de 30 nao adianta nada (a sessao ja
  // teria morrido na janela de ~20 minutos), e um valor invalido no ambiente nao
  // pode virar uma expressao cron quebrada que derruba a subida do servidor.
  const minutosDoPulso = intervaloValido(process.env.WMS_PULSO_MINUTOS, 10, 1, 30);
  const pulso = cron.schedule(`*/${minutosDoPulso} * * * *`, () => {
    sincronizarWms({ dias: Number(process.env.BLING_DIAS || 60) }).catch((err) =>
      console.error("[wms] erro na leitura:", err.message)
    );
  });
  console.log(`[scheduler] WMS lido (e sessao mantida viva) a cada ${minutosDoPulso} minuto(s).`);

  // ---------------------------------------------------------------------
  // A subida
  // ---------------------------------------------------------------------
  //
  // Antes toda subida disparava a varredura completa: ~10 minutos e mais de mil
  // chamadas ao Bling. Numa tarde de ajustes isso e puro desperdicio -- dez
  // deploys sao dez varreduras relendo os mesmos 60 dias, e a ultima nem chega
  // a terminar antes do proximo deploy derrubar o processo.
  //
  // Mas a varredura na subida existe por um motivo de verdade: se o servidor
  // ficou fora do ar, ha um buraco a tapar. A pergunta certa nao e "subiu?", e
  // "quanto tempo se perdeu?".
  //
  // Se a ultima varredura ainda e recente, a via rapida cobre o buraco sozinha
  // -- basta ela olhar pra tras ate ANTES da ultima varredura, e nao apenas os
  // poucos minutos de sempre. Se faz tempo, varre.
  async function cicloDeSubida() {
    const { getMeta } = await import("./lib/db.js");
    const ultima = getMeta("lastBlingSyncAt");
    const idade = ultima ? (Date.now() - Date.parse(ultima)) / 60000 : Infinity;

    if (!Number.isFinite(idade) || idade >= minutes) {
      const quanto = Number.isFinite(idade) ? `${Math.round(idade)} min` : "nunca";
      console.log(`[scheduler] ultima varredura: ${quanto}. Varrendo na subida.`);
      await anotar("subidaUltimaDecisao", `varredura completa (ultima ha ${quanto}) @ ${new Date().toISOString()}`);
      await ciclo();
      return;
    }

    console.log(
      `[scheduler] ultima varredura ha ${Math.round(idade)} min, ainda vale; ` +
        `subindo pela via rapida e pulando a varredura.`
    );
    await anotar(
      "subidaUltimaDecisao",
      `via rapida (varredura de ${Math.round(idade)} min atras aproveitada) @ ${new Date().toISOString()}`
    );

    // A janela cobre desde antes da ultima varredura ate agora, com a margem de
    // sempre por cima: o que mudou enquanto o servidor estava fora entra aqui.
    await viaRapida({ janelaMinutos: idade + margemDaJanela });

    // O WMS vai junto de qualquer forma. Ele nao entra na conta do que se
    // economiza: sao tres GETs no portal, e sem ele o armazem ficaria ate dez
    // minutos sem aparecer logo depois de um deploy.
    await sincronizarWms({ dias: Number(process.env.BLING_DIAS || 60) }).catch((err) =>
      console.error("[wms] erro na subida:", err.message)
    );
  }

  // Roda uma vez ao subir, sem travar o boot do servidor.
  //
  // AQUI, e nao la em cima junto da definicao do ciclo: `margemDaJanela` e
  // `minutosDaViaRapida` sao const declaradas neste corpo, e chamar isto antes
  // delas existirem estoura com ReferenceError -- o erro morreria no catch de
  // alguem e a subida ficaria sem sincronizar, em silencio.
  cicloDeSubida().catch((err) => console.error("[scheduler] erro na subida:", err.message));

  // Devolvidos pra que o encerramento gracioso consiga parar os timers -- sem
  // isso o cron segura o processo vivo e o desligamento estoura o prazo.
  return { stop: () => { tarefa.stop(); rapida.stop(); pulso.stop(); } };
}
