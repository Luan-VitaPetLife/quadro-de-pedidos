// Testa a integracao inteira com UM PEDIDO REAL SEU.
//
//   npm run testar-pedido -- VITPT123456789BR
//   npm run testar-pedido -- VITPT123456789BR 1234        (com o numero do pedido)
//
// O que ele faz, em ordem:
//   1. Busca na Mandae o rastreio de verdade desse codigo.
//   2. Mostra os eventos reais e de que cor cada um pintaria o quadrado.
//   3. Confere os DOIS jeitos de autenticar no webhook (header e ?s= na URL),
//      que e exatamente o ponto que costuma estar mal configurado no painel.
//   4. Manda o pedido pro quadro do jeito que a Mandae mandaria.
//   5. Le o quadro de volta e mostra como o pedido ficou.
//
// IMPORTANTE: o passo 4 grava de verdade. Como o dado e um pedido real seu,
// ele nao e lixo -- fica no quadro como qualquer outro. Mas nao existe (ainda)
// uma forma de apagar um pedido do quadro, entao use um pedido que voce QUER
// ver la.

import "dotenv/config";
import { mandaeFetch, latestEvent } from "./integrations/mandae.js";
import { mapMandaeEvent } from "./lib/statusMapping.js";

const CORES = { green: "VERDE", amber: "AMARELO", red: "VERMELHO" };

function titulo(t) { console.log(`\n${t}`); }
function ok(m) { console.log(`  [ok]    ${m}`); }
function falha(m) { console.log(`  [FALHA] ${m}`); }
function aviso(m) { console.log(`  [aviso] ${m}`); }

