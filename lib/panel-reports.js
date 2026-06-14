const { EmbedBuilder } = require('discord.js');

const { getField, joinLinesLimited, toNumber } = require('./utils');
const { buildFactionLeaderboard } = require('./reports');
const {
  colorToNumber,
  getMediaUrl,
  getSavedTheme,
  getThemeAttachments,
} = require('./panel-theme');

function medal(index) {
  return ['🥇', '🥈', '🥉'][index] || `**${index + 1}.**`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function buildDeathLeaderboard(playerRows, deathRows) {
  const players = playerRows.map((row) => getField(row, ['username'])).filter(Boolean);
  const counts = new Map(players.map((player) => [player, 0]));
  for (const row of deathRows || []) {
    const cells = row.map((cell) => String(cell || '').trim().toLowerCase());
    const matched = players.find((player) => cells.includes(player.toLowerCase()));
    if (matched) counts.set(matched, (counts.get(matched) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'pt-BR'));
}

function rankingDescription(rows, formatter, limit = 5) {
  return joinLinesLimited(
    rows.slice(0, limit).map((entry, index) => `${medal(index)} **${entry.name}**\n> ${formatter(entry)}`),
    4000,
  );
}

function buildOnlineProfiles(onlineNames, playerRows) {
  return onlineNames.map((nick) => {
    const row = playerRows.find((candidate) => getField(candidate, ['username']).toLowerCase() === nick.toLowerCase());
    return {
      nick,
      faction: row ? getField(row, ['factionname']) : '',
    };
  });
}

function buildServerPanelPayload(overview, options = {}) {
  const theme = options.theme || getSavedTheme();
  const primary = colorToNumber(theme.primaryColor);
  const secondary = colorToNumber(theme.secondaryColor, 0xf0a93b);
  const hasPanel = overview.ptero.ok;
  const hasRcon = overview.rconPlayers.ok;
  const resources = overview.ptero.resources || {};
  const uptimeMs = toNumber(resources.uptime);
  const lastBoot = uptimeMs > 0 ? Math.floor((Date.now() - uptimeMs) / 1000) : 0;
  const maxSlots = Number.parseInt(options.maxSlots || process.env.SERVER_MAX_SLOTS, 10);
  const connectAddress = String(options.connectAddress || process.env.SERVER_CONNECT_ADDRESS || '').trim();
  const banner = getMediaUrl(theme.banner);
  const thumbnail = getMediaUrl(theme.thumbnail);

  const states = {
    running: 'ONLINE',
    starting: 'INICIANDO',
    stopping: 'DESLIGANDO',
    offline: 'OFFLINE',
  };
  const state = states[String(overview.currentState || '').toLowerCase()] || String(overview.currentState || 'DESCONHECIDO').toUpperCase();

  const main = new EmbedBuilder()
    .setColor(overview.isOnline ? primary : 0xc74343)
    .setTitle(theme.title)
    .setDescription(`${overview.isOnline ? '🟢 **MUNDO OPERACIONAL**' : '🔴 **MUNDO INDISPONÍVEL**'}\n${theme.description}`)
    .addFields(
      { name: 'STATUS', value: `\`${state}\``, inline: true },
      {
        name: 'JOGADORES',
        value: `\`${overview.onlinePlayers.count}${Number.isFinite(maxSlots) ? ` / ${maxSlots}` : ''}\``,
        inline: true,
      },
      { name: 'PING DO PAINEL', value: hasPanel ? `\`${overview.ptero.latencyMs} ms\`` : '`indisponível`', inline: true },
    );

  const world = [];
  if (overview.world?.gameDate) world.push(`📅 **Dia:** ${overview.world.gameDate}`);
  if (overview.world?.timeOfDay) world.push(`🕒 **Hora:** ${overview.world.timeOfDay}`);
  if (overview.world?.temperature) world.push(`🌡️ **Temperatura:** ${overview.world.temperature} °C`);
  if (world.length > 0) main.addFields({ name: 'MUNDO', value: world.join('\n'), inline: true });

  const infrastructure = [
    `Painel ${hasPanel ? '🟢' : '🔴'} · RCON ${hasRcon ? '🟢' : '🟠'}`,
    `Fonte: **${overview.onlinePlayers.source === 'rcon' ? 'RCON ao vivo' : overview.onlinePlayers.source === 'csv' ? 'FriendHost' : 'sem leitura'}**`,
  ];
  if (uptimeMs > 0) infrastructure.push(`Uptime: **${formatDuration(uptimeMs)}**`);
  if (lastBoot > 0) infrastructure.push(`Último boot: <t:${lastBoot}:R>`);
  main.addFields({ name: 'INFRAESTRUTURA', value: infrastructure.join('\n'), inline: true });

  if (connectAddress) main.addFields({ name: 'CONECTAR', value: `\`${connectAddress}\``, inline: false });
  if (banner) main.setImage(banner);
  if (thumbnail) main.setThumbnail(thumbnail);
  main.setFooter({ text: 'Monitoramento ao vivo · atualização silenciosa a cada 60s' }).setTimestamp();

  const profiles = options.onlineProfiles || [];
  const embeds = [main];
  const canUsePlayerCards =
    overview.onlinePlayers.names.length > 0 &&
    overview.onlinePlayers.names.length <= 8 &&
    profiles.some((profile) => profile.avatarUrl);

  if (canUsePlayerCards) {
    for (const name of overview.onlinePlayers.names) {
      const profile = profiles.find((entry) => entry.nick.toLowerCase() === name.toLowerCase()) || { nick: name };
      const details = [];
      if (profile.faction) details.push(`🛡️ ${profile.faction}`);
      if (profile.onlineTime) details.push(`⏱️ online há ${profile.onlineTime}`);
      if (profile.discordId) details.push(`<@${profile.discordId}>`);
      const playerCard = new EmbedBuilder()
        .setColor(secondary)
        .setAuthor(profile.avatarUrl ? { name, iconURL: profile.avatarUrl } : { name })
        .setDescription(details.join(' · ') || 'Sobrevivente em atividade');
      embeds.push(playerCard);
    }
  } else {
    const online = new EmbedBuilder()
      .setColor(secondary)
      .setTitle(`👥 ${overview.onlinePlayers.count} sobrevivente${overview.onlinePlayers.count === 1 ? '' : 's'} online`);
    if (overview.onlinePlayers.names.length > 0) {
      online.setDescription(
        joinLinesLimited(
          overview.onlinePlayers.names.map((name) => {
            const profile = profiles.find((entry) => entry.nick.toLowerCase() === name.toLowerCase());
            const details = [profile?.faction ? `🛡️ ${profile.faction}` : '', profile?.onlineTime ? `⏱️ ${profile.onlineTime}` : '']
              .filter(Boolean)
              .join(' · ');
            return `▸ **${name}**${details ? `\n  ${details}` : ''}`;
          }),
          4000,
        ),
      );
    } else {
      online.setDescription('A estrada está silenciosa. Nenhum sobrevivente conectado agora.');
    }
    embeds.push(online);
  }

  return { embeds, files: getThemeAttachments(theme, 'status') };
}

function buildRankingPanelPayload(playerRows, factionRows, deathRows = [], options = {}) {
  const theme = options.theme || getSavedTheme();
  const primary = colorToNumber(theme.primaryColor);
  const secondary = colorToNumber(theme.secondaryColor, 0xf0a93b);
  const totalKills = playerRows.reduce((total, row) => total + toNumber(getField(row, ['zombiekills'])), 0);
  const totalHours = playerRows.reduce((total, row) => total + toNumber(getField(row, ['hourssurvived'])), 0);
  const factions = buildFactionLeaderboard(playerRows, factionRows);
  const deaths = buildDeathLeaderboard(playerRows, deathRows);

  const topKills = [...playerRows]
    .sort((left, right) => toNumber(getField(right, ['zombiekills'])) - toNumber(getField(left, ['zombiekills'])))
    .map((row) => ({ name: getField(row, ['username'], 'Sobrevivente'), value: toNumber(getField(row, ['zombiekills'])) }));
  const topHours = [...playerRows]
    .sort((left, right) => toNumber(getField(right, ['hourssurvived'])) - toNumber(getField(left, ['hourssurvived'])))
    .map((row) => ({ name: getField(row, ['username'], 'Sobrevivente'), value: toNumber(getField(row, ['hourssurvived'])) }));
  const topFactions = factions.map((entry) => ({
    ...entry,
    name: `${entry.name}${entry.tag ? ` [${entry.tag}]` : ''}`,
  }));

  const header = new EmbedBuilder()
    .setColor(primary)
    .setTitle(`🏆 ${theme.title} · Hall da Sobrevivência`)
    .setDescription(theme.description)
    .addFields(
      { name: 'SOBREVIVENTES', value: `\`${playerRows.length}\``, inline: true },
      { name: 'ABATES', value: `\`${totalKills.toLocaleString('pt-BR')}\``, inline: true },
      { name: 'HORAS VIVIDAS', value: `\`${totalHours.toFixed(1)}h\``, inline: true },
    );
  const rankingImage = getMediaUrl(theme.rankingBackground);
  const thumbnail = getMediaUrl(theme.thumbnail);
  if (rankingImage) header.setImage(rankingImage);
  if (thumbnail) header.setThumbnail(thumbnail);

  const embeds = [header];
  if (topKills.length > 0) {
    embeds.push(
      new EmbedBuilder()
        .setColor(secondary)
        .setTitle('🧟 CAÇADORES DE ELITE')
        .setDescription(rankingDescription(topKills, (entry) => `${entry.value.toLocaleString('pt-BR')} eliminações`)),
    );
  }
  if (topHours.length > 0) {
    embeds.push(
      new EmbedBuilder()
        .setColor(primary)
        .setTitle('⌛ VETERANOS DO APOCALIPSE')
        .setDescription(rankingDescription(topHours, (entry) => `${entry.value.toFixed(1)} horas sobrevividas`)),
    );
  }
  if (topFactions.length > 0) {
    embeds.push(
      new EmbedBuilder()
        .setColor(secondary)
        .setTitle('🛡️ DOMÍNIO DAS FACÇÕES')
        .setDescription(
          rankingDescription(topFactions, (entry) => `${entry.kills.toLocaleString('pt-BR')} abates · ${entry.members.size} membros`),
        ),
    );
  }
  if (deaths.length > 0) {
    embeds.push(
      new EmbedBuilder()
        .setColor(0xc74343)
        .setTitle('☠️ OS QUE MAIS VOLTARAM')
        .setDescription(rankingDescription(deaths.map(([name, value]) => ({ name, value })), (entry) => `${entry.value} mortes registradas`)),
    );
  }
  if (factions[0]) {
    const featured = factions[0];
    embeds.push(
      new EmbedBuilder()
        .setColor(primary)
        .setTitle('👑 FACÇÃO EM DESTAQUE')
        .setDescription(
          `**${featured.name}${featured.tag ? ` [${featured.tag}]` : ''}** lidera com ` +
            `**${featured.kills.toLocaleString('pt-BR')} abates**, **${featured.hours.toFixed(1)} horas** e ` +
            `**${featured.members.size} membros**.`,
        ),
    );
  }
  embeds[embeds.length - 1].setFooter({ text: 'Ranking atualizado silenciosamente a cada 60 segundos' }).setTimestamp();

  return { embeds, files: getThemeAttachments(theme, 'ranking') };
}

module.exports = {
  buildDeathLeaderboard,
  buildOnlineProfiles,
  buildRankingPanelPayload,
  buildServerPanelPayload,
  formatDuration,
};
