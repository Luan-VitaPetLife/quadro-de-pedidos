// Apaga o quadro e le tudo de novo, do zero, com as regras de hoje.
//
//   npm run reconstruir              (ultimos 30 dias)
//   npm run reconstruir -- 60        (ultimos 60 dias)
//   npm run reconstruir -- 30 --seco (so diz o que faria)
//
// Por que existe: o banco acumulou quadrados criados por regras que nao valem
// mais -- pedidos que a Mandae inventou a partir de um codigo desconhecido,
// notas rejeitadas que viraram remessa, etiquetas de venda abandonada. Corrigir
// um por um e mais arriscado do que reler: a leitura nova ja sabe o que
// e remessa e o que nao e.
//
// O QUE NAO SE PERDE: os pedidos marcados como resolvidos. Eles carregam um
// motivo escrito a mao ("extravio resolvido - realizado reenvio") que nao existe
// em fonte nenhuma -- se sumisse, sumia o trabalho de alguem. Sao exportados
// antes e reaplicados depois, inclusive quando o pedido volta com outro nome.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { db, dataDir, listOrders, ocultarPedido, resolverCanonico, getOrder, esquecerCaches } from "./lib/db.js";
import { runSyncBling } from "./sync-bling.js";

function agora() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const args = process.argv.slice(2);
  const seco = args.includes("--seco");
  const dias = Number(args.find((a) => /^\d+$/.test(a)) || 30);

  const antes = listOrders();
  const resolvidos = antes
    .filter((o) => o.oculto)
    .map((o) => ({
      orderNumber: o.orderNumber,
      apelidos: o.apelidos || [],
      motivo: o.ocultoMotivo,
      em: o.ocultoEm,
    }));

  console.log(`\nQuadro atual: ${antes.length} pedido(s), ${resolvidos.length} marcado(s) como resolvido(s).`);
  for (const r of resolvidos) {
    console.log(`   guardando: ${r.orderNumber} — ${r.motivo || "(sem motivo)"}`);
  }

  if (seco) {
    console.log(`\n--seco: nao apaguei nada. Releria os ultimos ${dias} dia(s) do Bling.\n`);
    return;
  }

  // Copia do banco antes de qualquer coisa. E barato e e a unica forma de
  // desfazer se a releitura vier pior do que o que estava la.
  const arquivo = path.join(dataDir, "orders.sqlite");
  if (fs.existsSync(arquivo)) {
    const copia = path.join(dataDir, `orders-antes-da-reconstrucao-${agora()}.sqlite`);
    fs.copyFileSync(arquivo, copia);
    console.log(`\nCopia de seguranca: ${copia}`);
  }

  // Os apelidos vao junto: o pedido resolvido pode voltar da releitura com outro
  // nome (pelo numero do pedido em vez do numero da nota, por exemplo), e a
  // marca precisa reencontra-lo.
  const apagados = db.prepare("DELETE FROM orders").run().changes;
  db.prepare("DELETE FROM orfaos").run();
  // Sem isto a releitura vem embaralhada: os mapas de apelido e de nota ficam
  // apontando para quadrados que acabaram de deixar de existir, e o primeiro
  // pedido relido cai no lugar do antigo.
  esquecerCaches();
  console.log(`${apagados} quadrado(s) apagado(s). Relendo o Bling...\n`);

  const r = await runSyncBling({ dias });

  // Reaplica as marcas de resolvido.
  let remarcados = 0;
  const perdidos = [];
  for (const res of resolvidos) {
    const candidatos = [res.orderNumber, ...res.apelidos];
    const alvo = candidatos.map((c) => resolverCanonico(c)).find((c) => getOrder(c));
    if (!alvo) {
      perdidos.push(res);
      continue;
    }
    ocultarPedido(alvo, res.motivo);
    remarcados++;
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Quadro reconstruido: ${listOrders().length} pedido(s).`);
  console.log(`  criados: ${r.criados} · ignorados: ${r.ignorados} · apelidos registrados: ${r.apelidos}`);
  console.log(`  com rastreio: ${r.comRastreio} · bonificacoes: ${r.bonificacoes} · erros: ${r.erros}`);
  console.log(`  notas sem valor (rejeitada/cancelada): ${r.notasSemValor}`);
  console.log(`\nResolvidos remarcados: ${remarcados} de ${resolvidos.length}.`);
  for (const p of perdidos) {
    // Nao some em silencio: se o pedido resolvido nao voltou, ou ele deixou de
    // ser remessa pelas regras novas (esperado) ou ficou de fora por engano.
    console.log(`   NAO VOLTOU: ${p.orderNumber} — ${p.motivo || "(sem motivo)"}`);
  }
  console.log("\nFalta ler o WMS: `npm run fonteslog-login` e depois `npm run sync-fonteslog`.\n");
}

main().catch((err) => {
  console.error("\nA reconstrucao falhou:", err.message);
  console.error("O banco anterior esta na copia de seguranca, se ela chegou a ser feita.\n");
  process.exit(1);
});
