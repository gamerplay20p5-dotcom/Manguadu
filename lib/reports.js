const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { getField, joinLinesLimited, toBoolean, toNumber } = require('./utils');
const { getPerkEntries, parsePlayersList } = require('./player-data');

function pickHealthEmoji(alive, healthValue) {
  const health = Number.parseFloat(String(healthValue || '').replace(',', '.'));
  if (!alive) {
    return '💀';
  }
  if (!Number.isFinite(health)) {
    return '🫀';
  }
  if (health >= 75) {
    return '💚';
  }
  if (health >= 40) {
    return '💛';
  }
  return '❤️';
}

function medalForIndex(index) {
  if (index === 0) {
    return '🥇';
  }
  if (index === 1) {
    return '🥈';
  }
  if (index === 2) {
    return '🥉';
  }
  return `\`${index + 1}\``;
}

function formatPerkPreview(perks, limit = 6) {
  if (!perks || perks.length === 0) {
    return '✨ Nenhuma skill acima de 0 registrada.';
  }

  return perks
    .slice(0, limit)
    .map((perk) => `${perk.emoji || '✨'} ${perk.label} • \`${perk.value}\``)
    .join('\n');
}

function formatInventoryCategoryPreview(summary, limit = 4) {
  if (!summary || !summary.categories || summary.categories.length === 0) {
    return '📦 Sem categorias registradas.';
  }

  return summary.categories
    .slice(0, limit)
    .map((entry) => `• ${entry.name}: \`${entry.count}\``)
    .join('\n');
}

function formatSafehouseLine(row) {
  const title = getField(row, ['title'], 'Sem titulo');
  const owner = getField(row, ['owner'], 'Sem dono');
  const x = getField(row, ['x'], '?');
  const y = getField(row, ['y'], '?');
  const x2 = getField(row, ['x2'], '?');
  const y2 = getField(row, ['y2'], '?');
  return `${title} | dono: ${owner} | area: (${x}, ${y}) -> (${x2}, ${y2})`;
}

function buildPlayersListMessage(players) {
  if (!players || players.length === 0) {
    return '🧍 Nenhum jogador disponivel nos CSVs do FriendHost.';
  }

  const lines = players.map((player, index) => `${medalForIndex(index)} ${player}`);
  return `🗂️ Jogadores disponiveis (${players.length}):\n${joinLinesLimited(lines, 1800)}`;
}

function buildStatusEmbed(snapshot) {
  const playerRow = snapshot.playerRow || {};
  const alive = toBoolean(getField(playerRow, ['isalive']));
  const healthEmoji = pickHealthEmoji(alive, getField(playerRow, ['health']));
  const title = getField(playerRow, ['charname'], snapshot.actualNick);
  const factionName = snapshot.faction?.name || getField(playerRow, ['factionname'], 'Lobo solitario');
  const factionTag = snapshot.faction?.tag || getField(playerRow, ['factiontag']);
  const safehouseTitle =
    getField(playerRow, ['safehousetitle']) || getField(snapshot.safehouses[0], ['title'], 'Nenhuma vinculada');
  const position = `${getField(playerRow, ['x'], '?')}, ${getField(playerRow, ['y'], '?')}, ${getField(playerRow, ['z'], '?')}`;
  const positivePerks = getPerkEntries(snapshot.perksRow, false);

  return new EmbedBuilder()
    .setColor(alive ? 0x2ecc71 : 0xe74c3c)
    .setTitle(`🧾 Perfil de ${title}`)
    .setDescription(
      [
        `🎮 **Nick:** ${snapshot.actualNick}`,
        `${healthEmoji} **Status:** ${alive ? 'Vivo' : 'Morto'}`,
        `🛡️ **Faccao:** ${factionTag ? `${factionName} [${factionTag}]` : factionName}`,
        `🏠 **Safehouse:** ${safehouseTitle}`,
      ].join('\n'),
    )
    .addFields(
      { name: '🧰 Profissao', value: getField(playerRow, ['profession'], 'N/A'), inline: true },
      { name: '🧟 Zumbis mortos', value: String(toNumber(getField(playerRow, ['zombiekills']))), inline: true },
      {
        name: '⏳ Horas vividas',
        value: toNumber(getField(playerRow, ['hourssurvived'])).toFixed(1),
        inline: true,
      },
      { name: `${healthEmoji} Vida`, value: getField(playerRow, ['health'], 'N/A'), inline: true },
      { name: '🆔 SteamID', value: getField(playerRow, ['steamid'], 'N/A'), inline: true },
      { name: '📍 Posicao', value: position, inline: true },
      { name: '✨ Skills em destaque', value: formatPerkPreview(positivePerks, 5), inline: false },
      { name: '⚔️ Arma favorita', value: getField(playerRow, ['favoriteweapon'], 'Nenhuma'), inline: false },
    )
    .setTimestamp();
}

