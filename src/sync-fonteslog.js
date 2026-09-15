// Le os pedidos no portal da FontesLog e manda pro quadro, da SUA maquina.
//
//   npm run sync-fonteslog              (ultimos 60 dias)
//   npm run sync-fonteslog -- 90        (ultimos 90 dias)
//   npm run sync-fonteslog -- 60 --seco (so mostra, nao grava)
//
// ISTO NAO E MAIS O CAMINHO NORMAL. Desde que a sessao passou a viver no
// servidor (ver lib/wms.js), o proprio quadro le o portal a cada ciclo e mantem
// a sessao viva sozinho -- ninguem precisa rodar nada. Este script ficou pra
// quando voce quiser CONFERIR o que o portal esta dizendo, ou empurrar uma
// leitura na mao enquanto o servidor esta sem sessao valida.
//
// Quando a sessao expirar, ele avisa e voce roda `npm run fonteslog-login`.

import "dotenv/config";
import { lerWms } from "./lib/wms.js";
import { mapFontesLogStatus } from "./lib/statusMapping.js";

const CORES = { green: "VERDE", amber: "AMARELO", red: "VERMELHO" };

async function main() {
  const args = process.argv.slice(2);
  const seco = args.includes("--seco");
  const dias = Number(args.find((a) => /^\d+$/.test(a)) || 60);

  console.log(`\nBuscando pedidos na FontesLog dos ultimos ${dias} dia(s)...`);

  let leitura;
  try {
    leitura = await lerWms({ dias });
  } catch (err) {
    if (err.message === "SESSAO_EXPIRADA") {
      console.error("\nA sessao da FontesLog expirou. Rode `npm run fonteslog-login` e tente de novo.\n");
      process.exit(1);
    }
    throw err;
  }

  const { pedidos, lidos, parados, rejeitados } = leitura;
  console.log(`Encontrei ${lidos} pedido(s).\n`);
  if (!pedidos.length) {
    console.log("Nada a enviar.\n");
    return;
  }

  // Resumo por status, pra voce conferir se o mapeamento de cor faz sentido.
  const porStatus = {};
  for (const p of pedidos) {
    const cor = p.severidade || mapFontesLogStatus(p.status);
    porStatus[p.status] = porStatus[p.status] || { total: 0, cor };
    porStatus[p.status].total++;
  }
  console.log("Status encontrados e a cor que cada um vira no quadro:");
  for (const [status, { total, cor }] of Object.entries(porStatus).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${String(total).padStart(3)}  ${String(status).padEnd(26)} -> ${CORES[cor]}`);
  }

  console.log("");
  if (parados || rejeitados) {
    console.log(`Telas de problema: ${parados} parado(s), ${rejeitados} rejeitado(s).`);
  } else {
    console.log("Telas de problema: nenhum pedido parado ou rejeitado no periodo.");
  }

  if (seco) {
    console.log("\n--seco: nao gravei nada. Amostra do que seria enviado:");
    console.log(JSON.stringify(pedidos.slice(0, 3), null, 2));
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
    body: JSON.stringify({ pedidos }),
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
