# Friendhost - PZ/Bot: comandos Project Zomboid

Este é o guia operacional do bot Python para administradores da comunidade. A identidade do produto foi atualizada para Friendhost - PZ/Bot; `manguadu` continua como o nome do pacote e módulo Python para inicialização.

Leia [README.md](README.md) para visão geral do projeto e [DEPLOY.md](DEPLOY.md) para instalar o runtime Python.

O runtime completo do bot e Python. Ele oferece `/config_bot`, `/bot`, `/servidor`, `/rcon`,
`/status`, `/statuscomplete`, `/automacao`, tickets, WL com `adduser` e os comandos publicos
`/online`, `/info`, `/skills`, `/traits`, `/rank`, `/localizar_veiculo`,
`/mapas`, `/gps`, `/satelite`, `/logs`, `/safehouse`, `/deletearquivo`, os comandos de whitelist,
administracao/jogador e teleport, e os comandos de wipe. Os painéis, automações,
alertas PZAntiCheat, espelho de logs e tarefas recorrentes também rodam no runtime Python.

O bot registra os comandos pelo sistema oficial de slash commands do Discord. Com `GUILD_ID` preenchido, eles aparecem imediatamente naquela guild; sem `GUILD_ID`, o registro e global e pode demorar para propagar.

## Configuracao na VM

1. Crie o arquivo de mapas sem versionar as coordenadas particulares do servidor:

```bash
cd /caminho/do/bot
cp config/pz-maps.example.json config/pz-maps.json
nano config/pz-maps.json
```

2. A descoberta dos arquivos de mod e automatica por padrao. Ao iniciar, o bot procura uma pasta `Zomboid/Lua`, reconhece inclusive uma `FriendHost_Data` vazia ou parcial, aplica os caminhos imediatamente e completa os campos vazios do `.env`. Se os mods ainda nao tiverem criado os arquivos no primeiro boot, ele salva os caminhos esperados e passa a enxerga-los assim que surgirem.

O FriendHost atual grava dados delimitados por ponto e virgula em `.txt`. O bot prefere esse formato e mantem leitura compativel com os antigos `.csv.txt` e `.csv`. A variavel `CSV_BASE_PATH` conserva o nome antigo apenas para nao quebrar instalacoes existentes.

Os locais verificados incluem `/root`, `/home`, `/home/container`, `/mnt/server`, `/srv` e volumes em `/var/lib/pterodactyl/volumes`. O log de inicializacao mostra `Descoberta PZ` quando encontra os arquivos.

Configuracao automatica padrao:

```env
PZ_AUTO_DISCOVER_PATHS=1
PZ_LUA_PATH=
PZ_PATH_SCAN_ROOTS=
CSV_BASE_PATH=
LOGS_PATH=
ANTICHEAT_CSV_PATH=
```

Qualquer campo preenchido manualmente tem prioridade e nunca e substituido. Se houver mais de uma instalacao PZ na VM, selecione apenas a pasta correta; os demais caminhos continuam automaticos:

```env
PZ_LUA_PATH=/root/Zomboid/Lua
```

Para procurar em uma raiz personalizada ou desativar completamente a descoberta:

```env
PZ_PATH_SCAN_ROOTS=/caminho/um,/caminho/dois
PZ_AUTO_DISCOVER_PATHS=0
```

3. Com `PTERO_URL`, `PTERO_SERVER_ID` e `PTERO_API_KEY` configurados, o bot tambem procura automaticamente o save pela API do painel. Ele reconhece o diretorio correto por arquivos como `players.db`, `map_meta.bin`, `map_*.bin` e `zpop_*.bin`, preenchendo `PZ_SAVE_ROOT` no `.env`. O caminho do CSV do anticheat dentro do painel tambem e descoberto.

Assim, normalmente estes campos ficam vazios:

```env
PZ_SAVE_ROOT=
PZ_WIPE_BACKUP_WAIT_MS=600000
ANTICHEAT_PTERO_CSV_PATH=
```

Os campos continuam aceitando configuracao manual, que sempre tem prioridade. Se o painel possuir mais de um save com a mesma pontuacao, o bot nao escolhe sozinho para evitar wipe no mundo errado. A chave Client API do Pterodactyl precisa permitir energia, console, leitura/edicao/exclusao de arquivos e criacao/restauracao de backups.

4. Reinicie e acompanhe o registro:

```bash
pm2 restart friendhost-pz-bot --update-env
pm2 logs friendhost-pz-bot --lines 100
```

## Comandos publicos

- `/online`, `/info`, `/skills`, `/traits` e `/rank`
- `/localizar_veiculo`, `/gps`, `/satelite` e `/mapas`

Os comandos dependem dos arquivos FriendHost apontados por `CSV_BASE_PATH`. A localizacao de veiculos aceita `.txt`, `.csv.txt` ou `.csv` cujo nome contenha `vehicle` dentro da pasta `Servidor`.

## Painéis e automações

- `/painel config` edita banner, thumbnail, cores, título, descrição e imagem do ranking; `/painel preview` mostra o rascunho e `/painel salvar` aplica o tema.
- `/painel jogadores vincular|desvincular` relaciona o nick PZ a uma conta Discord.
- `/painel restart|stop|recursos` controla o servidor e exibe recursos.
- `/automacao criar|listar|remover|pausar|retomar|executar|backupagora` gerencia rotinas diárias ou por dia da semana.
- `/config_bot` permite escolher os canais de status, ranking, evolução e anticheat. As mensagens de status e ranking são atualizadas a cada 60 segundos.

