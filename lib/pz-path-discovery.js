const fs = require('fs');
const os = require('os');
const path = require('path');

const { cleanText, isDirectory, logInfo, logWarn } = require('./utils');
const { isFriendHostDataFile } = require('./friendhost-files');

const ANTICHEAT_PENDING_FILE = 'PZAntiCheat_pending_alerts.csv';
const FRIENDHOST_DIRECTORY = 'FriendHost_Data';
const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_ENV_PATH = path.join(PROJECT_ROOT, '.env');
const PTERO_VOLUME_PATTERN = /\/var\/lib\/pterodactyl\/volumes\/([^/]+)/i;

function isEnabled() {
  const value = cleanText(process.env.PZ_AUTO_DISCOVER_PATHS || '1').toLowerCase();
  return !['0', 'false', 'nao', 'no', 'off'].includes(value);
}

function uniqueExistingDirectories(values) {
  const seen = new Set();
  const directories = [];
  for (const value of values) {
    const normalized = cleanText(value);
    if (!normalized) continue;
    const resolved = path.resolve(normalized);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!seen.has(key) && isDirectory(resolved)) {
      seen.add(key);
      directories.push(resolved);
    }
  }
  return directories;
}

function parseScanRoots() {
  const configured = cleanText(process.env.PZ_PATH_SCAN_ROOTS)
    .split(/[,;\n]+/)
    .map(cleanText)
    .filter(Boolean);
  if (configured.length > 0) {
    return uniqueExistingDirectories(configured);
  }

  const defaults = process.platform === 'win32'
    ? [os.homedir(), process.cwd(), PROJECT_ROOT]
    : [os.homedir(), '/root', '/home', '/home/container', '/mnt/server', '/srv', '/var/lib/pterodactyl/volumes'];
  return uniqueExistingDirectories(defaults);
}

function safeChildDirectories(directory, limit = 2000) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .slice(0, limit)
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    return [];
  }
}

function isLuaDirectory(directory) {
  if (path.basename(directory).toLowerCase() !== 'lua') {
    return false;
  }

  const parent = path.basename(path.dirname(directory)).toLowerCase();
  return (
    parent === 'zomboid' ||
    parent === '.cache' ||
    isDirectory(path.join(directory, FRIENDHOST_DIRECTORY)) ||
    fs.existsSync(path.join(directory, ANTICHEAT_PENDING_FILE))
  );
}

