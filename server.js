API ONLINE - HAPPY BURGER COLONIA

Esta pasta e a parte que recebe os pedidos, salva no banco e entrega os dados para o painel e para o agente de impressao.

O QUE TEM AQUI

- server.js
  Servidor da API.

- package.json
  Configuracao para hospedagem Node.js.

- config/menu.json
  Cardapio usado pela API para validar pedidos e calcular valores.

- config/store.json
  Configuracoes publicas da loja.

- SUPABASE-SCHEMA.sql
  Script para criar a tabela dos pedidos e a tabela de prazos no Supabase.

- .env.example
  Modelo das variaveis que voce vai configurar na hospedagem.

PASSO 1 - CRIAR O BANCO NO SUPABASE

1. Entrar em https://supabase.com/
2. Criar um projeto.
3. Abrir SQL Editor.
4. Colar o conteudo do arquivo SUPABASE-SCHEMA.sql.
5. Executar.

PASSO 2 - PEGAR AS CHAVES DO SUPABASE

No painel do Supabase:

1. Abrir Project Settings.
2. Abrir API.
3. Copiar Project URL.
4. Copiar service_role key.

IMPORTANTE:
A service_role key fica somente na hospedagem da API.
Nunca coloque essa chave no site-cliente nem no site-painel.

PASSO 3 - HOSPEDAR ESTA PASTA COMO API NODE

Em uma hospedagem que rode Node.js:

Build command:
npm install

Start command:
npm start

Variaveis de ambiente:

SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=COLE_AQUI_A_SERVICE_ROLE_KEY
SUPABASE_ORDERS_TABLE=happy_orders
SUPABASE_SETTINGS_TABLE=happy_store_settings
STORE_TOKEN=COLOQUE_O_CODIGO_DO_PAINEL
STORE_TIME_ZONE=America/Sao_Paulo
ORDER_RESET_HOUR=16

Se a hospedagem pedir porta, use a variavel PORT automatica da propria hospedagem.
O servidor ja le process.env.PORT.

SOBRE OS PEDIDOS E FECHAMENTO DE CAIXA

Os pedidos nao ficam salvos como historico permanente.
A API mantem o caixa atual e limpa pedidos antigos automaticamente.

Regra atual:

- Das 17:00 as 23:30, os pedidos ficam disponiveis para operacao e fechamento.
- No dia seguinte, antes das 16:00, pedidos do dia anterior ainda podem aparecer para conferencia.
- A partir das 16:00, a API limpa os pedidos antigos e o caixa do novo dia comeca zerado.

Se quiser limpar mais cedo ou mais tarde, altere:

ORDER_RESET_HOUR=16

PASSO 4 - TESTAR A API

Depois de publicar, abra:

https://SUA-API/api/health

Tem que responder algo parecido com:

{
  "ok": true,
  "store": "Happy Burger Colonia",
  "storage": "supabase"
}

Se aparecer "storage": "local", significa que as variaveis do Supabase nao foram configuradas.

SOBRE OS PRAZOS DE RETIRADA E ENTREGA

O painel da loja permite alterar os dois prazos a qualquer momento.
Os valores ficam salvos na tabela happy_store_settings e aparecem automaticamente no cardapio.

Depois de atualizar uma instalacao que ja estava online:

1. Abra o SQL Editor do Supabase.
2. Execute novamente o arquivo SUPABASE-SCHEMA.sql atualizado.
3. Adicione na hospedagem, se desejar deixar explicito:
   SUPABASE_SETTINGS_TABLE=happy_store_settings
4. Publique novamente a API, o site-cliente e o site-painel.

Executar o arquivo SQL novamente nao apaga os pedidos existentes.

PASSO 5 - CONECTAR OS SITES

Depois que a API estiver online, abrir:

site-cliente/config.js
site-painel/config.js

E colocar:

window.HAPPY_API_BASE_URL = "https://SUA-API";

Depois subir novamente site-cliente e site-painel.

PASSO 6 - CONECTAR A IMPRESSAO

No computador da loja, editar:

print-agent/config.local.json

E colocar:

{
  "serverUrl": "https://SUA-API",
  "storeToken": "COLOQUE_O_CODIGO_DO_PAINEL",
  "printerName": "Bematech MP-4200 TH",
  "pollEveryMs": 5000,
  "dryRun": false,
  "markPrintedAfterDryRun": false
}

O agente deve ficar aberto no computador da loja para imprimir automaticamente.
