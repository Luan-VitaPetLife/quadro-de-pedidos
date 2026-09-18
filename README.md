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

### Nota cancelada, e a venda refeita em outro pedido

Cancelar a **nota** não cancela a **venda**: a situação do pedido no Bling
segue `Aguardando Envio`, e por isso o quadro precisa olhar as duas coisas.

O caso que criou a regra: a Ilma comprou uma vez na Shopee e o Bling ficou com
dois pedidos carregando o mesmo `numeroLoja` — o 1551, com a nota 000323
**cancelada**, e o 1560, com a nota 001223 autorizada. Os dois apareciam
**verdes**: a situação do pedido não acusava nada, e o Shopee Xpress não manda
evento nenhum, então também não havia silêncio a cobrar.

Agora o quadro guarda a situação da nota (`situacao_nota`) e o número da venda
no marketplace (`numero_loja`), e dali sai a decisão:

| Situação | O que o quadro faz |
|---|---|
| Nota cancelada/rejeitada e **outro pedido da mesma venda** com nota de pé | o antigo sai do quadro apontando para o novo (`substituido_por`) |
| Nota cancelada/rejeitada e **ninguém refez** | 🟨 “Nota 000323 cancelada no Bling e ninguém refez o faturamento” |
| A nota do substituto também cai | o antigo **volta** ao quadro, amarelo |

Nada é apagado: o registro continua no banco e volta sozinho se o Bling mudar
de ideia.

**Detalhe que custa caro se esquecido:** a listagem `/nfe` **esconde** nota
cancelada e rejeitada — a janela 17–18/09 devolve 10 notas, todas situação 5 ou
6, e a 000323 (cancelada) só aparece quando se pergunta por ela com
`situacao=2`. Trazer as escondidas na listagem geral seria simples e pior: são
44 notas em 60 dias, e isso ligaria a rotina que **desmonta** quadrado (apaga o
rastreio, derruba o `temNota`) em cima de quadrados que hoje estão certos. Em
vez disso, a situação é perguntada **uma nota por vez**, só quando o pedido
aponta para uma nota que a listagem não trouxe — e o que se lê vira rótulo, sem
mexer em estado nenhum. No ensaio contra a produção, 13 pedidos se
qualificavam e só um respondeu "Cancelada".

### O botão "Reler no Bling"

Dentro do pop-up de cada pedido. Lê **só aquele pedido**, na hora, com o mesmo
código da varredura — acha o pedido pelo número, lê o detalhe, a nota dele pelo
id e o objeto de postagem. Quatro chamadas, nenhum efeito sobre os outros
quadrados, e não avança o carimbo de "última leitura" (que responde por
*quadro inteiro*, não por um cartão).

É a resposta para "o Bling já sabe, o quadro ainda não" sem esperar o ciclo de
duas horas — e sem precisar varrer nada.

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
  scheduler.js           varredura (2h), via rápida do Bling (3min) e pulso do WMS
  sync.js                reconsulta a Mandaê nos pedidos conhecidos (reforço)
  sync-bling.js          lê o Bling, mescla duplicados, preenche cadastro
  sync-fonteslog.js      lê o WMS na sua máquina (conferência; o servidor já lê sozinho)
  fonteslog-login.js     login manual no WMS e entrega a sessão ao quadro (RODA LOCAL)
  check-mandae.js        diagnóstico da conexão com a Mandaê
  testar-pedido.js       testa a integração inteira com um pedido real
  integrations/          clientes: mandae.js, fonteslog.js, bling.js
  webhooks/              handlers: mandae.js, fonteslog.js, bling.js,
                         blingEventos.js (o webhook de pedido/nota alterados)
  lib/
    statusMapping.js     regras de cor + envelhecimento
    diasUteis.js         calendário de feriados nacionais
    db.js                SQLite, merge de pedidos e mesclagem de duplicados
    wms.js               leitura do WMS, pulso da sessão e o estado que o quadro mostra
    pastaDeDados.js      onde ficam banco e sessão (Volume no Railway)
