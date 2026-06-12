const fs = require('fs');
const path = require('path');

const {
  cleanText,
  collectFilesRecursively,
  getField,
  readCsvRows,
  readLatestCsvRow,
  readTextFile,
  toNumber,
  truncateLine,
} = require('./utils');
const { getPerkEntries, getPlayerNames, getPlayersBasePath, getServerBasePath } = require('./player-data');

const DEFAULT_MAPS_CONFIG = path.join(__dirname, '..', 'config', 'pz-maps.json');

function getPlayerRows() {
  const playersBasePath = getPlayersBasePath();
  if (!playersBasePath) {
    return [];
  }

  return getPlayerNames()
    .map((nick) => {
      const row = readLatestCsvRow(path.join(playersBasePath, nick, `player_${nick}.csv`));
      return row ? { nick, row } : null;
    })
    .filter(Boolean);
}

function findPlayerRecord(nickInput) {
  const target = cleanText(nickInput).toLowerCase();
  if (!target) {
    return null;
  }

  return (
    getPlayerRows().find(({ nick, row }) => {
      const candidates = [nick, getField(row, ['username']), getField(row, ['charname'])]
        .map((value) => cleanText(value).toLowerCase())
        .filter(Boolean);
      return candidates.includes(target);
    }) || null
  );
}

