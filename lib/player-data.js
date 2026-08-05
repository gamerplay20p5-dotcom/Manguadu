const path = require('path');
const {
  cleanText,
  collectFilesRecursively,
  getField,
  isDirectory,
  parseDelimitedCsv,
  readCsvRows,
  readLatestCsvRow,
  readTextFile,
  toNumber,
  truncateLine,
} = require('./utils');
const { resolvePlayerFile, resolveServerFile } = require('./friendhost-files');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  DatabaseSync = null;
}

const perkDictionary = {
  cooking: 'Culinaria',
  fitness: 'Preparo fisico',
  strength: 'Forca',
  blunt: 'Contundente longa',
  axe: 'Machado',
  lightfoot: 'Pes leves',
  nimble: 'Agilidade',
  sprinting: 'Corrida',
  sneak: 'Furtividade',
  woodwork: 'Carpintaria',
  aiming: 'Mira',
  reloading: 'Recarga',
  farming: 'Agricultura',
  fishing: 'Pesca',
  trapping: 'Armadilhas',
  plantscavenging: 'Busca de alimentos',
  doctor: 'Primeiros socorros',
  electricity: 'Eletrica',
  blacksmith: 'Ferraria',
  metalwelding: 'Metalurgia',
  mechanics: 'Mecanica',
  spear: 'Lanca',
  maintenance: 'Manutencao',
  smallblade: 'Lamina curta',
  longblade: 'Lamina longa',
  smallblunt: 'Contundente curta',
  tailoring: 'Costura',
};

const perkEmojiMap = {
  cooking: '🍳',
  fitness: '💪',
  strength: '🏋️',
  blunt: '🔨',
  axe: '🪓',
  lightfoot: '🦶',
  nimble: '🤸',
  sprinting: '🏃',
  sneak: '🥷',
  woodwork: '🪚',
  aiming: '🎯',
  reloading: '🔁',
  farming: '🌾',
  fishing: '🎣',
  trapping: '🪤',
  plantscavenging: '🍄',
  doctor: '🩹',
  electricity: '🔌',
  blacksmith: '⚒️',
  metalwelding: '🧰',
  mechanics: '🔧',
  spear: '🗡️',
  maintenance: '🛠️',
  smallblade: '🔪',
  longblade: '⚔️',
  smallblunt: '🔩',
  tailoring: '🧵',
};

function getPerkEmoji(key) {
  return perkEmojiMap[key] || '✨';
}

function getPerkVisualLabel(key) {
  const label = perkDictionary[key] || key;
  return `${getPerkEmoji(key)} ${label}`;
}

const inventoryCategories = new Set([
  'Ammo',
  'Clothing',
  'Container',
  'Drainable',
  'Food',
  'Item',
  'Key',
  'Literature',
  'Material',
  'Moveable',
  'Normal',
  'Weapon',
  'WeaponPart',
]);

function getCsvBasePath() {
  return cleanText(process.env.CSV_BASE_PATH);
}

function getPlayersBasePath() {
  const basePath = getCsvBasePath();
  return basePath ? path.join(basePath, 'Jogadores') : '';
}

function getServerBasePath() {
  const basePath = getCsvBasePath();
  return basePath ? path.join(basePath, 'Servidor') : '';
}

function inferInventoryRow(rawRow) {
  const row = {
    itemindex: '',
    itemcategory: '',
    itemid: '',
    itemdisplayname: '',
    itemextrainfo: '',
    systemdate: '',
    systemtime: '',
    raw: rawRow.map((value) => cleanText(value)).join(' | '),
  };

  const leftovers = [];

  for (const valueRaw of rawRow) {
    const value = cleanText(valueRaw);
    if (!value) {
      continue;
    }

    if (!row.systemdate && /^\d{2}\.\d{2}\.\d{4}$/.test(value)) {
      row.systemdate = value;
      continue;
    }

    if (!row.systemtime && /^\d{2}:\d{2}:\d{2}$/.test(value)) {
      row.systemtime = value;
      continue;
    }

    if (!row.itemindex && /^\d+(?:\|\d+)*$/.test(value)) {
      row.itemindex = value;
      continue;
    }

    if (!row.itemid && /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(value)) {
      row.itemid = value;
      continue;
    }

    if (!row.itemcategory && inventoryCategories.has(value)) {
      row.itemcategory = value;
      continue;
    }

    leftovers.push(value);
  }

  if (!row.itemdisplayname && leftovers.length > 0) {
    row.itemdisplayname = leftovers.shift();
  }

  if (!row.itemextrainfo && leftovers.length > 0) {
    row.itemextrainfo = leftovers.join(' | ');
  }

  if (!row.itemdisplayname && row.itemid) {
    const pieces = row.itemid.split('.');
    row.itemdisplayname = pieces[pieces.length - 1];
  }

  return row;
}

