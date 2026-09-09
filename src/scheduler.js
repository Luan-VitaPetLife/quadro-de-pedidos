import cron from "node-cron";
import { runSync } from "./sync.js";

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
      const { runSyncBling } = await import("./sync-bling.js");
      await runSyncBling({ dias: Number(process.env.BLING_DIAS || 30) });
    } catch (err) {
      if (String(err.message).startsWith("BLING_NAO_AUTORIZADO")) {
        console.log("[scheduler] Bling ainda nao autorizado; pulando. (abra /bling/autorizar?s=SEGREDO)");
        return;
      }
      console.error("[scheduler] erro na sincronizacao do Bling:", err.message);
    }
  }

  async function ciclo() {
    // Ordem importa: a Mandae/WMS atualizam status; o Bling depois mescla os
    // duplicados e preenche cadastro. Mesclar antes deixaria de fora o que
    // acabou de chegar.
    await runSync().catch((err) => console.error("[scheduler] erro na sincronizacao:", err));
    await rodarBling();
  }

  // Roda uma vez ao subir, sem travar o boot do servidor.
  ciclo();

  const tarefa = cron.schedule(cronExpr, () => {
    ciclo();
  });

  // Devolvido pra que o encerramento gracioso consiga parar o timer -- sem
  // isso o cron segura o processo vivo e o desligamento estoura o prazo.
  return tarefa;
}
