# Gastos Nubank/Itaú → Notion

Sincronização automática de gastos bancários (Nubank e Itaú) para uma base
de dados no Notion, usando Open Finance como fonte de dados e uma função
serverless na AWS como motor da automação. Rodando no volume de uso
pessoal, o custo esperado é **R$0/mês** (dentro do free tier da AWS e do
conector gratuito da Pluggy).

## O que é este projeto

A ideia é simples: em vez de anotar gastos manualmente, o próprio banco
"avisa" o que foi gasto, e uma rotina automática registra isso numa base já
existente no Notion — a mesma que seria preenchida à mão, só que sem o
trabalho manual.

Para isso, três peças conversam entre si:

1. **Open Finance / Pluggy** — fornece acesso programático aos extratos e
   faturas das contas conectadas.
2. **AWS Lambda** — roda uma vez por dia, busca o que há de novo e decide o
   que efetivamente vale registrar (evitando lixo e duplicidade — ver
   seção de decisões de design abaixo).
3. **Notion API** — recebe os dados e cria as linhas na base existente,
   usando as mesmas propriedades que já eram preenchidas manualmente.

## Como funciona (arquitetura)

```
Nubank/Itaú --(Open Finance)--> Meu Pluggy --(consulta agendada)--> Lambda --> Notion API
                                                    ^
                                          EventBridge Rule (1x/dia)
```

- A cada execução, a Lambda autentica na API da Pluggy, busca as
  transações dos itens configurados, filtra e agrupa (ver abaixo), e para
  cada uma cria (ou pula, se já existir) uma página no database do Notion.
