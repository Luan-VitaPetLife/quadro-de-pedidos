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
  ocultos: 0,
  vendoOcultos: false,
  pin: localStorage.getItem("quadroPin") || "",
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
// Os tres dados que cabem num cartao, e o que cada um responde.
//
// `principal` e o que vai na linha grande -- a que se le de longe, da TV. O
// numero do pedido e o padrao porque e a chave que a operacao digita, mas quem
// atende cliente pode preferir o nome, e quem so despacha pode preferir o
// rastreio. Os outros dois viram linhas secundarias, ligaveis a parte.
const CAMPOS_DO_CARTAO = {
  numero: { rotulo: "Número do pedido", valor: (o) => o.orderNumber, classe: "num" },
  cliente: { rotulo: "Nome do cliente", valor: (o) => o.customer, classe: "cli" },
  rastreio: { rotulo: "Código de rastreio", valor: (o) => o.trackingCode, classe: "rast mono" },
};

const LEGENDA_PADRAO = {
  ok: "Seguindo bem",
  aviso: "Precisa de atenção",
  erro: "Com problema",
  tracejado: "Transportadora sem acompanhamento",
  relogio: "De outro dia, ainda pendente",
};

const PADRAO = {
  tema: "auto", tamanho: "m", forma: "arredondado", cor: "media",
  principal: "numero",
  rastreio: true, cliente: false, numero: false,
  legenda: { ...LEGENDA_PADRAO },
};
const CHAVE = "quadro.prefs";

