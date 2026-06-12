require('dotenv').config({ quiet: true });

const { Client, GatewayIntentBits, MessageFlags, PermissionFlagsBits, REST, Routes, SlashCommandBuilder, WebhookClient } = require('discord.js');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');

const {
  cleanText,
  collectFilesRecursively,
  delay,
  escapeCodeBlock,
  fileExists,
  joinLinesLimited,
  logError,
  logInfo,
  logWarn,
  readCsvRawRows,
  readCsvRows,
  readLatestCsvRow,
  toNumber,
  truncate,
} = require('./lib/utils');
const {
  collectPlayerSnapshot,
  getPerkVisualLabel,
  getPlayerFileSet,
  perkDictionary,
} = require('./lib/player-data');
const {
  buildPlayersListMessage,
  buildRankingEmbed,
  buildServerStatusEmbed,
  buildStatusCompleteAttachment,
  buildStatusCompleteEmbed,
  buildStatusEmbed,
} = require('./lib/reports');
const {
  buildServerOverview,
  extractPteroError,
  manageServer,
  runServerConsoleCommand,
} = require('./lib/server-integrations');
const {
  createAutomation,
  formatAutomationLine,
  formatAutomationsList,
  getAutomationRuntimeStatus,
  getAutomationTimezone,
  removeAutomation,
  runAutomationNow,
  runBackupNow,
  setAutomationEnabled,
  startAutomationLoop,
} = require('./lib/automation-scheduler');
const {
  getBotUpdateStatus,
  readLastUpdateLog,
  runBotUpdate,
  scheduleBotRestart,
  startBotAutoUpdateLoop,
} = require('./lib/bot-updater');
const { startAntiCheatAlertLoop } = require('./lib/anticheat-alerts');
const { handlePzCommand, pzCommandNames, pzSlashCommandBuilders } = require('./lib/pz-commands');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const state = {
  perksCache: new Map(),
  totalDeathsCache: 0,
  activeLogFiles: {
    chat: null,
    user: null,
  },
  fileOffsets: new Map(),
  fileRemainders: new Map(),
};

function getCsvBasePath() {
  return cleanText(process.env.CSV_BASE_PATH);
}

function getLocalPlayersBasePath() {
  const basePath = getCsvBasePath();
  return basePath ? path.join(basePath, 'Jogadores') : '';
}

function getLocalServerBasePath() {
  const basePath = getCsvBasePath();
  return basePath ? path.join(basePath, 'Servidor') : '';
}

function getSafePlayerNames() {
  try {
    const playersBasePath = getLocalPlayersBasePath();
    if (!playersBasePath || !fs.existsSync(playersBasePath)) {
      return [];
    }

    return fs
      .readdirSync(playersBasePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => cleanText(entry.name))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, 'pt-BR'));
  } catch (error) {
    logError('Leitura da lista de jogadores', error);
    return [];
  }
}

function getInteractionNickOption(interaction) {
  return cleanText(interaction.options.getString('nick'));
}

async function fetchTextChannel(channelId) {
  const normalizedChannelId = cleanText(channelId);
  if (!normalizedChannelId) {
    return null;
  }

  try {
    return client.channels.cache.get(normalizedChannelId) || (await client.channels.fetch(normalizedChannelId));
  } catch (error) {
    logError(`Falha ao buscar canal ${normalizedChannelId}`, error);
    return null;
  }
}

async function upsertSingleBotMessage(channel, payload) {
  const fetched = await channel.messages.fetch({ limit: 20 });
  const botMessage = fetched.find((message) => message.author.id === client.user.id);
  const now = Date.now();
  const maxAge = 14 * 24 * 60 * 60 * 1000;

  if (botMessage) {
    await botMessage.edit(payload);
  } else {
    await channel.send(payload);
  }

  const toDelete = fetched.filter((message) => !botMessage || message.id !== botMessage.id);
  const recent = toDelete.filter((message) => now - message.createdTimestamp < maxAge);
  const old = toDelete.filter((message) => now - message.createdTimestamp >= maxAge);

  if (recent.size > 0) {
    await channel.bulkDelete(recent, true).catch(() => {});
  }

  for (const message of old.values()) {
    await message.delete().catch(() => {});
  }
}

function loadAllPlayerRows() {
  const playersBasePath = getLocalPlayersBasePath();
  if (!playersBasePath) {
    return [];
  }

  return getSafePlayerNames()
    .map((nick) => readLatestCsvRow(path.join(playersBasePath, nick, `player_${nick}.csv`)))
    .filter(Boolean);
}