- Não existe endpoint público nem webhook nessa arquitetura: o gatilho é
  puramente um agendamento (`EventBridge Rule`, criado pelo tipo de evento
  `Schedule` do AWS SAM). Isso foi uma escolha deliberada, já que o
  conector gratuito usado na Pluggy (ver seção "Sobre a conta Pluggy
  usada") não oferece webhook — só é possível consultar sob demanda.
- Por não haver endpoint público, a superfície de ataque é mínima: a
  função só é invocável por quem tem credenciais AWS válidas na conta, ou
  pelo próprio agendamento.

## Sobre a conta Pluggy usada

A API "padrão" da Pluggy é paga (a partir de R$2.500/mês) e o free tier
principal é só um trial de 15 dias em produção — inviável para uso
pessoal contínuo. Existe, no entanto, um conector gratuito por tempo
indeterminado chamado **Meu Pluggy**, voltado a pessoas físicas acessando
os próprios dados (uso comercial não é permitido). É esse conector que o
projeto usa.

Fluxo de acesso (feito uma única vez, na configuração inicial):
1. Criar conta e conectar as contas bancárias em [meu.pluggy.ai](https://meu.pluggy.ai).
2. No [Dashboard de desenvolvedor da Pluggy](https://dashboard.pluggy.ai),
   abrir a aplicação "Demo" (já existe por padrão em contas novas) e, ao
   clicar em "Conectar Conta", buscar pelo conector **"Meu Pluggy"** (não
   pelo nome do banco) — isso vincula o consentimento já dado no passo 1
   como proxy, sem exigir aprovação de produção.
3. As credenciais de API (Client ID/Secret) e os IDs dos itens conectados
   ficam disponíveis nesse mesmo Dashboard, dentro do app "Demo".

Mais detalhes em [meu.pluggy.ai/api-guide](https://meu.pluggy.ai/api-guide).

## Decisões de design (o porquê por trás do código)

Alguns comportamentos do código não são óbvios à primeira vista — cada um
existe por um motivo concreto, descoberto testando com dados reais:

- **Só transações `DEBIT` contam como gasto.** A API devolve tanto dinheiro
  saindo (`DEBIT`) quanto entrando (`CREDIT` — Pix recebido, salário,
  reembolso). Só o primeiro tipo é um gasto de verdade.
- **Compras parceladas viram 1 linha, não N.** A Pluggy representa cada
  parcela de uma compra parcelada como uma transação separada — inclusive
  parcelas futuras, ainda não cobradas, com `status: PENDING`. O código
  agrupa todas as parcelas de uma mesma compra (mesma descrição, data da
  compra, valor total e número de parcelas) numa única página no Notion,
  com a propriedade de data representando um intervalo (1ª parcela → última
  parcela) — replicando como a base já era preenchida manualmente.
- **Só registra compra parcelada na parcela 1.** Sem esse filtro, qualquer
  parcelamento em andamento (mesmo um iniciado meses atrás) reaparece toda
  execução, porque sempre tem alguma parcela futura dentro da janela de
  busca. Registrar só quando a 1ª parcela aparece garante que cada compra
  entra exatamente uma vez, no momento em que é feita.
- **Deduplicação por chave própria, não pelo ID da transação.** Como várias
  transações (parcelas) viram 1 registro só, a chave de deduplicação
  salva no Notion (propriedade `Pluggy Transaction ID`) é uma combinação
  determinística de conta + descrição + data da compra + valor + número de
  parcelas — não o ID bruto de uma parcela individual.
- **Cálculo de "hoje" ajustado para o fuso do Brasil.** A Lambda roda em
  UTC. Sem ajuste, próximo da meia-noite UTC o cálculo de "hoje" já seria
  amanhã no horário do Brasil (UTC-3), excluindo gastos do dia. O código
  desloca o relógio em 3h antes de calcular a janela de busca.
- **Janela de busca (`LOOKBACK_DAYS`) maior que zero.** Mesmo com o ajuste
  de fuso, bancos por vezes registram a data de uma transação com atraso de
  liquidação (ex.: gasto de hoje aparece datado de ontem). Um valor de 1–2
  dias evita perder gastos por causa disso; a deduplicação garante que não
  duplica nada mesmo revisitando dias já processados.
- **API do Notion usa "data sources", não mais "database" direto.** A partir
  da versão `2025-09-03` da API do Notion, um database é um contêiner que
  pode ter múltiplos "data sources" — toda leitura/escrita aponta para o
  data source, não mais direto para o database. O código busca o data
  source automaticamente a partir do ID do database (`databases.retrieve`).

## Configuração inicial

### 1. Conectar as contas no Meu Pluggy

Siga o fluxo descrito em "Sobre a conta Pluggy usada" acima. Ao final,
você terá, para cada conta conectada: um **item ID**, e vai anotar também
o nome do banco e (se aplicável) se é uma conta PF ou PJ.

Monte a variável `PLUGGY_ITEMS` no formato `itemId:Banco:Cartao`
(a parte `:Cartao` é opcional, útil para distinguir contas PF/PJ do mesmo
banco):

```
itemIdBanco1:Nubank:CPF,itemIdBanco2:Nubank:CNPJ,itemIdBanco3:Itau:CPF
```

### 2. Preparar o database no Notion

Este projeto foi desenhado para reaproveitar um database de controle de
gastos já existente, com as propriedades: `Atividades` (title), `Categoria`
(multi_select), `Valor de parcela` (number), `Pago` (checkbox), `Tipo de
despesa` (select), `Forma de pagamento` (rich text), `Data de pagamento`
(date), `Cartão` (select), `Valor total` (formula/rollup — a automação
nunca escreve nele) e `Pagar para` (select).

Mapeamento usado pela automação:

| Propriedade | Preenchido com |
|---|---|
| `Atividades` | descrição da transação/compra |
| `Categoria` | categoria da Pluggy (quando disponível) |
| `Valor de parcela` | valor de cada parcela (ou valor único, se não for parcelado) |
| `Pago` | sempre marcado — só registramos o que a Pluggy já confirmou (status `POSTED`) |
| `Forma de pagamento` | `Mensal em Nx` (parcelado) ou o tipo de transferência (PIX/TED/DOC) ou `Debito` |
| `Data de pagamento` | 1ª parcela → última parcela (ou data única, se não for parcelado) |
| `Cartão` | `CPF` ou `CNPJ`, conforme configurado em `PLUGGY_ITEMS` |
| `Pagar para` | nome do banco |
| `Pluggy Transaction ID` | chave interna de deduplicação |

Se estiver montando do zero, crie essas propriedades com os tipos acima. Se
já tem um database parecido, confira se os **tipos** batem exatamente (a
API do Notion rejeita a escrita se o tipo declarado for diferente do que
existe de fato — foi a causa da maioria dos erros durante o
desenvolvimento).

Passos:
1. Crie uma integração interna em
   [notion.so/my-integrations](https://www.notion.so/my-integrations) e
   copie o **Internal Integration Secret** (`NOTION_TOKEN`).
2. Adicione ao database a propriedade `Pluggy Transaction ID` (tipo Text),
   caso ainda não exista.
3. Compartilhe o database com a integração ("..." → "Add connections").
4. Copie o **database ID** (trecho da URL do database) → `NOTION_DATABASE_ID`.

### 3. Preparar a AWS

```bash
aws configure         # credenciais de um usuario IAM (nunca do root)
brew install aws-sam-cli aws-cli
```

Recomendado: ativar MFA no usuário root, criar um usuário IAM específico
para uso via CLI, e configurar um "zero spend budget" em
[Billing → Budgets](https://console.aws.amazon.com/billing/home#/budgets)
como rede de segurança.

### 4. Instalar dependências e testar localmente

```bash
npm install
cp env.json.example env.json    # preencha com as credenciais reais
sam build
sam local invoke ExpenseSyncFunction --event events/sample-schedule.json --env-vars env.json
```

Dica: defina `"DRY_RUN": "true"` no `env.json` para rodar toda a lógica
(inclusive a busca na Pluggy) sem escrever nada no Notion — útil para
inspecionar o que seria criado antes de aplicar de verdade.

`env.json` está no `.gitignore` — nunca commitar segredos reais.

### 5. Deploy

```bash
sam deploy --guided
```

Na primeira execução, o SAM pergunta o nome do stack, a região, e os
parâmetros do `template.yaml` (credenciais da Pluggy, items, token do
Notion, database ID, janela de dias). Os parâmetros marcados como
`NoEcho: true` (segredos) não ficam salvos em nenhum arquivo de
configuração — só viram variáveis de ambiente da Lambda, criptografadas em
repouso pela AWS. O restante (IDs não sensíveis) fica salvo em
`samconfig.toml`, que também está no `.gitignore` por conter identificadores
pessoais.

Deploys seguintes, depois da configuração inicial, são só `sam deploy`.

### 6. Confirmar que está rodando

```bash
aws events describe-rule --name gastos-notion-daily-sync
aws lambda invoke --function-name <FunctionName do output do deploy> /tmp/out.json && cat /tmp/out.json
```

## Operação do dia a dia

- **Ver os logs de uma execução**: CloudWatch Logs, no log group da função
  (`/aws/lambda/<FunctionName>`), ou `aws lambda invoke` com
  `--log-type Tail`.
- **Mudar a frequência**: editar `Schedule: rate(1 day)` em `template.yaml`
  (ex.: `rate(12 hours)`) e rodar `sam build && sam deploy`.
- **Ajustar a janela de busca**: parâmetro `LookbackDays` (mesmo processo).
- **Conectar uma conta nova**: repetir o fluxo do Meu Pluggy, atualizar
  `PluggyItems` e rodar `sam deploy` de novo com o novo valor.
- **Nenhuma dessas mudanças é automática** — sempre exigem rodar o deploy
  de novo.

## Segurança

O código passou por revisão manual completa e por um scan automatizado com
o [gitleaks](https://github.com/gitleaks/gitleaks) antes de qualquer
publicação. Pontos relevantes:
- Nenhuma credencial fica hardcoded no código-fonte ou no `template.yaml`
  — tudo passa por parâmetros `NoEcho` do CloudFormation.
- A Lambda usa a role de execução mínima gerada pelo próprio SAM (só
  permissão de log no CloudWatch) — nenhuma policy adicional é concedida.
- `env.json` e `samconfig.toml` (únicos arquivos locais com dados reais)
  estão no `.gitignore`.

## Links de referência

**Pluggy / Open Finance**
- [Meu Pluggy](https://meu.pluggy.ai) — portal pessoal de conexão das contas
- [Guia de acesso via API do Meu Pluggy](https://meu.pluggy.ai/api-guide)
- [Dashboard de desenvolvedor da Pluggy](https://dashboard.pluggy.ai)
- [Documentação da API da Pluggy](https://docs.pluggy.ai)
- [Planos e preços da Pluggy](https://www.pluggy.ai/precos)
- [SDK oficial Node.js da Pluggy](https://github.com/pluggyai/pluggy-node) (pacote npm `pluggy-sdk`)

**Notion**
- [Criar integração interna](https://www.notion.so/my-integrations)
- [SDK oficial JavaScript do Notion](https://github.com/makenotion/notion-sdk-js) (pacote npm `@notionhq/client`)
- [Guia de upgrade da API — versão 2025-09-03 (data sources)](https://developers.notion.com/docs/upgrade-guide-2025-09-03)

**AWS**
- [Console AWS — IAM](https://console.aws.amazon.com/iam/home)
- [Console AWS — Billing / Budgets](https://console.aws.amazon.com/billing/home#/budgets)
- [AWS SAM CLI — documentação](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html)

**Segurança**
- [gitleaks](https://github.com/gitleaks/gitleaks) — scanner de segredos usado antes da publicação