function buildStatusCompleteEmbed(snapshot) {
  const playerRow = snapshot.playerRow || {};
  const alive = toBoolean(getField(playerRow, ['isalive']));
  const positivePerks = getPerkEntries(snapshot.perksRow, false);
  const factionName = snapshot.faction?.name || getField(playerRow, ['factionname'], 'Sem faccao');
  const factionTag = snapshot.faction?.tag || getField(playerRow, ['factiontag']);
  const healthEmoji = pickHealthEmoji(alive, getField(playerRow, ['health']));

  return new EmbedBuilder()
    .setColor(alive ? 0x1abc9c : 0xc0392b)
    .setTitle(`📚 Ficha completa de ${getField(playerRow, ['charname'], snapshot.actualNick)}`)
    .setDescription(
      [
        `🎮 **Nick:** ${snapshot.actualNick}`,
        `${healthEmoji} **Status:** ${alive ? 'Vivo' : 'Morto'}`,
        `🛡️ **Faccao:** ${factionTag ? `${factionName} [${factionTag}]` : factionName}`,
        `🏠 **Safehouses vinculadas:** ${snapshot.safehouses.length}`,
      ].join('\n'),
    )
    .addFields(
      {
        name: '🫀 Sobrevivencia',
        value: [
          `🧟 Zumbis: \`${toNumber(getField(playerRow, ['zombiekills']))}\``,
          `⏳ Horas: \`${toNumber(getField(playerRow, ['hourssurvived'])).toFixed(1)}\``,
          `${healthEmoji} Vida: \`${getField(playerRow, ['health'], 'N/A')}\``,
          `🦠 Infeccao: \`${getField(playerRow, ['infectionlevel'], '0')}\``,
        ].join('\n'),
        inline: true,
      },
      {
        name: '🎒 Inventario',
        value: [
          `📦 Linhas: \`${snapshot.inventorySummary.totalRows}\``,
          `🧩 Itens unicos: \`${snapshot.inventorySummary.uniqueItems}\``,
          `🗃️ Categorias: \`${snapshot.inventorySummary.categories.length}\``,
        ].join('\n'),
        inline: true,
      },
      {
        name: '🛰️ Extras',
        value: [
          `✨ Skills > 0: \`${positivePerks.length}\``,
          `💾 DBs com match: \`${snapshot.dbData.sqliteMatches.length}\``,
          `📄 Arquivos com match: \`${snapshot.dbData.textMatches.length}\``,
        ].join('\n'),
        inline: true,
      },
      {
        name: '🌟 Skills em destaque',
        value: formatPerkPreview(positivePerks, 8),
        inline: false,
      },
      {
        name: '📦 Categorias do inventario',
        value: formatInventoryCategoryPreview(snapshot.inventorySummary, 5),
        inline: false,
      },
    )
    .setFooter({ text: '📎 Relatorio completo anexado em .txt' })
    .setTimestamp();
}

