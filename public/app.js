const state = {
  orders: [],
  filter: "all",
  brandFilter: "all",
  periodo: "hoje",
  de: null,
  ate: null,
  search: "",
  selectedId: null,
  marcasConhecidas: "",
};

const palavraStatus = { green: "Seguindo bem", amber: "Precisa de atenção", red: "Com problema" };
const POLL_MS = 60000;

// ---------------------------------------------------------------------------
// Preferências
// ---------------------------------------------------------------------------
//
// Ficam no navegador de quem olha. A TV da operação e o notebook de quem
// investiga querem coisas diferentes do mesmo quadro: uma quer cartão grande e
// cor forte a três metros, o outro quer densidade e detalhe.
const PADRAO = { tema: "auto", tamanho: "m", forma: "arredondado", cor: "media", rastreio: true, cliente: false };
const CHAVE = "quadro.prefs";

function lerPrefs() {
  try {
    return { ...PADRAO, ...JSON.parse(localStorage.getItem(CHAVE) || "{}") };
  } catch {
    return { ...PADRAO };
  }
}

function gravarPrefs(p) {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(p));
  } catch {
    /* navegador anônimo ou storage bloqueado: valem só nesta sessão */
  }
}

let prefs = lerPrefs();

const TAMANHOS = {
  p: { largura: 104, altura: 46, num: 11.5, cod: 9, gap: 6 },
  m: { largura: 132, altura: 56, num: 13, cod: 10, gap: 8 },
  g: { largura: 168, altura: 74, num: 17, cod: 11.5, gap: 10 },
  tv: { largura: 210, altura: 100, num: 24, cod: 14, gap: 12 },
};

const FORMAS = {
  arredondado: { raio: "8px", aspecto: "auto" },
  reto: { raio: "0", aspecto: "auto" },
  quadrado: { raio: "8px", aspecto: "1" },
  pilula: { raio: "999px", aspecto: "auto" },
  circulo: { raio: "50%", aspecto: "1" },
};

function aplicarPrefs() {
  const raiz = document.documentElement;

  // Tema "auto" segue o sistema: sem atributo, o CSS cai no bloco padrão.
  if (prefs.tema === "auto") raiz.removeAttribute("data-theme");
  else raiz.setAttribute("data-theme", prefs.tema);
  document.getElementById("temaIcone").textContent =
    prefs.tema === "dark" ? "☀" : prefs.tema === "light" ? "☾" : "◐";

  const t = TAMANHOS[prefs.tamanho] || TAMANHOS.m;
  raiz.style.setProperty("--card-largura", t.largura + "px");
  raiz.style.setProperty("--card-altura", t.altura + "px");
  raiz.style.setProperty("--card-num", t.num + "px");
  raiz.style.setProperty("--card-cod", t.cod + "px");
  raiz.style.setProperty("--grade-gap", t.gap + "px");

  const f = FORMAS[prefs.forma] || FORMAS.arredondado;
  raiz.style.setProperty("--card-raio", f.raio);
  raiz.style.setProperty("--card-aspecto", f.aspecto);

  raiz.setAttribute("data-cor", prefs.cor);

  marcarSegmento("optTamanho", "tamanho", prefs.tamanho);
  marcarSegmento("optForma", "forma", prefs.forma);
  marcarSegmento("optCor", "cor", prefs.cor);
  document.getElementById("optRastreio").checked = prefs.rastreio;
  document.getElementById("optCliente").checked = prefs.cliente;
}

// ---------------------------------------------------------------------------
// Indicador deslizante dos seletores
// ---------------------------------------------------------------------------
//
// A marca do item ativo é UM elemento que se move entre as opções. Ver o
// percurso diz de onde a seleção saiu e para onde foi; quando ela só pisca no
// lugar novo, quem estava olhando outra parte da tela perde a transição e
// precisa reprocurar onde está.
//
// A posição vem do layout real (offsetLeft/offsetWidth), não de cálculo por
// índice: os rótulos têm larguras diferentes e a fila de lojas muda sozinha
// conforme o período.
function moverIndicador(container, primeiraVez = false) {
  const el = typeof container === "string" ? document.getElementById(container) : container;
  if (!el) return;

  let ind = el.querySelector(":scope > .indicador");
  if (!ind) {
    ind = document.createElement("span");
    ind.className = "indicador";
    el.prepend(ind);
    primeiraVez = true;
  }

  const ativo = el.querySelector('.seg[data-active="true"]');
  if (!ativo) {
    ind.style.width = "0px";
    return;
  }

  if (primeiraVez) ind.classList.add("sem-transicao");
  ind.style.width = ativo.offsetWidth + "px";
  ind.style.transform = "translateX(" + ativo.offsetLeft + "px)";
  if (primeiraVez) {
    // Uma volta do laço de eventos antes de religar a transição, senão o
    // navegador junta as duas mudanças e o salto acontece animado mesmo assim.
    requestAnimationFrame(() => ind.classList.remove("sem-transicao"));
  }
}

