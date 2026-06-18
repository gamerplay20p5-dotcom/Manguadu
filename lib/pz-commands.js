const { AttachmentBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');

const { cleanText, escapeCodeBlock, getField, joinLinesLimited, toNumber, truncate } = require('./utils');
const { collectPlayerSnapshot } = require('./player-data');
const { buildStatusEmbed } = require('./reports');
const {
  extractPlayerLogs,
  findMapByName,
  findPlayerRecord,
  findVehicleById,
  getMaps,
  getPlayerPoint,
  getPlayerRank,
  getPlayerRows,
  getPlayerSkills,
  getPlayerTraits,
  getSafehouses,
  getWorldBounds,
} = require('./pz-data');
const { createMapPng } = require('./pz-map-renderer');
const { buildWipePlan, executeWipePlan, formatWipePlan } = require('./pz-wipe');
const {
  saveDraftTheme,
  storePanelMedia,
  updateDraftTheme,
} = require('./panel-theme');
const { removePlayerLink, setPlayerLink } = require('./panel-player-links');
const {
  buildServerOverview,
  createPteroBackup,
  extractPteroError,
  fetchPteroResources,
  listPteroBackups,
  manageServer,
  restorePteroBackup,
  sendPteroConsoleCommand,
} = require('./server-integrations');

const SAFEHOUSE_BACKUP_PREFIX = 'Safehouses geral - ';
const ADMIN_COMMANDS = new Set([
  'wipe_zeds',
  'wipe',
  'wipe_force',
  'wipe_teste',
  'wipe_chunk',
  'wipe_chunk_force',
  'wipe_chunk_teste',
  'logs',
  'safehouse',
  'adduser',
  'removeuserfromwhitelist',
  'banid',
  'kick',
  'kick_all',
  'godmode',
  'invisible',
  'grantadmin',
  'removeadmin',
  'tpto',
  'tp',
  'servermsg',
  'painel',
]);

function playerOption(option, name = 'jogador', description = 'Nick do jogador') {
  return option.setName(name).setDescription(description).setRequired(true).setAutocomplete(true);
}

function adminBuilder(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false);
}

