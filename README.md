# Radar de Pedidos — Vita Pet Life

Quadro de pedidos: um quadrado por pedido, colorido por status.

- 🟩 **Verde** — seguindo normalmente
- 🟨 **Amarelo** — aviso em aberto, ainda não resolvido
- 🟥 **Vermelho** — problema (extravio, endereço não localizado, pedido rejeitado…)

No ar em **https://quadro.vitapetlife.com** (Railway).

## De onde vem cada informação

O quadro junta três sistemas, e cada um tem um papel bem definido:

| Sistema | Papel | Como entra |
|---|---|---|
| **FontesLog (WMS)** | **status** do armazém: separação, expedição, pedido parado/rejeitado com o motivo | raspagem do portal, rodada **localmente** |
| **Mandaê** | **status** da transportadora: trânsito, entrega, extravio, endereço não localizado | **webhook** em tempo real + reconsulta de reforço |
| **Bling (ERP)** | **cadastro e ponte**: cliente, loja, cidade — e a ligação entre os dois lados | API v3, rodada **no próprio quadro** |

**A cor sai do pior entre WMS e Mandaê.** A `situacao` do Bling é ignorada de
propósito: quem sabe se o pedido está bem ou mal é quem executa a operação.

### Por que o Bling é indispensável

O Bling alimenta o WMS e a Mandaê separadamente, e manda **referências
diferentes** para cada um:

```
Bling numero      = 1445             -> é o que o WMS recebe
Bling numeroLoja  = 7416887836984    -> é o que a Mandaê recebe
rastreio          = VITPT000406
```

Sem ele, a mesma venda ocupa dois ou três quadrados, cada um contando metade
da história — um verde dizendo que o armazém expediu, outro vermelho dizendo
que a encomenda extraviou, e ninguém ligando um ao outro. Só o Bling conhece
as três chaves ao mesmo tempo, então é ele quem diz o que mesclar. O `numero`
vira a chave canônica, porque é a que o WMS usa e a que a operação reconhece.

O Bling **não cria** quadrados — só enriquece e une. Um pedido só ganha um
quadrado quando o WMS ou a transportadora têm algo a dizer sobre ele.

## Pedido parado também é problema

As regras de cor olham o último evento. Um pedido coletado e esquecido tem,
como último evento, algo bom — e ficaria verde para sempre. O caso mais caro
da operação não é o erro declarado, é o silêncio.

Por isso todo pedido envelhece:

| Sem evento novo por | Cor |
|---|---|
| `DIAS_UTEIS_AVISO` (5) dias úteis | 🟨 |
| `DIAS_UTEIS_PROBLEMA` (10) dias úteis | 🟥 |

A contagem é em **dias úteis** — fim de semana e feriado nacional não contam
(`src/lib/diasUteis.js`, com os móveis derivados da Páscoa). Coletado num
sábado com feriado na segunda, o pedido só pode andar na terça: 3 dias de
calendário, 1 dia útil.

Só piora, nunca melhora. E **estados terminais não envelhecem**: pedido
entregue (Mandaê) ou expedido (WMS, quando a transportadora ainda não deu
notícia) ficam como estão.

## Estrutura

```
src/
  server.js              servidor web, rotas e encerramento gracioso
  scheduler.js           ciclo a cada SYNC_INTERVAL_MINUTES (padrão 2h)
  sync.js                reconsulta a Mandaê nos pedidos conhecidos (reforço)
  sync-bling.js          lê o Bling, mescla duplicados, preenche cadastro
  sync-fonteslog.js      lê o portal do WMS e manda pro quadro (RODA LOCAL)
  fonteslog-login.js     login manual no WMS, salva a sessão (RODA LOCAL)
  check-mandae.js        diagnóstico da conexão com a Mandaê
  testar-pedido.js       testa a integração inteira com um pedido real
  integrations/          clientes: mandae.js, fonteslog.js, bling.js
  webhooks/              handlers: mandae.js, fonteslog.js, bling.js
  lib/
    statusMapping.js     regras de cor + envelhecimento
    diasUteis.js         calendário de feriados nacionais
    db.js                SQLite, merge de pedidos e mesclagem de duplicados
public/                  o quadro (HTML/CSS/JS puro)
```

## Comandos

```
npm start                 sobe o servidor
npm run dev               idem, recarregando ao salvar
npm run check-mandae      confere token da Mandaê e a ponte (partnerItemId)
npm run check-mandae -- CODIGO          eventos reais de um rastreio
npm run testar-pedido -- CODIGO [NUM]   testa a corrente inteira com um pedido real
npm run fonteslog-login   abre o navegador pro login manual no WMS
npm run sync-fonteslog    lê o WMS e manda pro quadro (--seco não grava)
```

## O que roda onde, e por quê

**No Railway**, sozinho: o servidor, os webhooks da Mandaê, a reconsulta de
reforço e a sincronização do Bling.

**Na sua máquina**, com você por perto: a leitura do WMS da FontesLog.

