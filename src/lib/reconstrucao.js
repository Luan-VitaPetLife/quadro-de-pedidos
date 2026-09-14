// A reconstrucao do quadro: apaga e le tudo de novo.
//
// Mora numa biblioteca, e nao no script, porque precisa rodar nos dois lugares:
// na maquina de quem opera (`npm run reconstruir`) e no Railway, que e onde o
// banco de verdade vive -- o volume la nao e alcancavel de fora.
//
// O QUE NAO SE PERDE: os pedidos marcados como resolvidos. Eles carregam um
// motivo escrito a mao ("extravio resolvido - realizado reenvio") que nao existe
// em fonte nenhuma. Se sumisse, sumia o trabalho de alguem.

import fs from "node:fs";
import path from "node:path";
import {
  db,
  dataDir,
  listOrders,
  ocultarPedido,
  resolverCanonico,
  getOrder,
  esquecerCaches,
} from "./db.js";

function carimbo() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * @param {{dias?: number, seco?: boolean, aoAndar?: (texto: string) => void}} opcoes
 */
export async function reconstruirQuadro({ dias = 60, seco = false, aoAndar = () => {} } = {}) {
  const antes = listOrders();
  const resolvidos = antes
    .filter((o) => o.oculto)
    .map((o) => ({
      orderNumber: o.orderNumber,
      apelidos: o.apelidos || [],
      motivo: o.ocultoMotivo,
      em: o.ocultoEm,
    }));

  const relatorio = {
    antes: antes.length,
    resolvidosGuardados: resolvidos.length,
    copia: null,
    apagados: 0,
    depois: 0,
    remarcados: 0,
    naoVoltaram: [],
    sync: null,
  };

  if (seco) {
    aoAndar(`--seco: releria ${dias} dia(s); ${antes.length} quadrado(s) seriam apagados.`);
    return relatorio;
  }

  // Copia antes de qualquer coisa: e barata e e a unica forma de desfazer se a
  // releitura vier pior do que o que estava la.
  const arquivo = path.join(dataDir, "orders.sqlite");
  if (fs.existsSync(arquivo)) {
    const copia = path.join(dataDir, `orders-antes-da-reconstrucao-${carimbo()}.sqlite`);
    fs.copyFileSync(arquivo, copia);
    relatorio.copia = copia;
    aoAndar(`copia de seguranca em ${copia}`);
  }

  relatorio.apagados = db.prepare("DELETE FROM orders").run().changes;
  db.prepare("DELETE FROM orfaos").run();

  // Sem isto a releitura vem embaralhada: os mapas de apelido e de nota ficam
  // apontando para quadrados que acabaram de deixar de existir, e o primeiro
  // pedido relido cai no lugar do antigo.
  esquecerCaches();
  aoAndar(`${relatorio.apagados} quadrado(s) apagado(s); relendo o Bling...`);

  const { runSyncBling } = await import("../sync-bling.js");
  relatorio.sync = await runSyncBling({ dias });

  // Reaplica as marcas de resolvido. Os apelidos entram na busca porque a
  // releitura pode trazer a mesma venda com outro nome -- pelo numero do pedido
  // em vez do numero da nota, tipicamente.
  for (const res of resolvidos) {
    const alvo = [res.orderNumber, ...res.apelidos]
      .map((c) => resolverCanonico(c))
      .find((c) => getOrder(c));
    if (!alvo) {
      relatorio.naoVoltaram.push({ orderNumber: res.orderNumber, motivo: res.motivo });
      continue;
    }
    ocultarPedido(alvo, res.motivo);
    relatorio.remarcados++;
  }

  relatorio.depois = listOrders().length;
  aoAndar(`reconstruido: ${relatorio.depois} quadrado(s), ${relatorio.remarcados} resolvido(s) remarcado(s).`);
  return relatorio;
}