function buildStatusCompleteReport(snapshot) {
  const lines = [];
  const playerRow = snapshot.playerRow || {};
  const allPerks = getPerkEntries(snapshot.perksRow, true);
  const alive = toBoolean(getField(playerRow, ['isalive']));
  const factionName = snapshot.faction?.name || getField(playerRow, ['factionname'], 'Sem faccao');
  const factionTag = snapshot.faction?.tag || getField(playerRow, ['factiontag']);

  function section(title) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(title);
    lines.push('-'.repeat(title.length));
  }

  lines.push(`STATUS COMPLETO - ${snapshot.actualNick}`);
  lines.push(`Gerado em: ${new Date().toISOString()}`);

  section('Arquivos lidos');
  lines.push(`player: ${snapshot.files.playerFile}`);
  lines.push(`perks: ${snapshot.files.perksFile}`);
  lines.push(`inventario: ${snapshot.files.inventoryFile}`);

  section('Identificacao');
  lines.push(`Nick: ${snapshot.actualNick}`);
  lines.push(`Personagem: ${getField(playerRow, ['charname'], snapshot.actualNick)}`);
  lines.push(`SteamID: ${getField(playerRow, ['steamid'], 'N/A')}`);
  lines.push(`Profissao: ${getField(playerRow, ['profession'], 'N/A')}`);
  lines.push(`Traits: ${getField(playerRow, ['traits'], 'N/A')}`);

  section('Sobrevivencia');
  lines.push(`Status: ${alive ? 'Vivo' : 'Morto'}`);
  lines.push(`Zumbis mortos: ${toNumber(getField(playerRow, ['zombiekills']))}`);
  lines.push(`Horas vividas: ${toNumber(getField(playerRow, ['hourssurvived'])).toFixed(1)}`);
  lines.push(`Tempo sobrevivido: ${getField(playerRow, ['timesurvived'], 'N/A')}`);
  lines.push(`Vida: ${getField(playerRow, ['health'], 'N/A')}`);
  lines.push(`Lesao: ${getField(playerRow, ['hasinjury'], 'N/A')}`);
  lines.push(`Infeccao: ${getField(playerRow, ['infectionlevel'], '0')}`);
  lines.push(`Falsa infeccao: ${getField(playerRow, ['fakeinfectionlevel'], 'N/A')}`);
  lines.push(`Molhado: ${getField(playerRow, ['wetness'], 'N/A')}`);
  lines.push(`Peso: ${getField(playerRow, ['weight'], 'N/A')}`);
  lines.push(`Arma favorita: ${getField(playerRow, ['favoriteweapon'], 'Nenhuma')}`);
  lines.push(`Golpes com arma favorita: ${getField(playerRow, ['favoriteweaponhit'], '0')}`);
  lines.push(
    `Posicao: ${getField(playerRow, ['x'], '?')}, ${getField(playerRow, ['y'], '?')}, ${getField(playerRow, ['z'], '?')}`,
  );

  section('Faccao');
  lines.push(`Nome: ${factionName}`);
  lines.push(`Tag: ${factionTag || 'Sem tag'}`);
  lines.push(`Dono: ${snapshot.faction?.owner || 'Nao informado'}`);
  lines.push(
    `Membros: ${snapshot.faction?.players && snapshot.faction.players.length > 0 ? snapshot.faction.players.join(', ') : 'Nenhum/nao informado'}`,
  );

  section('Safehouses');
  if (snapshot.safehouses.length === 0) {
    lines.push('Nenhuma safehouse vinculada.');
  } else {
    snapshot.safehouses.forEach((row, index) => {
      lines.push(`${index + 1}. ${formatSafehouseLine(row)}`);
    });
  }

  section('Skills');
  if (allPerks.length === 0) {
    lines.push('Nenhuma skill registrada.');
  } else {
    allPerks.forEach((perk) => {
      lines.push(`${perk.label}: ${perk.value}`);
    });
  }

  section('Inventario');
  lines.push(`Linhas brutas: ${snapshot.inventorySummary.totalRows}`);
  lines.push(`Itens unicos: ${snapshot.inventorySummary.uniqueItems}`);
  lines.push(
    `Categorias: ${snapshot.inventorySummary.categories.length > 0 ? snapshot.inventorySummary.categories.map((entry) => `${entry.name}=${entry.count}`).join(', ') : 'Nenhuma'}`,
  );

  if (snapshot.inventorySummary.items.length === 0) {
    lines.push('Nenhum item encontrado.');
  } else {
    lines.push('Itens agrupados:');
    snapshot.inventorySummary.items.forEach((item) => {
      const detail = item.extra ? ` | extra: ${item.extra}` : '';
      const itemId = item.itemId ? ` | id: ${item.itemId}` : '';
      lines.push(`x${item.count} ${item.name} | categoria: ${item.category}${itemId}${detail}`);
    });
  }

  if (snapshot.inventoryRows.length > 0) {
    lines.push('');
    lines.push('Linhas brutas do inventario (primeiras 250):');
    snapshot.inventoryRows.slice(0, 250).forEach((row, index) => {
      lines.push(`${index + 1}. ${row.raw}`);
    });
    if (snapshot.inventoryRows.length > 250) {
      lines.push(`... ${snapshot.inventoryRows.length - 250} linha(s) omitidas.`);
    }
  }

  section('DB externa');
  if (snapshot.dbData.roots.length === 0) {
    lines.push('Nenhum diretorio candidato de DB encontrado perto do FriendHost.');
  } else {
    lines.push(`Diretorios candidatos: ${snapshot.dbData.roots.join(' | ')}`);
  }

  if (snapshot.dbData.sqliteMatches.length === 0 && snapshot.dbData.textMatches.length === 0) {
    lines.push('Nenhum registro adicional encontrado para este jogador.');
  } else {
    snapshot.dbData.sqliteMatches.forEach((match) => {
      lines.push(`SQLite: ${match.filePath}`);
      match.tables.forEach((table) => {
        lines.push(`  Tabela: ${table.name}`);
        table.rows.forEach((row) => {
          lines.push(
            `    ${Object.entries(row)
              .map(([key, value]) => `${key}=${value}`)
              .join(' | ')}`,
          );
        });
      });
    });

    snapshot.dbData.textMatches.forEach((match) => {
      lines.push(`Arquivo texto: ${match.filePath}`);
      match.lines.forEach((line) => {
        lines.push(`  ${line}`);
      });
    });
  }

  return `${lines.join('\n')}\n`;
}