const SELETORES = ["periodos", "filters", "brandFilters", "optTamanho", "optForma", "optCor"];

function moverTodosIndicadores() {
  for (const id of SELETORES) moverIndicador(id);
}

// A largura dos botões muda com o tamanho da janela; sem isto o indicador
// descola do rótulo depois de redimensionar.
window.addEventListener("resize", moverTodosIndicadores);

function marcarSegmento(idContainer, atributo, valor) {
  document.querySelectorAll(`#${idContainer} .seg`).forEach((b) => {
    b.dataset.active = String(b.dataset[atributo] === valor);
  });
  moverIndicador(idContainer);
}

// ---------------------------------------------------------------------------
// Datas e período
// ---------------------------------------------------------------------------
function fmtData(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtDia(iso) {
  // O Bling manda "0000-00-00" quando o campo está vazio. Sem esta guarda a
  // tela exibia "00/00/0000", que parece dado e não é.
  if (!iso) return null;
  const d = String(iso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < "2000-01-01") return null;
  return d.split("-").reverse().join("/");
}

// A data que manda é a do PEDIDO, não a do último evento: "pedidos de hoje"
// quer dizer feitos hoje.
function dataDoPedido(o) {
  return (o.placedAt || o.lastEventAt || "").slice(0, 10);
}

function hojeISO(deslocamento = 0) {
  const d = new Date();
  d.setDate(d.getDate() + deslocamento);
  // Data local, não toISOString(): em UTC o fuso do Brasil vira o dia anterior
  // depois das 21h, e "Hoje" apareceria vazio no fim do expediente.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function intervalo() {
  const hoje = hojeISO();
  switch (state.periodo) {
    case "hoje": return [hoje, hoje];
    case "ontem": { const o = hojeISO(-1); return [o, o]; }
    case "semana": {
      // Semana começa na segunda: getDay() dá 0 no domingo, que volta 6 dias.
      const diaSemana = (new Date().getDay() + 6) % 7;
      return [hojeISO(-diaSemana), hoje];
    }
    case "mes": return [hoje.slice(0, 8) + "01", hoje];
    case "custom": return [state.de || "0000-00-00", state.ate || "9999-99-99"];
    default: return null;
  }
}

function dentroDaFaixa(o, faixa) {
  if (!faixa) return true;
  const d = dataDoPedido(o);
  return d ? d >= faixa[0] && d <= faixa[1] : false;
}

// ---------------------------------------------------------------------------
// Pendência de outro dia volta pro quadro
// ---------------------------------------------------------------------------
//
// O quadro deixa de responder "o que aconteceu hoje" e passa a responder "o
// que precisa de ação hoje" -- que é a pergunta de quem está olhando.
//
// Um extravio de terça não deixa de ser problema na quinta. Preso ao filtro de
// data, ele sumia da tela no dia seguinte e só reaparecia se alguém lembrasse
// de trocar o período para "Tudo" -- ou seja, justamente o pedido que ninguém
// resolveu era o que ficava mais fácil de esquecer.
//
// Só volta o que está pendente. Pedido verde de outro dia seguiu seu caminho e
// não tem nada a cobrar; trazê-lo de volta seria encher a tela com o que já
// deu certo.
function ehPendencia(o) {
  return o.status !== "green";
}

function deOutroDia(o) {
  const faixa = intervalo();
  if (!faixa) return false; // em "Tudo" não existe "outro dia"
  return !dentroDaFaixa(o, faixa);
}

function dentroDoPeriodo(o) {
  const faixa = intervalo();
  if (!faixa) return true;
  return dentroDaFaixa(o, faixa) || ehPendencia(o);
}


// ---------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------
function render() {
  const grid = document.getElementById("grid");
  const vazio = document.getElementById("emptyState");

  const noPeriodo = state.orders.filter(dentroDoPeriodo);

  const lista = noPeriodo.filter((o) => {
    if (state.filter === "bonificacao") {
      if (!o.bonificacao) return false;
    } else if (state.filter !== "all" && o.status !== state.filter) {
      return false;
    }
    if (state.brandFilter !== "all" && o.brand !== state.brandFilter) return false;
    if (state.search) {
      const s = state.search.toLowerCase();
      // Os apelidos entram na busca: quem vem do portal da FontesLog tem na
      // mao "ATB0240367", que agora e apelido do quadrado da nota.
      const alvo = `${o.orderNumber} ${o.customer || ""} ${o.trackingCode || ""} ${o.notaFiscal || ""} ${(o.apelidos || []).join(" ")}`.toLowerCase();
      if (!alvo.includes(s)) return false;
    }
    return true;
  });

  grid.innerHTML = "";
  if (noPeriodo.length === 0) {
    vazio.hidden = false;
    vazio.textContent =
      state.orders.length === 0
        ? "Nenhum pedido no quadro ainda."
        : "Nenhum pedido neste período. Tente Semana, Mês ou Tudo.";
  } else if (lista.length === 0) {
    vazio.hidden = false;
    vazio.textContent = "Nenhum pedido corresponde a esses filtros.";
  } else {
    vazio.hidden = true;
    for (const o of lista) grid.appendChild(cartao(o));
  }

  const contas = { green: 0, amber: 0, red: 0 };
  for (const o of noPeriodo) if (contas[o.status] !== undefined) contas[o.status]++;
  document.getElementById("cTotal").textContent = noPeriodo.length;
  document.getElementById("cGreen").textContent = contas.green;
  document.getElementById("cAmber").textContent = contas.amber;
  document.getElementById("cRed").textContent = contas.red;

  const conta = document.getElementById("boardConta");
  if (conta) {
    const voltaram = lista.filter(deOutroDia).length;
    const base = lista.length === noPeriodo.length
      ? `${lista.length} pedido${lista.length === 1 ? "" : "s"}`
      : `${lista.length} de ${noPeriodo.length} pedidos`;
    conta.textContent = voltaram ? `${base} · ${voltaram} de outros dias` : base;
  }

  marcarSegmento("filters", "filter", state.filter);
  marcarSegmento("periodos", "periodo", state.periodo);
  montarMarcas(noPeriodo);
}

function cartao(o) {
  const el = document.createElement("button");
  el.className = "sq " + o.status + (o.orderNumber === state.selectedId ? " selected" : "");
  if (o.semAcompanhamento) el.classList.add("sem-acomp");
  el.title =
    `Pedido ${o.orderNumber}` +
    (o.customer ? ` — ${o.customer}` : "") +
    (o.trackingCode ? `\nRastreio: ${o.trackingCode}` : "") +
    (o.notaFiscal ? `\nNota: ${o.notaFiscal}` : "") +
    ((o.apelidos || []).length ? `\nTambém: ${o.apelidos.join(", ")}` : "");

  // textContent, nunca innerHTML: número, cliente e rastreio vêm de webhook,
  // portal e ERP — nenhum deles deveria poder injetar HTML na tela.
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = o.orderNumber;
  el.appendChild(num);

  if (prefs.rastreio && o.trackingCode) {
    const r = document.createElement("span");
    r.className = "rast mono";
    r.textContent = o.trackingCode;
    el.appendChild(r);
  }
  if (prefs.cliente && o.customer) {
    const c = document.createElement("span");
    c.className = "cli";
    c.textContent = o.customer;
    el.appendChild(c);
  }
  // Marca de "voltou de outro dia": relógio com a seta anti-horária, o ícone
  // universal de histórico. Vem antes do número porque a primeira pergunta de
  // quem vê o cartão passa a ser "isso é de hoje?".
  if (deOutroDia(o)) {
    el.classList.add("de-outro-dia");
    const marca = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    marca.setAttribute("class", "relogio");
    marca.setAttribute("viewBox", "0 0 24 24");
    marca.setAttribute("fill", "none");
    marca.setAttribute("stroke", "currentColor");
    marca.setAttribute("stroke-width", "2.2");
    marca.setAttribute("stroke-linecap", "round");
    marca.setAttribute("stroke-linejoin", "round");
    marca.setAttribute("aria-hidden", "true");
    marca.innerHTML =
      '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>';
    el.appendChild(marca);
  }

  if (o.bonificacao) {
    const b = document.createElement("span");
    b.className = "boni";
    b.textContent = "🎁";
    b.title = "Bonificação ou doação";
    el.appendChild(b);
  }

  el.addEventListener("click", () => abrirPainel(o.orderNumber));
  return el;
}

// As lojas vêm do que está no período — senão o filtro oferece loja sem
// nenhum pedido visível.
function montarMarcas(noPeriodo) {
  const alvo = document.getElementById("brandFilters");
  const marcas = [...new Set(noPeriodo.map((o) => o.brand).filter(Boolean))].sort();
  const assinatura = marcas.join("|");

  const reconstruiu = assinatura !== state.marcasConhecidas;
  if (reconstruiu) {
    state.marcasConhecidas = assinatura;
    alvo.innerHTML = "";
    for (const m of ["all", ...marcas]) {
      const b = document.createElement("button");
      b.className = "seg";
      b.dataset.brandfilter = m;
      b.textContent = m === "all" ? "Todas" : m;
      alvo.appendChild(b);
    }
  }
  marcarSegmento("brandFilters", "brandfilter", state.brandFilter);
  if (reconstruiu) moverIndicador("brandFilters", true);
}

// ---------------------------------------------------------------------------
// Painel do pedido
// ---------------------------------------------------------------------------
function campo(rotulo, valor, mono) {
  const d = document.createElement("div");
  d.className = "campo";
  const k = document.createElement("div");
  k.className = "k";
  k.textContent = rotulo;
  const v = document.createElement("div");
  v.className = "v" + (mono ? " mono" : "");
  v.textContent = valor || "—";
  d.append(k, v);
  return d;
}

function etiqueta(texto, extra) {
  const e = document.createElement("span");
  e.className = "etiqueta" + (extra ? " " + extra : "");
  e.textContent = texto;
  return e;
}

function abrirPainel(numero) {
  state.selectedId = numero;
  const o = state.orders.find((x) => x.orderNumber === numero);
  const cortina = document.getElementById("backdrop");
  const painel = document.getElementById("panel");
  if (!o) return cortina.classList.remove("open");

  painel.innerHTML = "";

  const ph = document.createElement("div");
  ph.className = "ph";
  const esq = document.createElement("div");
  const no = document.createElement("div");
  no.className = "order-no mono";
  no.textContent = o.orderNumber;
  esq.appendChild(no);
  if (o.brand) esq.appendChild(etiqueta(o.brand));
  if (o.bonificacao) esq.appendChild(etiqueta("Bonificação", "boni"));
  const fechar = document.createElement("button");
  fechar.className = "fechar";
  fechar.setAttribute("aria-label", "Fechar");
  fechar.textContent = "×";
  fechar.addEventListener("click", fecharPainel);
  ph.append(esq, fechar);
  painel.appendChild(ph);

  const selo = document.createElement("span");
  selo.className = "selo " + o.status;
  selo.textContent = palavraStatus[o.status] || o.status;
  painel.appendChild(selo);

  if (deOutroDia(o)) {
    const v = document.createElement("div");
    v.className = "motivo neutro";
    v.textContent =
      `Pedido de ${fmtDia(dataDoPedido(o)) || "outro dia"}. Aparece aqui porque continua pendente.`;
    painel.appendChild(v);
  }

  if (o.motivoStatus) {
    const m = document.createElement("div");
    m.className = "motivo";
    m.textContent = o.motivoStatus + ".";
    painel.appendChild(m);
  }
  if (o.semAcompanhamento) {
    const n = document.createElement("div");
    n.className = "motivo neutro";
    n.textContent =
      "Saiu por transportadora que o quadro não consulta — só a Mandaê tem integração. Não virão mais eventos por aqui.";
    painel.appendChild(n);
  }

  painel.append(
    campo("Cliente", o.customer),
    campo("Destino", o.city),
    campo("Status no WMS", o.wmsStatus || "sem dado ainda"),
    campo("Último evento da transportadora", o.carrierStatus || "sem dado ainda"),
    campo("Nota fiscal", o.notaFiscal, true),
    campo("Tambem conhecido como", (o.apelidos || []).join(", "), true),
    campo("Código de rastreio", o.trackingCode, true),
    campo("Natureza da operação", o.natureza),
    campo("Pedido feito em", fmtData(o.placedAt), true),
    campo("Coleta prevista", fmtData(o.coletaPrevista), true),
    campo("Prazo para emitir a nota", fmtDia(o.previsaoEntrega), true),
    campo("Última atualização", fmtData(o.lastEventAt), true),
    campo("Dias úteis sem novidade", o.diasParados ?? "—", true)
  );

  cortina.classList.add("open");
  render();
}

function fecharPainel() {
  state.selectedId = null;
  document.getElementById("backdrop").classList.remove("open");
  render();
}

// ---------------------------------------------------------------------------
// Tela cheia
// ---------------------------------------------------------------------------
function entrarTv() {
  document.body.classList.add("tv");
  document.getElementById("sairTv").hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {
    /* sem permissão de tela cheia: o modo do quadro funciona igual */
  });
}

