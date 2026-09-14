// Apaga o quadro e le tudo de novo, do zero, com as regras de hoje.
//
//   npm run reconstruir              (ultimos 30 dias)
//   npm run reconstruir -- 60        (ultimos 60 dias)
//   npm run reconstruir -- 30 --seco (so diz o que faria)
//
// ATENCAO: isto mexe no banco da SUA MAQUINA. O quadro de verdade roda no
// Railway, e o banco dele fica num volume que nao da pra alcancar daqui --
// para reconstruir a producao, use a rota:
//
//   POST /api/reconstruir?s=<segredo>&confirmar=APAGAR-E-RELER
//
// Por que reconstruir em vez de corrigir: o banco acumulou quadrados criados
// por regras que nao valem mais -- pedidos que a Mandae inventou a partir de um
// codigo desconhecido, notas rejeitadas que viraram remessa, etiquetas de venda
// abandonada. Consertar um por um e mais arriscado do que reler, porque a
// leitura nova ja sabe o que e remessa e o que nao e.

import "dotenv/config";
import { reconstruirQuadro } from "./lib/reconstrucao.js";

async function main() {
  const args = process.argv.slice(2);
  const seco = args.includes("--seco");
  const dias = Number(args.find((a) => /^\d+$/.test(a)) || 60);

  const r = await reconstruirQuadro({ dias, seco, aoAndar: (t) => console.log("  " + t) });

  console.log("\n" + "=".repeat(62));
  if (seco) {
    console.log(`Ensaio: ${r.antes} quadrado(s) no banco, ${r.resolvidosGuardados} resolvido(s).`);
    console.log("Nada foi apagado.\n");
    return;
  }

  const s = r.sync || {};
  console.log(`Quadro reconstruido: ${r.antes} -> ${r.depois} quadrado(s).`);
  console.log(`  criados: ${s.criados} · ignorados: ${s.ignorados} · apelidos: ${s.apelidos}`);
  console.log(`  com rastreio: ${s.comRastreio} · bonificacoes: ${s.bonificacoes} · erros: ${s.erros}`);
  console.log(`  notas rejeitadas/canceladas: ${s.notasSemValor}`);
  console.log(`\nResolvidos remarcados: ${r.remarcados} de ${r.resolvidosGuardados}.`);
  for (const p of r.naoVoltaram) {
    // Nao some em silencio: ou o pedido deixou de ser remessa pelas regras novas
    // (esperado) ou ficou de fora por engano, e so olhando da pra saber qual.
    console.log(`   NAO VOLTOU: ${p.orderNumber} — ${p.motivo || "(sem motivo)"}`);
  }
  console.log("\nFalta o WMS: `npm run fonteslog-login` e depois `npm run sync-fonteslog`.\n");
}

main().catch((err) => {
  console.error("\nA reconstrucao falhou:", err.message);
  console.error("Se a copia de seguranca chegou a ser feita, o banco anterior esta em data/.\n");
  process.exit(1);
});