function buildStatusCompleteAttachment(snapshot) {
  const report = buildStatusCompleteReport(snapshot);
  return new AttachmentBuilder(Buffer.from(report, 'utf8'), {
    name: `statuscomplete-${snapshot.actualNick}.txt`,
  });
}

function buildFactionLeaderboard(playerRows, factionRows) {
  const factions = new Map();

  function ensureFaction(name) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
      return null;
    }

    if (!factions.has(normalizedName)) {
      factions.set(normalizedName, {
        name: normalizedName,
        owner: '',
        tag: '',
        members: new Set(),
        kills: 0,
        hours: 0,
      });
    }

    return factions.get(normalizedName);
  }

  for (const row of factionRows) {
    const name = getField(row, ['name']);
    const entry = ensureFaction(name);
    if (!entry) {
      continue;
    }

    entry.owner = getField(row, ['owner'], entry.owner);
    entry.tag = getField(row, ['tagname'], entry.tag);

    const players = parsePlayersList(getField(row, ['players']));
    players.forEach((player) => entry.members.add(player));
    if (entry.owner) {
      entry.members.add(entry.owner);
    }
  }

  for (const row of playerRows) {
    const factionName = getField(row, ['factionname']);
    const username = getField(row, ['username']);
    const entry = ensureFaction(factionName);
    if (!entry) {
      continue;
    }

    if (username) {
      entry.members.add(username);
    }

    entry.kills += toNumber(getField(row, ['zombiekills']));
    entry.hours += toNumber(getField(row, ['hourssurvived']));
  }

  return Array.from(factions.values()).sort((left, right) => {
    if (right.kills !== left.kills) {
      return right.kills - left.kills;
    }
    if (right.hours !== left.hours) {
      return right.hours - left.hours;
    }
    return right.members.size - left.members.size;
  });
}

function buildRankingEmbed(playerRows, factionRows) {
  const zombiesTotal = playerRows.reduce((total, row) => total + toNumber(getField(row, ['zombiekills'])), 0);
  const hoursTotal = playerRows.reduce((total, row) => total + toNumber(getField(row, ['hourssurvived'])), 0);
  const factionLeaderboard = buildFactionLeaderboard(playerRows, factionRows);

  const topKills = [...playerRows]
    .sort((left, right) => toNumber(getField(right, ['zombiekills'])) - toNumber(getField(left, ['zombiekills'])))
    .slice(0, 10)
    .map(
      (row, index) =>
        `${medalForIndex(index)} ${getField(row, ['username'], 'Sem nick')}  |  \`${toNumber(getField(row, ['zombiekills']))} zumbis\``,
    );

  const topHours = [...playerRows]
    .sort((left, right) => toNumber(getField(right, ['hourssurvived'])) - toNumber(getField(left, ['hourssurvived'])))
    .slice(0, 10)
    .map(
      (row, index) =>
        `${medalForIndex(index)} ${getField(row, ['username'], 'Sem nick')}  |  \`${toNumber(getField(row, ['hourssurvived'])).toFixed(1)} h\``,
    );

  const topFactions = factionLeaderboard
    .slice(0, 10)
    .map((entry, index) => {
      const tag = entry.tag ? ` [${entry.tag}]` : '';
      return `${medalForIndex(index)} ${entry.name}${tag}  |  \`${entry.kills} zumbis\`  |  \`${entry.members.size} membro(s)\``;
    });

  const bestFaction = factionLeaderboard[0];
  const summaryField = [
    `Jogadores\n\`${playerRows.length}\``,
    `Faccoes\n\`${factionRows.length}\``,
    `Atualizacao\n\`60s\``,
  ].join('\n\n');

  const totalsField = [
    `Zumbis\n\`${zombiesTotal}\``,
    `Horas\n\`${hoursTotal.toFixed(1)}\``,
    `Media por player\n\`${playerRows.length > 0 ? (zombiesTotal / playerRows.length).toFixed(1) : '0.0'}\``,
  ].join('\n\n');

  const highlightField = bestFaction
    ? [
        `Nome\n\`${bestFaction.name}${bestFaction.tag ? ` [${bestFaction.tag}]` : ''}\``,
        `Zumbis\n\`${bestFaction.kills}\``,
        `Membros\n\`${bestFaction.members.size}\``,
      ].join('\n\n')
    : 'Nenhuma faccao registrada.';

  return new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('🏆 Painel de ranking')
    .setDescription('📊 Resumo geral do servidor a partir dos dados coletados pelo FriendHost.')
    .addFields(
      { name: '🧾 Resumo', value: summaryField, inline: true },
      { name: '📌 Totais', value: totalsField, inline: true },
      { name: '👑 Faccao em destaque', value: highlightField, inline: true },
      { name: '🧟 Top zumbis', value: joinLinesLimited(topKills, 1024), inline: false },
      { name: '⏳ Top horas', value: joinLinesLimited(topHours, 1024), inline: false },
      { name: '🛡️ Top faccoes', value: joinLinesLimited(topFactions, 1024), inline: false },
    )
    .setFooter({ text: '⏱️ Atualizado automaticamente a cada 60 segundos' })
    .setTimestamp();
}

