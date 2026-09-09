// Diagnostico da conexao com a Mandae -- RODE `npm run check-mandae`.
//
// Responde a pergunta "o quadro ja vai receber dados de verdade?" antes de
// depender disso em producao. Confere, em ordem:
//   1. As variaveis do .env estao preenchidas?
//   2. O token e aceito? (testa `Authorization: <token>` e `Bearer <token>`,
//      porque o formato exato nao esta confirmado na doc)
//   3. Se voce passar um codigo de rastreio como argumento, mostra os eventos
//      reais e como o quadro pintaria esse pedido.
//
// Uso:
//   npm run check-mandae
//   npm run check-mandae -- SEU-CODIGO-DE-RASTREIO

import "dotenv/config";
import { mandaeConfig, mandaeFetch, latestEvent } from "./integrations/mandae.js";
import { mapMandaeEvent } from "./lib/statusMapping.js";

const CORES = { green: "VERDE", amber: "AMARELO", red: "VERMELHO" };

function ok(msg) { console.log(`  [ok]    ${msg}`); }
function falha(msg) { console.log(`  [FALHA] ${msg}`); }
function aviso(msg) { console.log(`  [aviso] ${msg}`); }

async function main() {
  const trackingCode = process.argv[2] || null;
  const { token, customerId } = mandaeConfig();

  console.log("\n1) Variaveis de ambiente");
  if (token) ok(`MANDAE_TOKEN preenchido (${token.length} caracteres)`);
  else falha("MANDAE_TOKEN vazio -- preencha o .env antes de continuar.");
  // Mostra so o fim do valor: o suficiente pra voce conferir que e o certo,
  // sem jogar a credencial inteira num log que pode acabar compartilhado.
  if (customerId) ok(`MANDAE_CUSTOMER_ID preenchido (...${customerId.slice(-4)})`);
  else aviso("MANDAE_CUSTOMER_ID vazio -- nao bloqueia o rastreio de hoje, mas os endpoints por cliente vao precisar dele.");

  if (!token) {
    console.log("\nSem token nao da pra testar mais nada. Preencha e rode de novo.\n");
    process.exit(1);
  }

  console.log("\n2) O token e aceito? (testando os dois formatos de header)");
  // Um codigo qualquer serve pra testar AUTENTICACAO: 404 significa "te
  // reconheci, mas esse rastreio nao existe" -- ou seja, o token passou.
  const alvo = trackingCode || "TESTE000000000BR";
  let esquemaBom = null;

  for (const scheme of ["raw", "bearer"]) {
    const rotulo = scheme === "bearer" ? "Authorization: Bearer <token>" : "Authorization: <token>";
    try {
      const res = await mandaeFetch(`/v3/trackings/${encodeURIComponent(alvo)}`, { authScheme: scheme });
      if (res.status === 401 || res.status === 403) {
        falha(`${rotulo} -> ${res.status} (recusado)`);
      } else if (res.status === 404) {
        ok(`${rotulo} -> 404 (autenticou; o codigo "${alvo}" e que nao existe)`);
        esquemaBom = esquemaBom || scheme;
      } else if (res.ok) {
        ok(`${rotulo} -> ${res.status} (autenticou e achou o rastreio)`);
        esquemaBom = esquemaBom || scheme;
      } else {
        aviso(`${rotulo} -> ${res.status} (resposta inesperada)`);
      }
    } catch (err) {
      falha(`${rotulo} -> erro de rede: ${err.message}`);
    }
  }

  if (!esquemaBom) {
    console.log("\nNenhum formato de header foi aceito. Confira se o MANDAE_TOKEN foi copiado inteiro,");
    console.log("em Configuracoes da conta -> API, dentro do app da Mandae.\n");
    process.exit(1);
  }

  if (esquemaBom === "bearer") {
    console.log('\n  >> ATENCAO: so o formato "Bearer" funcionou. Troque authScheme para "bearer"');
    console.log("     em src/integrations/mandae.js (funcao mandaeFetch).\n");
  }

  console.log("\n3) Rastreio de verdade");
  if (!trackingCode) {
    aviso("Nenhum codigo passado. Rode `npm run check-mandae -- SEU-CODIGO` pra ver eventos reais.");
    console.log("");
    return;
  }

  const res = await mandaeFetch(`/v3/trackings/${encodeURIComponent(trackingCode)}`, { authScheme: esquemaBom });
  if (res.status === 404) {
    falha(`A Mandae nao conhece o rastreio ${trackingCode}.`);
    console.log("");
    return;
  }
  if (!res.ok) {
    falha(`Mandae respondeu ${res.status}.`);
    console.log("");
    return;
  }

  const tracking = await res.json();
  const eventos = Array.isArray(tracking.events) ? tracking.events : [];
  ok(`${eventos.length} evento(s) recebido(s).`);

  if (eventos.length === 0) {
    aviso("Rastreio sem eventos ainda -- no quadro esse pedido ficaria AMARELO.");
    console.log("");
    return;
  }

  console.log("\n  Como o quadro pintaria cada evento:");
  for (const ev of eventos) {
    const { status } = mapMandaeEvent(ev);
    const quando = ev.timestamp || ev.date || "sem data";
    console.log(`    ${String(CORES[status]).padEnd(9)} ${quando}  ${ev.name || ev.description || "(sem texto)"}`);
  }

  const ultimo = latestEvent(tracking);
  const final = mapMandaeEvent(ultimo);
  console.log(`\n  >> Evento mais recente: "${final.label}" -> quadrado ${CORES[final.status]}\n`);

  const naoReconhecidos = eventos.filter((ev) => {
    const texto = ev.name || ev.description || "";
    return texto && mapMandaeEvent(ev).status === "amber" && !/aguardando/i.test(texto);
  });
  if (naoReconhecidos.length > 0) {
    console.log("  Textos que cairam no amarelo padrao (talvez faltem regras em src/lib/statusMapping.js):");
    for (const ev of naoReconhecidos) console.log(`    - ${ev.name || ev.description}`);
    console.log("");
  }
}

main().catch((err) => {
  console.error("\nErro no diagnostico:", err.message, "\n");
  process.exit(1);
});
