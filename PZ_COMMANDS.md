# Comandos Project Zomboid

O bot registra os comandos pelo sistema oficial de slash commands do Discord. Com `GUILD_ID` preenchido, eles aparecem imediatamente naquela guild; sem `GUILD_ID`, o registro e global e pode demorar para propagar.

## Configuracao na VM

1. Crie o arquivo de mapas sem versionar as coordenadas particulares do servidor:

```bash
cd /root/Manguadu
cp config/pz-maps.example.json config/pz-maps.json
nano config/pz-maps.json
```

2. Configure no `.env`:

```env
# Caminho visto pelo gerenciador de arquivos do Pterodactyl.
PZ_SAVE_ROOT=/Zomboid/Saves/Multiplayer/servertest
PZ_WIPE_BACKUP_WAIT_MS=600000

# Use o caminho local se bot e PZ compartilham arquivos.
ANTICHEAT_CSV_PATH=/root/Zomboid/Lua/PZAntiCheat_pending_alerts.csv

# Use este caminho quando o bot estiver fora do container do PZ.
ANTICHEAT_PTERO_CSV_PATH=/Zomboid/Lua/PZAntiCheat_pending_alerts.csv
```

O bot tenta primeiro `ANTICHEAT_CSV_PATH`; se o arquivo local nao existir, usa `ANTICHEAT_PTERO_CSV_PATH`. A chave Client API do Pterodactyl precisa permitir energia, console, leitura/edicao/exclusao de arquivos e criacao/restauracao de backups.

3. Reinicie e acompanhe o registro:

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
