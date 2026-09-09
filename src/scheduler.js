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

  // Roda uma vez ao subir, sem travar o boot do servidor.
  runSync().catch((err) => console.error("[scheduler] erro na sincronizacao inicial:", err));

  const tarefa = cron.schedule(cronExpr, () => {
    runSync().catch((err) => console.error("[scheduler] erro na sincronizacao agendada:", err));
  });

  // Devolvido pra que o encerramento gracioso consiga parar o timer -- sem
  // isso o cron segura o processo vivo e o desligamento estoura o prazo.
  return tarefa;
}