const pzSlashCommandBuilders = [
  new SlashCommandBuilder()
    .setName('localizar_veiculo')
    .setDescription('Localiza um veiculo pelo ID registrado nos CSVs')
    .setDMPermission(false)
    .addStringOption((option) => option.setName('id').setDescription('ID do veiculo').setRequired(true)),
  new SlashCommandBuilder().setName('online').setDescription('Lista usuarios online no servidor').setDMPermission(false),
  new SlashCommandBuilder()
    .setName('info')
    .setDescription('Exibe informacoes de um jogador')
    .setDMPermission(false)
    .addStringOption((option) => playerOption(option)),
  new SlashCommandBuilder()
    .setName('skills')
    .setDescription('Mostra habilidades de um jogador')
    .setDMPermission(false)
    .addStringOption((option) => playerOption(option)),
  new SlashCommandBuilder()
    .setName('traits')
    .setDescription('Mostra profissao e traits de um jogador')
    .setDMPermission(false)
    .addStringOption((option) => playerOption(option)),
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Mostra a posicao de um jogador no ranking')
    .setDMPermission(false)
    .addStringOption((option) => playerOption(option))
    .addStringOption((option) =>
      option
        .setName('tipo')
        .setDescription('Metrica do ranking')
        .setRequired(false)
        .addChoices({ name: 'Zumbis mortos', value: 'kills' }, { name: 'Horas sobrevividas', value: 'hours' }),
    ),
  new SlashCommandBuilder()
    .setName('gps')
    .setDescription('Gera imagem da ultima localizacao do jogador')
    .setDMPermission(false)
    .addStringOption((option) => playerOption(option)),
  new SlashCommandBuilder().setName('satelite').setDescription('Gera uma visao PNG do servidor inteiro').setDMPermission(false),
  new SlashCommandBuilder().setName('mapas').setDescription('Lista mapas configurados no servidor').setDMPermission(false),
  adminBuilder('wipe_zeds', 'Reseta zombies de um mapa ou de todos')
    .addStringOption((option) => option.setName('alvo').setDescription('todos, nome do mapa ou celula x,y').setRequired(true))
    .addStringOption((option) => option.setName('confirmar').setDescription('Digite APAGAR').setRequired(true)),
  adminBuilder('wipe', 'Wipe global: apaga DB, Logs e Saves')
    .addStringOption((option) => option.setName('confirmar').setDescription('Digite APAGAR_TUDO').setRequired(true)),
  adminBuilder('wipe_force', 'Reseta mapa/celula ignorando safehouses')
    .addStringOption((option) => option.setName('alvo').setDescription('Nome do mapa ou celula x,y').setRequired(true))
    .addStringOption((option) => option.setName('confirmar').setDescription('Digite APAGAR').setRequired(true)),
  adminBuilder('wipe_teste', 'Simula wipe global sem apagar'),
  adminBuilder('wipe_chunk', 'Reseta chunk 10x10 protegendo safehouses')
    .addStringOption((option) => option.setName('chunk').setDescription('Chunk no formato x,y').setRequired(true))
    .addStringOption((option) => option.setName('confirmar').setDescription('Digite APAGAR').setRequired(true)),
  adminBuilder('wipe_chunk_force', 'Reseta chunk 10x10 ignorando safehouses')
    .addStringOption((option) => option.setName('chunk').setDescription('Chunk no formato x,y').setRequired(true))
    .addStringOption((option) => option.setName('confirmar').setDescription('Digite APAGAR').setRequired(true)),
  adminBuilder('wipe_chunk_teste', 'Simula exclusao de chunk sem apagar')
    .addStringOption((option) => option.setName('chunk').setDescription('Chunk no formato x,y').setRequired(true)),
  adminBuilder('logs', 'Extrai logs de um jogador em um intervalo')
    .addStringOption((option) => playerOption(option))
    .addStringOption((option) =>
      option
        .setName('tipo')
        .setDescription('Tipo de log')
        .setRequired(true)
        .addChoices(
          { name: 'PVP', value: 'pvp' },
          { name: 'Chat', value: 'chat' },
          { name: 'Usuarios', value: 'user' },
          { name: 'Administracao', value: 'admin' },
          { name: 'Todos', value: 'todos' },
        ),
    )
    .addIntegerOption((option) => option.setName('horas').setDescription('Intervalo em horas').setRequired(true).setMinValue(1).setMaxValue(168)),
  adminBuilder('safehouse', 'Gerencia safehouses e backups gerais')
    .addSubcommand((subcommand) => subcommand.setName('listar').setDescription('Lista todas safehouses'))
    .addSubcommand((subcommand) => subcommand.setName('listar_bkp_geral').setDescription('Lista backups gerais de safehouse'))
    .addSubcommand((subcommand) => subcommand.setName('executar_bkp_geral').setDescription('Cria backup geral antes de manutencao'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('restaurar_bkp_geral')
        .setDescription('Restaura um backup geral com servidor offline')
        .addStringOption((option) => option.setName('uuid').setDescription('UUID do backup').setRequired(true))
        .addStringOption((option) => option.setName('confirmar').setDescription('Digite RESTAURAR').setRequired(true)),
    ),
  adminBuilder('adduser', 'Adiciona usuario na whitelist')
    .addStringOption((option) => option.setName('usuario').setDescription('Usuario').setRequired(true))
    .addStringOption((option) => option.setName('senha').setDescription('Senha inicial').setRequired(true)),
  adminBuilder('removeuserfromwhitelist', 'Remove usuario da whitelist')
    .addStringOption((option) => option.setName('usuario').setDescription('Usuario').setRequired(true)),
  adminBuilder('banid', 'Bane um jogador pelo SteamID')
    .addStringOption((option) => option.setName('steamid').setDescription('SteamID').setRequired(true)),
  adminBuilder('kick', 'Expulsa um jogador pelo nick').addStringOption((option) => playerOption(option)),
  adminBuilder('kick_all', 'Expulsa todos os jogadores online')
    .addStringOption((option) => option.setName('confirmar').setDescription('Digite EXPULSAR').setRequired(true)),
  adminBuilder('godmode', 'Ativa ou desativa modo Deus para um jogador')
    .addStringOption((option) => playerOption(option))
    .addBooleanOption((option) => option.setName('ativar').setDescription('Estado desejado').setRequired(true)),
  adminBuilder('invisible', 'Ativa ou desativa invisibilidade para um jogador')
    .addStringOption((option) => playerOption(option))
    .addBooleanOption((option) => option.setName('ativar').setDescription('Estado desejado').setRequired(true)),
  adminBuilder('grantadmin', 'Concede status de admin').addStringOption((option) => playerOption(option)),
  adminBuilder('removeadmin', 'Remove status de admin').addStringOption((option) => playerOption(option)),
  adminBuilder('tpto', 'Teleporta um jogador para coordenadas')
    .addStringOption((option) => playerOption(option))
    .addIntegerOption((option) => option.setName('x').setDescription('Coordenada X').setRequired(true))
    .addIntegerOption((option) => option.setName('y').setDescription('Coordenada Y').setRequired(true))
    .addIntegerOption((option) => option.setName('z').setDescription('Andar Z').setRequired(false)),
  adminBuilder('tp', 'Teleporta um jogador para outro')
    .addStringOption((option) => playerOption(option))
    .addStringOption((option) => playerOption(option, 'destino', 'Jogador de destino')),
  adminBuilder('servermsg', 'Envia mensagem vermelha no centro da tela')
    .addStringOption((option) => option.setName('mensagem').setDescription('Mensagem').setRequired(true).setMaxLength(500)),
  adminBuilder('painel', 'Controla e consulta o servidor pelo painel ou Docker local')
    .addSubcommandGroup((group) =>
      group
        .setName('config')
        .setDescription('Personaliza a identidade visual dos paineis')
        .addSubcommand((subcommand) =>
          subcommand
            .setName('banner')
            .setDescription('Define banner por arquivo, GIF, video, URL ou YouTube')
            .addAttachmentOption((option) => option.setName('arquivo').setDescription('Imagem, GIF ou video').setRequired(false))
            .addStringOption((option) => option.setName('url').setDescription('URL de imagem, GIF ou YouTube').setRequired(false)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('thumbnail')
            .setDescription('Define o logo lateral do painel')
            .addAttachmentOption((option) => option.setName('arquivo').setDescription('Imagem, GIF ou video').setRequired(false))
            .addStringOption((option) => option.setName('url').setDescription('URL de imagem, GIF ou YouTube').setRequired(false)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('cor')
            .setDescription('Define a cor principal')
            .addStringOption((option) => option.setName('hex').setDescription('Cor hexadecimal, exemplo #28D17C').setRequired(true)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('cor-secundaria')
            .setDescription('Define a cor complementar')
            .addStringOption((option) => option.setName('hex').setDescription('Cor hexadecimal, exemplo #F0A93B').setRequired(true)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('titulo')
            .setDescription('Altera o titulo principal')
            .addStringOption((option) => option.setName('texto').setDescription('Titulo do servidor').setRequired(true).setMaxLength(100)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('descricao')
            .setDescription('Altera a descricao principal')
            .addStringOption((option) => option.setName('texto').setDescription('Descricao da comunidade').setRequired(true).setMaxLength(500)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('fundo-ranking')
            .setDescription('Define a imagem principal do ranking')
            .addAttachmentOption((option) => option.setName('arquivo').setDescription('Imagem, GIF ou video').setRequired(false))
            .addStringOption((option) => option.setName('url').setDescription('URL de imagem, GIF ou YouTube').setRequired(false)),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('jogadores')
        .setDescription('Vincula jogadores PZ a membros do Discord')
        .addSubcommand((subcommand) =>
          subcommand
            .setName('vincular')
            .setDescription('Vincula um nick PZ a um membro')
            .addStringOption((option) => playerOption(option))
            .addUserOption((option) => option.setName('membro').setDescription('Membro do Discord').setRequired(true)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('desvincular')
            .setDescription('Remove o vinculo Discord de um jogador')
            .addStringOption((option) => playerOption(option)),
        ),
    )
    .addSubcommand((subcommand) => subcommand.setName('restart').setDescription('Reinicia o servidor'))
    .addSubcommand((subcommand) => subcommand.setName('stop').setDescription('Para o servidor'))
    .addSubcommand((subcommand) => subcommand.setName('recursos').setDescription('Mostra CPU, RAM, disco e estado'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('preview')
        .setDescription('Mostra o rascunho antes de salvar')
        .addStringOption((option) =>
          option
            .setName('tipo')
            .setDescription('Painel para visualizar')
            .setRequired(false)
            .addChoices({ name: 'Servidor', value: 'status' }, { name: 'Ranking', value: 'ranking' }),
        ),
    )
    .addSubcommand((subcommand) => subcommand.setName('salvar').setDescription('Publica o tema em rascunho')),
];

const pzCommandNames = new Set(pzSlashCommandBuilders.map((builder) => builder.name));

function quotePz(value) {
  return `"${cleanText(value).replace(/["\r\n]/g, '')}"`;
}

async function sendConsole(command, successMessage) {
  const result = await sendPteroConsoleCommand(command);
  return result.ok
    ? { ok: true, message: successMessage }
    : { ok: false, message: `Falha no console do Pterodactyl: ${extractPteroError(result)}` };
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function getCellForPoint(point) {
  return {
    x: Math.floor(point.x / 300),
    y: Math.floor(point.y / 300),
  };
}

function getChunkForPoint(point) {
  return {
    x: Math.floor(point.x / 10),
    y: Math.floor(point.y / 10),
  };
}

function rectangleFromCell(cell) {
  return {
    minX: cell.x * 300,
    minY: cell.y * 300,
    maxX: cell.x * 300 + 299,
    maxY: cell.y * 300 + 299,
  };
}

function rectangleFromChunk(chunk) {
  return {
    minX: chunk.x * 10,
    minY: chunk.y * 10,
    maxX: chunk.x * 10 + 9,
    maxY: chunk.y * 10 + 9,
  };
}

function findMapForPoint(point, maps) {
  return (maps || []).find((map) =>
    point.x >= toNumber(map.minX) &&
    point.x <= toNumber(map.maxX) &&
    point.y >= toNumber(map.minY) &&
    point.y <= toNumber(map.maxY),
  );
}

function buildGpsBounds(point) {
  const radius = Math.max(900, Number.parseInt(process.env.PZ_GPS_VIEW_RADIUS, 10) || 1500);
  return {
    minX: point.x - radius,
    minY: point.y - radius,
    maxX: point.x + radius,
    maxY: point.y + radius,
  };
}

async function handlePublicCommand(interaction) {
  const name = interaction.commandName;
  await interaction.deferReply();

  if (name === 'online') {
    const overview = await buildServerOverview();
    const lines = overview.onlinePlayers.names.length > 0 ? overview.onlinePlayers.names.map((nick, index) => `${index + 1}. ${nick}`) : ['Nenhum jogador online.'];
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(overview.isOnline ? 0x2ecc71 : 0xe74c3c).setTitle(`Jogadores online: ${overview.onlinePlayers.count}`).setDescription(joinLinesLimited(lines, 3900)).setTimestamp()],
    });
    return;
  }

  if (name === 'info') {
    const nick = interaction.options.getString('jogador', true);
    const snapshot = collectPlayerSnapshot(nick, { includeInventory: false, includeDb: false });
    await interaction.editReply(snapshot.found ? { embeds: [buildStatusEmbed(snapshot)] } : 'Jogador nao encontrado nos dados do servidor.');
    return;
  }

  if (name === 'skills') {
    const data = getPlayerSkills(interaction.options.getString('jogador', true));
    if (!data) {
      await interaction.editReply('Jogador nao encontrado.');
      return;
    }
    const lines = data.skills.map((skill) => `${skill.emoji || ''} **${skill.label}:** \`${skill.value}\``);
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle(`Skills de ${data.nick}`).setDescription(joinLinesLimited(lines, 3900)).setTimestamp()] });
    return;
  }

  if (name === 'traits') {
    const record = findPlayerRecord(interaction.options.getString('jogador', true));
    if (!record) {
      await interaction.editReply('Jogador nao encontrado.');
      return;
    }
    const traits = getPlayerTraits(record.row);
    const allTraits = [...traits.positive, ...traits.negative, ...traits.traits];
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x9b59b6).setTitle(`Profissao e traits de ${record.nick}`).addFields({ name: 'Profissao', value: traits.profession }, { name: 'Traits', value: allTraits.length ? joinLinesLimited(allTraits.map((trait) => `- ${trait}`), 1024) : 'Nao exportados pelo coletor atual.' }).setTimestamp()],
    });
    return;
  }

  if (name === 'rank') {
    const type = interaction.options.getString('tipo') || 'kills';
    const rank = getPlayerRank(interaction.options.getString('jogador', true), type);
    if (!rank) {
      await interaction.editReply('Jogador nao encontrado no ranking.');
      return;
    }
    const unit = rank.metric === 'hourssurvived' ? 'h' : 'zumbis';
    await interaction.editReply(`**${rank.entry.nick}** esta em **#${rank.position} de ${rank.total}** com **${rank.entry.value.toFixed(rank.metric === 'hourssurvived' ? 1 : 0)} ${unit}**.`);
    return;
  }

  if (name === 'localizar_veiculo') {
    const vehicle = findVehicleById(interaction.options.getString('id', true));
    if (!vehicle) {
      await interaction.editReply('Veiculo nao encontrado. Confirme se o coletor exporta `vehicles.csv`.');
      return;
    }
    const row = vehicle.row;
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0xf39c12).setTitle(`Veiculo ${getField(row, ['vehicleid', 'id', 'sqlid'], 'sem ID')}`).addFields({ name: 'Modelo', value: getField(row, ['scriptname', 'vehicle', 'type', 'name'], 'N/A'), inline: true }, { name: 'Posicao', value: `${getField(row, ['x'], '?')}, ${getField(row, ['y'], '?')}, ${getField(row, ['z'], '0')}`, inline: true }, { name: 'Dono/chave', value: getField(row, ['owner', 'keyid', 'key'], 'N/A'), inline: true }).setFooter({ text: 'Dados exportados pelo servidor PZ' }).setTimestamp()],
    });
    return;
  }

  if (name === 'mapas') {
    const maps = getMaps();
    const lines = maps.map((map) => `- \`${map.id}\` ${map.name}: (${map.minX},${map.minY}) -> (${map.maxX},${map.maxY})`);
    await interaction.editReply(maps.length ? `**Mapas configurados:**\n${joinLinesLimited(lines, 1850)}` : 'Nenhum mapa configurado. Crie `config/pz-maps.json` a partir do exemplo.');
    return;
  }

  if (name === 'gps' || name === 'satelite') {
    const records = getPlayerRows();
    const points = records.map(getPlayerPoint).filter(Boolean);
    let focus = '';
    let description = `${points.length} localizacao(oes) conhecidas.`;
    let bounds = getWorldBounds(points);
    let focusCell = null;
    let focusChunk = null;
    let title = 'SATELITE DO SERVIDOR';
    let subtitle = `${points.length} jogadores mapeados`;
    const maps = getMaps();
    if (name === 'gps') {
      const record = findPlayerRecord(interaction.options.getString('jogador', true));
      const point = getPlayerPoint(record);
      if (!point) {
        await interaction.editReply('Jogador sem coordenadas exportadas.');
        return;
      }
      focus = point.nick;
      const cell = getCellForPoint(point);
      const chunk = getChunkForPoint(point);
      const map = findMapForPoint(point, maps);
      bounds = buildGpsBounds(point);
      focusCell = rectangleFromCell(cell);
      focusChunk = rectangleFromChunk(chunk);
      title = `GPS ${point.nick}`;
      subtitle = `X ${Math.round(point.x)} Y ${Math.round(point.y)} CELL ${cell.x},${cell.y} CHUNK ${chunk.x},${chunk.y}`;
      description =
        `Ultima posicao de **${point.nick}**: \`${point.x}, ${point.y}, ${point.z}\`\n` +
        `Mapa: **${map?.name || 'desconhecido'}** | Celula: \`${cell.x},${cell.y}\` | Chunk: \`${chunk.x},${chunk.y}\``;
    }
    const safehouses = getSafehouses();
    const png = createMapPng({
      bounds,
      maps,
      safehouses,
      points,
      focus,
      focusCell,
      focusChunk,
      title,
      subtitle,
      minorGridStep: name === 'gps' ? 100 : 300,
      majorGridStep: name === 'gps' ? 300 : 900,
      showPlayerLabels: name === 'gps',
    });
    const filename = name === 'gps' ? `gps-${focus}.png` : 'satelite-servidor.png';
    await interaction.editReply({ content: description, files: [new AttachmentBuilder(png, { name: filename })] });
  }
}