function readInventoryRows(filePath) {
  const content = readTextFile(filePath);
  if (!content.trim()) {
    return [];
  }

  let rawRows = [];
  try {
    rawRows = parseDelimitedCsv(content, {
      delimiter: ';',
      skipEmptyLines: true,
      trim: true,
    });
  } catch (error) {
    return [];
  }

  return rawRows.map((rawRow) => inferInventoryRow(rawRow));
}

function getPlayerNames() {
  const playersBasePath = getPlayersBasePath();
  if (!isDirectory(playersBasePath)) {
    return [];
  }

  return require('fs')
    .readdirSync(playersBasePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'pt-BR'));
}

function resolvePlayerNick(nickInput) {
  const requestedNick = cleanText(nickInput);
  if (!requestedNick) {
    return null;
  }

  const players = getPlayerNames();
  const loweredRequestedNick = requestedNick.toLowerCase();

  const exact = players.find((player) => player.toLowerCase() === loweredRequestedNick);
  if (exact) {
    return exact;
  }

  const partialMatches = players.filter((player) => player.toLowerCase().includes(loweredRequestedNick));
  if (partialMatches.length === 1) {
    return partialMatches[0];
  }

  return null;
}

function getPlayerFileSet(nickInput) {
  const actualNick = resolvePlayerNick(nickInput);
  if (!actualNick) {
    return null;
  }

  const directory = path.join(getPlayersBasePath(), actualNick);

  return {
    actualNick,
    directory,
    playerFile: resolvePlayerFile(getPlayersBasePath(), actualNick, 'player'),
    perksFile: resolvePlayerFile(getPlayersBasePath(), actualNick, 'perks'),
    inventoryFile: resolvePlayerFile(getPlayersBasePath(), actualNick, 'inventory'),
  };
}

function parsePlayersList(rawValue) {
  const normalized = cleanText(rawValue);
  if (!normalized) {
    return [];
  }

  let parsed = normalized;
  if (/^Players\(/i.test(parsed)) {
    parsed = parsed.replace(/^Players\(/i, '');
  }
  parsed = parsed.replace(/\)$/, '');

  return parsed
    .split(',')
    .map((value) => cleanText(value))
    .filter(Boolean);
}

function findFactionForPlayer(playerNick, playerRow, factionRows) {
  const nick = cleanText(playerNick).toLowerCase();
  const factionName = getField(playerRow, ['factionname']);
  const factionTag = getField(playerRow, ['factiontag']);

  for (const row of factionRows) {
    const rowName = getField(row, ['name']);
    const owner = getField(row, ['owner']);
    const players = parsePlayersList(getField(row, ['players']));

    if (rowName && factionName && rowName.toLowerCase() === factionName.toLowerCase()) {
      return {
        name: rowName,
        owner,
        tag: getField(row, ['tagname'], factionTag),
        players,
        raw: row,
      };
    }

    if (owner.toLowerCase() === nick || players.some((player) => player.toLowerCase() === nick)) {
      return {
        name: rowName || factionName || 'Sem faccao',
        owner,
        tag: getField(row, ['tagname'], factionTag),
        players,
        raw: row,
      };
    }
  }

  if (factionName || factionTag) {
    return {
      name: factionName || 'Sem nome',
      owner: '',
      tag: factionTag,
      players: cleanText(playerNick) ? [cleanText(playerNick)] : [],
      raw: null,
    };
  }

  return null;
}

function findSafehousesForPlayer(playerNick, playerRow, safehouseRows) {
  const nick = cleanText(playerNick).toLowerCase();
  const safehouseTitle = getField(playerRow, ['safehousetitle']);

  return safehouseRows.filter((row) => {
    const owner = getField(row, ['owner']).toLowerCase();
    const title = getField(row, ['title']);
    const players = parsePlayersList(getField(row, ['players']));

    return (
      owner === nick ||
      players.some((player) => player.toLowerCase() === nick) ||
      (safehouseTitle && title && title.toLowerCase() === safehouseTitle.toLowerCase())
    );
  });
}

function getPerkEntries(perksRow, includeZeroLevels = true) {
  if (!perksRow) {
    return [];
  }

  const ignoredKeys = new Set(['systemdate', 'systemtime', 'gametime', 'steamid', 'username', 'charname']);

  return Object.entries(perksRow)
    .filter(([key]) => !ignoredKeys.has(key))
    .map(([key, value]) => ({
      key,
      label: perkDictionary[key] || key,
      visualLabel: getPerkVisualLabel(key),
      emoji: getPerkEmoji(key),
      value: toNumber(value),
    }))
    .filter((entry) => includeZeroLevels || entry.value > 0)
    .sort((left, right) => {
      if (right.value !== left.value) {
        return right.value - left.value;
      }
      return left.label.localeCompare(right.label, 'pt-BR');
    });
}

function summarizeInventory(inventoryRows) {
  const grouped = new Map();
  const categories = new Map();

  for (const row of inventoryRows) {
    const displayName = getField(row, ['itemdisplayname'], getField(row, ['itemid'], 'Item desconhecido'));
    const itemId = getField(row, ['itemid']);
    const category = getField(row, ['itemcategory'], 'Sem categoria');
    const extra = getField(row, ['itemextrainfo']);
    const key = `${displayName}|||${itemId}|||${category}|||${extra}`;

    grouped.set(key, {
      name: displayName,
      itemId,
      category,
      extra,
      count: (grouped.get(key)?.count || 0) + 1,
    });

    categories.set(category, (categories.get(category) || 0) + 1);
  }

  return {
    totalRows: inventoryRows.length,
    uniqueItems: grouped.size,
    items: Array.from(grouped.values()).sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.name.localeCompare(right.name, 'pt-BR');
    }),
    categories: Array.from(categories.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count),
  };
}