public/                  o quadro (HTML/CSS/JS puro)
```

## Comandos

```
npm start                 sobe o servidor
npm run dev               idem, recarregando ao salvar
npm run check-mandae      confere token da Mandaê e a ponte (partnerItemId)
npm run check-mandae -- CODIGO          eventos reais de um rastreio
npm run testar-pedido -- CODIGO [NUM]   testa a corrente inteira com um pedido real
npm run fonteslog-login   login manual no WMS e entrega a sessão ao quadro
npm run sync-fonteslog    lê o WMS daqui (conferência; --seco não grava)
```

## O que roda onde, e por quê

**No Railway**, sozinho: o servidor, os webhooks da Mandaê, a reconsulta de
reforço, a sincronização do Bling **e a leitura do WMS da FontesLog**.

**Você**: resolver um captcha no portal da FontesLog, no máximo a cada ~5 dias —
e só quando o quadro pedir, pelo botão **Entrar na FontesLog** no aviso vermelho.

São três camadas, da mais barata para a mais cara:

1. O **pulso** de 10 minutos segura a sessão viva. Quase sempre é só isso.
2. Se a sessão cair assim mesmo (deploy, portal reiniciado), o quadro **refaz o
   login sozinho** — um POST em `/Login/AcessarCliente` com as credenciais do
   servidor. Funciona enquanto valer o cookie `recaptcha_verificado`, que o
   portal grava quando alguém resolve um captcha e que dura ~5 dias.
3. Vencido esse prazo, aí sim uma pessoa resolve um captcha. Só aí.

O passo 2 **não é captcha burlado**: é a mesma sessão humana sendo reaproveitada
enquanto vale, como já se faz com o `ASP.NET_SessionId`. O login não renova o
`recaptcha_verificado` (medido: a resposta não traz `Set-Cookie`), então o
sistema continua ancorado num humano de verdade.

> **Cuidado com um erro que já custou meses aqui.** Até setembro de 2026 este
> README e os comentários do código afirmavam que refazer o login por HTTP era
> impossível. O teste que provava isso rodava com a **senha truncada**: o dotenv
> corta a linha no `#`, e a senha termina em `#`. O portal respondia o que
> responde a qualquer senha errada, e aquilo virou lei. Use aspas no `.env`.

Depois de logado, a leitura em si **não precisa de navegador**: as telas do
portal são GET com tudo na query string, então basta um `fetch` com o cookie. É
isso que permite o servidor ler sozinho.

### O pulso, e por que ele existe

O cookie `ASP.NET_SessionId` **não tem data de validade**: quem o mata é o
servidor da DDS, por **inatividade** — a janela padrão do ASP.NET é de ~20
minutos, e ela reinicia a cada requisição. No relógio do ciclo (2 horas) a
sessão morreria sozinha entre uma rodada e outra, e o login manual viraria
rotina diária. Por isso o quadro bate numa tela barata a cada
`WMS_PULSO_MINUTOS` (padrão 10) só para manter a janela aberta.

O que ainda derruba, e contra o que não há jeito: o portal reiniciar (a sessão
vive na memória do servidor deles) ou a DDS expirar por tempo absoluto. Aí é
login manual mesmo — e o quadro avisa numa faixa acima do placar, porque dado
velho **sem aviso** é pior do que dado nenhum: os quadrados continuariam com o
último status conhecido e um pedido travado no armazém ontem seguiria verde hoje.

> **Paginação:** a tabela do portal usa DataTables no lado do cliente. O
> "Mostrar 10 registros" e o "Anterior/Próximo" são enfeite do JavaScript — o
> HTML já vem com todas as linhas. Confirmado: a tela exibia 10 e o HTML
> trazia 66. Não existe página 2 para buscar.

## Com que rapidez um pedido aparece

