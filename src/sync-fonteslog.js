// Le os pedidos no portal da FontesLog e manda pro quadro.
//
//   npm run sync-fonteslog              (ultimos 30 dias)
//   npm run sync-fonteslog -- 90        (ultimos 90 dias)
//   npm run sync-fonteslog -- 30 --seco (so mostra, nao grava)
//
// RODA NA SUA MAQUINA, nao no Railway: o portal exige login manual por causa
// do reCAPTCHA, e a sessao salva fica aqui. O script le o portal por HTTP
// (sem navegador) e empurra o resultado pro quadro pela rota /webhooks/fonteslog.
//
// Quando a sessao expirar, ele avisa e voce roda `npm run fonteslog-login`.

import "dotenv/config";
import { buscarPedidos, ultimoMovimento } from "./integrations/fonteslog.js";
import { mapFontesLogStatus } from "./lib/statusMapping.js";

const CORES = { green: "VERDE", amber: "AMARELO", red: "VERMELHO" };

async function main() {
  const args = process.argv.slice(2);
  const seco = args.includes("--seco");
  const dias = Number(args.find((a) => /^\d+$/.test(a)) || 30);

  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - dias * 86400000);

  console.log(`\nBuscando pedidos na FontesLog dos ultimos ${dias} dia(s)...`);

  let pedidos;
  try {
    pedidos = await buscarPedidos({ dataDe: inicio, dataAte: hoje });
  } catch (err) {
    if (err.message === "SESSAO_EXPIRADA") {
      console.error("\nA sessao da FontesLog expirou. Rode `npm run fonteslog-login` e tente de novo.\n");
      process.exit(1);
    }
    throw err;
  }

  console.log(`Encontrei ${pedidos.length} pedido(s).\n`);
  if (pedidos.length === 0) {
    console.log("Nada a enviar.\n");
    return;
  }

  // Resumo por status, pra voce conferir se o mapeamento de cor faz sentido.
  const porStatus = {};
  for (const p of pedidos) {
    const cor = mapFontesLogStatus(p.status);
    porStatus[p.status] = porStatus[p.status] || { total: 0, cor };
    porStatus[p.status].total++;
  }
  console.log("Status encontrados e a cor que cada um vira no quadro:");
  for (const [status, { total, cor }] of Object.entries(porStatus).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${String(total).padStart(3)}  ${String(status).padEnd(26)} -> ${CORES[cor]}`);
  }

  const payload = {
    pedidos: pedidos.map((p) => ({
      numeroPedido: p.numeroPedido,
      status: p.status,
      ultimoMovimento: ultimoMovimento(p),
    })),
  };

  if (seco) {
    console.log("\n--seco: nao gravei nada. Amostra do que seria enviado:");
    console.log(JSON.stringify(payload.pedidos.slice(0, 3), null, 2));
    console.log("");
    return;
  }

  const boardUrl = (process.env.BOARD_URL || "http://localhost:3000").replace(/\/+$/, "");
  const segredo = process.env.MANDAE_WEBHOOK_SECRET;
  if (!segredo) {
    console.error("\nMANDAE_WEBHOOK_SECRET vazio no .env -- sem ele o quadro recusa a gravacao.\n");
    process.exit(1);
  }

  console.log(`\nEnviando para ${boardUrl} ...`);
  const res = await fetch(`${boardUrl}/webhooks/fonteslog?s=${encodeURIComponent(segredo)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mandae-Secret": segredo },
    body: JSON.stringify(payload),
  });

  const corpo = await res.text();
  if (!res.ok) {
    console.error(`O quadro recusou (HTTP ${res.status}): ${corpo}\n`);
    process.exit(1);
  }

  console.log(`OK: ${corpo}`);
  console.log(`\nAbra ${boardUrl} pra ver os quadrados.\n`);
}

main().catch((err) => {
  console.error("\nErro:", err.message, "\n");
  process.exit(1);
});