async function handleWipeCommand(interaction) {
  const name = interaction.commandName;
  const isTest = name.endsWith('_teste');
  const force = name.includes('_force');
  const kind = name === 'wipe' || name === 'wipe_teste' ? 'global' : name === 'wipe_zeds' ? 'zeds' : name.includes('chunk') ? 'chunk' : 'cell';
  const target = kind === 'global' ? '' : kind === 'chunk' ? interaction.options.getString('chunk', true) : interaction.options.getString('alvo', true);
  const expectedConfirmation = kind === 'global' ? 'APAGAR_TUDO' : 'APAGAR';
  if (!isTest && cleanText(interaction.options.getString('confirmar')).toUpperCase() !== expectedConfirmation) {
    await interaction.editReply(`Confirmacao invalida. Digite exatamente \`${expectedConfirmation}\`.`);
    return;
  }
  const plan = await buildWipePlan({ kind, target, force: kind === 'global' ? true : force });
  if (!plan.ok) {
    await interaction.editReply(plan.error);
    return;
  }
  if (isTest) {
    await interaction.editReply(`**SIMULACAO, nada foi apagado**\n\`\`\`\n${escapeCodeBlock(truncate(formatWipePlan(plan), 1750))}\n\`\`\``);
    return;
  }
  await interaction.editReply(`Plano validado para **${plan.files.length} arquivo(s)**. Criando backup pre-wipe; isso pode levar alguns minutos...`);
  const result = await executeWipePlan(plan);
  await interaction.editReply(result.ok ? `Wipe concluido: **${result.deleted.length} arquivo(s)** apagados. Backup: \`${result.backup.uuid}\`.` : `Wipe abortado: ${result.error}`);
}

