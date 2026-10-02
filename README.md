# Friendhost - PZ/Bot

Bot Discord em Python para administrar comunidades de **Project Zomboid**, com integrações para o mod FriendHost, RCON e Pterodactyl. O projeto reúne ferramentas para jogadores, atendimento de whitelist, operação do servidor e automações em uma interface de slash commands e mensagens interativas do Discord.

O pacote Python ainda se chama `manguadu` para preservar o comando de inicialização e a estrutura interna do projeto. O nome público do projeto é **Friendhost - PZ/Bot**.

## O que o bot faz

- **Configuração no Discord:** `/config_bot` abre uma interface administrativa por servidor Discord para canais, equipe, categoria de tickets e regras da WL. `/config_api` recebe e testa a chave Gemini por um painel privado. As credenciais de Pterodactyl e RCON continuam na VM.
- **Tickets e whitelist:** cria canais privados, coleta personagem, senha opcional e lore, permite revisão manual ou triagem automática e executa `adduser` via RCON. Senhas ausentes são geradas pelo bot. Aprovações e reprovações, com motivos, são publicadas no canal de decisões configurado; o resultado não é enviado ao chat do jogo. Credenciais são entregues por DM ou no ticket privado.
- **Controle RP por voz:** `/config_kick_automatico` exige uma call Discord configurada para jogadores online. A cada 10 segundos, compara `/players` do PZ com os vínculos de contas; quem ficar fora da call por 60 segundos recebe kick com motivo e registro no canal administrativo.
- **Validação de lore:** com Gemini configurado, avalia coerência narrativa, cronologia e contradições, produzindo resumo e evidências para a equipe. Sem chave, usa a triagem lexical local. Textos longos podem ser importados em `.txt` até 9.999.999 caracteres; ficam comprimidos no SQLite e apenas trechos limitados são enviados ao modelo.
- **Administração PZ:** consulta jogadores, ficha, skills, traits, safehouses, arquivos e logs; oferece operações administrativas, RCON, controle do servidor, backups e ferramentas de wipe com verificações de segurança.
- **FriendHost e anticheat:** lê arquivos de dados do mod, produz status e rankings, acompanha evoluções e mortes, espelha eventos de chat/login/logout e encaminha alertas do PZAntiCheat.
- **Painéis e rotinas:** monta painéis de status e ranking, relaciona nomes PZ a membros Discord, personaliza imagens/temas e agenda tarefas de servidor.
- **Operação e atualização:** descobre caminhos PZ quando possível e atualiza o checkout Python pelo comando `/bot atualizar` ou pelo agendador opcional.

## Requisitos