function buildDiscoveryRoots() {
  const roots = new Set();
  const seedPaths = [cleanText(process.env.CSV_BASE_PATH), cleanText(process.env.LOGS_PATH)].filter(Boolean);

  for (const seed of seedPaths) {
    let current = path.resolve(seed);
    for (let depth = 0; depth < 6; depth += 1) {
      roots.add(path.join(current, 'db'));
      roots.add(path.join(current, 'DB'));
      roots.add(path.join(current, '.cache', 'db'));
      roots.add(path.join(current, '.cache', 'DB'));
      roots.add(path.join(current, 'Saves', 'Multiplayer'));
      roots.add(path.join(current, '.cache', 'Saves', 'Multiplayer'));

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return Array.from(roots).filter((candidate) => isDirectory(candidate));
}

function escapeSqliteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function tryReadSqliteMatches(filePath, searchTokens) {
  if (!DatabaseSync || searchTokens.length === 0) {
    return null;
  }

  let database = null;

  try {
    database = new DatabaseSync(filePath, { readonly: true });
  } catch (error) {
    return null;
  }

  const result = {
    filePath,
    tables: [],
  };

  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();

    for (const table of tables) {
      const tableName = table.name;
      let columns = [];

      try {
        columns = database.prepare(`PRAGMA table_info(${escapeSqliteIdentifier(tableName)})`).all();
      } catch (error) {
        continue;
      }

      const searchableColumns = columns
        .map((column) => cleanText(column.name))
        .filter((columnName) => /name|username|user|steam|char|player|owner/i.test(columnName));

      if (searchableColumns.length === 0) {
        continue;
      }

      const whereParts = [];
      const parameters = [];

      for (const columnName of searchableColumns) {
        for (const token of searchTokens) {
          whereParts.push(`LOWER(CAST(${escapeSqliteIdentifier(columnName)} AS TEXT)) LIKE ?`);
          parameters.push(`%${token}%`);
        }
      }

      let rows = [];
      try {
        rows = database
          .prepare(`SELECT * FROM ${escapeSqliteIdentifier(tableName)} WHERE ${whereParts.join(' OR ')} LIMIT 5`)
          .all(...parameters);
      } catch (error) {
        continue;
      }

      if (rows.length > 0) {
        result.tables.push({
          name: tableName,
          rows: rows.map((row) => {
            const formatted = {};
            for (const [key, value] of Object.entries(row)) {
              if (value === null || value === undefined) {
                formatted[key] = '';
              } else if (Buffer.isBuffer(value)) {
                formatted[key] = `<blob ${value.length} bytes>`;
              } else {
                formatted[key] = truncateLine(String(value), 220);
              }
            }
            return formatted;
          }),
        });
      }
    }
  } finally {
    try {
      database.close();
    } catch (error) {
      // ignore
    }
  }

  return result.tables.length > 0 ? result : null;
}

function tryReadTextDbMatches(filePath, searchTokens) {
  const extension = path.extname(filePath).toLowerCase();
  if (!['.json', '.txt', '.ini', '.cfg', '.csv', '.log'].includes(extension)) {
    return null;
  }

  const fs = require('fs');
  const stat = fs.statSync(filePath);
  if (stat.size > 2 * 1024 * 1024) {
    return null;
  }

  const content = readTextFile(filePath);
  if (!content) {
    return null;
  }

  const loweredContent = content.toLowerCase();
  const loweredName = path.basename(filePath).toLowerCase();
  const matched = searchTokens.some((token) => loweredName.includes(token) || loweredContent.includes(token));
  if (!matched) {
    return null;
  }

  const lines = content
    .split(/\r?\n/)
    .filter((line) => searchTokens.some((token) => line.toLowerCase().includes(token)))
    .slice(0, 20)
    .map((line) => truncateLine(line, 220));

  return {
    filePath,
    lines,
  };
}

function discoverPlayerDbData(nick, steamId) {
  const searchTokens = [cleanText(nick).toLowerCase(), cleanText(steamId).toLowerCase()].filter(Boolean);
  const roots = buildDiscoveryRoots();

  const result = {
    roots,
    sqliteMatches: [],
    textMatches: [],
  };

  if (searchTokens.length === 0 || roots.length === 0) {
    return result;
  }

  const candidateFiles = [];
  for (const root of roots) {
    collectFilesRecursively(
      root,
      (filePath, entry) => /\.(db|sqlite|sqlite3|json|txt|ini|cfg|csv|log)$/i.test(entry.name),
      3,
      candidateFiles,
      120,
    );
  }

  for (const filePath of candidateFiles) {
    if (/\.(db|sqlite|sqlite3)$/i.test(filePath)) {
      const sqliteMatch = tryReadSqliteMatches(filePath, searchTokens);
      if (sqliteMatch) {
        result.sqliteMatches.push(sqliteMatch);
      }
      continue;
    }

    const textMatch = tryReadTextDbMatches(filePath, searchTokens);
    if (textMatch) {
      result.textMatches.push(textMatch);
    }
  }

  return result;
}

function collectPlayerSnapshot(nickInput, options = {}) {
  const availablePlayers = getPlayerNames();
  const requestedNick = cleanText(nickInput);

  if (!requestedNick) {
    return {
      found: false,
      availablePlayers,
      reason: 'missing_nick',
    };
  }

  const files = getPlayerFileSet(requestedNick);
  if (!files) {
    return {
      found: false,
      availablePlayers,
      reason: 'not_found',
    };
  }

  const includeInventory = options.includeInventory === true;
  const includeDb = options.includeDb === true;

  const playerRow = readLatestCsvRow(files.playerFile);
  const perksRow = readLatestCsvRow(files.perksFile);
  const inventoryRows = includeInventory ? readInventoryRows(files.inventoryFile) : [];
  const factionRows = readCsvRows(resolveServerFile(getServerBasePath(), 'factions'));
  const safehouseRows = readCsvRows(resolveServerFile(getServerBasePath(), 'safehouses'));

  if (!playerRow && !perksRow && inventoryRows.length === 0) {
    return {
      found: false,
      availablePlayers,
      reason: 'files_missing',
      actualNick: files.actualNick,
    };
  }

  const faction = findFactionForPlayer(files.actualNick, playerRow, factionRows);
  const safehouses = findSafehousesForPlayer(files.actualNick, playerRow, safehouseRows);
  const inventorySummary = summarizeInventory(inventoryRows);
  const steamId = getField(playerRow, ['steamid']);
  const dbData = includeDb ? discoverPlayerDbData(files.actualNick, steamId) : { roots: [], sqliteMatches: [], textMatches: [] };

  return {
    found: true,
    requestedNick,
    actualNick: files.actualNick,
    files,
    availablePlayers,
    playerRow,
    perksRow,
    inventoryRows,
    inventorySummary,
    faction,
    factionRows,
    safehouses,
    dbData,
  };
}

module.exports = {
  collectPlayerSnapshot,
  discoverPlayerDbData,
  getCsvBasePath,
  getPerkEmoji,
  getPerkEntries,
  getPerkVisualLabel,
  getPlayerFileSet,
  getPlayerNames,
  getPlayersBasePath,
  getServerBasePath,
  parsePlayersList,
  perkDictionary,
  perkEmojiMap,
  readInventoryRows,
  resolvePlayerNick,
  summarizeInventory,
};
