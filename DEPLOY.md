# Deploy automatico do bot

Este bot pode atualizar a VM sem abrir SSH, mas a VM precisa buscar as mudancas de algum lugar online.
O fluxo recomendado e usar um repositorio Git remoto.

## Fluxo recomendado

1. Edite o bot na sua maquina local.
2. Envie as alteracoes para o repositorio remoto.
3. A VM puxa as alteracoes e reinicia o PM2.

Voce pode fazer o passo 3 de duas formas:

- Manual pelo Discord: `/bot atualizar`
- Automatico por intervalo: habilite `BOT_AUTO_UPDATE_ENABLED=1`

## Variaveis da VM

No `.env` da VM:

```env
PM2_APP_NAME=manguadu
BOT_UPDATE_BRANCH=main
BOT_AUTO_UPDATE_ENABLED=1
BOT_AUTO_UPDATE_INTERVAL_MS=120000
BOT_GITHUB_TOKEN=
AUTOMATION_TIMEZONE=America/Sao_Paulo
AUTOMATION_GRACE_MINUTES=5
```

`BOT_AUTO_UPDATE_INTERVAL_MS` precisa ser pelo menos `60000`.
`AUTOMATION_GRACE_MINUTES` define por quantos minutos depois do horario marcado o bot ainda pode disparar uma automacao.

Como o repositorio e privado, `BOT_GITHUB_TOKEN` deve receber um fine-grained personal access token do GitHub limitado ao repositorio `Manguadu`, com permissao **Contents: Read-only**. O token fica somente no `.env` da VM, nao e colocado na URL do remote e nao aparece nos logs do bot.

## O que o update executa

O script `scripts/update-bot.sh` roda:

```bash
git fetch --prune origin
git pull --ff-only origin "$BOT_UPDATE_BRANCH"
npm ci --omit=dev
node --check index.js
node --check lib/*.js
pm2 restart "$PM2_APP_NAME" --update-env
```

Para proteger a VM, ele aborta se existirem alteracoes locais rastreadas no repositorio da VM.

## Observacoes

- A pasta local do Windows nao e visivel para a VM diretamente.
- O auto-update so detecta mudancas depois que elas chegam ao repositorio remoto.
- `data/automations.json`, `.env`, logs e `node_modules` nao devem ser versionados.
