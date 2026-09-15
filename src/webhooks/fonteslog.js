// Recebe no quadro os pedidos lidos do WMS da FontesLog.
//
// HOJE o caminho normal e outro: o proprio servidor le o portal a cada ciclo
// (ver lib/wms.js e o agendador). Esta rota continua existindo porque e util
// quando o servidor esta sem sessao valida e alguem quer empurrar uma leitura
// feita na propria maquina -- e porque quebrar uma entrada que ja funciona, sem
// precisar, nao melhora nada.
//
// A gravacao em si mora em lib/wms.js, a mesma que o agendador usa: se as duas
// entradas tivessem codigo proprio, o quadro mostraria coisas diferentes
// dependendo de quem leu.
//
// Autenticacao: o mesmo MANDAE_WEBHOOK_SECRET, por header ou ?s= na URL.

import { gravarPedidosWms } from "../lib/wms.js";
import { verifyMandaeWebhook } from "./mandae.js";

// POST /webhooks/fonteslog
export async function handleFontesLog(req, res) {
  if (!verifyMandaeWebhook(req)) {
    console.warn("[webhook] fonteslog RECUSADO (401): segredo invalido ou ausente.");
    return res.status(401).json({ error: "assinatura invalida" });
  }

  const pedidos = Array.isArray(req.body?.pedidos) ? req.body.pedidos : null;
  if (!pedidos) {
    return res.status(400).json({ error: "esperado { pedidos: [...] }" });
  }

  const { gravados, naoCasaram, ignorados } = gravarPedidosWms(pedidos);

  console.log(
    `[webhook] fonteslog: ${gravados} pedido(s) atualizado(s), ${naoCasaram.length} sem pedido correspondente, ${ignorados} ignorado(s).`
  );
  res.status(200).json({ ok: true, gravados, semCorrespondencia: naoCasaram.length, ignorados });
}