function lerPrefs() {
  try {
    const salvo = JSON.parse(localStorage.getItem(CHAVE) || "{}");
    // A legenda e objeto: sem juntar por dentro, uma versao antiga guardada no
    // navegador apagaria as chaves que nasceram depois.
    return { ...PADRAO, ...salvo, legenda: { ...LEGENDA_PADRAO, ...(salvo.legenda || {}) } };
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

const IDS_DA_LEGENDA = {
  ok: "legOk", aviso: "legAviso", erro: "legErro",
  tracejado: "legTracejado", relogio: "legRelogio",
};

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
  document.getElementById("optNumero").checked = prefs.numero;
  marcarSegmento("optPrincipal", "principal", prefs.principal);

  // O campo escolhido como destaque nao pode tambem ser linha secundaria: a
  // caixa dele fica desligada e sem uso, em vez de aparecer ligavel e nao
  // fazer nada.
  for (const chave of ["numero", "cliente", "rastreio"]) {
    const cx = document.getElementById("opt" + chave[0].toUpperCase() + chave.slice(1));
    const ehPrincipal = prefs.principal === chave;
    cx.disabled = ehPrincipal;
    // A propria linha, e nao o grupo: as tres caixas dividem um `.opcao` so,
    // entao apagar o grupo apagaria as tres por causa de uma.
    cx.closest(".cx").classList.toggle("desativada", ehPrincipal);
  }

  for (const [chave, id] of Object.entries(IDS_DA_LEGENDA)) {
    const campo = document.getElementById(id);
    if (campo && campo !== document.activeElement) campo.value = prefs.legenda[chave] || "";
  }
  for (const el of document.querySelectorAll("[data-legenda]")) {
    el.textContent = prefs.legenda[el.dataset.legenda] || LEGENDA_PADRAO[el.dataset.legenda];
  }
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

  // Data SEM hora sai daqui pelo caminho de cima, e isso nao e detalhe.
  //
  // `new Date("2026-09-14")` nao e lido como 14 de setembro aqui: a norma manda
  // tratar uma data pura como MEIA-NOITE EM UTC, e Brasilia esta tres horas
  // atras -- o resultado exibido virava "13/09/26, 21:00". Errava o dia E
  // inventava uma hora que o dado nunca teve. Era assim que o pedido feito no
  // dia 14 aparecia como feito no dia 13.
  //
  // Formatando o texto direto, sem passar por Date, nao ha fuso para atrapalhar.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso).trim())) return fmtDia(iso);

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

// A data que o filtro de período usa.
//
// A emissão da NOTA vem primeiro, e não a data do pedido. O motivo é o critério
// da própria operação: a NF de saída é o momento em que aquilo vira remessa e
// vai pro armazém -- antes dela, o que está no pedido ainda não é uma entrega.
//
// Na prática: um pedido de domingo faturado na segunda saiu junto com os de
// segunda, e é em segunda que quem opera vai procurá-lo. Foi o caso das notas
// 296 e 297, emitidas às 09:04 do mesmo dia e mostradas em dias diferentes
// porque uma das compras tinha sido feita na véspera.
//
// Sem nota, cai na data do pedido: aí não há remessa ainda, e o que existe para
// datar é mesmo a compra.
function dataDoPedido(o) {
  return (o.notaEmitidaEm || o.placedAt || o.lastEventAt || "").slice(0, 10);
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
  // Cancelado e entregue nao sao pendencia: a cor conta o que aconteceu, mas
  // nao ha proximo passo. Sem esta excecao eles voltariam ao quadro todo dia,
  // para sempre -- e pendencia que nunca sai ensina a ignorar o quadro.
  if (o.encerrado) return false;
  return o.status !== "green";
}

// Pendência volta do PASSADO, nunca do futuro.
//
// "Volta pro quadro" só faz sentido para trás: um extravio de terça continua
// sendo problema na quinta. Um pedido de setembro não tem nada a fazer numa
// revisão de agosto — ele ainda nem existia no período que se está olhando.
//
// A primeira versão comparava só "está fora da faixa", e com isso qualquer
// pendência aparecia em qualquer período. Filtrando 01/08 a 31/08, entravam os
// problemas de setembro junto — o mês fechado deixava de ser o mês fechado.
function ehAnterior(o, faixa) {
  const d = dataDoPedido(o);
  return d ? d < faixa[0] : false;
}

function deOutroDia(o) {
  const faixa = intervalo();
  if (!faixa) return false; // em "Tudo" não existe "outro dia"
  return !dentroDaFaixa(o, faixa);
}

function dentroDoPeriodo(o) {
  const faixa = intervalo();
  if (!faixa) return true;
  return dentroDaFaixa(o, faixa) || (ehPendencia(o) && ehAnterior(o, faixa));
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
  // A lista de lojas vem do quadro INTEIRO, nao do periodo.
  //
  // Montada a partir do periodo, ela mudava de forma a cada filtro: escolher
  // agosto fazia sumir o Mercado Livre e a Yucaloo, e junto sumia a
  // possibilidade de seleciona-los. Um filtro que se reorganiza enquanto a
  // pessoa usa e pior do que um filtro com uma opcao vazia.
  montarMarcas(state.orders);
  atualizarBotaoOcultos();
}

// ---------------------------------------------------------------------------
// Ocultar um pedido
// ---------------------------------------------------------------------------
//
// Confirmação em diálogo próprio, não em confirm() do navegador: o quadro roda
// numa TV, e um alerta nativo trava a página inteira até alguém ir lá clicar.

async function chamar(rota, corpo) {
  const cabecalhos = { "Content-Type": "application/json" };
  if (state.pin) cabecalhos["X-Quadro-Pin"] = state.pin;
  const r = await fetch(rota, { method: "POST", headers: cabecalhos, body: JSON.stringify(corpo) });
  if (r.status === 401) {
    const pin = prompt("Este quadro pede um PIN para tirar pedidos do quadro. Qual é?");
    if (!pin) return null;
    state.pin = pin;
    localStorage.setItem("quadroPin", pin);
    return chamar(rota, corpo);
  }
  if (!r.ok) throw new Error(`o quadro recusou (${r.status})`);
  return r.json();
}

function confirmarOcultar(o) {
  const cortina = document.getElementById("ocultarBackdrop");
  const alvo = document.getElementById("ocultarAlvo");
  const motivo = document.getElementById("ocultarMotivo");
  alvo.textContent = o.orderNumber + (o.customer ? ` — ${o.customer}` : "");
  motivo.value = "";
  cortina.dataset.pedido = o.orderNumber;
  cortina.classList.add("open");
  setTimeout(() => motivo.focus(), 60);
}

function fecharOcultar() {
  document.getElementById("ocultarBackdrop").classList.remove("open");
}

async function ocultarConfirmado() {
  const cortina = document.getElementById("ocultarBackdrop");
  const numero = cortina.dataset.pedido;
  const motivo = document.getElementById("ocultarMotivo").value.trim();
  fecharOcultar();
  try {
    await chamar("/api/ocultar", { orderNumber: numero, motivo: motivo || undefined });
    await poll();
  } catch (err) {
    alert(`Não consegui marcar o pedido ${numero} como resolvido: ${err.message}`);
  }
}

async function reexibir(numero) {
  try {
    await chamar("/api/reexibir", { orderNumber: numero });
    await poll();
  } catch (err) {
    alert(`Não consegui trazer o pedido ${numero} de volta: ${err.message}`);
  }
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
  const principal = CAMPOS_DO_CARTAO[prefs.principal] ? prefs.principal : "numero";
  const grande = document.createElement("span");
  grande.className = "num";
  // Se o campo escolhido estiver vazio nesse pedido, o número entra no lugar --
  // um cartão sem nada escrito não identifica coisa nenhuma.
  grande.textContent = CAMPOS_DO_CARTAO[principal].valor(o) || o.orderNumber;
  el.appendChild(grande);

  for (const chave of ["cliente", "rastreio", "numero"]) {
    if (chave === principal || !prefs[chave]) continue;
    const valor = CAMPOS_DO_CARTAO[chave].valor(o);
    if (!valor) continue;
    const linha = document.createElement("span");
    linha.className = CAMPOS_DO_CARTAO[chave].classe === "num" ? "rast mono" : CAMPOS_DO_CARTAO[chave].classe;
    linha.textContent = valor;
    el.appendChild(linha);
  }
  // Os ícones dividem o cartão em dois lados, e a divisão tem regra: à direita
  // o que o pedido É (bonificação, veio de outro dia), à esquerda o que se pode
  // FAZER com ele. Antes o relógio e o botão de resolver dividiam o mesmo canto
  // e se sobrepunham.
  const marcas = document.createElement("span");
  marcas.className = "marcas";

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
    marcas.appendChild(marca);
  }

  if (o.bonificacao) {
    const b = document.createElement("span");
    b.className = "boni";
    b.textContent = "🎁";
    b.title = "Bonificação ou doação";
    marcas.appendChild(b);
  }
  if (marcas.children.length) el.appendChild(marcas);

  // Ocultar: a saída manual para o que nenhuma regra resolve.
  //
  // <span> com role="button" e não <button>: o cartão inteiro já é um botão, e
  // botão dentro de botão é HTML inválido — o navegador desmonta a árvore e o
  // clique passa a cair no lugar errado.
  const naGaveta = state.vendoOcultos;
  if (naGaveta) el.classList.add("esta-oculto");

  const esconder = document.createElement("span");
  esconder.className = "ocultar";
  esconder.setAttribute("role", "button");
  esconder.setAttribute("tabindex", "0");
  esconder.setAttribute("aria-label",
    naGaveta ? `Trazer o pedido ${o.orderNumber} de volta ao quadro` : `Marcar o pedido ${o.orderNumber} como resolvido`);
  esconder.title = naGaveta ? "Trazer de volta ao quadro" : "Marcar como resolvido e tirar do quadro";
  esconder.textContent = naGaveta ? "↩" : "×";
  const agir = (ev) => {
    ev.stopPropagation(); // senão abre o painel do pedido junto
    if (naGaveta) reexibir(o.orderNumber);
    else confirmarOcultar(o);
  };
  esconder.addEventListener("click", agir);
  esconder.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") agir(ev);
  });
  el.appendChild(esconder);

  el.addEventListener("click", () => abrirPainel(o.orderNumber));
  return el;
}

