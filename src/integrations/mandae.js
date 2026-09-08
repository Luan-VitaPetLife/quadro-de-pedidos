// Cliente simples para a API da Mandae (docs.mandae.com.br).
// Endpoint: GET /v3/trackings/{trackingCode} -> historico de eventos do rastreio.

const BASE_URL = "https://api.mandae.com.br";

/**
 * Busca o historico de rastreio de um codigo na Mandae.
 * @param {string} trackingCode
 * @returns {Promise<{trackingCode: string, events: Array<{id: string, date: string, name: string}>} | null>}
 */
export async function fetchTracking(trackingCode) {
  const token = process.env.MANDAE_TOKEN;
  if (!token) throw new Error("MANDAE_TOKEN nao configurado (.env)");
  if (!trackingCode) return null;

  const res = await fetch(`${BASE_URL}/v3/trackings/${encodeURIComponent(trackingCode)}`, {
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Mandae respondeu ${res.status} para o rastreio ${trackingCode}`);
  }
  return res.json();
}

/**
 * Pega o evento mais recente de um payload de tracking da Mandae.
 * A API nao garante ordem, entao ordenamos por timestamp/date.
 */
export function latestEvent(tracking) {
  if (!tracking || !Array.isArray(tracking.events) || tracking.events.length === 0) {
    return null;
  }
  const sorted = [...tracking.events].sort((a, b) => {
    const ta = new Date(a.timestamp || a.date).getTime();
    const tb = new Date(b.timestamp || b.date).getTime();
    return tb - ta;
  });
  return sorted[0];
}
