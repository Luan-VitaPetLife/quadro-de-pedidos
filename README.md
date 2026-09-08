# Radar de Pedidos — Vita Pet Life

Quadro de pedidos: um quadrado por pedido, colorido por status:

- 🟩 **Verde** — tudo certo
- 🟨 **Amarelo** — aviso em aberto, ainda não resolvido
- 🟥 **Vermelho** — problema (ex.: tentativa de entrega falhou)

Roda sozinho (fora do Claude): um servidor Node.js sincroniza a cada X minutos
com a Mandaê (transportadora) e, assim que estiver pronto, com a FontesLog
(WMS), e serve o quadro numa página web simples.

## Estrutura

```
src/
  server.js              servidor web (Express) + dispara o agendador
  scheduler.js            roda a sincronização a cada N minutos (node-cron)
  sync.js                 orquestra: le pedidos -> consulta Mandaê/FontesLog -> grava no banco
  explore-fonteslog.js    script de diagnostico para mapear o portal da FontesLog (rode você mesmo)
  integrations/
    mandae.js              cliente da API da Mandaê
    fonteslog.js            login + scraping do portal da FontesLog (EM CONSTRUÇÃO)
  lib/
    statusMapping.js        regras que decidem verde/amarelo/vermelho
    db.js                    banco SQLite local (arquivo em data/orders.sqlite)
public/
  index.html, styles.css, app.js    o quadro (frontend)
data/
  orders-source.json       lista de pedidos a sincronizar (por enquanto, manual — ver "Próximos passos")
```

## Configuração

1. `npm install`
2. Copie `.env.example` para `.env` e preencha:
   - `MANDAE_TOKEN` / `MANDAE_CUSTOMER_ID` — em *Configurações da conta → API*, dentro do app da Mandaê.
   - `FONTESLOG_URL` / `FONTESLOG_LOGIN` / `FONTESLOG_SENHA` — acesso do portal do cliente FontesLog.
   - **Nunca** comite o `.env` (já está no `.gitignore`). Em produção (Railway), essas variáveis vão direto no painel do Railway, não em arquivo.

## Rodando localmente

```
npm run dev
```

Abre em `http://localhost:3000`. A primeira sincronização roda assim que o servidor sobe, e depois a cada `SYNC_INTERVAL_MINUTES` (padrão 120 = 2h).

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
- [ ] Implementar `fetchOrderStatus()` e ligar isso em `src/sync.js` (hoje o WMS status fica sempre vazio).
- [ ] Trocar `data/orders-source.json` (lista manual) por uma consulta direta à API do Shopify — precisa criar um app privado em *Shopify Admin → Configurações → Apps → Desenvolver apps* e gerar um Admin API access token.
- [ ] Revisar `src/lib/statusMapping.js` — o mapeamento de texto de evento da Mandaê para verde/amarelo/vermelho é um primeiro rascunho; vale conferir com pedidos reais.
- [ ] Deploy no Railway (ver abaixo).

## Deploy no Railway

1. Suba este repositório no GitHub (`git init`, `git add .`, `git commit`, crie o repo no GitHub e dê `git push`).
2. No Railway: **New Project → Deploy from GitHub repo**, escolha este repositório.
3. Em **Variables**, adicione as mesmas chaves do `.env.example` (`MANDAE_TOKEN`, `MANDAE_CUSTOMER_ID`, `FONTESLOG_URL`, `FONTESLOG_LOGIN`, `FONTESLOG_SENHA`, `SYNC_INTERVAL_MINUTES`).
4. O Railway detecta o `package.json` e roda `npm start` automaticamente. Ele também define `PORT` sozinho.
5. Como o banco é um arquivo SQLite em `data/orders.sqlite`, adicione um **Volume** no serviço do Railway montado em `/app/data` — sem isso, o banco reseta a cada deploy.
6. O Playwright precisa dos binários do Chromium instalados no build — se o build falhar por causa disso, adicione um `postinstall` script rodando `npx playwright install --with-deps chromium` (posso ajudar a ajustar isso quando chegarmos lá).

## Segurança

- Nenhuma credencial (token da Mandaê, login/senha da FontesLog) fica no código nem em nenhum documento — só em `.env` local (fora do git) e nas *Variables* do Railway em produção.