// As lojas vêm do que está no período — senão o filtro oferece loja sem
// nenhum pedido visível.
// As lojas que aparecem no filtro, escolhidas pelo Luan no painel do Bling.
//
// Lista fechada de proposito. A conta tem 15 canais de venda, a maioria
// desativada ou substituida -- "Mercado Livre - Paraná" velho, duas lojas TikTok
// antigas, uma Shopee criada por app. Todos tem pedido antigo no historico,
// entao montar o filtro a partir do que existe no quadro enchia a barra de
// lojas que ninguem usa mais.
//
// Os nomes sao exatamente a `descricao` do canal no Bling. Se uma loja for
// renomeada la, o nome muda aqui junto -- e e so acrescentar a linha quando
// nascer uma loja nova.
const LOJAS_NO_FILTRO = [
  "Coco and Luna - Brasil",
  "Yucaloo - Brasil",
  "Shopee",
  "Mercado Livre - SP",
  "TikTok Shop - Vita Pet Life",
  "Vita Pet Life - São Paulo",
];

function montarMarcas(pedidos) {
  const alvo = document.getElementById("brandFilters");
  const presentes = new Set(pedidos.map((o) => o.brand).filter(Boolean));
  const marcas = LOJAS_NO_FILTRO.filter((m) => presentes.has(m));
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

function secao(titulo, campos) {
  const uteis = campos.filter(Boolean);
  if (!uteis.length) return null;
  const s = document.createElement("section");
  s.className = "bloco";
  const h = document.createElement("h3");
  h.textContent = titulo;
  s.appendChild(h);
  const corpo = document.createElement("div");
  corpo.className = "campos";
  corpo.append(...uteis);
  s.appendChild(corpo);
  return s;
}

function aviso(texto, tom) {
  const n = document.createElement("div");
  n.className = "motivo" + (tom ? " " + tom : "");
  n.textContent = texto;
  return n;
}

function abrirPainel(numero) {
  state.selectedId = numero;
  const o = state.orders.find((x) => x.orderNumber === numero);
  const cortina = document.getElementById("backdrop");
  const painel = document.getElementById("panel");
  if (!o) return cortina.classList.remove("open");

  painel.innerHTML = "";

  // ── Cabeçalho: número, loja e a cor, tudo numa linha ────────────────
  // A cor sobe pro cabeçalho porque é a primeira coisa que se procura, e
  // ocupava uma linha inteira sozinha logo abaixo.
  const ph = document.createElement("div");
  ph.className = "ph";

  const esq = document.createElement("div");
  esq.className = "titulo";
  const no = document.createElement("div");
  no.className = "order-no mono";
  no.textContent = o.orderNumber;
  esq.appendChild(no);
  const etiquetas = document.createElement("div");
  etiquetas.className = "etiquetas";
  if (o.brand) etiquetas.appendChild(etiqueta(o.brand));
  if (o.bonificacao) etiquetas.appendChild(etiqueta("Bonificação", "boni"));
  if (etiquetas.children.length) esq.appendChild(etiquetas);

  const dir = document.createElement("div");
  dir.className = "acoes-ph";
  const selo = document.createElement("span");
  selo.className = "selo " + o.status;
  selo.textContent = palavraStatus[o.status] || o.status;
  const fechar = document.createElement("button");
  fechar.className = "fechar";
  fechar.setAttribute("aria-label", "Fechar");
  fechar.textContent = "×";
  fechar.addEventListener("click", fecharPainel);
  dir.append(selo, fechar);

  ph.append(esq, dir);
  painel.appendChild(ph);

  // ── Avisos ──────────────────────────────────────────────────────────
  const avisos = document.createElement("div");
  avisos.className = "avisos";
  if (deOutroDia(o)) {
    avisos.appendChild(
      aviso(`Pedido de ${fmtDia(dataDoPedido(o)) || "outro dia"}. Aparece aqui porque continua pendente.`, "neutro")
    );
  }
  // O motivo de ter sido resolvido vem primeiro, e nao junto dos campos: e a
  // resposta para "por que esse pedido esta aqui?", que e a unica pergunta de
  // quem abre um cartao da gaveta. Estava gravado desde sempre e nao aparecia
  // em lugar nenhum -- o texto que alguem digitou morria no banco.
  if (o.oculto) {
    const quando = fmtDia(o.ocultoEm);
    avisos.appendChild(
      aviso(
        o.ocultoMotivo
          ? `Marcado como resolvido${quando ? " em " + quando : ""}: ${o.ocultoMotivo}`
          : `Marcado como resolvido${quando ? " em " + quando : ""}, sem motivo anotado.`,
        "resolvido"
      )
    );
  }
  if (o.motivoStatus) avisos.appendChild(aviso(o.motivoStatus + "."));
  if (o.semAcompanhamento) {
    avisos.appendChild(
      aviso("Saiu por transportadora que o quadro não consulta — só a Mandaê tem integração. Não virão mais eventos por aqui.", "neutro")
    );
  }
  if (o.entregaNaoConfirmada) {
    avisos.appendChild(
      aviso("Saiu para entrega e a transportadora não registrou mais nada. Sem ocorrência aberta, isso costuma ser entrega que não foi bipada — não um extravio.", "neutro")
    );
  }
  if (o.rastreioDesconhecido) {
    avisos.appendChild(
      aviso("A transportadora não conhece este código de rastreio. A etiqueta foi criada no Bling, mas a encomenda nunca entrou no sistema dela.", "neutro")
    );
  }
  if (o.aguardandoPrimeiroEvento) {
    avisos.appendChild(
      aviso("Nota emitida e etiqueta criada. O primeiro evento da transportadora ainda não chegou — normal até a coleta passar.", "neutro")
    );
  }
  if (avisos.children.length) painel.appendChild(avisos);

  // ── Os dados, agrupados por pergunta ────────────────────────────────
  //
  // Eram quinze linhas numa coluna só, na ordem em que foram sendo
  // acrescentadas — e a cada aviso novo a lista descia mais e o scroll
  // aparecia. Agrupadas, respondem quatro perguntas em vez de uma lista.
  // Cada coluna tem fluxo proprio: os blocos se empilham sem esperar a altura
  // do vizinho, que era o que abria o vao branco no meio do painel.
  const coluna = (...blocos) => {
    const c = document.createElement("div");
    c.className = "coluna";
    c.append(...blocos.filter(Boolean));
    return c.children.length ? c : null;
  };

  const grade = document.createElement("div");
  grade.className = "grade";
  grade.append(
    ...[
      coluna(
        secao("Para quem", [campo("Cliente", o.customer), campo("Destino", o.city)]),
        secao("Documento", [
          campo("Nota fiscal", o.notaFiscal, true),
          // A situação da NOTA é outra coisa que a do pedido: nota cancelada
          // não cancela a venda, mas desfaz a remessa — e era esse o dado que
          // faltava quando dois pedidos da mesma compra apareciam verdes.
          campo("Situação da nota", o.situacaoNota),
          campo("Natureza da operação", o.natureza),
          campo("Situação no Bling", o.situacaoBling),
          campo("Também conhecido como", (o.apelidos || []).join(", "), true),
        ])
      ),
      coluna(
        secao("Onde está", [
          campo("Armazém", o.wmsStatus || "sem dado ainda"),
          campo("Transportadora", o.carrierStatus || "sem dado ainda"),
          campo("Código de rastreio", o.trackingCode, true),
          campo("Coleta prevista", fmtData(o.coletaPrevista), true),
        ]),
        secao("Linha do tempo", [
          campo("Pedido feito em", fmtData(o.placedAt), true),
          campo("Último movimento", fmtData(o.ultimoMovimentoAt), true),
          campo("Última atualização", fmtData(o.lastEventAt), true),
          campo("Dias úteis sem novidade", o.diasParados ?? "—", true),
          campo("Prazo para emitir a nota", fmtDia(o.previsaoEntrega), true),
        ])
      ),
    ].filter(Boolean)
  );
  painel.appendChild(grade);

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
segmento("optPrincipal", "principal", (v) => {
  prefs.principal = v;
  // Ligar a linha secundaria do campo que DEIXOU de ser destaque: senao ele
  // simplesmente some do cartao, e a impressao e de que o dado se perdeu.
  prefs[v] = false;
  gravarPrefs(prefs);
  aplicarPrefs();
  render();
});

for (const [chave, id] of Object.entries(IDS_DA_LEGENDA)) {
  document.getElementById(id).addEventListener("input", (e) => {
    const texto = e.target.value.trim();
    prefs.legenda[chave] = texto || LEGENDA_PADRAO[chave];
    gravarPrefs(prefs);
    for (const el of document.querySelectorAll(`[data-legenda="${chave}"]`)) {
      el.textContent = prefs.legenda[chave];
    }
  });
}

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
document.getElementById("optNumero").addEventListener("change", (e) => {
  prefs.numero = e.target.checked; gravarPrefs(prefs); render();
});
document.getElementById("configPadrao").addEventListener("click", () => {
  // Copia funda na legenda: sem isso o PADRAO seria alterado junto na proxima
  // edicao, e "restaurar padrao" passaria a restaurar o texto customizado.
  prefs = { ...PADRAO, legenda: { ...LEGENDA_PADRAO } };
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
  fecharEntrar();
  fecharPainel();
});

// ---------------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------------

/**
 * Avisa quando o armazem parou de chegar no quadro.
 *
 * O quadro le o WMS sozinho, mas a sessao do portal da FontesLog cai de tempos
 * em tempos e so uma pessoa consegue renova-la -- o portal pede captcha, que
 * existe justamente pra barrar robo. Quando isso acontece, os quadrados
 * continuam ali com o ultimo status conhecido, e e ai que mora o perigo: sem
 * este aviso, um pedido travado no armazem ontem seguiria verde hoje.
 *
 * Portal fora do ar e tratado a parte, e de proposito: nao adianta mandar
 * alguem logar quando o problema e do outro lado.
 */
function mostrarAvisoDoWms(wms) {
  const caixa = document.getElementById("avisoWms");
  if (!caixa) return;

  // Só os estados que são de fato um problema. Qualquer outra coisa -- "ok",
  // um estado novo que o servidor passe a mandar, meta ainda não escrita --
  // esconde a faixa. Uma tarja vermelha por um estado que ninguém previu
  // alarma sem informar, e alarme que não diz nada ensina a ignorar alarme.
  const PROBLEMAS = ["expirada", "ausente", "indisponivel"];
  if (!wms || !PROBLEMAS.includes(wms.estado)) {
    caixa.hidden = true;
    return;
  }

  const titulo = document.getElementById("avisoWmsTitulo");
  const texto = document.getElementById("avisoWmsTexto");
  const desde = wms.desde ? ` desde ${fmtData(wms.desde)}` : "";

  if (wms.estado === "indisponivel") {
    caixa.className = "avisoWms ameno";
    titulo.textContent = "O portal do armazém não está respondendo.";
    texto.textContent = `Os status do WMS estão parados${desde}. Não é nada que você precise fazer — quando o portal voltar, o quadro volta a ler sozinho.`;
  } else if (wms.estado === "ausente") {
    // Nunca houve login NESTE servidor -- o caso do primeiro deploy, e de um
    // volume novo. Dizer "a sessão caiu" aqui seria mentira, e mandaria a pessoa
    // procurar um problema que nao existe.
    caixa.className = "avisoWms";
    titulo.textContent = "O quadro ainda não tem acesso ao armazém.";
    texto.textContent =
      "Falta o primeiro login na FontesLog. Leva um minuto, e daí em diante o quadro lê o WMS sozinho.";
  } else {
    caixa.className = "avisoWms";
    titulo.textContent = "O quadro parou de receber o armazém.";
    const ultima = wms.ultimaLeituraEm ? ` A última leitura foi ${fmtData(wms.ultimaLeituraEm)}.` : "";
    // Chegar aqui significa que o religamento automático JÁ tentou e não passou
    // -- senão o estado nem seria "expirada". Dizer só "a sessão caiu" faria a
    // pessoa tentar o que o servidor já tentou sozinho.
    texto.textContent =
      `A sessão da FontesLog caiu${desde} e o quadro não conseguiu reconectar sozinho:` +
      ` faz mais de 5 dias que ninguém resolve um captcha no portal.${ultima}` +
      " Entre uma vez e ele volta a se virar sozinho.";
  }

  // O botão só nos estados em que entrar RESOLVE. Com o portal fora do ar, quem
  // clicasse gastaria o gesto à toa -- e aprenderia a desconfiar do botão.
  document.getElementById("avisoWmsEntrar").hidden = wms.estado === "indisponivel";
  caixa.hidden = false;
}

// ---------------------------------------------------------------------------
// Entrar na FontesLog, pelo quadro
// ---------------------------------------------------------------------------
//
// O captcha do portal só renderiza no domínio do próprio portal (medido: sob
// outro domínio ele responde "domínio inválido para a chave do site"), e o
// cookie da sessão é httpOnly. Ou seja: a parte humana não tem como sumir.
//
// O que esta tela faz é encolher tudo em volta dela. Antes, renovar a sessão
// pedia o repositório clonado, o Playwright instalado e um terminal na máquina
// certa. Agora pede três passos numa tela que abre do próprio aviso vermelho --
// de qualquer computador do time.

const entrarState = { pin: null, portalUrl: null };

function recadoEntrar(texto, tipo = "erro") {
  const el = document.getElementById("entrarRecado");
  el.textContent = texto || "";
  el.className = `recado ${tipo}`;
  el.hidden = !texto;
}

function mostrarPasso(id) {
  for (const li of document.querySelectorAll("#entrarBackdrop .passo")) {
    li.dataset.aberto = String(li.id === id);
  }
}

function abrirEntrar() {
  document.getElementById("entrarBackdrop").classList.add("open");
  recadoEntrar("");
  document.getElementById("entrarCookie").value = "";

  // O PIN já validado nesta aba pula o passo 1. Fica em sessionStorage, e não
  // em localStorage, de propósito: numa TV do armazém que ninguém desliga, um
  // PIN gravado para sempre viraria a senha do portal ao alcance de qualquer um.
  const guardado = sessionStorage.getItem("wmsPin");
  if (guardado) {
    document.getElementById("entrarPin").value = guardado;
    validarPin();
  } else {
    mostrarPasso("passoPin");
    document.getElementById("entrarPin").focus();
  }
}

function fecharEntrar() {
  document.getElementById("entrarBackdrop").classList.remove("open");
}

async function validarPin() {
  const pin = document.getElementById("entrarPin").value.trim();
  if (!pin) return recadoEntrar("Digite o PIN.");

  const botao = document.getElementById("entrarPinOk");
  botao.disabled = true;
  try {
    const res = await fetch("/api/fonteslog/entrar/credenciais", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const corpo = await res.json();
    if (!res.ok) {
      sessionStorage.removeItem("wmsPin");
      mostrarPasso("passoPin");
      return recadoEntrar(corpo.error || "Não consegui destravar.");
    }

    entrarState.pin = pin;
    entrarState.portalUrl = corpo.url;
    sessionStorage.setItem("wmsPin", pin);
    document.getElementById("planoB").open = false;

    document.getElementById("credLogin").textContent = corpo.login;
    const senha = document.getElementById("credSenha");
    senha.dataset.valor = corpo.senha;
    senha.dataset.oculta = "true";
    senha.textContent = "••••••••";
    document.getElementById("credVer").textContent = "Ver";

    recadoEntrar("");
    mostrarPasso("passoReligar");
  } catch {
    recadoEntrar("Sem conexão com o servidor.");
  } finally {
    botao.disabled = false;
  }
}

/**
 * O caminho normal: um clique, e o servidor refaz o login sozinho.
 *
 * Só chega no plano B quando o selo do captcha venceu -- e aí a tela abre a
 * gaveta sozinha, porque nesse momento ela deixou de ser um detalhe escondido
 * e passou a ser a única coisa que resta fazer.
 */
async function religar() {
  const botao = document.getElementById("entrarReligar");
  botao.disabled = true;
  recadoEntrar("Refazendo o login no portal…", "neutro");
  try {
    const res = await fetch("/api/fonteslog/entrar/religar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: entrarState.pin }),
    });
    const corpo = await res.json();

    if (res.status === 409) {
      document.getElementById("planoB").open = true;
      return recadoEntrar(
        "Faz mais de 5 dias que ninguém resolve um captcha no portal, e sem isso o quadro não consegue entrar sozinho. Siga os passos que abriram abaixo."
      );
    }
    if (!res.ok) {
      const extra = corpo.detalhe ? ` (${corpo.detalhe})` : "";
      return recadoEntrar(`${corpo.error || "Não deu certo."}${extra}`);
    }

    const ate = corpo.seloValeAte ? ` O quadro consegue se reconectar sozinho até ${fmtData(corpo.seloValeAte)}.` : "";
    recadoEntrar(`Pronto. O quadro já está lendo o armazém de novo.${ate}`, "ok");
    poll();
    setTimeout(fecharEntrar, 3500);
  } catch {
    recadoEntrar("Sem conexão com o servidor.");
  } finally {
    botao.disabled = false;
  }
}

async function enviarSessaoColada() {
  const texto = document.getElementById("entrarCookie").value.trim();
  if (!texto) return recadoEntrar("Cole o cookie primeiro.");

  const botao = document.getElementById("entrarEnviar");
  botao.disabled = true;
  recadoEntrar("Conferindo no portal…", "neutro");
  try {
    const res = await fetch("/api/fonteslog/entrar/sessao", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: entrarState.pin, texto }),
    });
    const corpo = await res.json();
    if (!res.ok) {
      const extra = corpo.detalhe ? ` (${corpo.detalhe})` : "";
      return recadoEntrar(`${corpo.error || "Não deu certo."}${extra}`);
    }
    recadoEntrar("Pronto. O quadro já está lendo o armazém de novo.", "ok");
    poll();
    setTimeout(fecharEntrar, 2500);
  } catch {
    recadoEntrar("Sem conexão com o servidor.");
  } finally {
    botao.disabled = false;
  }
}