O motivo é o **reCAPTCHA** no login do portal da FontesLog
(`/Login/ExibirCaptcha` responde `{"MostrarRecaptcha":true}`). Robô nenhum
passa por ali — e não é para passar, essa é a função dele. O caminho legítimo
é você logar uma vez (`npm run fonteslog-login`) e a automação reaproveitar a
sessão salva, como o navegador faz com "continuar conectado".

Depois de logado, a leitura em si **não precisa de navegador**: as telas do
portal são GET com tudo na query string, então basta um `fetch` com o cookie.

> **Paginação:** a tabela do portal usa DataTables no lado do cliente. O
> "Mostrar 10 registros" e o "Anterior/Próximo" são enfeite do JavaScript — o
> HTML já vem com todas as linhas. Confirmado: a tela exibia 10 e o HTML
> trazia 66. Não existe página 2 para buscar.

O cookie do portal expira; quando expirar, os scripts avisam e é só rodar o
login de novo.

## Configuração

Copie `.env.example` para `.env` e preencha. As mesmas chaves vão nas
*Variables* do Railway — **menos** as da FontesLog, que só existem localmente.

| Variável | Para quê |
|---|---|
| `MANDAE_TOKEN` / `MANDAE_CUSTOMER_ID` | API da Mandaê (Configurações → API) |
| `MANDAE_WEBHOOK_SECRET` | autentica os webhooks **e** as rotas administrativas |
| `BLING_CLIENT_ID` / `BLING_CLIENT_SECRET` | app criado na Área do integrador do Bling |
| `FONTESLOG_URL` / `_LOGIN` / `_SENHA` | portal do WMS (**só local**) |
| `SYNC_INTERVAL_MINUTES` | padrão 120. Acima de 60, use múltiplos de 60 |
| `DIAS_UTEIS_AVISO` / `_PROBLEMA` | envelhecimento (padrão 5 e 10) |
| `BOARD_URL` | quadro alvo dos scripts locais |
| `DATA_DIR` | opcional: o Railway já usa o Volume sozinho |

## Autorizando o Bling

Uma vez só. Abra, trocando pelo valor real do segredo:

```
https://quadro.vitapetlife.com/bling/autorizar?s=<MANDAE_WEBHOOK_SECRET>
```

O token de acesso dura 6h e o de renovação 30 dias, com renovação automática.
Os tokens ficam na tabela `meta` do SQLite — ou seja, no Volume — e sobrevivem
a deploys.

Conferir: `/bling/status?s=…` · Forçar leitura: `POST /bling/sincronizar?s=…`

## Webhooks da Mandaê

Painel da Mandaê → **Configurações da conta → API → Webhooks**:

| Campo | Valor |
|---|---|
| Chave de autenticação | `X-Mandae-Secret` |
| Valor de autenticação | o `MANDAE_WEBHOOK_SECRET` |
| Rastreamento | `https://quadro.vitapetlife.com/webhooks/mandae/rastreamento` |
| Item processado | `https://quadro.vitapetlife.com/webhooks/mandae/item-processado?s=<SEGREDO>` |

O "Item processado" leva o segredo **na URL** porque o painel da Mandaê só
oferece campos de header para o webhook de rastreamento. Sem isso ele seria
recusado com 401 — e como é ele que **cria** os pedidos, o quadro nunca sairia
do zero.

## Deploy

Push no `master` → o Railway constrói e sobe sozinho.

- Node fixado em **22** (`engines` + `.nvmrc`): o `better-sqlite3` não publica
  binário pronto para o Node 24, e sem binário o build tenta compilar e falha.
- O banco fica no **Volume** (`RAILWAY_VOLUME_MOUNT_PATH`, detectado sozinho).
  Sem volume, o histórico some a cada deploy — o log avisa na subida.
- `SIGTERM` é tratado e o processo sai com **0**. Sem isso o Node sai com 143,
  o Railway lê como *crash* e manda alerta a cada deploy bem-sucedido.

## Segurança

O quadro é **público por decisão de operação** — sem senha, para qualquer
pessoa do time abrir direto. Tem `noindex` para não ser indexado por
buscadores, mas quem tiver o link vê os pedidos e os nomes dos clientes.

As rotas que **escrevem ou administram** (webhooks, `/bling/*`) exigem o
`MANDAE_WEBHOOK_SECRET`, por header ou `?s=` na URL.

Nenhuma credencial fica no código: `.env` local (fora do git) e *Variables* no
Railway. A sessão da FontesLog (`data/fonteslog-sessao.json`) vale como senha e
está no `.gitignore`.

## Pendências conhecidas

- **XSS no painel**: o detalhe do pedido monta HTML com `innerHTML`
  interpolando dados externos. Risco baixo enquanto o segredo dos webhooks
  estiver configurado, mas vale fechar.
- **Ordenação**: o quadro ordena por evento mais recente, então os pedidos mais
  parados ficam por último. Os filtros de cor contornam, mas ordenar por
  urgência seria melhor.
- **Não dá para remover um pedido pela tela** — só pela mesclagem do Bling.
- O portal da FontesLog **não atende em HTTPS**: as credenciais trafegam sem
  criptografia. Vale reportar à DDS Informática — (11) 3977-4169.