async function main() {
  const trackingCode = process.argv[2];
  const orderNumber = process.argv[3] || null;

  if (!trackingCode) {
    console.log("\nUso: npm run testar-pedido -- CODIGO-DE-RASTREIO [NUMERO-DO-PEDIDO]");
    console.log("Ex.: npm run testar-pedido -- VITPT123456789BR 1234\n");
    process.exit(1);
  }

  const boardUrl = (process.env.BOARD_URL || "http://localhost:3000").replace(/\/+$/, "");
  const segredo = process.env.MANDAE_WEBHOOK_SECRET;
  if (!segredo) {
    console.log("\nMANDAE_WEBHOOK_SECRET vazio no .env -- sem ele nao da pra falar com o webhook.\n");
    process.exit(1);
  }

  console.log(`\nQuadro alvo: ${boardUrl}`);
  console.log(`Rastreio:    ${trackingCode}`);

  // ---------------------------------------------------------------- 1 e 2
  titulo("1) Buscando o rastreio real na Mandae");
  const res = await mandaeFetch(`/v3/trackings/${encodeURIComponent(trackingCode)}`);
  if (res.status === 404) {
    falha(`A Mandae nao conhece o rastreio ${trackingCode}. Confira o codigo (o seu prefixo e VITPT).`);
    console.log("");
    process.exit(1);
  }
  if (!res.ok) {
    falha(`Mandae respondeu ${res.status}.`);
    console.log("");
    process.exit(1);
  }

  const tracking = await res.json();
  const eventos = Array.isArray(tracking.events) ? tracking.events : [];
  ok(`${eventos.length} evento(s) encontrado(s).`);

  if (eventos.length === 0) {
    aviso("Rastreio sem eventos -- o pedido entraria no quadro como AMARELO.");
  } else {
    titulo("2) Como o quadro pinta cada evento");
    for (const ev of eventos) {
      const { status } = mapMandaeEvent(ev);
      const quando = ev.timestamp || ev.date || "sem data";
      console.log(`  ${String(CORES[status]).padEnd(9)} ${String(quando).padEnd(26)} ${ev.name || ev.description || "(sem texto)"}`);
    }
    const ultimo = mapMandaeEvent(latestEvent(tracking));
    console.log(`\n  >> Mais recente: "${ultimo.label}" -> quadrado ${CORES[ultimo.status]}`);
  }

  // ------------------------------------------------------------------- 3
  // Manda um payload SEM identificador de proposito: a resposta 400 prova que
  // a autenticacao passou, sem criar nada no quadro. E o jeito de testar as
  // duas formas de autenticar sem efeito colateral.
  titulo("3) Conferindo os dois jeitos de autenticar no webhook");

  async function sonda(rota, { comHeader, comQuery }) {
    const url = `${boardUrl}/webhooks/mandae/${rota}` + (comQuery ? `?s=${encodeURIComponent(segredo)}` : "");
    const headers = { "Content-Type": "application/json" };
    if (comHeader) headers["X-Mandae-Secret"] = segredo;
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({}) });
    return r.status;
  }

  for (const rota of ["item-processado", "rastreamento"]) {
    const viaHeader = await sonda(rota, { comHeader: true, comQuery: false });
    const viaQuery = await sonda(rota, { comHeader: false, comQuery: true });
    const semNada = await sonda(rota, { comHeader: false, comQuery: false });

    const desc = (c) => (c === 400 ? "autentica" : c === 401 ? "RECUSA" : `HTTP ${c}`);
    console.log(`  ${rota.padEnd(16)} header: ${desc(viaHeader).padEnd(10)} ?s=: ${desc(viaQuery).padEnd(10)} sem nada: ${desc(semNada)}`);

    if (viaHeader !== 400 && viaQuery !== 400) {
      falha(`Nenhum jeito de autenticar funcionou em ${rota} -- confira MANDAE_WEBHOOK_SECRET no Railway.`);
      process.exit(1);
    }
    if (semNada !== 401) {
      aviso(`${rota} aceitou chamada SEM autenticacao -- MANDAE_WEBHOOK_SECRET deve estar vazio no servidor.`);
    }
  }
  ok("Autenticacao conferida.");

  // ------------------------------------------------------------------- 4
  titulo("4) Mandando o pedido pro quadro (igual a Mandae faria)");
  const corpo = {
    idItemParceiro: orderNumber || undefined,
    trackingCode,
    events: eventos,
  };
  const envio = await fetch(`${boardUrl}/webhooks/mandae/rastreamento?s=${encodeURIComponent(segredo)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mandae-Secret": segredo },
    body: JSON.stringify(corpo),
  });
  const respostaEnvio = await envio.text();
  if (!envio.ok) {
    falha(`O quadro recusou (HTTP ${envio.status}): ${respostaEnvio}`);
    process.exit(1);
  }
  ok(`Aceito (HTTP ${envio.status}).`);
  if (!orderNumber) {
    aviso("Sem numero de pedido informado -- o quadro vai identificar esse pedido pelo codigo de rastreio.");
  }

  // ------------------------------------------------------------------- 5
  titulo("5) Conferindo como ficou no quadro");
  const listaRes = await fetch(`${boardUrl}/api/orders`);
  const { orders } = await listaRes.json();
  const chave = orderNumber || trackingCode;
  const pedido = orders.find((o) => o.orderNumber === chave);

  if (!pedido) {
    falha(`O pedido ${chave} nao apareceu no quadro. Pedidos atuais: ${orders.length}.`);
    process.exit(1);
  }

  ok(`Pedido ${pedido.orderNumber} esta no quadro.`);
  console.log(`     cor            : ${CORES[pedido.status] || pedido.status}`);
  console.log(`     ultimo evento  : ${pedido.carrierStatus}`);
  console.log(`     rastreio       : ${pedido.trackingCode}`);
  console.log(`     atualizado em  : ${pedido.lastEventAt}`);
  console.log(`\nAbra ${boardUrl} -- o quadrado tem que estar la, na cor ${CORES[pedido.status]}.\n`);
}

main().catch((err) => {
  console.error("\nErro:", err.message, "\n");
  process.exit(1);
});