function validateHexColor(value) {
  const normalized = cleanText(value).replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(normalized) ? `#${normalized.toUpperCase()}` : '';
}

async function handlePanelConfig(interaction) {
  const setting = interaction.options.getSubcommand(true);
  if (setting === 'cor' || setting === 'cor-secundaria') {
    const color = validateHexColor(interaction.options.getString('hex', true));
    if (!color) {
      await interaction.editReply('Cor invalida. Use seis digitos hexadecimais, por exemplo `#28D17C`.');
      return;
    }
    updateDraftTheme({ [setting === 'cor' ? 'primaryColor' : 'secondaryColor']: color });
    await interaction.editReply(`Cor do rascunho atualizada para \`${color}\`. Use \`/painel preview\` e depois \`/painel salvar\`.`);
    return;
  }

  if (setting === 'titulo' || setting === 'descricao') {
    const text = cleanText(interaction.options.getString('texto', true));
    updateDraftTheme({ [setting === 'titulo' ? 'title' : 'description']: text });
    await interaction.editReply(`Texto atualizado no rascunho. Use \`/painel preview\` e depois \`/painel salvar\`.`);
    return;
  }

  const fieldMap = {
    banner: 'banner',
    thumbnail: 'thumbnail',
    'fundo-ranking': 'rankingBackground',
  };
  const mediaUrl = cleanText(interaction.options.getString('url'));
  if (['remover', 'limpar', 'remove', 'clear'].includes(mediaUrl.toLowerCase())) {
    updateDraftTheme({ [fieldMap[setting]]: null });
    await interaction.editReply('Midia removida do rascunho. Use `/painel preview` e depois `/painel salvar`.');
    return;
  }
  const media = await storePanelMedia(setting, {
    attachment: interaction.options.getAttachment('arquivo'),
    url: mediaUrl,
  });
  updateDraftTheme({ [fieldMap[setting]]: media });
  await interaction.editReply('Midia armazenada no rascunho. Use `/painel preview` e depois `/painel salvar`.');
}