function sairTv() {
  document.body.classList.remove("tv");
  document.getElementById("sairTv").hidden = true;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
function abrirConfig() {
  document.getElementById("configBackdrop").classList.add("open");
  // Os seletores da janela nunca foram medidos ate ela abrir; sem isto o
  // indicador aparece encolhido no primeiro clique.
  for (const id of ["optTamanho", "optForma", "optCor"]) moverIndicador(id, true);
}
function fecharConfig() { document.getElementById("configBackdrop").classList.remove("open"); }

function segmento(idContainer, atributo, aoEscolher) {
  document.getElementById(idContainer).addEventListener("click", (e) => {
    const btn = e.target.closest(".seg");
    if (!btn || !btn.dataset[atributo]) return;
    aoEscolher(btn.dataset[atributo]);
  });
}

segmento("periodos", "periodo", (v) => { state.periodo = v; render(); });
segmento("filters", "filter", (v) => { state.filter = v; render(); });
segmento("brandFilters", "brandfilter", (v) => { state.brandFilter = v; render(); });
segmento("optTamanho", "tamanho", (v) => { prefs.tamanho = v; gravarPrefs(prefs); aplicarPrefs(); });
segmento("optForma", "forma", (v) => { prefs.forma = v; gravarPrefs(prefs); aplicarPrefs(); });
segmento("optCor", "cor", (v) => { prefs.cor = v; gravarPrefs(prefs); aplicarPrefs(); });

document.getElementById("backdrop").addEventListener("click", (e) => {
  if (e.target.id === "backdrop") fecharPainel();
});
document.getElementById("configBackdrop").addEventListener("click", (e) => {
  if (e.target.id === "configBackdrop") fecharConfig();
});

["dataDe", "dataAte"].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => {
    state.de = document.getElementById("dataDe").value || null;
    state.ate = document.getElementById("dataAte").value || null;
    if (state.de || state.ate) state.periodo = "custom";
    render();
  });
});

