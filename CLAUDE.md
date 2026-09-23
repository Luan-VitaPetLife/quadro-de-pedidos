# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Quadro de pedidos da Vita Pet Life: um quadrado por pedido (verde/amarelo/vermelho), no ar em https://quadro.vitapetlife.com, no Railway. O README e só a vitrine; o conhecimento de operação está aqui e, principalmente, nos comentários do código — eles são o registro de projeto, com o incidente que motivou cada regra.

## Comandos

```
npm run dev                                   servidor com --watch (npm start sem)
npm run testar-pedido -- CODIGO [NUMERO]      exercita a corrente inteira com um pedido real
npm run check-mandae [-- CODIGO]              confere token/header da Mandaê, ou os eventos de um rastreio
npm run sync-fonteslog [-- --seco]            lê o WMS desta máquina (--seco não grava)
npm run fonteslog-login                       login manual no WMS (Playwright, navegador visível), entrega a sessão em BOARD_URL
```

**Não há testes, lint nem build.** ESM puro em Node 22 (fixado em `engines` e `.nvmrc` — o `better-sqlite3` não tem binário pronto pro Node 24). Para conferir uma mudança:

- `node --check` e scripts descartáveis que importam os módulos reais.
- `DATA_DIR` apontando pra uma pasta temporária roda os módulos contra um SQLite vazio, em vez de `data/orders.sqlite`.
- `globalThis.fetch` trocado por um falso simula Bling/Mandaê/portal (foi assim que a disputa pela renovação do token foi reproduzida).
- Deploy = push no `master`; o Railway constrói sozinho. **`GET /api/diagnostico?s=<MANDAE_WEBHOOK_SECRET>` devolve `commit`** — espere bater antes de confiar num resultado de produção ("reiniciou agora" também vale pro reinício ANTERIOR).
- Rotas administrativas levam o segredo em `?s=`: `/bling/status`, `POST /bling/renovar`, `POST /bling/sincronizar`, `/api/pente-fino`, `/api/investigar`. `POST /api/pedido/reler {"orderNumber"}` relê um pedido no Bling com o código completo da varredura.

## Arquitetura

**Três fontes, papéis fixos.** WMS/FontesLog (`integrations/fonteslog.js` + `lib/wms.js`) e a transportadora (webhooks da Mandaê + `sync.js`, ou o texto da transportadora copiado do objeto de postagem do Bling) decidem a **cor**. O Bling (`integrations/bling.js` + `sync-bling.js`) é **cadastro e ponte**: só ele sabe que o número do WMS, o número do marketplace (`numeroLoja`) e o rastreio são a mesma venda, então é ele quem manda mesclar (`mesclarEmCanonico`, `registrarApelidos`, `resolverCanonico`). A `situacao` do Bling não pinta, salvo Cancelado / Em devolução / Entregue (`corDaSituacao`).

**Só o Bling cria quadrados.** `upsertOrder(partial, { permitirCriacao })` faz merge dos campos parciais; criar vem desligado, e só a sincronização do Bling e o pente fino passam `true`. WMS e Mandaê só atualizam pedidos que já existem (número desconhecido vira órfão).

**A cor é calculada em dois lugares — importa ao mexer em regra.**
- *Na escrita* (`upsertOrder`): `wmsSeverity` / `carrierSeverity` saem do texto da fonte via `statusMapping.js` e são **gravados**.
- *Na leitura* (`rowToOrder` → `listOrders`/`getOrder`): envelhecimento (`aplicarEnvelhecimento`), prazo, coleta, handover e "sem acompanhamento" rodam a cada requisição sobre as severidades gravadas.

Mudança numa regra *de leitura* vale no deploy. Mudança no mapeamento texto→cor só chega aos pedidos existentes quando eles são relidos (`/api/pedido/reler`, ou a varredura de 2h).

**`lib/statusMapping.js` é o livro de regras.** O texto da transportadora é normalizado (NFD, sem acento, minúsculo) antes de casar, então padrões se escrevem **sem acento**. VERMELHO é testado antes de VERDE, antes de AMARELO. O vocabulário de "entregue" mora **numa constante só, `ENTREGUE`**, usada tanto pra cor quanto pra `ehEventoFinal` (que para o envelhecimento) — cada transportadora/marketplace inventa a sua frase ("Pacote entregue" no TikTok Shop, "A transportadora já informou sobre a chegada do item" no Mercado Livre); frase nova entra ali, nunca como padrão paralelo. Bug conhecido em aberto: `/coletad/` casa "Sua encomenda **não** foi coletada" como verde (não há tratamento de negação).

**Tudo que escreve a partir do Bling passa por uma trava.** `lib/travaDeSincronizacao.js` é um flag em memória; a varredura de 2h, a via rápida de 3min, o webhook do Bling (`webhooks/blingEventos.js`) e `/api/pedido/reler` chamam `runSyncBling` dentro de `comTravaDeSincronizacao`. Quem chega em segundo recebe `{rodou:false}` e é descartado, não enfileirado. As rotas de diagnóstico chamam o Bling *fora* da trava.

