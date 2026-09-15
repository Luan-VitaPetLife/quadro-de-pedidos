// O aviso do Bling quando um pedido ou uma nota muda -- o "ao vivo" de verdade.
//
// COMO ISTO SE ENCAIXA, e por que nao processa o evento por conta propria:
//
// O webhook nao traz nada ao quadro sozinho. Ele so ADIANTA a via rapida que
// ja roda de minutos em minutos (ver scheduler.js). O evento chega, e o quadro
// pergunta ao Bling "o que mudou?" -- a mesma pergunta, as mesmas regras, o
// mesmo codigo.
//
// A alternativa seria gravar direto o que vem no corpo do evento. Seria mais
// rapido e seria um erro: as regras que decidem se um pedido vira quadrado
// moram em sync-bling.js (nota emitida ou prazo estourado, nota rejeitada
// desmonta a remessa, o rastreio vem da nota e nunca do pedido...). Um segundo
// caminho de gravacao teria que repetir tudo isso e, no dia em que uma das
// regras mudasse, o quadro passaria a mostrar coisas diferentes conforme o
// pedido tivesse chegado por webhook ou por varredura.
//
// Alem disso o proprio Bling avisa que nao garante ordem de entrega e que pode
// repetir eventos. Um gatilho e idempotente por natureza; uma gravacao direta
// teria que virar idempotente na mao.
//
// Se o webhook nunca for configurado, ou cair, nada quebra: a via rapida
// continua perguntando sozinha. O webhook so encurta a espera de alguns
// minutos para alguns segundos.

import crypto from "node:crypto";
import { comTravaDeSincronizacao } from "../lib/travaDeSincronizacao.js";
import { setMeta } from "../lib/db.js";

// Eventos que NAO mexem no quadro. Produto e estoque podem ser assinados no
// painel do Bling e nao interessam aqui -- o quadro e de remessas.
//
// A lista e de recusa, e nao de aceite, de proposito. Se o nome do evento vier
// num campo que este codigo nao conhece (versao nova do payload, formato
// diferente), uma lista de aceite nao casaria com nada e o quadro responderia
// 200 sem NUNCA agir -- a pior falha possivel aqui, porque por fora parece que
// esta tudo configurado. Com a lista de recusa, o desconhecido dispara a
// leitura. O custo de disparar a toa e uma leitura incremental barata, ja
// protegida por debounce e trava; o custo de nao disparar e o recurso inteiro
// nao funcionar em silencio.
const NAO_INTERESSA = /^(product|stock|virtualStock|supplierProduct)\./i;

/**
 * Confere a assinatura HMAC-SHA256 que o Bling manda em X-Bling-Signature-256.
 *
 * A chave e o client secret do app. Sem isso, qualquer pessoa que descobrisse a
 * URL poderia disparar sincronizacoes a vontade -- nao inventaria pedidos (a
 * rota nao grava nada do que recebe), mas gastaria o orcamento de chamadas da
 * API do Bling ate a sincronizacao de verdade comecar a falhar.
 */
export function assinaturaConfere(req) {
  const segredo = process.env.BLING_CLIENT_SECRET;
  if (!segredo) return { ok: false, motivo: "BLING_CLIENT_SECRET nao configurado" };

  const cabecalho = req.get("X-Bling-Signature-256") || "";
  const recebida = cabecalho.replace(/^sha256=/i, "").trim();
  if (!recebida) return { ok: false, motivo: "sem cabecalho X-Bling-Signature-256" };

  const corpo = req.corpoCru;
  if (!corpo?.length) return { ok: false, motivo: "corpo vazio" };

  const calculada = crypto.createHmac("sha256", segredo).update(corpo).digest("hex");

  // timingSafeEqual exige o mesmo tamanho, e estoura se nao for -- por isso a
  // comparacao de tamanho vem antes, e nao dentro do try.
  const a = Buffer.from(calculada, "utf-8");
  const b = Buffer.from(recebida.toLowerCase(), "utf-8");
  if (a.length !== b.length) return { ok: false, motivo: "assinatura nao confere" };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, motivo: "assinatura nao confere" };
}