document.getElementById("search").addEventListener("input", (e) => {
  state.search = e.target.value;
  render();
});

document.getElementById("temaBtn").addEventListener("click", () => {
  // auto → claro → escuro → auto
  prefs.tema = prefs.tema === "auto" ? "light" : prefs.tema === "light" ? "dark" : "auto";
  gravarPrefs(prefs);
  aplicarPrefs();
});

document.getElementById("configBtn").addEventListener("click", abrirConfig);
document.getElementById("configFechar").addEventListener("click", fecharConfig);

document.getElementById("optRastreio").addEventListener("change", (e) => {
  prefs.rastreio = e.target.checked; gravarPrefs(prefs); render();
});
document.getElementById("optCliente").addEventListener("change", (e) => {
  prefs.cliente = e.target.checked; gravarPrefs(prefs); render();
});
document.getElementById("configPadrao").addEventListener("click", () => {
  prefs = { ...PADRAO };
  gravarPrefs(prefs);
  aplicarPrefs();
  render();
});

document.getElementById("expandirBtn").addEventListener("click", entrarTv);
document.getElementById("sairTv").addEventListener("click", sairTv);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.body.classList.contains("tv")) return sairTv();
  fecharConfig();
  fecharPainel();
});

// ---------------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------------
async function poll() {
  const linha = document.getElementById("syncLine");
  try {
    const [pedidos, meta] = await Promise.all([fetch("/api/orders"), fetch("/api/meta")]);
    state.orders = (await pedidos.json()).orders || [];
    const { lastSyncAt } = await meta.json();
    render();
    if (state.selectedId) abrirPainel(state.selectedId);
    linha.textContent = lastSyncAt ? `Sincronizado ${fmtData(lastSyncAt)}` : "Aguardando primeira sincronização";
  } catch {
    linha.textContent = "Sem conexão com o servidor";
  }
}

document.getElementById("syncBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const linha = document.getElementById("syncLine");
  btn.disabled = true;
  const rotulo = btn.textContent;
  btn.textContent = "Sincronizando…";
  try {
    const res = await fetch("/api/sync", { method: "POST" });
    const dados = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(dados.error || "não deu para sincronizar");
    await poll();
  } catch (err) {
    linha.textContent = "Não deu para sincronizar: " + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = rotulo;
  }
});

aplicarPrefs();
render();

// As fontes chegam depois do primeiro render e mudam a largura dos rotulos --
// sem reposicionar, o indicador fica deslocado ate alguem clicar.
document.fonts?.ready.then(moverTodosIndicadores);
poll();
setInterval(poll, POLL_MS);
