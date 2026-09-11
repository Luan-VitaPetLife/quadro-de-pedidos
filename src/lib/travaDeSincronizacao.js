// Uma sincronizacao do Bling por vez, venha de onde vier.
//
// A trava existia, mas so na ROTA. O agendador chamava runSyncBling()
// diretamente e passava por baixo dela -- entao a rodada automatica de duas em
// duas horas e uma disparada a mao podiam correr juntas, disputando o mesmo
// orcamento de chamadas de uma API que anda a 2,5 por segundo.
//
// Foi visivel no contador de etapa: ele avancou ate "nota 300/344" e voltou
// para "nota 150/344". Duas rodadas escrevendo o mesmo campo, cada uma no seu
// ritmo, e as duas demorando o dobro. Muito provavelmente e o que deixou a
// primeira rodada meia hora presa na leitura das notas.
//
// A trava mora aqui, e nao no webhook, porque quem precisa dela sao os dois.

let emCurso = false;

export function sincronizacaoEmCurso() {
  return emCurso;
}

/**
 * Roda `tarefa` se nao houver outra sincronizacao em andamento.
 * @returns {Promise<{rodou: boolean, resultado?: any}>}
 */
export async function comTravaDeSincronizacao(tarefa) {
  if (emCurso) return { rodou: false };
  emCurso = true;
  try {
    return { rodou: true, resultado: await tarefa() };
  } finally {
    emCurso = false;
  }
}