- Python 3.11 ou superior.
- Uma aplicação de bot criada no [Discord Developer Portal](https://discord.com/developers/applications), com `DISCORD_TOKEN`.
- Pterodactyl e RCON para os recursos correspondentes; ambos são configurados no `.env` da VM.
- PM2 é opcional e serve somente para manter o processo Python ativo e reiniciá-lo.
- `ffmpeg` é opcional e serve para gerar thumbnails de vídeos usados nos painéis.

## Instalação local

```bash
git clone --branch migration/python-runtime https://github.com/gamerplay20p5-dotcom/Manguadu.git Friendhost-PZ-Bot
cd Friendhost-PZ-Bot
python -m venv .venv
# Linux/macOS:
. .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e '.[dev]'
```

Copie `.env.example` para `.env` e preencha o token do Discord e as credenciais de infraestrutura que for usar. Não versione `.env`. Depois, teste e inicie:

```bash
python -m compileall -q manguadu scripts/update_bot.py
python -m pytest -q tests_py
python -m manguadu             # diagnóstico local sem conectar ao Discord
python -m manguadu --probe     # consulta Pterodactyl
python -m manguadu --bot       # inicia o bot Discord
```

## Primeira configuração no Discord

1. Convide o bot com permissões para ver canais, enviar mensagens, anexar arquivos no canal de auditoria, gerenciar canais e usar comandos de aplicação. Habilite os intents necessários no Developer Portal se a configuração do aplicativo exigir.
2. Execute `/config_bot` como administrador e escolha canais, categoria de tickets, cargo da equipe e opções da WL.
3. Em **Config WL**, escolha o servidor, defina se a lore é obrigatória e selecione revisão manual ou automática. Para lore acima de 4.000 caracteres, use `/config_lore` com um arquivo `.txt` UTF-8 em um canal privado da equipe.
4. Use `/config_api`, abra o Google AI Studio pelo botão do painel, crie uma chave, cole-a no modal privado e teste a conexão. A camada gratuita pode usar prompts para melhorar produtos Google; o painel informa isso antes da configuração.
5. Configure no `.env` da VM `PTERO_URL`, `PTERO_SERVER_ID`, `PTERO_API_KEY` e os dados de RCON. Esses segredos de infraestrutura não são gravados pela UI do Discord.
6. Vincule nomes PZ aos membros Discord com `/painel jogadores vincular`, abra `/config_kick_automatico`, escolha a call e ative a fiscalização. O bot exige RCON válido e vínculos para os jogadores que já estiverem online antes de ativar.
7. Consulte [PZ_COMMANDS.md](PZ_COMMANDS.md) para os comandos e fluxos do servidor e [DEPLOY.md](DEPLOY.md) para o processo de produção.

### Canais da WL

- **Canal de decisões:** recebe aprovações e reprovações, incluindo o motivo. Esse aviso fica no Discord, fora do chat dentro do Project Zomboid.
- **Canal de auditoria:** recebe a lore analisada e o resumo da triagem; toda WL aprovada também anexa a lore completa em `.txt`. Administradores podem recuperar a lore mais recente de um usuário PZ com `/wl puxar_lore jogador:<nome PZ>`.
- **Ticket privado:** mantém a conversa entre quem abriu o pedido e a equipe autorizada. A senha gerada ou informada é entregue por DM; se a DM estiver fechada, o bot usa o canal privado.

## Configuração e dados

`/config_bot` guarda no SQLite IDs de canais, categoria, cargo e regras de WL por servidor Discord. O arquivo local `data/bot-config.sqlite3` deve ser preservado entre atualizações. A chave Gemini fica cifrada nesse banco; preserve também `data/bot-config.sqlite3.key` para que o bot possa decifrá-la após reiniciar ou restaurar backup.

Credenciais do Discord, Pterodactyl, RCON e uma eventual chave privada do GitHub vivem apenas no `.env` da VM. A chave Gemini é cadastrada pela UI e cifrada localmente. `BOT_GITHUB_TOKEN` pode ficar vazio para repositório público. Para instalação, veja [`.env.example`](.env.example); os arquivos de servidor e mapa têm exemplos em `config/`.

Para instalar em vários servidores PZ, copie `config/servers.example.json` para `config/servers.json` e preencha os identificadores e nomes das variáveis de ambiente. Não coloque os valores dos segredos diretamente nesse JSON.

## Atualização automática

O atualizador Python executa `git fetch`, `git pull --ff-only`, instala o projeto e compila os módulos antes de reiniciar o processo configurado em `PM2_APP_NAME`. Ele cancela a operação se encontrar alterações rastreadas locais. Para habilitar as verificações periódicas, configure `BOT_AUTO_UPDATE_ENABLED=1`; para uma atualização manual, use `/bot atualizar`.

Durante os testes desta branch, mantenha `BOT_UPDATE_BRANCH=migration/python-runtime`. Depois que a branch for integrada, altere para `main`. Um token GitHub só é necessário se o repositório for privado.

## Estrutura

| Caminho | Responsabilidade |
| --- | --- |
| `manguadu/discord_bot.py` | Cliente Discord, comandos, views, tickets e integração WL |
| `manguadu/config_store.py` | Configuração e estado transacional em SQLite |
| `manguadu/server_registry.py`, `pterodactyl.py`, `rcon.py` | Cadastro, painel de hospedagem e console do jogo |
| `manguadu/pz_data.py`, `player_data.py`, `player_reports.py` | Leitura de arquivos FriendHost e relatórios de jogador |
| `manguadu/pz_map_renderer.py`, `pz_wipe.py`, `pz_path_discovery.py` | Mapas, wipes e descoberta de arquivos PZ |
| `manguadu/panel_*.py`, `automation_scheduler.py`, `watchers.py` | Painéis, automações e monitoramento |
| `manguadu/bot_updater.py`, `scripts/update_bot.py` | Atualizador Python usado na VM |
| `tests_py/` | Testes automatizados, sem conexão com Discord ou serviços externos |

Este repositório executa o bot em Python. A dependência Discord é `discord.py`; não há runtime Node/npm no projeto. Veja [PYTHON_MIGRATION.md](PYTHON_MIGRATION.md) para o registro técnico da migração.

## Licença e contribuição

Consulte a licença do repositório antes de redistribuir. Alterações podem ser validadas com `python -m pytest -q tests_py` e `python -m compileall -q manguadu scripts/update_bot.py`.
