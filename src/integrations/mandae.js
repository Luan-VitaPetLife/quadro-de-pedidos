// Cliente simples para a API da Mandae (docs.mandae.com.br).
// Endpoint: GET /v3/trackings/{trackingCode} -> historico de eventos do rastreio.

const BASE_URL = "https://api.mandae.com.br";

/**
 * Le as credenciais do .env em UM lugar so, pra nao ficar espalhado.
 *
 * Sobre o customerId: a Mandae entrega DUAS coisas em Configuracoes -> API,
 * o Access Token e o Customer ID. O token sozinho basta pro endpoint de
 * rastreio que usamos hoje (a consulta e por codigo de rastreio, nao por
 * cliente). O customerId e exigido pelos endpoints "por cliente"
 * (/v3/customers/{customerId}/...), que ainda nao consumimos -- por isso ele
 * fica configurado e validado aqui, mas so vira obrigatorio quando alguem
 * chamar requireCustomerId(). Ele NAO e mais uma variavel morta no .env:
 * o `npm run check-mandae` confere se esta preenchido.
 */
export function mandaeConfig() {
  return {
    token: process.env.MANDAE_TOKEN || null,
    customerId: process.env.MANDAE_CUSTOMER_ID || null,
    baseUrl: BASE_URL,
  };
}

function requireToken() {
  const { token } = mandaeConfig();
  if (!token) throw new Error("MANDAE_TOKEN nao configurado (.env)");
  return token;
}

export function requireCustomerId() {
  const { customerId } = mandaeConfig();
  if (!customerId) throw new Error("MANDAE_CUSTOMER_ID nao configurado (.env)");
  return customerId;
}

/**
 * Faz uma chamada autenticada na Mandae e devolve a resposta crua.
 *
 * ATENCAO -- ponto ainda NAO confirmado contra a API real: o formato do header
 * de autenticacao. Estamos mandando `Authorization: <token>` (sem prefixo
 * "Bearer"), que e o que a doc parecia indicar. Se a Mandae responder 401 com
 * as credenciais certas, o primeiro suspeito e aqui: tente `Bearer <token>`.
 * Rode `npm run check-mandae` -- ele testa os dois formatos e diz qual passou.
 */
export async function mandaeFetch(path, { token, authScheme = "raw" } = {}) {
  const usedToken = token || requireToken();
  const authValue = authScheme === "bearer" ? `Bearer ${usedToken}` : usedToken;

  return fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: authValue,
      "Content-Type": "application/json",
    },
  });
}

/**
 * Busca o historico de rastreio de um codigo na Mandae.
 * @param {string} trackingCode
 * @returns {Promise<{trackingCode: string, events: Array<{id: string, date: string, name: string}>} | null>}
 */
export async function fetchTracking(trackingCode) {
  requireToken();
  if (!trackingCode) return null;

  const res = await mandaeFetch(`/v3/trackings/${encodeURIComponent(trackingCode)}`);

  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Mandae recusou a autenticacao (${res.status}) no rastreio ${trackingCode}. ` +
        `Rode \`npm run check-mandae\` pra descobrir se o problema e o token ou o formato do header.`
    );
  }
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
