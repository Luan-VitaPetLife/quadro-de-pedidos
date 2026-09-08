# Radar de Pedidos — Vita Pet Life

Quadro de pedidos: um quadrado por pedido, colorido por status:

- 🟩 **Verde** — tudo certo
- 🟨 **Amarelo** — aviso em aberto, ainda não resolvido
- 🟥 **Vermelho** — problema (ex.: tentativa de entrega falhou)

Roda sozinho (fora do Claude): um servidor Node.js recebe **webhooks da
Mandaê** em tempo real (é assim que os pedidos entram no quadro — sem
Shopify, sem lista manual) e, assim que estiver pronto, também consulta a
FontesLog (WMS). Um pedido não fica só em memória: tudo é gravado em SQLite.

## Como os pedidos entram no quadro

**Não usamos Shopify nem nenhuma lista manual como fonte.** Todos os pedidos
— de qualquer marca, sem filtro — chegam pela Mandaê e pela FontesLog, que já
recebem os pedidos de todos os canais de venda.

1. A Mandaê expede uma encomenda → dispara o webhook **"Item processado"** →
   o pedido aparece no quadro (status inicial: amarelo, aguardando o primeiro
   evento de rastreio).
2. A cada novo evento de rastreio → dispara o webhook **"Rastreamento"** → o
   quadrado muda de cor em tempo real, sem precisar esperar o ciclo de
   sincronização.
3. A cada `SYNC_INTERVAL_MINUTES` (padrão 120 = 2h), uma sincronização de
   reforço (`src/sync.js`) reconsulta a API da Mandaê para todo pedido já
   conhecido — rede de segurança caso algum webhook se perca.
4. A FontesLog (WMS) ainda não tem integração pronta (ver seção abaixo) — ela
   vai entrar como mais uma fonte de status por pedido, do mesmo jeito.

## Estrutura

```
src/
  server.js              servidor web (Express), rotas de webhook e dispara o agendador
  scheduler.js            roda a sincronização de reforço a cada N minutos (node-cron)
  sync.js                 reconsulta a Mandaê para os pedidos já conhecidos (rede de segurança)
  explore-fonteslog.js    script de diagnostico para mapear o portal da FontesLog (rode você mesmo)
  webhooks/
    mandae.js              handlers dos webhooks "item processado" e "rastreamento" da Mandaê
  integrations/
    mandae.js              cliente da API da Mandaê (consulta direta, usada pela sincronização de reforço)
    fonteslog.js            login + scraping do portal da FontesLog (EM CONSTRUÇÃO)
  lib/
    statusMapping.js        regras que decidem verde/amarelo/vermelho
    db.js                    banco SQLite local (arquivo em data/orders.sqlite)
public/
  index.html, styles.css, app.js    o quadro (frontend)
```

## Configuração

1. `npm install`
2. Copie `.env.example` para `.env` e preencha:
   - `MANDAE_TOKEN` / `MANDAE_CUSTOMER_ID` — em *Configurações da conta → API*, dentro do app da Mandaê.
   - `MANDAE_WEBHOOK_SECRET` — um valor aleatório qualquer (ex.: `openssl rand -hex 24`), usado pra confirmar que os webhooks recebidos são mesmo da Mandaê.
   - `FONTESLOG_URL` / `FONTESLOG_LOGIN` / `FONTESLOG_SENHA` — acesso do portal do cliente FontesLog.
   - **Nunca** comite o `.env` (já está no `.gitignore`). Em produção (Railway), essas variáveis vão direto no painel do Railway, não em arquivo.

## Rodando localmente

```
npm run dev
```

Abre em `http://localhost:3000`. Os pedidos aparecem conforme os webhooks da
Mandaê chegam (não dá pra testar webhooks reais em `localhost` sem expor a
porta pra internet — ver "Configurando os webhooks da Mandaê" abaixo). A
sincronização de reforço roda assim que o servidor sobe, e depois a cada
`SYNC_INTERVAL_MINUTES` (padrão 120 = 2h).

## Configurando os webhooks da Mandaê

Isso só funciona com uma URL pública (ou seja, depois do deploy no Railway —
ver abaixo). Com o app no ar:

1. No painel da Mandaê: **Configurações da conta → API → Webhooks**.
2. Cadastre dois webhooks:
   - **Item processado** → `https://SEU-APP.up.railway.app/webhooks/mandae/item-processado`
   - **Rastreamento** → `https://SEU-APP.up.railway.app/webhooks/mandae/rastreamento`
3. Em cada um, configure um header customizado `X-Mandae-Secret` com o mesmo
   valor que você colocou em `MANDAE_WEBHOOK_SECRET` no Railway. Isso evita
   que qualquer pessoa na internet consiga forjar pedidos no seu quadro.

## Terminando a integração com a FontesLog

A FontesLog não tem API pública, então a integração é via automação de navegador (Playwright) no portal do cliente. Como ninguém ainda navegou pelo portal pra saber sua estrutura real:

```
npm run explore-fonteslog
```

Isso faz login (usando o `.env` — a senha nunca sai do seu computador) e salva em `data/fonteslog-debug/`:
- `pagina-pos-login.png` — screenshot de onde o login te levou
- `pagina-pos-login.html` — o HTML da página

Com isso em mãos dá pra terminar `src/integrations/fonteslog.js` (os seletores de login já estão lá como um primeiro chute — ajuste conforme o que o screenshot/HTML mostrarem) e implementar `fetchOrderStatus()`, que hoje só lança um erro "ainda não implementado".

## Próximos passos

- [ ] Rodar `npm run explore-fonteslog` e ajustar `src/integrations/fonteslog.js` com os seletores reais.
- [ ] Implementar `fetchOrderStatus()` e ligar isso na sincronização (hoje o WMS status fica sempre vazio).
- [ ] Revisar `src/lib/statusMapping.js` — o mapeamento de texto de evento da Mandaê para verde/amarelo/vermelho é um primeiro rascunho; vale conferir com pedidos reais.
- [ ] Deploy no Railway (ver abaixo) e cadastrar os webhooks no painel da Mandaê.

## Deploy no Railway

1. Suba este repositório no GitHub (`git init`, `git add .`, `git commit`, crie o repo no GitHub e dê `git push`).
2. No Railway: **New Project → Deploy from GitHub repo**, escolha este repositório.
3. Em **Variables**, adicione as mesmas chaves do `.env.example` (`MANDAE_TOKEN`, `MANDAE_CUSTOMER_ID`, `MANDAE_WEBHOOK_SECRET`, `FONTESLOG_URL`, `FONTESLOG_LOGIN`, `FONTESLOG_SENHA`, `SYNC_INTERVAL_MINUTES`).
4. O Railway detecta o `package.json` e roda `npm start` automaticamente. Ele também define `PORT` sozinho.
5. Como o banco é um arquivo SQLite em `data/orders.sqlite`, adicione um **Volume** no serviço do Railway montado em `/app/data` — sem isso, o banco reseta a cada deploy.
6. O Playwright precisa dos binários do Chromium instalados no build — se o build falhar por causa disso, adicione um `postinstall` script rodando `npx playwright install --with-deps chromium` (posso ajudar a ajustar isso quando chegarmos lá).
7. Com a URL pública em mãos, cadastre os dois webhooks no painel da Mandaê (ver "Configurando os webhooks da Mandaê" acima).

## Segurança

- Nenhuma credencial (token da Mandaê, segredo do webhook, login/senha da FontesLog) fica no código nem em nenhum documento — só em `.env` local (fora do git) e nas *Variables* do Railway em produção.
