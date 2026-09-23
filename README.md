# Quadro de Pedidos — Vita Pet Life

Um painel que mostra, num relance, como está cada pedido da loja: um quadrado por pedido, colorido pelo andamento.

- 🟩 **Verde** — seguindo normalmente
- 🟨 **Amarelo** — precisa de atenção
- 🟥 **Vermelho** — problema na entrega ou no armazém

## O que ele faz

O quadro acompanha o pedido do começo ao fim, juntando o que cada etapa sabe:

- **Venda** — o pedido e a nota fiscal, vindos do ERP e dos marketplaces (loja própria, Mercado Livre, Shopee, TikTok Shop…)
- **Armazém** — separação, conferência e expedição
- **Transporte** — coleta, trânsito, entrega e ocorrências da transportadora

Quando as três pontas falam do mesmo pedido, ele vira um quadrado só.

## Por que existe

O problema mais caro da operação quase nunca é o erro declarado — é o pedido que **para de andar** e ninguém percebe. Por isso o quadro não olha só o último evento: um pedido que fica tempo demais sem novidade muda de cor sozinho, contando em dias úteis.

O que dá para resolver à mão sai da tela e fica guardado numa gaveta, pronto para voltar se precisar.

## Na prática

- Filtros por período, situação e canal de venda
- Detalhe de cada pedido: cliente, destino, nota, rastreio e linha do tempo
- Atualização automática, sem precisar recarregar a página
- Modo tela cheia para deixar numa TV

## Tecnologia

Node.js 22, Express, SQLite e uma interface em HTML/CSS/JS puro, sem etapa de build.

```
npm install
cp .env.example .env    # preencha as credenciais
npm run dev
```
