// Recebe no quadro os pedidos lidos do WMS da FontesLog.
//
// Por que existe uma rota em vez de gravar direto no banco: o portal da
// FontesLog exige login manual (reCAPTCHA), entao a leitura roda na maquina de
// quem opera -- nao no Railway, que nao tem navegador nem sessao. O script
// local le o portal e empurra o resultado pra ca por esta rota.
//
// Autenticacao: o mesmo MANDAE_WEBHOOK_SECRET, por header ou ?s= na URL.

import { upsertOrder } from "../lib/db.js";
import { mapFontesLogStatus } from "../lib/statusMapping.js";
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

  let gravados = 0;
  const ignorados = [];

  for (const p of pedidos) {
    const orderNumber = String(p.numeroPedido || "").trim();
    if (!orderNumber) {
      ignorados.push(p);
      continue;
    }

    // So mandamos os campos do WMS. O db.js recalcula a cor final combinando
    // com o que a Mandae ja souber do mesmo pedido -- e por isso que o pedido
    // aparece como UM quadrado, e nao dois.
    // A severidade pode vir decidida da origem (`severidade`). Isso existe
    // porque as telas de Parados e Rejeitados trazem um MOTIVO em texto livre,
    // que vai junto no rotulo -- e deduzir a cor de um texto livre e pedir
    // acidente: "PARADO: falta de estoque" casaria com a regra de "falta" e
    // viraria vermelho, quando parado e amarelo. Quem leu a tela sabe a cor;
    // mapFontesLogStatus fica so para o status seco do rastreamento.
    upsertOrder({
      orderNumber,
      wmsStatus: p.status || null,
      notaFiscal: p.notaFiscal || undefined,
      wmsSeverity: p.severidade || mapFontesLogStatus(p.status),
      lastEventAt: p.ultimoMovimento || undefined,
      // "ATB0240367" e nome que so existe dentro do portal da FontesLog. Se a
      // nota dessa remessa ja tem quadrado, e nele que este status entra --
      // senao o mesmo pedido aparece duas vezes, um lado com o status do
      // armazem e outro com o rastreio, cada um contando metade da historia.
      numeroProvisorio: true,
    });
    gravados++;
  }

  console.log(`[webhook] fonteslog: ${gravados} pedido(s) gravado(s), ${ignorados.length} ignorado(s).`);
  res.status(200).json({ ok: true, gravados, ignorados: ignorados.length });
}