async function handleAdminCommand(interaction, context = {}) {
  const name = interaction.commandName;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (name.startsWith('wipe')) {
    await handleWipeCommand(interaction);
    return;
  }

  if (name === 'logs') {
    const result = extractPlayerLogs(interaction.options.getString('jogador', true), interaction.options.getString('tipo', true), interaction.options.getInteger('horas', true));
    const content = result.lines.length ? result.lines.join('\n') : 'Nenhuma linha encontrada.';
    await interaction.editReply({ content: `Encontradas **${result.lines.length}** linha(s) em ${result.files.length} arquivo(s).`, files: [new AttachmentBuilder(Buffer.from(content, 'utf8'), { name: `logs-${Date.now()}.txt` })] });
    return;
  }

  if (name === 'safehouse') {
    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand === 'listar') {
      const rows = getSafehouses();
      const lines = rows.map((row, index) => `${index + 1}. ${getField(row, ['title'], 'Sem titulo')} | ${getField(row, ['owner'], 'Sem dono')} | (${getField(row, ['x'], '?')},${getField(row, ['y'], '?')}) -> (${getField(row, ['x2'], '?')},${getField(row, ['y2'], '?')})`);
      await interaction.editReply(lines.length ? joinLinesLimited(lines, 1900) : 'Nenhuma safehouse registrada.');
      return;
    }
    if (subcommand === 'listar_bkp_geral') {
      const result = await listPteroBackups();
      const backups = result.ok ? result.backups.filter((backup) => backup.name.startsWith(SAFEHOUSE_BACKUP_PREFIX)) : [];
      await interaction.editReply(result.ok ? (backups.length ? joinLinesLimited(backups.map((backup) => `\`${backup.uuid}\` ${backup.name} | ${backup.completedAt || 'processando'} | ${formatBytes(backup.bytes)}`), 1900) : 'Nenhum backup geral encontrado.') : extractPteroError(result));
      return;
    }
    if (subcommand === 'executar_bkp_geral') {
      const result = await createPteroBackup({ name: `${SAFEHOUSE_BACKUP_PREFIX}${new Date().toISOString()}`, isLocked: true });
      await interaction.editReply(result.ok ? `Backup geral iniciado: \`${result.backup.uuid}\`. Ele inclui o save completo para garantir consistencia das safehouses.` : extractPteroError(result));
      return;
    }
    if (cleanText(interaction.options.getString('confirmar')).toUpperCase() !== 'RESTAURAR') {
      await interaction.editReply('Confirmacao invalida. Digite exatamente `RESTAURAR`.');
      return;
    }
    const resources = await fetchPteroResources();
    if (!resources.ok || resources.state.toLowerCase() !== 'offline') {
      await interaction.editReply(`Servidor precisa estar offline. Estado: ${resources.state || extractPteroError(resources)}.`);
      return;
    }
    const result = await restorePteroBackup(interaction.options.getString('uuid', true), { truncate: false });
    await interaction.editReply(result.ok ? 'Restauracao solicitada ao Pterodactyl.' : extractPteroError(result));
    return;
  }

  if (name === 'painel') {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(true);
    if (group === 'config') {
      await handlePanelConfig(interaction);
      return;
    }
    if (group === 'jogadores') {
      const nick = interaction.options.getString('jogador', true);
      if (subcommand === 'vincular') {
        const member = interaction.options.getUser('membro', true);
        setPlayerLink(nick, member.id);
        await interaction.editReply(`**${nick}** foi vinculado a ${member}.`);
      } else {
        const removed = removePlayerLink(nick);
        await interaction.editReply(removed ? `Vinculo de **${nick}** removido.` : `**${nick}** nao possuia vinculo.`);
      }
      return;
    }
    if (subcommand === 'preview') {
      if (typeof context.buildPanelPreview !== 'function') {
        await interaction.editReply('Preview indisponivel nesta inicializacao.');
        return;
      }
      const payload = await context.buildPanelPreview(interaction.options.getString('tipo') || 'status');
      await interaction.editReply(payload);
      return;
    }
    if (subcommand === 'salvar') {
      const theme = saveDraftTheme();
      let refreshWarning = '';
      if (typeof context.refreshPanels === 'function') {
        try {
          await context.refreshPanels();
        } catch (error) {
          refreshWarning = ` Tema salvo, mas a atualizacao imediata falhou: ${error.message}`;
        }
      }
      await interaction.editReply(`Tema **${theme.title}** salvo.${refreshWarning || ' Os paineis foram atualizados.'}`);
      return;
    }
    if (subcommand === 'recursos') {
      const result = await fetchPteroResources();
      if (!result.ok) {
        await interaction.editReply(extractPteroError(result));
        return;
      }
      const resources = result.resources || {};
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x2c3e50).setTitle('Recursos do servidor').addFields({ name: 'Estado', value: result.state, inline: true }, { name: 'CPU', value: `${Number(resources.cpu_absolute || 0).toFixed(1)}%`, inline: true }, { name: 'RAM', value: formatBytes(resources.memory_bytes), inline: true }, { name: 'Disco', value: formatBytes(resources.disk_bytes), inline: true }, { name: 'Rede recebida', value: formatBytes(resources.network_rx_bytes), inline: true }, { name: 'Rede enviada', value: formatBytes(resources.network_tx_bytes), inline: true }).setTimestamp()] });
      return;
    }
    const result = await manageServer(subcommand);
    const via = result.transport === 'docker' ? 'Docker/local' : 'Pterodactyl';
    await interaction.editReply(result.ok ? `Comando \`${subcommand}\` enviado via ${via}.` : extractPteroError(result));
    return;
  }

  if (name === 'kick_all') {
    if (cleanText(interaction.options.getString('confirmar')).toUpperCase() !== 'EXPULSAR') {
      await interaction.editReply('Confirmacao invalida. Digite exatamente `EXPULSAR`.');
      return;
    }
    const overview = await buildServerOverview();
    const failures = [];
    for (const nick of overview.onlinePlayers.names) {
      const result = await sendConsole(`kickuser ${quotePz(nick)}`, '');
      if (!result.ok) failures.push(nick);
    }
    await interaction.editReply(`Jogadores processados: ${overview.onlinePlayers.names.length}. Falhas: ${failures.length}${failures.length ? ` (${failures.join(', ')})` : ''}.`);
    return;
  }

  const nick = cleanText(interaction.options.getString('jogador'));
  let command = '';
  let success = 'Comando enviado.';
  if (name === 'adduser') {
    command = `adduser ${quotePz(interaction.options.getString('usuario', true))} ${quotePz(interaction.options.getString('senha', true))}`;
    success = 'Usuario adicionado a whitelist.';
  } else if (name === 'removeuserfromwhitelist') {
    command = `removeuserfromwhitelist ${quotePz(interaction.options.getString('usuario', true))}`;
    success = 'Usuario removido da whitelist.';
  } else if (name === 'banid') {
    const steamId = cleanText(interaction.options.getString('steamid', true)).replace(/\D/g, '');
    if (steamId.length < 15 || steamId.length > 20) {
      await interaction.editReply('SteamID invalido. Informe o SteamID64 numerico completo.');
      return;
    }
    command = `banid ${steamId}`;
    success = 'Banimento por SteamID enviado.';
  } else if (name === 'kick') {
    command = `kickuser ${quotePz(nick)}`;
    success = `${nick} expulso.`;
  } else if (name === 'godmode') {
    const enabled = interaction.options.getBoolean('ativar', true);
    command = `godmod ${quotePz(nick)} -${enabled}`;
    success = `God mode ${enabled ? 'ativado' : 'desativado'} para ${nick}.`;
  } else if (name === 'invisible') {
    const enabled = interaction.options.getBoolean('ativar', true);
    command = `invisible ${quotePz(nick)} -${enabled}`;
    success = `Invisibilidade ${enabled ? 'ativada' : 'desativada'} para ${nick}.`;
  } else if (name === 'grantadmin') {
    command = `grantadmin ${quotePz(nick)}`;
    success = `Admin concedido para ${nick}.`;
  } else if (name === 'removeadmin') {
    command = `removeadmin ${quotePz(nick)}`;
    success = `Admin removido de ${nick}.`;
  } else if (name === 'tpto') {
    command = `teleportto ${quotePz(nick)} ${interaction.options.getInteger('x', true)},${interaction.options.getInteger('y', true)},${interaction.options.getInteger('z') || 0}`;
    success = `${nick} teleportado para as coordenadas.`;
  } else if (name === 'tp') {
    command = `teleport ${quotePz(nick)} ${quotePz(interaction.options.getString('destino', true))}`;
    success = `${nick} teleportado.`;
  } else if (name === 'servermsg') {
    command = `servermsg ${quotePz(interaction.options.getString('mensagem', true))}`;
    success = 'Mensagem enviada ao servidor.';
  }
  const result = await sendConsole(command, success);
  await interaction.editReply(result.message);
}

async function handlePzCommand(interaction, context = {}) {
  if (ADMIN_COMMANDS.has(interaction.commandName)) {
    if (typeof context.ensureAdminChannel === 'function' && !(await context.ensureAdminChannel(interaction))) {
      return;
    }
    await handleAdminCommand(interaction, context);
    return;
  }
  await handlePublicCommand(interaction);
}

module.exports = {
  handlePzCommand,
  pzCommandNames,
  pzSlashCommandBuilders,
};
