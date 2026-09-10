const state = {
  orders: [],
  filter: "all",
  brandFilter: "all",
  periodo: "hoje",
  de: null,
  ate: null,
  search: "",
  selectedId: null,
  knownBrands: "",
};
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

function fmtDia(iso) {
  if (!iso) return "—";
  return String(iso).slice(0, 10).split("-").reverse().join("/");
}

// ---------------------------------------------------------------------------
// Período
// ---------------------------------------------------------------------------
//
// A data que manda é a do PEDIDO (placedAt), não a do último evento. "Pedidos
// de hoje" quer dizer feitos hoje — um pedido de semana passada que se mexeu
// hoje não é de hoje. Quando não há data de pedido, cai no último evento, que
// é o melhor palpite disponível.
function dataDoPedido(o) {
  return (o.placedAt || o.lastEventAt || "").slice(0, 10);
}

function hojeISO(deslocamentoDias = 0) {
  const d = new Date();
  d.setDate(d.getDate() + deslocamentoDias);
  // Data local, não UTC: toISOString() joga o fuso do Brasil pro dia anterior
  // depois das 21h, e o filtro "hoje" ficaria vazio à noite.
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function intervaloDoPeriodo() {
  const hoje = hojeISO();
  switch (state.periodo) {
    case "hoje":
      return [hoje, hoje];
    case "ontem": {
      const o = hojeISO(-1);
      return [o, o];
    }
    case "semana": {
      const d = new Date();
      // Semana começa na segunda: getDay() dá 0 no domingo, que precisa voltar 6.
      const diaDaSemana = (d.getDay() + 6) % 7;
      return [hojeISO(-diaDaSemana), hoje];
    }
    case "mes":
      return [hoje.slice(0, 8) + "01", hoje];
    case "custom":
      return [state.de || "0000-00-00", state.ate || "9999-99-99"];
    default:
      return null; // "tudo"
  }
}

function dentroDoPeriodo(o) {
  const faixa = intervaloDoPeriodo();
  if (!faixa) return true;
  const d = dataDoPedido(o);
  if (!d) return false;
  return d >= faixa[0] && d <= faixa[1];
}

function render() {
  const grid = document.getElementById("grid");
  const empty = document.getElementById("emptyState");

  const noPeriodo = state.orders.filter(dentroDoPeriodo);

  const list = noPeriodo.filter((o) => {
    if (state.filter === "bonificacao") {
      if (!o.bonificacao) return false;
    } else if (state.filter !== "all" && o.status !== state.filter) {
      return false;
    }
    if (state.brandFilter !== "all" && o.brand !== state.brandFilter) return false;
    if (state.search) {
      const s = state.search.toLowerCase();
      const hay = (o.orderNumber + " " + (o.customer || "") + " " + (o.trackingCode || "")).toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  });

  grid.innerHTML = "";
  if (noPeriodo.length === 0) {
    empty.hidden = false;
    empty.textContent =
      state.orders.length === 0
        ? "Nenhum pedido no radar ainda."
        : "Nenhum pedido neste período. Experimente “Essa semana”, “Esse mês” ou “Tudo”.";
  } else if (list.length === 0) {
    empty.hidden = false;
    empty.textContent = "Nenhum pedido corresponde ao filtro atual.";
  } else {
    empty.hidden = true;
    for (const o of list) {
      const el = document.createElement("button");
      el.className = "sq " + o.status + (o.orderNumber === state.selectedId ? " selected" : "");
      el.title =
        "Pedido " + o.orderNumber + (o.customer ? " — " + o.customer : "") + (o.trackingCode ? "\nRastreio: " + o.trackingCode : "");

      // textContent em vez de innerHTML: número de pedido e código de rastreio
      // vêm de fora (webhook, portal, ERP) e não devem poder injetar HTML.
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = o.orderNumber;
      el.appendChild(num);

      if (o.trackingCode) {
        const rast = document.createElement("span");
        rast.className = "rast mono";
        rast.textContent = o.trackingCode;
        el.appendChild(rast);
      }
      if (o.semAcompanhamento) el.classList.add("sem-acomp");
      if (o.bonificacao) {
        const b = document.createElement("span");
        b.className = "boni";
        b.textContent = "🎁";
        b.title = "Bonificação/doação";
        el.appendChild(b);
      }

      el.addEventListener("click", () => openPanel(o.orderNumber));
      grid.appendChild(el);
    }
  }

  const counts = { green: 0, amber: 0, red: 0 };
  for (const o of noPeriodo) if (counts[o.status] !== undefined) counts[o.status]++;
  document.getElementById("cTotal").textContent = noPeriodo.length;
  document.getElementById("cGreen").textContent = counts.green;
  document.getElementById("cAmber").textContent = counts.amber;
  document.getElementById("cRed").textContent = counts.red;

  document.querySelectorAll(".chip[data-filter]").forEach((c) => {
    c.dataset.active = String(c.dataset.filter === state.filter);
  });
  document.querySelectorAll(".chip[data-periodo]").forEach((c) => {
    c.dataset.active = String(c.dataset.periodo === state.periodo);
  });

  // As marcas vêm do que está no período — senão o filtro lista lojas que
  // não têm nenhum pedido visível.
  const brandFiltersEl = document.getElementById("brandFilters");
  const brands = Array.from(new Set(noPeriodo.map((o) => o.brand).filter(Boolean))).sort();
  const assinatura = brands.join("|");
  if (assinatura !== state.knownBrands) {
    state.knownBrands = assinatura;
    brandFiltersEl.innerHTML = "";
    const todos = document.createElement("button");
    todos.className = "chip";
    todos.dataset.brandfilter = "all";
    todos.textContent = "Todas as marcas";
    brandFiltersEl.appendChild(todos);
    for (const b of brands) {
      const btn = document.createElement("button");
      btn.className = "chip";
      btn.dataset.brandfilter = b;
      btn.textContent = b;
      brandFiltersEl.appendChild(btn);
    }
  }
  document.querySelectorAll(".chip[data-brandfilter]").forEach((c) => {
    c.dataset.active = String(c.dataset.brandfilter === state.brandFilter);
  });

  const noteEl = document.getElementById("feedNote");
  noteEl.textContent =
    "Cor = o pior entre o WMS (FontesLog) e a transportadora (Mandaê). O Bling entra como cadastro e ponte. " +
    "Clique num quadrado para ver o histórico do pedido.";
}

function campo(rotulo, valor, mono) {
  const d = document.createElement("div");
  d.className = "field";
  const k = document.createElement("div");
  k.className = "k";
  k.textContent = rotulo;
  const v = document.createElement("div");
  v.className = "v" + (mono ? " mono" : "");
  v.textContent = valor || "—";
  d.appendChild(k);
  d.appendChild(v);
  return d;
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

  // Painel montado por DOM, não por innerHTML: os valores vêm de sistemas
  // externos e não devem poder injetar HTML na tela de quem abre o quadro.
  panel.innerHTML = "";

  const ph = document.createElement("div");
  ph.className = "ph";
  const esq = document.createElement("div");
  const no = document.createElement("div");
  no.className = "order-no mono";
  no.textContent = "Pedido " + o.orderNumber;
  esq.appendChild(no);
  if (o.brand) {
    const tag = document.createElement("span");
    tag.className = "brand-tag";
    tag.textContent = o.brand;
    esq.appendChild(tag);
  }
  if (o.bonificacao) {
    const tag = document.createElement("span");
    tag.className = "brand-tag boni-tag";
    tag.textContent = "🎁 Bonificação";
    esq.appendChild(tag);
  }
  const fechar = document.createElement("button");
  fechar.className = "close";
  fechar.setAttribute("aria-label", "Fechar");
  fechar.textContent = "×";
  fechar.addEventListener("click", closePanel);
  ph.appendChild(esq);
  ph.appendChild(fechar);
  panel.appendChild(ph);

  const pill = document.createElement("span");
  pill.className = "status-pill " + o.status;
  pill.textContent = statusWord[o.status] || o.status;
  panel.appendChild(pill);

  if (o.motivoStatus) {
    const m = document.createElement("div");
    m.className = "motivo";
    m.textContent = o.motivoStatus + ". Último evento conhecido: " + (o.carrierStatus || o.wmsStatus || "nenhum") + ".";
    panel.appendChild(m);
  }

  if (o.semAcompanhamento) {
    const n = document.createElement("div");
    n.className = "motivo neutro";
    n.textContent =
      "Despachado por transportadora que o quadro nao consulta (so a Mandaê tem integração). " +
      "Sabemos que saiu; não haverá mais eventos por aqui.";
    panel.appendChild(n);
  }

  panel.appendChild(campo("Cliente", o.customer));
  panel.appendChild(campo("Status FontesLog (WMS)", o.wmsStatus || "sem dado ainda"));
  panel.appendChild(campo("Último evento Mandaê", o.carrierStatus || "sem dado ainda"));
  panel.appendChild(campo("Código de rastreio", o.trackingCode, true));
  panel.appendChild(campo("Destino", o.city));
  panel.appendChild(campo("Natureza da operação", o.natureza));
  panel.appendChild(campo("Pedido feito em", fmtDate(o.placedAt), true));
  panel.appendChild(campo("Previsão de entrega", o.previsaoEntrega ? fmtDia(o.previsaoEntrega) : null, true));
  panel.appendChild(campo("Última atualização", fmtDate(o.lastEventAt), true));
  panel.appendChild(campo("Dias úteis sem novidade", o.diasParados ?? "—", true));

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
document.getElementById("periodos").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip[data-periodo]");
  if (!btn) return;
  state.periodo = btn.dataset.periodo;
  render();
});
["dataDe", "dataAte"].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => {
    state.de = document.getElementById("dataDe").value || null;
    state.ate = document.getElementById("dataAte").value || null;
    // Mexer nas datas já significa querer o período personalizado.
    if (state.de || state.ate) state.periodo = "custom";
    render();
  });
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
    syncLine.textContent = metaData.lastSyncAt
      ? "Última sincronização: " + fmtDate(metaData.lastSyncAt)
      : "Aguardando primeira sincronização";
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
  btn.textContent = "Sincronizando…";
  try {
    const res = await fetch("/api/sync", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "falha ao sincronizar");
    await poll();
  } catch (err) {
    syncLine.textContent = "Não deu pra sincronizar agora: " + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});
