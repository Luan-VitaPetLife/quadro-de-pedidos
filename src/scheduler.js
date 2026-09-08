import cron from "node-cron";
import { runSync } from "./sync.js";

export function startScheduler() {
  const minutes = Number(process.env.SYNC_INTERVAL_MINUTES || 120);
  const cronExpr = `*/${minutes} * * * *`;

  console.log(`[scheduler] sincronizacao agendada a cada ${minutes} minuto(s).`);

  // Roda uma vez ao subir, sem travar o boot do servidor.
  runSync().catch((err) => console.error("[scheduler] erro na sincronizacao inicial:", err));

  cron.schedule(cronExpr, () => {
    runSync().catch((err) => console.error("[scheduler] erro na sincronizacao agendada:", err));
  });
}
