const state = { orders: [], filter: "all", brandFilter: "all", search: "", selectedId: null, knownBrands: "" };
const statusWord = { green: "Tudo certo", amber: "Aviso em aberto", red: "Problema" };
const POLL_MS = 60000;

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return iso;
  }
}

function render() {
  const grid = document.getElementById("grid");
  const empty = document.getElementById("emptyState");
  const list = state.orders.filter((o) => {
    if (state.filter !== "all" && o.status !== state.filter) return false;
    if (state.brandFilter !== "all" && o.brand !== state.brandFilter) return false;
    if (state.search) {
      const s = state.search.toLowerCase();
      const hay = (o.orderNumber + " " + (o.customer || "")).toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  });

  grid.innerHTML = "";
  if (state.orders.length === 0) {
    empty.hidden = false;
    empty.textContent = "Nenhum pedido no radar ainda. Assim que a sincronização com a FontesLog e a Mandaê rodar, os quadrados aparecem aqui.";
  } else if (list.length === 0) {
    empty.hidden = false;
    empty.textContent = "Nenhum pedido corresponde ao filtro atual.";
  } else {
    empty.hidden = true;
    for (const o of list) {
      const el = document.createElement("button");
      el.className = "sq " + o.status + (o.orderNumber === state.selectedId ? " selected" : "");
      el.title = "Pedido " + o.orderNumber + (o.customer ? " — " + o.customer : "");
      el.innerHTML = "<span>" + o.orderNumber + "</span>";
      el.addEventListener("click", () => openPanel(o.orderNumber));
      grid.appendChild(el);
    }
  }

  const counts = { green: 0, amber: 0, red: 0 };
  for (const o of state.orders) if (counts[o.status] !== undefined) counts[o.status]++;
  document.getElementById("cTotal").textContent = state.orders.length;
  document.getElementById("cGreen").textContent = counts.green;
  document.getElementById("cAmber").textContent = counts.amber;
  document.getElementById("cRed").textContent = counts.red;

  document.querySelectorAll(".chip[data-filter]").forEach((c) => {
    c.dataset.active = String(c.dataset.filter === state.filter);
  });

  const brandFiltersEl = document.getElementById("brandFilters");
  const brands = Array.from(new Set(state.orders.map((o) => o.brand).filter(Boolean))).sort();
  if (brands.join("|") !== state.knownBrands) {
    state.knownBrands = brands.join("|");
    brandFiltersEl.innerHTML =
      '<button class="chip" data-brandfilter="all">Todas as marcas</button>' +
      brands.map((b) => `<button class="chip" data-brandfilter="${b}">${b}</button>`).join("");
  }
  document.querySelectorAll(".chip[data-brandfilter]").forEach((c) => {
    c.dataset.active = String(c.dataset.brandfilter === state.brandFilter);
  });

  const noteEl = document.getElementById("feedNote");
  noteEl.textContent =
    "Atualizado automaticamente a partir da FontesLog (WMS) e da Mandaê, com todos os pedidos, sem separação por marca. Clique em um quadrado para ver o histórico do pedido.";
}

function openPanel(orderNumber) {
  state.selectedId = orderNumber;
  const o = state.orders.find((x) => x.orderNumber === orderNumber);
  const backdrop = document.getElementById("backdrop");
  const panel = document.getElementById("panel");
  if (!o) {
    backdrop.classList.remove("open");
    return;
  }

  panel.innerHTML = `
    <div class="ph">
      <div>
        <div class="order-no mono">Pedido ${o.orderNumber}</div>
        ${o.brand ? `<span class="brand-tag">${o.brand}</span>` : ""}
      </div>
      <button class="close" aria-label="Fechar">&times;</button>
    </div>
    <span class="status-pill ${o.status}">${statusWord[o.status] || o.status}</span>
    ${o.motivoStatus ? `<div class="motivo">${o.motivoStatus}. Último evento conhecido: "${o.carrierStatus || "nenhum"}".</div>` : ""}
    <div class="field"><div class="k">Cliente</div><div class="v">${o.customer || "—"}</div></div>
    <div class="field"><div class="k">Status FontesLog (WMS)</div><div class="v">${o.wmsStatus || "sem dado ainda"}</div></div>
    <div class="field"><div class="k">Último evento Mandaê</div><div class="v">${o.carrierStatus || "sem dado ainda"}</div></div>
    <div class="field"><div class="k">Código de rastreio</div><div class="v mono">${o.trackingCode || "—"}</div></div>
    <div class="field"><div class="k">Destino</div><div class="v">${o.city || "—"}</div></div>
    <div class="field"><div class="k">Pedido feito em</div><div class="v mono">${fmtDate(o.placedAt)}</div></div>
    <div class="field"><div class="k">Última atualização</div><div class="v mono">${fmtDate(o.lastEventAt)}</div></div>
    <div class="field"><div class="k">Dias úteis sem novidade</div><div class="v mono">${o.diasParados ?? "—"}</div></div>
  `;
  panel.querySelector(".close").addEventListener("click", closePanel);
  backdrop.classList.add("open");
  render();
}

function closePanel() {
  state.selectedId = null;
  document.getElementById("backdrop").classList.remove("open");
  render();
}

document.getElementById("backdrop").addEventListener("click", (e) => {
  if (e.target.id === "backdrop") closePanel();
});
document.getElementById("filters").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip[data-filter]");
  if (!btn) return;
  state.filter = btn.dataset.filter;
  render();
});
document.getElementById("brandFilters").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip[data-brandfilter]");
  if (!btn) return;
  state.brandFilter = btn.dataset.brandfilter;
  render();
});
document.getElementById("search").addEventListener("input", (e) => {
  state.search = e.target.value;
  render();
});

render();

async function poll() {
  const syncLine = document.getElementById("syncLine");
  try {
    const [ordersRes, metaRes] = await Promise.all([fetch("/api/orders"), fetch("/api/meta")]);
    const ordersData = await ordersRes.json();
    const metaData = await metaRes.json();
    state.orders = ordersData.orders || [];
    render();
    if (state.selectedId) openPanel(state.selectedId);
    syncLine.innerHTML = metaData.lastSyncAt
      ? '<span class="dot"></span>Última sincronização: ' + fmtDate(metaData.lastSyncAt)
      : '<span class="dot"></span>Aguardando primeira sincronização';
  } catch (err) {
    syncLine.textContent = "Não foi possível falar com o servidor agora.";
  }
}

poll();
setInterval(poll, POLL_MS);

document.getElementById("syncBtn").addEventListener("click", async () => {
  const btn = document.getElementById("syncBtn");
  const syncLine = document.getElementById("syncLine");
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = "Sincronizando\u2026";
  try {
    const res = await fetch("/api/sync", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "falha ao sincronizar");
    await poll();
  } catch (err) {
    syncLine.textContent = "N\u00e3o deu pra sincronizar agora: " + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});