function buildServerStatusEmbed(overview, footerText) {
  const hasLiveRcon = overview.rconPlayers.ok;
  const hasPanel = overview.ptero.ok && overview.ptero.transport !== 'docker';
  const hasLocalDocker = overview.ptero.ok && overview.ptero.transport === 'docker';
  const isDegraded = overview.isOnline && (!hasLiveRcon || !hasPanel);

  let color = 0xe74c3c;
  if (overview.isOnline && !isDegraded) {
    color = 0x2ecc71;
  } else if (overview.isOnline) {
    color = 0xf39c12;
  }

  const stateLabelMap = {
    running: 'Online',
    starting: 'Iniciando',
    stopping: 'Desligando',
    offline: 'Offline',
  };

  const sourceLabelMap = {
    rcon: 'RCON ao vivo',
    csv: 'CSV FriendHost',
    none: 'Sem leitura',
  };

  const stateLabel = stateLabelMap[(overview.currentState || '').toLowerCase()] || (overview.currentState || 'Desconhecido');
  const panelLabel = hasPanel ? 'Conectado' : hasLocalDocker ? 'Fallback Docker' : 'Indisponivel';
  const rconLabel = hasLiveRcon ? 'Conectado' : 'Indisponivel';
  const sourceLabel = sourceLabelMap[overview.onlinePlayers.source] || overview.onlinePlayers.source || 'Desconhecido';
  const playersLabel = overview.onlinePlayers.count === 1 ? '1 sobrevivente ativo.' : `${overview.onlinePlayers.count} sobreviventes ativos.`;

  const namesLines =
    overview.onlinePlayers.names.length > 0
      ? overview.onlinePlayers.names.map((name, index) => `${index + 1}. ${name}`)
      : ['Nenhum sobrevivente online no momento.'];

  const serverField = [
    `Estado\n\`${stateLabel}\``,
    `Painel\n\`${panelLabel}\``,
    `RCON\n\`${rconLabel}\``,
  ].join('\n\n');

  const worldField = [
    `Hora\n\`${overview.world?.timeOfDay || 'N/A'}\``,
    `Dia\n\`${overview.world?.gameDate || 'N/A'}\``,
    `Temperatura\n\`${overview.world?.temperature ? `${overview.world.temperature} C` : 'N/A'}\``,
  ].join('\n\n');

  const readingField = [
    `Players\n\`${overview.onlinePlayers.count}\``,
    `Leitura\n\`${sourceLabel}\``,
    `Atualizacao\n\`60s\``,
  ].join('\n\n');

  const description = overview.isOnline
    ? `Servidor operacional. ${playersLabel}`
    : 'Servidor indisponivel ou em reinicializacao.';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('📡 Painel do servidor')
    .setDescription(description)
    .addFields({
      name: '🖥️ Servidor',
      value: serverField,
      inline: true,
    })
    .addFields({
      name: '🌍 Mundo',
      value: worldField,
      inline: true,
    })
    .addFields({
      name: '📶 Leitura',
      value: readingField,
      inline: true,
    })
    .addFields({
      name: `🧍 Sobreviventes online`,
      value: joinLinesLimited(namesLines, 1024),
      inline: false,
    })
    .setTimestamp();

  if (footerText) {
    embed.setFooter({ text: footerText });
  }

  return embed;
}

module.exports = {
  buildFactionLeaderboard,
  buildPlayersListMessage,
  buildRankingEmbed,
  buildServerStatusEmbed,
  buildStatusCompleteAttachment,
  buildStatusCompleteEmbed,
  buildStatusCompleteReport,
  buildStatusEmbed,
  formatSafehouseLine,
};