async function refreshStatsPanel() {
  const channel = await fetchTextChannel(process.env.ID_CANAL_STATS);
  if (!channel) {
    return;
  }

  const overview = await buildServerOverview();
  const embed = buildServerStatusEmbed(overview, 'Atualizado automaticamente a cada 60 segundos');
  await upsertSingleBotMessage(channel, { embeds: [embed] });
}

async function refreshRankingPanel() {
  const channel = await fetchTextChannel(process.env.ID_CANAL_RANKING);
  if (!channel) {
    return;
  }

  const playerRows = loadAllPlayerRows();
  const serverBasePath = getLocalServerBasePath();
  const factionRows = serverBasePath ? readCsvRows(path.join(serverBasePath, 'factions.csv')) : [];
  const embed = buildRankingEmbed(playerRows, factionRows);
  await upsertSingleBotMessage(channel, { embeds: [embed] });
}

function refreshInMemoryCaches() {
  state.perksCache.clear();
  const playersBasePath = getLocalPlayersBasePath();
  const serverBasePath = getLocalServerBasePath();

  if (playersBasePath) {
    for (const nick of getSafePlayerNames()) {
      const perksFile = path.join(playersBasePath, nick, `playerperks_${nick}.csv`);
      const latestPerks = readLatestCsvRow(perksFile);
      if (latestPerks) {
        state.perksCache.set(nick, latestPerks);
      }
    }
  }

  state.totalDeathsCache = serverBasePath ? readCsvRawRows(path.join(serverBasePath, 'deaths.csv')).length : 0;
}

async function sendEvolutionMessage(content) {
  const channel = await fetchTextChannel(process.env.ID_CANAL_EVOLUCAO);
  if (!channel) {
    return;
  }

  await channel.send(content).catch((error) => logError('Falha ao enviar mensagem de evolucao', error));
}

async function sendAutomationMessage(content) {
  const channel = await fetchTextChannel(process.env.ID_CANAL_ADMIN);
  if (!channel) {
    return;
  }

  await channel.send(content).catch((error) => logError('Falha ao enviar mensagem de automacao', error));
}

async function processPerksSnapshot(nick, latestRow) {
  if (!latestRow) {
    return;
  }

  const previousRow = state.perksCache.get(nick);

  if (previousRow) {
    const ignoredKeys = new Set(['systemdate', 'systemtime', 'gametime', 'steamid', 'username', 'charname']);

    for (const [key, value] of Object.entries(latestRow)) {
      if (ignoredKeys.has(key)) {
        continue;
      }

      const oldLevel = toNumber(previousRow[key]);
      const newLevel = toNumber(value);

      if (newLevel > oldLevel) {
        const label = getPerkVisualLabel(key) || perkDictionary[key] || key;
        await sendEvolutionMessage(`📈 **LEVEL UP**\n🧍 **${nick}** evoluiu **${label}** para o nivel **${newLevel}**.`);
      }
    }
  }

  state.perksCache.set(nick, latestRow);
}

async function handlePerksFileChange(filePath) {
  const nick = path.basename(filePath).replace('playerperks_', '').replace('.csv', '');
  const rows = readCsvRows(filePath);
  if (rows.length === 0) {
    return;
  }

  await processPerksSnapshot(nick, rows[rows.length - 1]);
}

function extractNickFromDeathRow(row) {
  if (!Array.isArray(row) || row.length === 0) {
    return 'Desconhecido';
  }

  const preferredCandidates = [row[4], row[5], row[6]]
    .map((value) => cleanText(value))
    .filter(Boolean);

  for (const candidate of preferredCandidates) {
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(candidate) && !/^\d{2}:\d{2}:\d{2}$/.test(candidate)) {
      return candidate;
    }
  }

  return 'Desconhecido';
}

async function handleDeathsFileChange(filePath) {
  const rows = readCsvRawRows(filePath);
  if (rows.length <= state.totalDeathsCache) {
    state.totalDeathsCache = rows.length;
    return;
  }

  const newRows = rows.slice(state.totalDeathsCache);
  for (const row of newRows) {
    const deadNick = extractNickFromDeathRow(row);
    await sendEvolutionMessage(`💀 **ALERTA DE MORTE**\n🧍 **${deadNick}** morreu no servidor.`);
  }

  state.totalDeathsCache = rows.length;
}

