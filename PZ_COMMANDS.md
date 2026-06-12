# Comandos Project Zomboid

O bot registra os comandos pelo sistema oficial de slash commands do Discord. Com `GUILD_ID` preenchido, eles aparecem imediatamente naquela guild; sem `GUILD_ID`, o registro e global e pode demorar para propagar.

## Configuracao na VM

1. Crie o arquivo de mapas sem versionar as coordenadas particulares do servidor:

```bash
cd /root/Manguadu
cp config/pz-maps.example.json config/pz-maps.json
nano config/pz-maps.json
```

2. A descoberta dos arquivos de mod e automatica por padrao. Ao iniciar, o bot procura uma pasta `Zomboid/Lua`, reconhece `FriendHost_Data/Jogadores`, `FriendHost_Data/Servidor` e `PZAntiCheat_pending_alerts.csv`, aplica os caminhos imediatamente e completa os campos vazios do `.env`. Se os mods ainda nao tiverem criado os arquivos no primeiro boot, ele salva os caminhos esperados dentro da pasta Lua encontrada e passa a enxergar os CSVs assim que surgirem.

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

3. Configure os caminhos exclusivos do Pterodactyl quando necessario:

```env
# Caminho visto pelo gerenciador de arquivos do Pterodactyl.
PZ_SAVE_ROOT=/Zomboid/Saves/Multiplayer/servertest
PZ_WIPE_BACKUP_WAIT_MS=600000

# Use este caminho quando o bot estiver fora do container do PZ.
ANTICHEAT_PTERO_CSV_PATH=/Zomboid/Lua/PZAntiCheat_pending_alerts.csv
```

O bot tenta primeiro o `ANTICHEAT_CSV_PATH` descoberto ou configurado manualmente; se o arquivo local nao existir, usa `ANTICHEAT_PTERO_CSV_PATH`. A chave Client API do Pterodactyl precisa permitir energia, console, leitura/edicao/exclusao de arquivos e criacao/restauracao de backups.

4. Reinicie e acompanhe o registro:

```bash
pm2 restart manguadu --update-env
pm2 logs manguadu --lines 100
```

## Comandos publicos

- `/online`, `/info`, `/skills`, `/traits` e `/rank`
- `/localizar_veiculo`, `/gps`, `/satelite` e `/mapas`

Os comandos dependem dos CSVs apontados por `CSV_BASE_PATH`. A localizacao de veiculos exige um CSV cujo nome contenha `vehicle` dentro da pasta `Servidor`.

## Administracao

- Wipes: `/wipe_zeds`, `/wipe`, `/wipe_force`, `/wipe_teste`, `/wipe_chunk`, `/wipe_chunk_force` e `/wipe_chunk_teste`
- Safehouses: `/safehouse listar`, `/safehouse listar_bkp_geral`, `/safehouse executar_bkp_geral` e `/safehouse restaurar_bkp_geral`
- Jogadores: `/adduser`, `/removeuserfromwhitelist`, `/banid`, `/kick`, `/kick_all`, `/godmode`, `/invisible`, `/grantadmin`, `/removeadmin`, `/tpto` e `/tp`
- Servidor: `/servermsg` e `/painel restart|stop|recursos`
- Auditoria: `/logs`

Wipes reais exigem servidor offline, confirmacao escrita e um backup completo concluido antes da exclusao. As variantes normais ignoram celulas/chunks que cruzem safehouses; as variantes `force` removem essa protecao. Sempre use o comando de teste antes do wipe real e confirme que `PZ_SAVE_ROOT` aponta exatamente para o save correto.

O backup “geral de safehouses” e propositalmente um backup completo do save. Isso evita restaurar apenas parte dos dados e deixar safehouses, jogadores e mundo fora de sincronia.