Três relógios, porque são três perguntas de custo muito diferente.

| Quando | O que faz | Custo |
|---|---|---|
| a cada 3 min | pergunta ao Bling **o que mudou** desde a última vez | quase nada: 0 a 3 pedidos |
| a cada 2 h | varre os últimos 60 dias inteiros | 1 chamada de detalhe **por pedido** |
| ao receber o webhook | adianta a pergunta de 3 min | idem à via rápida |

A varredura não é desperdício: ela é a rede de segurança. O webhook pode não
estar configurado, pode cair, e o próprio Bling avisa que não garante ordem nem
entrega única. A via rápida pode perder uma janela num deploy. A varredura vê
tudo de novo e conserta.

### Dois detalhes que custam caro se esquecidos

**O relógio do Bling é o de São Paulo.** O container roda em UTC, e uma janela
montada com `toISOString()` cai três horas no futuro: o filtro aceita, responde
`200` e devolve lista vazia — a via rápida *pareceria* funcionar sem nunca
trazer nada. Medido: a janela `08:40–09:40` devolveu os pedidos 1515 e 1517; a
mesma janela escrita em UTC devolveu zero. Por isso `momentoNoBling()`.

**`/nfe` ignora o filtro de alteração.** Uma janela de alteração impossível
devolve a lista inteira, em silêncio. Só `/pedidos/vendas` filtra por alteração
de verdade (janela de 2019 → zero; parâmetro inventado → não filtra nada). Por
isso as notas vêm por **emissão** recente — que de todo modo é o evento que
interessa: nota emitida é o marco em que a remessa vai pro WMS.

### Ligando o webhook (feito uma vez, no Bling)

1. Bling → **Área do integrador** → o seu app → aba **Webhooks**
2. URL: `https://quadro.vitapetlife.com/webhooks/bling`
3. Recursos: **Pedido de venda** e **Nota fiscal**, ações *criado* e *alterado*
4. Salvar. Não há segredo a preencher: a autenticação é a assinatura
   HMAC-SHA256 que o Bling manda em `X-Bling-Signature-256`, conferida contra o
   `BLING_CLIENT_SECRET` do app.

Para saber se está chegando, `GET /api/diagnostico?s=SEGREDO` mostra
`bling.webhookUltimoEm`, `webhookUltimoEvento` e `webhookUltimaRecusa`. Sem
isso, "configurado e funcionando" e "nunca configurado" seriam
indistinguíveis — nos dois casos o quadro fica atualizado, porque a via rápida
cobre os dois; a diferença é segundos contra minutos.

## Configuração

Copie `.env.example` para `.env` e preencha. As mesmas chaves vão nas
*Variables* do Railway — **menos** `FONTESLOG_LOGIN` e `FONTESLOG_SENHA`, que
só servem para preencher o formulário do login manual, na sua máquina. A sessão
resultante é que vai para o servidor, pela rota de entrega.

| Variável | Para quê |
|---|---|
| `MANDAE_TOKEN` / `MANDAE_CUSTOMER_ID` | API da Mandaê (Configurações → API) |
| `MANDAE_WEBHOOK_SECRET` | autentica os webhooks **e** as rotas administrativas |
| `BLING_CLIENT_ID` / `BLING_CLIENT_SECRET` | app criado na Área do integrador do Bling |
| `FONTESLOG_URL` | portal do WMS (o servidor também precisa: é ele quem lê) |
| `FONTESLOG_LOGIN` / `_SENHA` | preenchem o formulário do login manual (**só local**) |
| `WMS_PULSO_MINUTOS` | padrão 10. De quanto em quanto tempo a sessão do WMS é mantida viva |
| `SYNC_INTERVAL_MINUTES` | varredura completa; padrão 120. Acima de 60, use múltiplos de 60 |
| `BLING_VIA_RAPIDA_MINUTOS` | "o que mudou?"; padrão 3, entre 1 e 30 |
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