async function scanPerkChanges() {
  const playersBasePath = getLocalPlayersBasePath();
  if (!playersBasePath) {
    return;
  }

  for (const nick of getSafePlayerNames()) {
    const perksFile = path.join(playersBasePath, nick, `playerperks_${nick}.csv`);
    const latestPerks = readLatestCsvRow(perksFile);
    if (latestPerks) {
      await processPerksSnapshot(nick, latestPerks);
    }
  }
}

async function scanDeathChanges() {
  const serverBasePath = getLocalServerBasePath();
  const deathsFile = serverBasePath ? path.join(serverBasePath, 'deaths.csv') : '';
  if (!deathsFile || !fileExists(deathsFile)) {
    state.totalDeathsCache = 0;
    return;
  }

  await handleDeathsFileChange(deathsFile);
}

function findLatestLogFile(logsPath, suffix) {
  if (!fs.existsSync(logsPath)) {
    return null;
  }

  const files = fs
    .readdirSync(logsPath)
    .filter((fileName) => fileName.endsWith(suffix))
    .map((fileName) => {
      const fullPath = path.join(logsPath, fileName);
      return {
        fullPath,
        modifiedAt: fs.statSync(fullPath).mtimeMs,
      };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  return files[0]?.fullPath || null;
}

function initializeFileFollower(filePath) {
  try {
    const size = fs.statSync(filePath).size;
    state.fileOffsets.set(filePath, size);
    state.fileRemainders.set(filePath, '');
  } catch (error) {
    state.fileOffsets.set(filePath, 0);
    state.fileRemainders.set(filePath, '');
  }
}

function readFileChunk(filePath, start, length) {
  return new Promise((resolve, reject) => {
    if (length <= 0) {
      resolve('');
      return;
    }

    const chunks = [];
    const stream = fs.createReadStream(filePath, {
      start,
      end: start + length - 1,
      encoding: 'utf8',
    });

    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(chunks.join('')));
  });
}

async function consumeNewLines(filePath, onLine) {
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    return;
  }

  let previousOffset = state.fileOffsets.get(filePath) || 0;
  if (stat.size < previousOffset) {
    previousOffset = 0;
    state.fileRemainders.set(filePath, '');
  }

  if (stat.size === previousOffset) {
    return;
  }

  const chunk = await readFileChunk(filePath, previousOffset, stat.size - previousOffset);
  state.fileOffsets.set(filePath, stat.size);

  const combined = `${state.fileRemainders.get(filePath) || ''}${chunk}`;
  const lines = combined.split(/\r?\n/);
  const remainder = lines.pop() || '';
  state.fileRemainders.set(filePath, remainder);

  for (const line of lines) {
    const normalized = cleanText(line);
    if (normalized) {
      await onLine(normalized);
    }
  }
}

async function startLogMirrors() {
  const logsPath = cleanText(process.env.LOGS_PATH);
  if (!logsPath || !fs.existsSync(logsPath)) {
    logWarn('LOGS_PATH nao encontrado. Espelho de logs desativado.');
    return;
  }

  let webhookChat = null;
  const webhookChatUrl = cleanText(process.env.WEBHOOK_CHAT);
  if (webhookChatUrl) {
    try {
      webhookChat = new WebhookClient({ url: webhookChatUrl });
    } catch (error) {
      logError('WEBHOOK_CHAT invalido. Espelho de chat desativado', error);
    }
  }

  const latestChatFile = findLatestLogFile(logsPath, '_chat.txt');
  const latestUserFile = findLatestLogFile(logsPath, '_user.txt');

  if (latestChatFile) {
    state.activeLogFiles.chat = latestChatFile;
    initializeFileFollower(latestChatFile);
  }

  if (latestUserFile) {
    state.activeLogFiles.user = latestUserFile;
    initializeFileFollower(latestUserFile);
  }

  const handleChatLine = async (line) => {
    if (!webhookChat) {
      return;
    }

    const match = line.match(/\[Chat\]\s+\[([^\]]+)\]\s+(.+)/i);
    if (!match) {
      return;
    }

    await webhookChat
      .send({
        content: match[2].trim(),
        username: match[1].trim(),
        avatarURL: 'https://i.imgur.com/7HnOMg0.png',
      })
      .catch((error) => logError('Falha no espelho de chat', error));
  };

  const handleUserLine = async (line) => {
    const match = line.match(/"(.*?)"\s+(fully connected|disconnected)/i);
    if (!match) {
      return;
    }

    const nick = cleanText(match[1]);
    const action = cleanText(match[2]).toLowerCase();

    if (action === 'fully connected') {
      await sendEvolutionMessage(`[LOGIN] ${nick} entrou no servidor.`);
    } else if (action === 'disconnected') {
      await sendEvolutionMessage(`[LOGOUT] ${nick} saiu do servidor.`);
    }
  };

  chokidar
    .watch(logsPath, { depth: 0, ignoreInitial: true, awaitWriteFinish: true })
    .on('add', async (filePath) => {
      if (filePath.endsWith('_chat.txt')) {
        state.activeLogFiles.chat = filePath;
        initializeFileFollower(filePath);
      }

      if (filePath.endsWith('_user.txt')) {
        state.activeLogFiles.user = filePath;
        initializeFileFollower(filePath);
      }
    })
    .on('change', async (filePath) => {
      if (filePath === state.activeLogFiles.chat) {
        await consumeNewLines(filePath, handleChatLine);
      }

      if (filePath === state.activeLogFiles.user) {
        await consumeNewLines(filePath, handleUserLine);
      }
    })
    .on('error', (error) => logError('Watcher de logs', error));
}

