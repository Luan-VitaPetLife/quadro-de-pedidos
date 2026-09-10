// Diario de bordo do processo: quando subiu, quando caiu e POR QUE.
//
// Por que isso existe: o Railway manda "Deploy Crashed" a cada deploy, mas o
// container que morreu levou o log junto e a interface so mostra o estado
// final. Sem registro que sobreviva ao reinicio, cada investigacao vira
// adivinhacao -- e uma suposicao errada ja custou uma correcao que nao
// resolveu (o SIGTERM).
//
// Como o banco fica no Volume, gravar aqui atravessa o reinicio: a instancia
// nova consegue ler como a anterior terminou.

import { getMeta, setMeta } from "./db.js";

const CHAVE = "diarioDeSaida";

export function lerDiario() {
  const bruto = getMeta(CHAVE);
  if (!bruto) return null;
  try {
    return JSON.parse(bruto);
  } catch {
    return null;
  }
}

/**
 * Registra como este processo esta terminando.
 * Chamado por todos os caminhos de saida -- inclusive os feios.
 */
export function anotarSaida(motivo, detalhe = null) {
  try {
    const anterior = lerDiario() || {};
    setMeta(
      CHAVE,
      JSON.stringify({
        motivo,
        detalhe: detalhe ? String(detalhe).slice(0, 1000) : null,
        em: new Date().toISOString(),
        subiuEm: anterior.subiuEm || null,
        // Quantas vezes o processo ja subiu neste volume. Se esse numero cresce
        // rapido, o container esta reiniciando em loop -- e ai o "crash" nao e
        // do deploy, e de algo que derruba o app em operacao normal.
        boots: anterior.boots || 0,
      })
    );
  } catch {
    // Nunca deixar o registro do erro atrapalhar o encerramento.
  }
}

/** Chamado na subida: conta o boot e devolve como o processo anterior terminou. */
export function registrarBoot() {
  const anterior = lerDiario();
  const boots = (anterior?.boots || 0) + 1;
  setMeta(
    CHAVE,
    JSON.stringify({
      motivo: "rodando",
      detalhe: null,
      em: null,
      subiuEm: new Date().toISOString(),
      boots,
      // Guarda como a instancia anterior terminou, pra nao se perder no proximo
      // registro de saida.
      anterior: anterior ? { motivo: anterior.motivo, detalhe: anterior.detalhe, em: anterior.em } : null,
    })
  );
  return { boots, anterior };
}
