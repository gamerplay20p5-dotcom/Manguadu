# Deploy do Friendhost - PZ/Bot

O bot é executado integralmente em Python. O PM2 atua como supervisor do processo Python; Discord, comandos, tickets, WL, tarefas e atualização ficam no pacote `manguadu`.

## Atualizar uma instalação existente

Faça backup do `.env` e da pasta `data/` antes da troca. O `.env` e o banco `data/bot-config.sqlite3` contêm configuração local que deve ser preservada.

No checkout existente, obtenha e abra a branch de migração:

```bash
git fetch --prune origin
git switch --track origin/migration/python-runtime
```

Se a branch já existir localmente, use `git switch migration/python-runtime`. A URL atual do remote ainda se chama `Manguadu`; se o repositório já tiver sido renomeado no GitHub, use a URL clone exibida na página atual do repositório.

Crie o ambiente e instale o pacote Python:

```bash
cd /caminho/do/Friendhost-PZ-Bot
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e '.[dev]'
```

Mantenha o `.env` existente. Para uma instalação nova, copie `.env.example` para `.env` e preencha `DISCORD_TOKEN`. Mantenha Pterodactyl, RCON e chaves privadas no `.env` da VM. Os canais, categoria, cargo de equipe e regras WL são ajustados pelo `/config_bot` no Discord.

Valide antes de iniciar o processo persistente:

```bash
python -m compileall -q manguadu scripts/update_bot.py
python -m pytest -q tests_py
python -m manguadu
```

## Criar ou substituir o processo PM2

Configure no `.env` da VM:

```env
PM2_APP_NAME=friendhost-pz-bot
BOT_PM2_RUNTIME=python
BOT_UPDATE_BRANCH=migration/python-runtime
```

Se a instalação anterior tiver um processo Node chamado `manguadu`, remova somente esse processo depois de validar a instalação Python. Os arquivos `.env` e `data/` permanecem na pasta:

```bash
pm2 delete manguadu
pm2 start "$PWD/.venv/bin/python" --name friendhost-pz-bot --interpreter none -- -m manguadu --bot
pm2 save
pm2 startup
```

Em uma máquina nova, clone a branch de teste e instale antes de iniciar o PM2:

```bash
git clone --branch migration/python-runtime https://github.com/gamerplay20p5-dotcom/Manguadu.git Friendhost-PZ-Bot
cd Friendhost-PZ-Bot
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[dev]'
cp .env.example .env
nano .env
```

Depois, use o comando `pm2 start` acima. Confira `pm2 logs friendhost-pz-bot` e execute `/bot status` no Discord. Ao iniciar, o bot publica os slash commands Python do aplicativo.

Quando esta branch for integrada em `main`, altere `BOT_UPDATE_BRANCH=main` no `.env` da VM e reinicie o processo.

## Atualizações

Administradores podem executar `/bot atualizar`; o bot também pode consultar atualizações quando `BOT_AUTO_UPDATE_ENABLED=1`. O atualizador faz `git fetch`, aplica `git pull --ff-only`, instala novamente o projeto Python, compila os módulos e reinicia `PM2_APP_NAME`. A operação é cancelada se houver alterações locais rastreadas para não sobrescrever trabalho da VM.

Em repositório público, deixe `BOT_GITHUB_TOKEN` vazio: `git fetch` pode ler o repositório sem autenticação. Se o repositório for privado, use um fine-grained token com acesso somente de leitura ao conteúdo e guarde-o apenas no `.env` da VM.

## Configurar o bot

1. Use `/config_bot` com uma conta administradora.
2. Configure os canais de tickets, lore, auditoria, decisões da WL, status, ranking e anticheat; selecione a categoria e o cargo da equipe.
3. Em **Config WL**, selecione o servidor PZ, defina se a lore será obrigatória, informe a lore base e escolha a revisão manual ou automática.
4. Configure Pterodactyl e RCON no `.env`. A UI Discord não salva essas credenciais.
5. Use `/painel config`, `/painel preview` e `/painel salvar` para montar os painéis públicos.

O canal de decisões recebe aprovações e reprovações com os motivos no Discord, fora do chat do jogo. O canal de auditoria recebe lore e resumos da triagem. A senha da WL é enviada por DM ou pelo ticket privado quando a DM está fechada.

## Preservar entre deploys

- `.env`
- `data/bot-config.sqlite3` e outros estados em `data/`
- `data/automations.json`, temas, mídias e logs
- `config/pz-maps.json` se tiver coordenadas específicas
- `.venv/`

O bot requer Python 3.11 ou superior. `ffmpeg` é opcional para thumbnails de vídeos nos painéis. Veja [README.md](README.md) para visão geral, requisitos e comandos.