function startDataWatchers() {
  const playersBasePath = getLocalPlayersBasePath();
  const serverBasePath = getLocalServerBasePath();
  const deathsFile = serverBasePath ? path.join(serverBasePath, 'deaths.csv') : '';

  if (playersBasePath && fs.existsSync(playersBasePath)) {
    chokidar
      .watch(path.join(playersBasePath, '**', 'playerperks_*.csv'), {
        ignoreInitial: true,
        awaitWriteFinish: true,
      })
      .on('add', handlePerksFileChange)
      .on('change', handlePerksFileChange)
      .on('error', (error) => logError('Watcher de perks', error));
  }

  if (deathsFile) {
    chokidar
      .watch(deathsFile, { ignoreInitial: true, awaitWriteFinish: true })
      .on('add', handleDeathsFileChange)
      .on('change', handleDeathsFileChange)
      .on('error', (error) => logError('Watcher de mortes', error));
  }
}

function isRestrictedToAdminChannel(interaction) {
  const adminChannelId = cleanText(process.env.ID_CANAL_ADMIN);
  return !adminChannelId || interaction.channelId === adminChannelId;
}

async function ensureAdminChannel(interaction) {
  if (isRestrictedToAdminChannel(interaction)) {
    return true;
  }

  await interaction.reply({
    content: 'Este comando so pode ser usado no canal administrativo configurado.',
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

function buildDeleteTargets(scope, nickInput) {
  const playersBasePath = getLocalPlayersBasePath();
  const serverBasePath = getLocalServerBasePath();

  if (scope === 'ranking') {
    const files = [];
    for (const nick of getSafePlayerNames()) {
      if (!playersBasePath) {
        break;
      }

      const dir = path.join(playersBasePath, nick);
      files.push(path.join(dir, `player_${nick}.csv`));
      files.push(path.join(dir, `playerperks_${nick}.csv`));
    }

    if (serverBasePath) {
      files.push(path.join(serverBasePath, 'deaths.csv'));
      files.push(path.join(serverBasePath, 'factions.csv'));
      files.push(path.join(serverBasePath, 'safehouses.csv'));
      files.push(path.join(serverBasePath, 'players_online.csv'));
    }

    return files;
  }

  if (scope === 'inventarios') {
    if (!playersBasePath) {
      return [];
    }

    return getSafePlayerNames().map((nick) => path.join(playersBasePath, nick, `playerinventory_${nick}.csv`));
  }

  if (scope === 'jogador') {
    const files = getPlayerFileSet(nickInput);
    if (!files) {
      return null;
    }
    return [files.playerFile, files.perksFile, files.inventoryFile];
  }

  if (scope === 'tudo') {
    const basePath = getCsvBasePath();
    if (!basePath || !fs.existsSync(basePath)) {
      return [];
    }
    return collectFilesRecursively(basePath, (filePath) => /\.csv$/i.test(filePath), 8, [], 2000);
  }

  return [];
}

const slashCommandBuilders = [
  new SlashCommandBuilder()
    .setName('servidor')
    .setDescription('Gerencia energia e status do servidor')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName('acao')
        .setDescription('Acao desejada')
        .setRequired(true)
        .addChoices(
          { name: 'Status', value: 'status' },
          { name: 'Ligar', value: 'start' },
          { name: 'Desligar', value: 'stop' },
          { name: 'Reiniciar', value: 'restart' },
          { name: 'Agendar desligamento (10 min)', value: 'schedule_stop' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('automacao')
    .setDescription('Cria e gerencia automacoes do Pterodactyl pelo bot')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('criar')
        .setDescription('Cria uma automacao diaria ou em dias especificos')
        .addStringOption((option) =>
          option
            .setName('tipo')
            .setDescription('O que o bot deve executar')
            .setRequired(true)
            .addChoices(
              { name: 'Ligar servidor', value: 'start' },
              { name: 'Desligar servidor', value: 'stop' },
              { name: 'Reiniciar servidor', value: 'restart' },
              { name: 'Criar backup', value: 'backup' },
              { name: 'Salvar mundo', value: 'save' },
              { name: 'Comando do console', value: 'command' },
            ),
        )
        .addStringOption((option) => option.setName('horario').setDescription('Horario no formato HH:MM').setRequired(true))
        .addStringOption((option) => option.setName('dias').setDescription('todos, uteis, fds ou numeros: 1=domingo ... 7=sabado').setRequired(false))
        .addIntegerOption((option) =>
          option.setName('manter_backups').setDescription('Backups automaticos para manter').setRequired(false).setMinValue(1).setMaxValue(50),
        )
        .addStringOption((option) => option.setName('comando').setDescription('Obrigatorio se tipo = comando').setRequired(false)),
    )
    .addSubcommand((subcommand) => subcommand.setName('listar').setDescription('Lista as automacoes criadas'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remover')
        .setDescription('Remove uma automacao')
        .addStringOption((option) => option.setName('id').setDescription('ID da automacao').setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('pausar')
        .setDescription('Pausa uma automacao sem apagar')
        .addStringOption((option) => option.setName('id').setDescription('ID da automacao').setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('retomar')
        .setDescription('Reativa uma automacao pausada')
        .addStringOption((option) => option.setName('id').setDescription('ID da automacao').setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('executar')
        .setDescription('Executa uma automacao agora')
        .addStringOption((option) => option.setName('id').setDescription('ID da automacao').setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('backupagora')
        .setDescription('Cria um backup agora e limpa backups automaticos antigos')
        .addIntegerOption((option) =>
          option.setName('manter_backups').setDescription('Backups automaticos para manter').setRequired(false).setMinValue(1).setMaxValue(50),
        ),
    ),
  new SlashCommandBuilder()
    .setName('bot')
    .setDescription('Gerencia manutencao do bot')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('Mostra a configuracao de atualizacao do bot'))
    .addSubcommand((subcommand) => subcommand.setName('atualizar').setDescription('Atualiza o bot pela VM e reinicia o PM2'))
    .addSubcommand((subcommand) => subcommand.setName('logatualizacao').setDescription('Mostra o ultimo log de atualizacao do bot')),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Mostra o perfil resumido de um jogador')
    .setDMPermission(false)
    .addStringOption((option) => option.setName('nick').setDescription('Nick do jogador').setRequired(false).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('statuscomplete')
    .setDescription('Gera a ficha completa do jogador, incluindo inventario e DB')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption((option) => option.setName('nick').setDescription('Nick do jogador').setRequired(false).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('rcon')
    .setDescription('Envia um comando ao servidor usando RCON ou console do painel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption((option) => option.setName('comando').setDescription('Comando do servidor').setRequired(true)),
  new SlashCommandBuilder()
    .setName('deletearquivo')
    .setDescription('Apaga CSVs do FriendHost para forcar a recriacao')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName('alvo')
        .setDescription('Escopo da limpeza')
        .setRequired(true)
        .addChoices(
          { name: 'Ranking geral', value: 'ranking' },
          { name: 'Inventarios', value: 'inventarios' },
          { name: 'Jogador especifico', value: 'jogador' },
          { name: 'Tudo do FriendHost', value: 'tudo' },
        ),
    )
    .addStringOption((option) => option.setName('nick').setDescription('Obrigatorio se alvo = jogador').setRequired(false).setAutocomplete(true)),
  ...pzSlashCommandBuilders,
];

async function registerSlashCommands() {
  const token = cleanText(process.env.DISCORD_TOKEN);
  const clientId = cleanText(process.env.DISCORD_CLIENT_ID);

  if (!token || !clientId) {
    logWarn('DISCORD_TOKEN ou DISCORD_CLIENT_ID ausente. Registro de slash commands ignorado.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const guildId = cleanText(process.env.GUILD_ID);
  const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);

  await rest.put(route, {
    body: slashCommandBuilders.map((command) => command.toJSON()),
  });

  logInfo(`Slash commands registrados em ${guildId ? 'guild' : 'escopo global'}.`);
}

async function handleAutocomplete(interaction) {
  const focusedValue = cleanText(interaction.options.getFocused());
  const choices = getSafePlayerNames()
    .filter((player) => player.toLowerCase().includes(focusedValue.toLowerCase()))
    .slice(0, 25)
    .map((player) => ({ name: player, value: player }));

  await interaction.respond(choices).catch(() => {});
}

async function handleStatusCommand(interaction) {
  const nick = getInteractionNickOption(interaction);
  await interaction.deferReply();

  if (!nick) {
    await interaction.editReply(buildPlayersListMessage(getSafePlayerNames()));
    return;
  }

  const snapshot = collectPlayerSnapshot(nick, { includeInventory: false, includeDb: false });
  if (!snapshot.found) {
    await interaction.editReply(
      snapshot.availablePlayers.length > 0
        ? `Jogador nao encontrado.\n\n${buildPlayersListMessage(snapshot.availablePlayers)}`
        : 'Jogador nao encontrado e nenhum CSV de jogador foi localizado.',
    );
    return;
  }

  await interaction.editReply({ embeds: [buildStatusEmbed(snapshot)] });
}

async function handleStatusCompleteCommand(interaction) {
  const nick = getInteractionNickOption(interaction);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!nick) {
    await interaction.editReply(buildPlayersListMessage(getSafePlayerNames()));
    return;
  }

  const snapshot = collectPlayerSnapshot(nick, { includeInventory: true, includeDb: true });
  if (!snapshot.found) {
    await interaction.editReply(
      snapshot.availablePlayers.length > 0
        ? `Jogador nao encontrado.\n\n${buildPlayersListMessage(snapshot.availablePlayers)}`
        : 'Jogador nao encontrado e nenhum CSV de jogador foi localizado.',
    );
    return;
  }

  await interaction.editReply({
    embeds: [buildStatusCompleteEmbed(snapshot)],
    files: [buildStatusCompleteAttachment(snapshot)],
  });
}

async function handleServerCommand(interaction) {
  if (!(await ensureAdminChannel(interaction))) {
    return;
  }

  const action = interaction.options.getString('acao', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (action === 'status') {
    const overview = await buildServerOverview();
    await interaction.editReply({ embeds: [buildServerStatusEmbed(overview, 'Consulta manual do slash command')] });
    return;
  }

  if (action === 'schedule_stop') {
    const warningMessage = 'servermsg "O SERVIDOR SERA DESLIGADO EM 10 MINUTOS. GUARDEM SEUS ITENS."';
    const shutdownMessage = 'servermsg "DESLIGANDO AGORA."';

    const warningResult = await runServerConsoleCommand(warningMessage);
    await interaction.editReply(
      warningResult.ok
        ? 'Agendamento iniciado. Aviso enviado e desligamento previsto para 10 minutos.'
        : `Agendamento iniciado, mas falhou ao enviar aviso. RCON: ${warningResult.rconError || 'N/A'} | Pterodactyl: ${warningResult.pteroError || 'N/A'}`,
    );

    setTimeout(async () => {
      await runServerConsoleCommand(shutdownMessage);
      await runServerConsoleCommand('save');
      await delay(5000);
      await manageServer('stop');
    }, 10 * 60 * 1000);

    return;
  }

  const result = await manageServer(action);
  await interaction.editReply(
    result.ok ? `Comando ${action} enviado ao Pterodactyl com sucesso.` : `Falha ao comunicar com o Pterodactyl: ${extractPteroError(result)}`,
  );
}

async function handleAutomationCommand(interaction) {
  if (!(await ensureAdminChannel(interaction))) {
    return;
  }

  const subcommand = interaction.options.getSubcommand(true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (subcommand === 'criar') {
    const result = createAutomation({
      action: interaction.options.getString('tipo', true),
      time: interaction.options.getString('horario', true),
      days: interaction.options.getString('dias'),
      retainBackups: interaction.options.getInteger('manter_backups'),
      command: interaction.options.getString('comando'),
    });

    if (!result.ok) {
      await interaction.editReply(result.error);
      return;
    }

    await interaction.editReply(`Automacao criada.\n${formatAutomationLine(result.automation)}`);
    return;
  }

  if (subcommand === 'listar') {
    const runtime = getAutomationRuntimeStatus();
    const header = [
      `Timezone: ${getAutomationTimezone()}`,
      `Agora na VM: ${runtime.dateKey} ${runtime.timeKey} (${runtime.weekdayLabel})`,
      `Janela de execucao: ${runtime.graceMinutes} minuto(s)`,
      `Arquivo: ${runtime.storeFile}`,
    ].join('\n');
    await interaction.editReply(`${header}\n${truncate(formatAutomationsList(), 1700)}`);
    return;
  }

  if (subcommand === 'remover') {
    const result = removeAutomation(interaction.options.getString('id', true));
    await interaction.editReply(result.ok ? 'Automacao removida.' : result.error);
    return;
  }

  if (subcommand === 'pausar' || subcommand === 'retomar') {
    const enabled = subcommand === 'retomar';
    const result = setAutomationEnabled(interaction.options.getString('id', true), enabled);
    await interaction.editReply(result.ok ? `Automacao ${enabled ? 'reativada' : 'pausada'}.\n${formatAutomationLine(result.automation)}` : result.error);
    return;
  }

  if (subcommand === 'executar') {
    const result = await runAutomationNow(interaction.options.getString('id', true));
    await interaction.editReply(result.ok ? `Automacao executada.\n${result.message}` : result.error || result.message);
    return;
  }

  if (subcommand === 'backupagora') {
    const result = await runBackupNow(interaction.options.getInteger('manter_backups'));
    await interaction.editReply(result.message);
  }
}

async function handleBotCommand(interaction) {
  if (!(await ensureAdminChannel(interaction))) {
    return;
  }

  const subcommand = interaction.options.getSubcommand(true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (subcommand === 'status') {
    const status = getBotUpdateStatus();
    const lines = [
      `Projeto: ${status.projectRoot}`,
      `Script: ${status.scriptPath}`,
      `Script encontrado: ${status.scriptExists ? 'sim' : 'nao'}`,
      `PM2 app: ${status.pm2AppName}`,
      `Timeout: ${Math.round(status.timeoutMs / 1000)}s`,
      `Auto-update: ${status.autoUpdateEnabled ? 'ativo' : 'desativado'}`,
      `Intervalo auto-update: ${Math.round(status.autoUpdateIntervalMs / 1000)}s`,
      `Log: ${status.logFile}`,
    ];
    await interaction.editReply(`\`\`\`\n${escapeCodeBlock(lines.join('\n'))}\n\`\`\``);
    return;
  }

  if (subcommand === 'logatualizacao') {
    await interaction.editReply(`\`\`\`\n${escapeCodeBlock(readLastUpdateLog())}\n\`\`\``);
    return;
  }

  if (subcommand === 'atualizar') {
    await interaction.editReply('Atualizacao iniciada. Vou buscar o codigo novo, instalar dependencias, validar sintaxe e reiniciar o bot se tudo passar.');

    const result = await runBotUpdate();
    if (!result.ok) {
      const details = [result.error, result.output].filter(Boolean).join('\n\n');
      await interaction.editReply(`Atualizacao falhou.\n\`\`\`\n${escapeCodeBlock(truncate(details, 1800))}\n\`\`\``);
      return;
    }

    await interaction.editReply(`Atualizacao concluida. Reiniciando o bot em alguns segundos.\n\`\`\`\n${escapeCodeBlock(result.output || 'Sem saida do script.')}\n\`\`\``);
    scheduleBotRestart();
  }
}

async function handleRconCommand(interaction) {
  if (!(await ensureAdminChannel(interaction))) {
    return;
  }

  const command = cleanText(interaction.options.getString('comando', true));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await runServerConsoleCommand(command);
  if (!result.ok) {
    await interaction.editReply(`Falha ao executar o comando.\nRCON: ${result.rconError || 'N/A'}\nPterodactyl: ${result.pteroError || 'N/A'}`);
    return;
  }

  if (result.transport === 'pterodactyl') {
    await interaction.editReply(`Comando enviado via console do painel porque o RCON falhou.\nErro do RCON: ${result.warning || 'Indisponivel no momento.'}`);
    return;
  }

  const output = result.output || 'Comando executado sem retorno.';
  await interaction.editReply(`Comando executado via RCON:\n\`\`\`\n${truncate(escapeCodeBlock(output), 1800)}\n\`\`\``);
}

async function handleDeleteFileCommand(interaction) {
  if (!(await ensureAdminChannel(interaction))) {
    return;
  }

  const scope = cleanText(interaction.options.getString('alvo', true));
  const nick = getInteractionNickOption(interaction);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (scope === 'jogador' && !nick) {
    await interaction.editReply('Voce precisa informar o nick quando escolher o alvo "jogador".');
    return;
  }

  const targets = buildDeleteTargets(scope, nick);
  if (targets === null) {
    await interaction.editReply(`Jogador nao encontrado para limpeza.\n\n${buildPlayersListMessage(getSafePlayerNames())}`);
    return;
  }

  const existingTargets = Array.from(new Set(targets)).filter((filePath) => fileExists(filePath));
  if (existingTargets.length === 0) {
    await interaction.editReply('Nenhum arquivo correspondente foi encontrado para apagar.');
    return;
  }

  const deleted = [];
  const failed = [];

  for (const filePath of existingTargets) {
    try {
      fs.unlinkSync(filePath);
      deleted.push(filePath);
    } catch (error) {
      failed.push(`${filePath} (${error.message})`);
    }
  }

  refreshInMemoryCaches();

  const responseLines = [
    `Arquivos apagados: ${deleted.length}`,
    deleted.length > 0 ? joinLinesLimited(deleted.map((filePath) => `- ${filePath}`), 1500) : '',
  ];

  if (failed.length > 0) {
    responseLines.push('');
    responseLines.push(`Falhas: ${failed.length}`);
    responseLines.push(joinLinesLimited(failed.map((line) => `- ${line}`), 1200));
  }

  await interaction.editReply(responseLines.filter(Boolean).join('\n'));
}

const commandHandlers = {
  automacao: handleAutomationCommand,
  bot: handleBotCommand,
  servidor: handleServerCommand,
  status: handleStatusCommand,
  statuscomplete: handleStatusCompleteCommand,
  rcon: handleRconCommand,
  deletearquivo: handleDeleteFileCommand,
};

for (const commandName of pzCommandNames) {
  commandHandlers[commandName] = (interaction) => handlePzCommand(interaction, { ensureAdminChannel });
}

async function runStartupStep(label, handler) {
  try {
    await handler();
  } catch (error) {
    logError(`Inicializacao - ${label}`, error);
  }
}

client.once('clientReady', async () => {
  logInfo(`Bot online como ${client.user.tag}`);

  await runStartupStep('slash commands', registerSlashCommands);
  await runStartupStep('cache local', async () => refreshInMemoryCaches());
  await runStartupStep('automacoes', async () => startAutomationLoop({ notify: sendAutomationMessage }));
  await runStartupStep('auto-update', async () => startBotAutoUpdateLoop({ notify: sendAutomationMessage }));
  await runStartupStep('anticheat', async () => startAntiCheatAlertLoop({ fetchTextChannel }));
  await runStartupStep('espelho de logs', startLogMirrors);
  await runStartupStep('watchers de dados', async () => startDataWatchers());
  await runStartupStep('painel de status', refreshStatsPanel);
  await runStartupStep('ranking', refreshRankingPanel);

  setInterval(() => {
    refreshStatsPanel().catch((error) => logError('Atualizacao periodica do painel de status', error));
  }, 60 * 1000);

  setInterval(() => {
    refreshRankingPanel().catch((error) => logError('Atualizacao periodica do ranking', error));
  }, 60 * 1000);

  setInterval(() => {
    scanPerkChanges().catch((error) => logError('Varredura periodica de perks', error));
  }, 30 * 1000);

  setInterval(() => {
    scanDeathChanges().catch((error) => logError('Varredura periodica de mortes', error));
  }, 30 * 1000);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const handler = commandHandlers[interaction.commandName];
  if (!handler) {
    return;
  }

  try {
    await handler(interaction);
  } catch (error) {
    logError(`Comando ${interaction.commandName}`, error);
    const message = 'Ocorreu um erro ao executar este comando.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.on('error', (error) => logError('Discord client', error));
process.on('unhandledRejection', (error) => logError('Unhandled rejection', error));
process.on('uncaughtException', (error) => logError('Uncaught exception', error));

if (require.main === module) {
  const token = cleanText(process.env.DISCORD_TOKEN);
  if (!token) {
    logWarn('DISCORD_TOKEN ausente. Bot nao iniciado.');
  } else {
    client.login(token).catch((error) => logError('Login do bot', error));
  }
}