/** Copia sem depender da API nova: em http:// o navegador não dá clipboard. */
async function copiar(texto, botao) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    const campo = document.createElement("textarea");
    campo.value = texto;
    campo.style.position = "fixed";
    campo.style.opacity = "0";
    document.body.appendChild(campo);
    campo.select();
    document.execCommand("copy");
    campo.remove();
  }
  const antes = botao.textContent;
  botao.textContent = "Copiado";
  setTimeout(() => { botao.textContent = antes; }, 1400);
}

document.getElementById("avisoWmsEntrar").addEventListener("click", abrirEntrar);
document.getElementById("entrarFechar").addEventListener("click", fecharEntrar);
document.getElementById("entrarBackdrop").addEventListener("click", (e) => {
  if (e.target.id === "entrarBackdrop") fecharEntrar();
});
document.getElementById("entrarPinOk").addEventListener("click", validarPin);
document.getElementById("entrarPin").addEventListener("keydown", (e) => {
  if (e.key === "Enter") validarPin();
});
document.getElementById("entrarReligar").addEventListener("click", religar);
document.getElementById("entrarEnviar").addEventListener("click", enviarSessaoColada);
document.getElementById("entrarAbrirPortal").addEventListener("click", () => {
  window.open(entrarState.portalUrl, "_blank", "noopener");
});
document.getElementById("credVer").addEventListener("click", (e) => {
  const campo = document.getElementById("credSenha");
  const oculta = campo.dataset.oculta === "true";
  campo.dataset.oculta = String(!oculta);
  campo.textContent = oculta ? campo.dataset.valor : "••••••••";
  e.target.textContent = oculta ? "Ocultar" : "Ver";
});
for (const botao of document.querySelectorAll("#entrarBackdrop [data-copiar]")) {
  botao.addEventListener("click", () => {
    const campo = document.getElementById(botao.dataset.copiar);
    copiar(campo.dataset.valor || campo.textContent, botao);
  });
}
// Clicar no passo já cumprido volta para ele: a pessoa que fechou o portal sem
// copiar o cookie precisa reabrir, e não recomeçar do PIN.
for (const cabecalho of document.querySelectorAll("#entrarBackdrop .passo h3")) {
  cabecalho.addEventListener("click", () => {
    const passo = cabecalho.closest(".passo");
    if (passo.id === "passoPin" || entrarState.pin) mostrarPasso(passo.id);
  });
}