As rotinas monitoram aumentos de skills, novas mortes FriendHost e os logs de chat/login/logout. Alertas PZAntiCheat são agrupados e encaminhados ao canal configurado. `WEBHOOK_CHAT` continua opcional para espelhar as mensagens do jogo.

## Fiscalização RP por call de voz

1. Em **Config WL**, selecione o servidor PZ que a fiscalização deverá consultar. O comando usa o RCON configurado para esse servidor.
2. Para cada conta, vincule o usuário PZ ao membro correto do Discord com `/painel jogadores vincular` usando o nome de login exato do PZ.
3. Como administrador, execute `/config_kick_automatico`, selecione a call obrigatória e pressione **Ativar / pausar fiscalização**. Antes de ativar, o bot valida RCON, `/players` e os vínculos dos jogadores que já estão online.

Enquanto ativo, o bot consulta `/players` a cada 10 segundos. Se uma conta PZ vinculada ficar fora da call selecionada por 60 segundos, o bot executa `kickuser` com o motivo `É necessário estar na call [nome da call] para poder permanecer no servidor.` e registra o kick no canal administrativo configurado. Jogadores novos também precisam estar vinculados antes de entrar; sem vínculo, são considerados fora da call. Pause a fiscalização no mesmo painel para interrompê-la.

Se RCON estiver indisponível, a resposta de `/players` estiver incompleta ou a call configurada não puder ser encontrada, o ciclo não aplica kicks e o bot reinicia a contagem de tolerância. A resposta `/players` precisa incluir a lista de nomes; uma contagem sem nomes não é suficiente para autorizar expulsões.

## Tickets, WL e Gemini

- `/config_bot` abre a configuração de tickets e da WL. Escolha a categoria e o canal do painel de tickets, depois publique o painel pela interface.
- Em **Config WL**, defina a lore obrigatória, os canais de auditoria e decisões e o modo manual ou automático. Aprovações e reprovações, com seus motivos, vão para o canal de decisões do Discord; nada é enviado ao chat do Project Zomboid.
- `/config_lore` importa a lore oficial por arquivo `.txt` UTF-8 em um canal privado da equipe. O limite do bot é 9.999.999 caracteres e o arquivo é comprimido no SQLite. O Discord limita cada campo de modal a 4.000 caracteres; textos maiores precisam ser anexados como arquivo.
- `/config_api` abre o painel privado da chave Gemini: crie uma chave no Google AI Studio pelo botão, configure-a no modal e selecione **Testar conexão**. A chave é cifrada no banco local `data/bot-config.sqlite3`; preserve também `data/bot-config.sqlite3.key` nos backups.
- Dentro do ticket, o jogador pode usar **Criar personagem / WL** para a história curta ou anexar um `.txt` e executar `/wl lore` para a história longa. O bot então coleta usuário PZ, personagem e senha opcional em um formulário privado; se não houver senha, gera uma.
- O Gemini faz a análise narrativa da WL e registra resumo, coerências, contradições e confiança no canal de auditoria. Senha, usuário PZ e ID Discord não são enviados ao modelo. Quando faltar evidência ou o Gemini falhar, o pedido segue para revisão humana; a cota gratuita pode impor limites temporários.

## Administracao

- Wipes: `/wipe_zeds`, `/wipe`, `/wipe_force`, `/wipe_teste`, `/wipe_chunk`, `/wipe_chunk_force` e `/wipe_chunk_teste`
- Safehouses: `/safehouse listar`, `/safehouse listar_bkp_geral`, `/safehouse executar_bkp_geral` e `/safehouse restaurar_bkp_geral`
- Jogadores: `/adduser`, `/removeuserfromwhitelist`, `/banid`, `/kick`, `/kick_all`, `/godmode`, `/invisible`, `/grantadmin`, `/removeadmin`, `/tpto` e `/tp`
- Servidor: `/servermsg` e `/painel restart|stop|recursos`
- Auditoria: `/logs`

Wipes reais exigem servidor offline, confirmacao escrita e um backup completo concluido antes da exclusao. As variantes normais ignoram celulas/chunks que cruzem safehouses; as variantes `force` removem essa protecao. Sempre use o comando de teste antes do wipe real e confirme que `PZ_SAVE_ROOT` aponta exatamente para o save correto.

O backup “geral de safehouses” e propositalmente um backup completo do save. Isso evita restaurar apenas parte dos dados e deixar safehouses, jogadores e mundo fora de sincronia.

## Personalizacao dos paineis

Use `/painel config` para montar um rascunho de banner, thumbnail, cores, titulo, descricao e fundo do ranking. `/painel preview` mostra o resultado sem alterar os canais publicos; `/painel salvar` aplica o tema e edita as mensagens existentes.

Imagens e GIFs enviados sao guardados em `data/panel-media`. Links externos e links do YouTube tambem sao aceitos. Para converter videos enviados ou URLs diretas de video em thumbnail, instale `ffmpeg` na VM:

```bash
apt update
apt install -y ffmpeg
```

Digite `remover` no campo URL de uma configuracao de midia para limpa-la. Vinculos entre nick PZ e membro Discord podem ser gerenciados por `/painel jogadores vincular` e `/painel jogadores desvincular`.

O IP e o limite de slots exibidos no painel sao opcionais:

```env
SERVER_CONNECT_ADDRESS=connect.seuservidor.com:16261
SERVER_MAX_SLOTS=32
```