// ---------------------------------------------------------------------------
// Juntar os eventos antes de agir
// ---------------------------------------------------------------------------
//
// Faturar um pedido dispara varios eventos quase juntos (o pedido muda, a nota
// nasce, a nota e autorizada). Uma sincronizacao por evento seria trabalho
// repetido: a segunda leria exatamente o mesmo que a primeira.
//
// Entao o gatilho espera alguns segundos e junta o que chegar nesse meio tempo.
// E se um evento chegar ENQUANTO a leitura roda, fica marcado que falta uma
// rodada -- senao esse evento seria engolido pela trava e so apareceria na
// proxima via rapida.
const ESPERA_MS = Number(process.env.BLING_WEBHOOK_ESPERA_MS || 4000);
let aguardando = null;
let rodando = false;
let ficouPendente = false;

async function lerOQueMudou() {
  const { momentoNoBling } = await import("../integrations/bling.js");
  const { runSyncBling } = await import("../sync-bling.js");
  // Quinze minutos pra tras, e nao "desde o evento": eventos podem chegar fora
  // de ordem e com atraso (o Bling reentrega por ate 3 dias). Uma janela curta
  // demais deixaria passar justamente o evento atrasado.
  const desde = momentoNoBling(new Date(Date.now() - 15 * 60000));
  const { rodou, resultado } = await comTravaDeSincronizacao(() => runSyncBling({ alteradosDesde: desde }));
  if (!rodou) return false;

  // So os pedidos que esta leitura mexeu -- ver o mesmo cuidado no scheduler.
  const tocados = resultado?.tocados || [];
  if (tocados.length) {
    const { runSync } = await import("../sync.js");
    await runSync({ apenas: tocados }).catch((err) => console.error("[bling-webhook] Mandae:", err.message));
  }
  return true;
}

async function rodarAgora() {
  aguardando = null;
  if (rodando) {
    ficouPendente = true;
    return;
  }
  rodando = true;
  try {
    const rodou = await lerOQueMudou();
    if (!rodou) ficouPendente = true; // a varredura estava rodando; tenta depois
  } catch (err) {
    console.error("[bling-webhook] falha ao ler o que mudou:", err.message);
  } finally {
    rodando = false;
    if (ficouPendente) {
      ficouPendente = false;
      agendar();
    }
  }
}

function agendar() {
  if (aguardando) return; // ja ha uma rodada marcada; este evento entra nela
  aguardando = setTimeout(() => {
    rodarAgora().catch((err) => console.error("[bling-webhook]", err.message));
  }, ESPERA_MS);
  // Nao segura o processo vivo no desligamento.
  aguardando.unref?.();
}

// POST /webhooks/bling
export async function handleEventoBling(req, res) {
  const conferencia = assinaturaConfere(req);
  if (!conferencia.ok) {
    // Registrar a recusa importa: sem isso, "o Bling chamou e foi rejeitado" e
    // "o Bling nunca chamou" produzem o mesmo sintoma -- quadro parado e log
    // em branco.
    console.warn(`[bling-webhook] RECUSADO (401): ${conferencia.motivo}`);
    setMeta("blingWebhookUltimaRecusa", `${conferencia.motivo} @ ${new Date().toISOString()}`);
    return res.status(401).json({ error: "assinatura invalida" });
  }

  // O nome do evento ja apareceu como `event` na documentacao; os outros campos
  // ficam como plano B para o caso de uma versao do payload usar outro nome.
  const corpo = req.body || {};
  const evento = String(corpo.event || corpo.evento || corpo.type || "");

  // Responde JA. O Bling desiste em 5 segundos e reentrega o evento depois; se
  // a resposta esperasse a sincronizacao terminar, todo evento viraria uma
  // reentrega e o mesmo trabalho seria feito varias vezes.
  res.status(200).json({ ok: true, evento });

  setMeta("blingWebhookUltimoEm", new Date().toISOString());
  // Quando o nome do evento nao for reconhecido, guarda os CAMPOS que vieram.
  // Sem isso, diagnosticar um payload em formato inesperado exigiria o log do
  // container, que nao esta ao alcance de quem opera.
  setMeta("blingWebhookUltimoEvento", evento || `(sem nome; campos: ${Object.keys(corpo).join(", ")})`);

  if (evento && NAO_INTERESSA.test(evento)) return;
  agendar();
}