function parseListField(value) {
  const normalized = cleanText(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .replace(/^\[|\]$/g, '')
    .replace(/^\(|\)$/g, '')
    .split(/[,;|]+/)
    .map((entry) => cleanText(entry).replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function getPlayerTraits(playerRow) {
  const rawTraits = getField(playerRow, ['traits', 'traitlist', 'playertraits', 'charactertraits']);
  const positive = getField(playerRow, ['positivetraits', 'goodtraits']);
  const negative = getField(playerRow, ['negativetraits', 'badtraits']);
  return {
    profession: getField(playerRow, ['profession', 'professionname'], 'Nao informada'),
    traits: parseListField(rawTraits),
    positive: parseListField(positive),
    negative: parseListField(negative),
  };
}

function getPlayerSkills(nickInput) {
  const record = findPlayerRecord(nickInput);
  if (!record) {
    return null;
  }

  const perksFile = path.join(getPlayersBasePath(), record.nick, `playerperks_${record.nick}.csv`);
  const perksRow = readLatestCsvRow(perksFile);
  return {
    ...record,
    perksRow,
    skills: getPerkEntries(perksRow, true),
  };
}

function getPlayerRank(nickInput, metric = 'zombiekills') {
  const normalizedMetric = metric === 'hours' ? 'hourssurvived' : 'zombiekills';
  const rows = getPlayerRows()
    .map((entry) => ({
      ...entry,
      value: toNumber(getField(entry.row, [normalizedMetric])),
    }))
    .sort((left, right) => right.value - left.value || left.nick.localeCompare(right.nick, 'pt-BR'));
  const target = cleanText(nickInput).toLowerCase();
  const index = rows.findIndex(({ nick, row }) =>
    [nick, getField(row, ['username']), getField(row, ['charname'])]
      .map((value) => cleanText(value).toLowerCase())
      .includes(target),
  );

  if (index < 0) {
    return null;
  }

  return {
    metric: normalizedMetric,
    position: index + 1,
    total: rows.length,
    entry: rows[index],
    leaderboard: rows.slice(0, 10),
  };
}

function findVehicleFiles() {
  const serverBasePath = getServerBasePath();
  if (!serverBasePath) {
    return [];
  }

  return collectFilesRecursively(
    serverBasePath,
    (filePath, entry) => /vehicle.*\.csv$|vehicles\.csv$/i.test(entry.name),
    3,
    [],
    20,
  );
}

function findVehicleById(vehicleIdInput) {
  const target = cleanText(vehicleIdInput).toLowerCase();
  if (!target) {
    return null;
  }

  for (const filePath of findVehicleFiles()) {
    for (const row of readCsvRows(filePath)) {
      const identifiers = [
        getField(row, ['vehicleid']),
        getField(row, ['id']),
        getField(row, ['sqlid']),
        getField(row, ['vehicle_id']),
      ]
        .map((value) => cleanText(value).toLowerCase())
        .filter(Boolean);
      if (identifiers.includes(target)) {
        return { filePath, row };
      }
    }
  }

  return null;
}

function getSafehouses() {
  return readCsvRows(path.join(getServerBasePath(), 'safehouses.csv'));
}

function normalizeMap(rawMap, index) {
  const minX = toNumber(rawMap?.minX ?? rawMap?.x1);
  const minY = toNumber(rawMap?.minY ?? rawMap?.y1);
  const maxX = toNumber(rawMap?.maxX ?? rawMap?.x2);
  const maxY = toNumber(rawMap?.maxY ?? rawMap?.y2);
  return {
    id: cleanText(rawMap?.id || rawMap?.name || `map-${index + 1}`).toLowerCase().replace(/\s+/g, '-'),
    name: cleanText(rawMap?.name || rawMap?.id || `Mapa ${index + 1}`),
    minX: Math.min(minX, maxX),
    minY: Math.min(minY, maxY),
    maxX: Math.max(minX, maxX),
    maxY: Math.max(minY, maxY),
    enabled: rawMap?.enabled !== false,
  };
}

function getMapsConfigPath() {
  return cleanText(process.env.PZ_MAPS_CONFIG_PATH) || DEFAULT_MAPS_CONFIG;
}

function getMaps() {
  const configPath = getMapsConfigPath();
  try {
    if (!fs.existsSync(configPath)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const maps = Array.isArray(parsed) ? parsed : parsed.maps;
    return (Array.isArray(maps) ? maps : []).map(normalizeMap).filter((map) => map.enabled && map.maxX > map.minX && map.maxY > map.minY);
  } catch (error) {
    return [];
  }
}

function findMapByName(mapInput) {
  const target = cleanText(mapInput).toLowerCase();
  return getMaps().find((map) => map.id === target || map.name.toLowerCase() === target) || null;
}

function getWorldBounds(points = []) {
  const maps = getMaps();
  const coordinates = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const xs = [...maps.flatMap((map) => [map.minX, map.maxX]), ...coordinates.map((point) => point.x)];
  const ys = [...maps.flatMap((map) => [map.minY, map.maxY]), ...coordinates.map((point) => point.y)];
  if (xs.length === 0 || ys.length === 0) {
    return { minX: 0, minY: 0, maxX: 30000, maxY: 30000 };
  }

  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function getPlayerPoint(record) {
  if (!record) {
    return null;
  }
  const x = Number.parseFloat(getField(record.row, ['x', 'posx', 'positionx']));
  const y = Number.parseFloat(getField(record.row, ['y', 'posy', 'positiony']));
  const z = Number.parseFloat(getField(record.row, ['z', 'posz', 'positionz']));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x, y, z: Number.isFinite(z) ? z : 0, nick: record.nick };
}

function parseLogTimestamp(line) {
  const match = String(line).match(/(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }
  const year = 2000 + Number.parseInt(match[1], 10);
  return new Date(year, Number.parseInt(match[2], 10) - 1, Number.parseInt(match[3], 10), Number.parseInt(match[4], 10), Number.parseInt(match[5], 10), Number.parseInt(match[6], 10));
}

function extractPlayerLogs(nickInput, typeInput, hoursInput) {
  const logsPath = cleanText(process.env.LOGS_PATH);
  const nick = cleanText(nickInput);
  const type = cleanText(typeInput).toLowerCase();
  const hours = Math.max(1, Math.min(168, Number.parseInt(hoursInput, 10) || 24));
  if (!logsPath || !fs.existsSync(logsPath) || !nick) {
    return { files: [], lines: [], hours, type };
  }

  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const files = collectFilesRecursively(
    logsPath,
    (filePath, entry) => /\.txt$|\.log$/i.test(entry.name) && (!type || type === 'todos' || entry.name.toLowerCase().includes(type)),
    2,
    [],
    100,
  ).filter((filePath) => {
    try {
      return fs.statSync(filePath).mtimeMs >= cutoff;
    } catch (error) {
      return false;
    }
  });

  const loweredNick = nick.toLowerCase();
  const lines = [];
  for (const filePath of files) {
    const content = readTextFile(filePath);
    for (const line of content.split(/\r?\n/)) {
      if (!line.toLowerCase().includes(loweredNick)) {
        continue;
      }
      const timestamp = parseLogTimestamp(line);
      if (timestamp && timestamp.getTime() < cutoff) {
        continue;
      }
      lines.push(`${path.basename(filePath)} | ${truncateLine(line, 500)}`);
      if (lines.length >= 1000) {
        break;
      }
    }
  }

  return { files, lines, hours, type };
}

module.exports = {
  extractPlayerLogs,
  findMapByName,
  findPlayerRecord,
  findVehicleById,
  getMaps,
  getMapsConfigPath,
  getPlayerPoint,
  getPlayerRank,
  getPlayerRows,
  getPlayerSkills,
  getPlayerTraits,
  getSafehouses,
  getWorldBounds,
  parseListField,
};