**Um cliente HTTP do Bling só.** Apenas `pedirToken` (troca do code + renovação) e `blingFetch` (todo o resto) fazem `fetch` no Bling; o resto importa funções de `integrations/bling.js`. Os dois mandam `CABECALHOS_BLING` (`enable-jwt: 1` — o Bling recusa o token opaco; token opaco *com* o header leva 401). Os tokens ficam como JSON na tabela `meta` do SQLite. A renovação é única por vez (`renovarUmaVez`: o refresh token é de uso único, renovações simultâneas se matariam), e um 401 dispara uma renovação compartilhada + uma nova tentativa antes de desistir.

**Login do WMS.** O portal tem reCAPTCHA; o servidor lê as telas com GET simples usando o cookie de sessão salvo (`fonteslog-sessao.json` na pasta de dados), mantém a sessão viva com um pulso de 10 min que *é* a própria leitura, e refaz o login por HTTP sozinho enquanto vale o cookie `recaptcha_verificado` que um humano ganhou (~5 dias, o login não renova). Passado isso, uma pessoa resolve um captcha pelo botão "Entrar na FontesLog" (com PIN, `webhooks/wmsLogin.js`) ou por `npm run fonteslog-login`.

**Pasta de dados** (`lib/pastaDeDados.js`): `DATA_DIR`, senão o Volume do Railway, senão `./data`. Banco SQLite, tokens e a sessão do WMS moram ali; sem Volume, somem a cada deploy.

**Frontend** (`public/`): HTML/CSS/JS puro, sem build. Consulta `/api/orders` e `/api/meta` em intervalo. Cores são variáveis CSS em `:root`, com versão para modo escuro.

## Operação

- **Variáveis**: `.env.example` documenta cada uma; as mesmas vão nas *Variables* do Railway. Faltam lá `BLING_CLIENT_ID` / `BLING_CLIENT_SECRET` (app na Área do integrador do Bling). `MANDAE_WEBHOOK_SECRET` autentica webhooks **e** rotas administrativas.
- **Autorizar o Bling** (uma vez, ou se o refresh de 30 dias morrer): `https://quadro.vitapetlife.com/bling/autorizar?s=<MANDAE_WEBHOOK_SECRET>`. Conferir em `/bling/status` (mostra formato e tamanho do token, nunca o valor).
- **Webhook do Bling**: Área do integrador → app → Webhooks → `https://quadro.vitapetlife.com/webhooks/bling`, recursos Pedido de venda e Nota fiscal (criado/alterado). Autenticado por HMAC-SHA256 em `X-Bling-Signature-256` com o `BLING_CLIENT_SECRET`. Chegada visível em `/api/diagnostico` (`bling.webhookUltimoEm`, `webhookUltimaRecusa`).
- **Webhooks da Mandaê**: header `X-Mandae-Secret` = `MANDAE_WEBHOOK_SECRET`. Rastreamento em `/webhooks/mandae/rastreamento`; Item processado em `/webhooks/mandae/item-processado?s=<SEGREDO>` (segredo na URL porque o painel da Mandaê só oferece header pro de rastreamento).
- **Três relógios**: via rápida do Bling a cada `BLING_VIA_RAPIDA_MINUTOS` (3), varredura completa a cada `SYNC_INTERVAL_MINUTES` (120; acima de 60, múltiplos de 60), pulso do WMS a cada `WMS_PULSO_MINUTOS` (10). A varredura é a rede de segurança: webhook e via rápida podem perder eventos.
- **Deploy**: `SIGTERM` é tratado e o processo sai com 0 — sem isso o Railway lê cada deploy como crash.
- O quadro é público de propósito (sem login, com `noindex`). O portal da FontesLog não atende HTTPS.

## Armadilhas que já viraram incidente

- **`#` no `.env` corta o valor** (o dotenv trata como comentário). `FONTESLOG_SENHA` termina em `#`; use aspas. Um teste com senha truncada "provou" por meses que o login por HTTP era impossível. Variáveis do Railway não passam pelo dotenv.
- **O relógio do Bling é o de São Paulo, o container é UTC.** Monte janelas com `momentoNoBling()`, nunca `toISOString()` — janela em UTC responde 200 com lista vazia.
- **`/nfe` do Bling ignora o filtro de alteração** e **esconde nota cancelada/rejeitada** se não for pedida por `situacao`. Notas vêm por data de emissão; a situação de cancelada é perguntada uma nota por vez.
- **O Bling responde 429** acima de um teto por segundo: `blingFetch` espaça as chamadas (`BLING_INTERVALO_MS`, padrão 400) e recua. Uma varredura é uma chamada de detalhe por pedido.
- **Teste negativo prova pouco quando uma entrada não foi conferida** — a lição que mais se repete aqui. Meça contra dado real (vocabulário de produção em `/api/orders`, respostas reais do portal) antes de codificar uma regra.

## Convenções

- Código, identificadores, comentários, interface e mensagens de commit em **português**. Comentários de código **sem acento** (textos da interface mantêm).
- Comentários explicam o *porquê*, normalmente citando o pedido ou incidente real que motivou a regra ("O pedido 1482 mostrou..."). Mantenha essa densidade e esse estilo ao editar.
- Assunto do commit é uma frase em linguagem comum descrevendo o efeito no quadro (sem prefixos tipo `feat:`); o corpo conta o incidente, a causa e o que foi medido. **Sem trailers de coautoria ou de sessão** e sem nenhuma menção ao Claude em commits e PRs.
- O quadro é aberto; rotas que escrevem ou expõem segredo exigem `MANDAE_WEBHOOK_SECRET`, e a tela de login da FontesLog exige também `WMS_LOGIN_PIN`.