function findLuaAncestor(value) {
  let current = path.resolve(cleanText(value));
  for (let depth = 0; depth < 6; depth += 1) {
    if (path.basename(current).toLowerCase() === 'lua' && isDirectory(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return '';
}

function findLuaDirectories() {
  const configuredLuaPath = cleanText(process.env.PZ_LUA_PATH);
  const candidates = [];
  if (configuredLuaPath && isDirectory(configuredLuaPath)) {
    candidates.push(configuredLuaPath);
  } else if (configuredLuaPath) {
    logWarn(`PZ_LUA_PATH configurado, mas nao encontrado: ${configuredLuaPath}`);
  }

  const configuredHints = [
    process.env.CSV_BASE_PATH,
    process.env.ANTICHEAT_CSV_PATH,
    process.env.PZ_CACHE_ROOT,
    process.env.ZOMBOID_HOME,
    process.env.PZ_HOME,
  ].map(cleanText).filter(Boolean);

  for (const hint of configuredHints) {
    const luaAncestor = findLuaAncestor(hint);
    if (luaAncestor) candidates.push(luaAncestor);
    candidates.push(path.join(hint, 'Lua'));
    candidates.push(path.join(hint, 'Zomboid', 'Lua'));
  }

  for (const root of parseScanRoots()) {
    const directCandidates = [
      root,
      path.join(root, 'Lua'),
      path.join(root, 'Zomboid', 'Lua'),
      path.join(root, '.cache', 'Lua'),
      path.join(root, '.cache', 'Zomboid', 'Lua'),
    ];
    for (const child of safeChildDirectories(root)) {
      directCandidates.push(path.join(child, 'Lua'));
      directCandidates.push(path.join(child, '.cache', 'Lua'));
      directCandidates.push(path.join(child, '.cache', 'Zomboid', 'Lua'));
      directCandidates.push(path.join(child, 'Zomboid', 'Lua'));
      if (path.basename(child).toLowerCase() === 'zomboid') {
        directCandidates.push(path.join(child, 'Lua'));
      }
      if (path.basename(child).toLowerCase() === '.cache') {
        directCandidates.push(path.join(child, 'Lua'));
      }
    }
    candidates.push(...directCandidates.filter((candidate) => isLuaDirectory(candidate)));
  }

  return uniqueExistingDirectories(candidates);
}

function isFriendHostBase(directory) {
  if (!isDirectory(directory)) return false;
  if (path.basename(directory).toLowerCase() === FRIENDHOST_DIRECTORY.toLowerCase()) return true;
  return isDirectory(path.join(directory, 'Jogadores')) || isDirectory(path.join(directory, 'Servidor'));
}

function findFriendHostBase(luaDirectory) {
  const preferred = path.join(luaDirectory, FRIENDHOST_DIRECTORY);
  if (isFriendHostBase(preferred)) {
    return preferred;
  }
  return safeChildDirectories(luaDirectory, 200).find(isFriendHostBase) || '';
}

function countFriendHostSignals(friendHostBase) {
  if (!isDirectory(friendHostBase)) return 0;
  let signals = 1;
  const playersPath = path.join(friendHostBase, 'Jogadores');
  const serverPath = path.join(friendHostBase, 'Servidor');
  if (isDirectory(playersPath)) signals += 1;
  if (isDirectory(serverPath)) signals += 1;

  try {
    if (isDirectory(serverPath) && fs.readdirSync(serverPath).some(isFriendHostDataFile)) signals += 2;
  } catch (error) {
    // A missing or temporarily inaccessible data directory is valid on first boot.
  }

  try {
    const playerDirectories = safeChildDirectories(playersPath, 20);
    if (playerDirectories.some((directory) => fs.readdirSync(directory).some(isFriendHostDataFile))) signals += 2;
  } catch (error) {
    // Keep discovery read-only and tolerant of files being created concurrently.
  }

  return signals;
}

function getPzRootFromLuaDirectory(luaDirectory) {
  const parent = path.dirname(luaDirectory);
  if (path.basename(parent).toLowerCase() === '.cache') {
    return parent;
  }
  return path.basename(parent).toLowerCase() === 'zomboid' ? parent : path.dirname(parent);
}

function getPteroVolumeIdFromPath(value) {
  const normalized = cleanText(value).replace(/\\/g, '/');
  const match = normalized.match(PTERO_VOLUME_PATTERN);
  return match ? cleanText(match[1]) : '';
}

function scoreLocalSaveDirectory(directory) {
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    return { directory, score: 0, fileCount: 0 };
  }

  return scorePteroSaveDirectory(
    directory,
    entries.map((entry) => ({ name: entry.name, isFile: entry.isFile() })),
  );
}

function findLocalSaveCandidates(pzRoot) {
  const multiplayerRoot = path.join(pzRoot, 'Saves', 'Multiplayer');
  if (!isDirectory(multiplayerRoot)) {
    return [];
  }

  const candidates = [scoreLocalSaveDirectory(multiplayerRoot)];
  for (const entry of safeChildDirectories(multiplayerRoot, 200)) {
    candidates.push(scoreLocalSaveDirectory(entry));
  }

  const scored = candidates.filter((candidate) => candidate.score > 0);
  return scored.length > 0 ? scored : candidates.filter((candidate) => candidate.fileCount > 0);
}

function getLuaCandidate(luaDirectory) {
  const pzRoot = getPzRootFromLuaDirectory(luaDirectory);
  const detectedFriendHostBase = findFriendHostBase(luaDirectory);
  const friendHostBase = detectedFriendHostBase || path.join(luaDirectory, FRIENDHOST_DIRECTORY);
  const anticheatPath = path.join(luaDirectory, ANTICHEAT_PENDING_FILE);
  const logsPath = path.join(pzRoot, 'Logs');
  const hasAnticheat = fs.existsSync(anticheatPath);
  const friendHostSignals = countFriendHostSignals(detectedFriendHostBase);
  const hasLogs = isDirectory(logsPath);
  const saveSelection = choosePteroSaveCandidate(findLocalSaveCandidates(pzRoot));
  const volumeId = getPteroVolumeIdFromPath(luaDirectory);
  const configuredServerId = cleanText(process.env.PTERO_SERVER_ID || process.env.PTERO_SERVER_UUID);
  const matchesConfiguredServer = Boolean(
    configuredServerId &&
      (volumeId.toLowerCase().startsWith(configuredServerId.toLowerCase()) ||
        luaDirectory.toLowerCase().includes(configuredServerId.toLowerCase())),
  );
  return {
    luaDirectory,
    pzRoot,
    volumeId,
    friendHostBase,
    anticheatPath,
    logsPath: hasLogs ? logsPath : '',
    saveRoot: saveSelection.candidate?.directory || '',
    hasFriendHost: Boolean(detectedFriendHostBase),
    friendHostSignals,
    hasAnticheat,
    score:
      (matchesConfiguredServer ? 10 : 0) +
      (detectedFriendHostBase ? 4 + Math.min(friendHostSignals, 4) : 0) +
      (hasAnticheat ? 3 : 0) +
      (saveSelection.candidate ? 3 : 0) +
      (hasLogs ? 1 : 0),
  };
}

function chooseCandidate(candidates) {
  const configuredLuaPath = cleanText(process.env.PZ_LUA_PATH);
  if (configuredLuaPath) {
    const configured = candidates.find((candidate) => path.resolve(candidate.luaDirectory) === path.resolve(configuredLuaPath));
    if (configured) {
      return { candidate: configured, ambiguous: false };
    }
  }

  const ranked = candidates.filter((candidate) => candidate.score > 0).sort((left, right) => right.score - left.score);
  if (ranked.length === 0) {
    return candidates.length === 1 ? { candidate: candidates[0], ambiguous: false } : { candidate: null, ambiguous: false };
  }
  const bestScore = ranked[0].score;
  const best = ranked.filter((candidate) => candidate.score === bestScore);
  return best.length === 1 ? { candidate: best[0], ambiguous: false } : { candidate: null, ambiguous: true, matches: best };
}

function quoteEnvValue(value) {
  const text = String(value || '');
  return /[\s#"']/u.test(text) ? JSON.stringify(text) : text;
}

function persistEnvValues(envPath, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) {
    return [];
  }

  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const changed = [];

  for (const key of keys) {
    const value = updates[key];
    const expression = new RegExp(`^(\\s*${key}\\s*=)(.*)$`, 'm');
    const match = content.match(expression);
    if (match) {
      if (cleanText(match[2]).replace(/^['"]|['"]$/g, '')) {
        continue;
      }
      content = content.replace(expression, `$1${quoteEnvValue(value)}`);
    } else {
      const separator = content && !content.endsWith('\n') && !content.endsWith('\r') ? newline : '';
      content += `${separator}${key}=${quoteEnvValue(value)}${newline}`;
    }
    changed.push(key);
  }

  if (changed.length === 0) {
    return [];
  }

  const tempPath = `${envPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, envPath);
  return changed;
}

function discoverAndPersistPzPaths(options = {}) {
  if (!isEnabled()) {
    return { enabled: false, updates: {}, candidates: [] };
  }

  const candidates = findLuaDirectories().map(getLuaCandidate);
  const selection = chooseCandidate(candidates);
  if (selection.ambiguous) {
    logWarn(`Mais de uma pasta PZ Lua foi encontrada: ${selection.matches.map((entry) => entry.luaDirectory).join(' | ')}. Configure PZ_LUA_PATH para selecionar o servidor correto.`);
    return { enabled: true, ambiguous: true, updates: {}, candidates };
  }
  if (!selection.candidate) {
    logWarn('Nenhuma pasta Zomboid/Lua reconhecida na VM. Caminhos manuais continuam validos.');
    return { enabled: true, updates: {}, candidates };
  }

  const selected = selection.candidate;
  const discovered = {
    PZ_LUA_PATH: selected.luaDirectory,
    PZ_CACHE_ROOT: selected.pzRoot,
    PTERO_VOLUME_ID: selected.volumeId,
    CSV_BASE_PATH: selected.friendHostBase,
    ANTICHEAT_CSV_PATH: selected.anticheatPath,
    LOGS_PATH: selected.logsPath,
    PZ_SAVE_ROOT: selected.saveRoot,
  };
  const updates = {};
  for (const [key, value] of Object.entries(discovered)) {
    if (value && !cleanText(process.env[key])) {
      process.env[key] = value;
      updates[key] = value;
    }
  }

  const envPath = options.envPath || DEFAULT_ENV_PATH;
  let persisted = [];
  try {
    persisted = persistEnvValues(envPath, updates);
  } catch (error) {
    logWarn(`Caminhos PZ encontrados, mas nao foi possivel atualizar ${envPath}: ${error.message}`);
  }

  if (Object.keys(updates).length > 0) {
    logInfo(`Descoberta PZ: ${Object.entries(updates).map(([key, value]) => `${key}=${value}`).join(' | ')}`);
  } else {
    logInfo(`Descoberta PZ confirmou a pasta Lua: ${selected.luaDirectory}`);
  }

  return { enabled: true, updates, persisted, selected, candidates };
}

function scorePteroSaveDirectory(directory, files) {
  const entries = files || [];
  const names = new Set(entries.filter((file) => file.isFile).map((file) => file.name.toLowerCase()));
  const directories = new Set(entries.filter((file) => file.isDirectory).map((file) => file.name.toLowerCase()));
  let score = 0;
  if (names.has('players.db')) score += 5;
  if (names.has('map_meta.bin')) score += 4;
  if (names.has('map_ver.bin')) score += 3;
  if ([...names].some((name) => /^map_-?\d+_-?\d+\.bin$/.test(name))) score += 3;
  if ([...names].some((name) => /^zpop_-?\d+_-?\d+\.bin$/.test(name))) score += 2;
  if (directories.has('chunkdata')) score += 2;
  return { directory, score, fileCount: names.size + directories.size };
}

function choosePteroSaveCandidate(candidates) {
  const ranked = [...candidates].sort((left, right) => right.score - left.score || right.fileCount - left.fileCount);
  if (ranked.length === 0) {
    return { candidate: null, ambiguous: false };
  }
  const best = ranked.filter((candidate) => candidate.score === ranked[0].score && candidate.fileCount === ranked[0].fileCount);
  return best.length === 1 ? { candidate: best[0], ambiguous: false } : { candidate: null, ambiguous: true, matches: best };
}

async function findPteroSaveCandidates() {
  const { listPteroFiles } = require('./server-integrations');
  const multiplayerRoots = [
    '/Zomboid/Saves/Multiplayer',
    '/.cache/Zomboid/Saves/Multiplayer',
    '/.cache/Saves/Multiplayer',
    '/home/container/Zomboid/Saves/Multiplayer',
    '/home/container/.cache/Zomboid/Saves/Multiplayer',
    '/home/container/.cache/Saves/Multiplayer',
  ];
  const candidates = [];
  const visited = new Set();

  for (const multiplayerRoot of multiplayerRoots) {
    const rootResult = await listPteroFiles(multiplayerRoot);
    if (!rootResult.ok) {
      continue;
    }

    const rootScore = scorePteroSaveDirectory(multiplayerRoot, rootResult.files);
    if (rootScore.score > 0) {
      candidates.push(rootScore);
    }

    for (const entry of rootResult.files.filter((file) => file.isDirectory).slice(0, 100)) {
      const directory = `${multiplayerRoot.replace(/\/$/, '')}/${entry.name}`;
      if (visited.has(directory)) {
        continue;
      }
      visited.add(directory);
      const saveResult = await listPteroFiles(directory);
      if (saveResult.ok) {
        candidates.push(scorePteroSaveDirectory(directory, saveResult.files));
      }
    }
  }

  const scored = candidates.filter((candidate) => candidate.score > 0);
  if (scored.length > 0) {
    return scored;
  }
  return candidates.length === 1 ? candidates : [];
}

async function findPteroAnticheatPath() {
  const { readPteroFile } = require('./server-integrations');
  const candidates = [
    '/Zomboid/Lua/PZAntiCheat_pending_alerts.csv',
    '/.cache/Zomboid/Lua/PZAntiCheat_pending_alerts.csv',
    '/.cache/Lua/PZAntiCheat_pending_alerts.csv',
    '/home/container/Zomboid/Lua/PZAntiCheat_pending_alerts.csv',
  ];

  for (const candidate of candidates) {
    const result = await readPteroFile(candidate);
    if (result.ok) {
      return candidate;
    }
  }
  return '';
}

async function discoverAndPersistPteroPaths(options = {}) {
  if (!isEnabled()) {
    return { enabled: false, updates: {} };
  }
  if (!cleanText(process.env.PTERO_URL) || !cleanText(process.env.PTERO_SERVER_ID) || !cleanText(process.env.PTERO_API_KEY)) {
    return { enabled: true, configured: false, updates: {} };
  }

  const updates = {};
  if (!cleanText(process.env.PZ_SAVE_ROOT)) {
    const candidates = await findPteroSaveCandidates();
    const selection = choosePteroSaveCandidate(candidates);
    if (selection.ambiguous) {
      logWarn(`Mais de um save PZ foi encontrado no Pterodactyl: ${selection.matches.map((entry) => entry.directory).join(' | ')}. Configure PZ_SAVE_ROOT para selecionar o correto.`);
    } else if (selection.candidate) {
      process.env.PZ_SAVE_ROOT = selection.candidate.directory;
      updates.PZ_SAVE_ROOT = selection.candidate.directory;
    }
  }

  if (!cleanText(process.env.ANTICHEAT_PTERO_CSV_PATH)) {
    const anticheatPath = await findPteroAnticheatPath();
    if (anticheatPath) {
      process.env.ANTICHEAT_PTERO_CSV_PATH = anticheatPath;
      updates.ANTICHEAT_PTERO_CSV_PATH = anticheatPath;
    }
  }

  let persisted = [];
  try {
    persisted = persistEnvValues(options.envPath || DEFAULT_ENV_PATH, updates);
  } catch (error) {
    logWarn(`Caminhos Pterodactyl encontrados, mas nao foi possivel atualizar o .env: ${error.message}`);
  }
  if (Object.keys(updates).length > 0) {
    logInfo(`Descoberta Pterodactyl: ${Object.entries(updates).map(([key, value]) => `${key}=${value}`).join(' | ')}`);
  }
  return { enabled: true, configured: true, updates, persisted };
}

module.exports = {
  choosePteroSaveCandidate,
  chooseCandidate,
  discoverAndPersistPzPaths,
  discoverAndPersistPteroPaths,
  findLocalSaveCandidates,
  findPteroSaveCandidates,
  findFriendHostBase,
  findLuaDirectories,
  findLuaAncestor,
  getLuaCandidate,
  getPteroVolumeIdFromPath,
  getPzRootFromLuaDirectory,
  persistEnvValues,
  scoreLocalSaveDirectory,
  scorePteroSaveDirectory,
};