async function poll() {
  const linha = document.getElementById("syncLine");
  try {
    const rota = state.vendoOcultos ? "/api/orders?ocultos=1" : "/api/orders";
    const [pedidos, meta] = await Promise.all([fetch(rota), fetch("/api/meta")]);
    const corpo = await pedidos.json();
    state.orders = corpo.orders || [];
    state.ocultos = corpo.ocultos || 0;
    const { lastSyncAt, wms } = await meta.json();
    render();
    mostrarAvisoDoWms(wms);
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


// ---------------------------------------------------------------------------
// Gaveta dos ocultos
// ---------------------------------------------------------------------------
// O elemento e buscado DENTRO da funcao, nao guardado num const aqui em cima.
//
// Este bloco esta no fim do arquivo, e render() -- que chama esta funcao -- roda
// antes dele, la na linha 737. Um `const` no fim so existe depois que a linha
// dele executa: ler antes disso nao devolve undefined, lanca ReferenceError. O
// erro acontecia no topo do script, entao o `poll()` logo abaixo nunca chegava a
// rodar e o quadro ficava eternamente em "Conectando...".
function atualizarBotaoOcultos() {
  const ocultosBtn = document.getElementById("ocultosBtn");
  if (!ocultosBtn) return;
  if (state.vendoOcultos) {
    ocultosBtn.hidden = false;
    ocultosBtn.textContent = "Voltar ao quadro";
    ocultosBtn.dataset.active = "true";
    return;
  }
  // Sem nada oculto o botão não existe: um controle permanentemente zerado é
  // ruído em cima de uma tela que precisa ser lida de longe.
  ocultosBtn.hidden = state.ocultos === 0;
  ocultosBtn.textContent = `Pedidos resolvidos (${state.ocultos})`;
  delete ocultosBtn.dataset.active;
}

document.getElementById("ocultosBtn").addEventListener("click", async () => {
  state.vendoOcultos = !state.vendoOcultos;
  await poll();
});

document.getElementById("ocultarFechar").addEventListener("click", fecharOcultar);
document.getElementById("ocultarCancelar").addEventListener("click", fecharOcultar);
document.getElementById("ocultarConfirmar").addEventListener("click", ocultarConfirmado);
document.getElementById("ocultarBackdrop").addEventListener("click", (ev) => {
  if (ev.target.id === "ocultarBackdrop") fecharOcultar();
});
document.getElementById("ocultarMotivo").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") ocultarConfirmado();
});
