const fs = require('fs');
const os = require('os');
const path = require('path');

const { cleanText, isDirectory, logInfo, logWarn } = require('./utils');

const ANTICHEAT_PENDING_FILE = 'PZAntiCheat_pending_alerts.csv';
const FRIENDHOST_DIRECTORY = 'FriendHost_Data';
const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_ENV_PATH = path.join(PROJECT_ROOT, '.env');

function isEnabled() {
  const value = cleanText(process.env.PZ_AUTO_DISCOVER_PATHS || '1').toLowerCase();
  return !['0', 'false', 'nao', 'no', 'off'].includes(value);
}

function uniqueExistingDirectories(values) {
  const seen = new Set();
  const directories = [];
  for (const value of values) {
    const resolved = path.resolve(cleanText(value));
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
    ? [os.homedir()]
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
  return path.basename(directory).toLowerCase() === 'lua' && path.basename(path.dirname(directory)).toLowerCase() === 'zomboid';
}

function findLuaDirectories() {
  const configuredLuaPath = cleanText(process.env.PZ_LUA_PATH);
  const candidates = [];
  if (configuredLuaPath && isDirectory(configuredLuaPath)) {
    candidates.push(configuredLuaPath);
  } else if (configuredLuaPath) {
    logWarn(`PZ_LUA_PATH configurado, mas nao encontrado: ${configuredLuaPath}`);
  }

  for (const root of parseScanRoots()) {
    const directCandidates = [root, path.join(root, 'Zomboid', 'Lua')];
    for (const child of safeChildDirectories(root)) {
      directCandidates.push(path.join(child, 'Zomboid', 'Lua'));
      if (path.basename(child).toLowerCase() === 'zomboid') {
        directCandidates.push(path.join(child, 'Lua'));
      }
    }
    candidates.push(...directCandidates.filter((candidate) => isLuaDirectory(candidate)));
  }

  return uniqueExistingDirectories(candidates);
}

function isFriendHostBase(directory) {
  return isDirectory(path.join(directory, 'Jogadores')) && isDirectory(path.join(directory, 'Servidor'));
}

function findFriendHostBase(luaDirectory) {
  const preferred = path.join(luaDirectory, FRIENDHOST_DIRECTORY);
  if (isFriendHostBase(preferred)) {
    return preferred;
  }
  return safeChildDirectories(luaDirectory, 200).find(isFriendHostBase) || '';
}

function getLuaCandidate(luaDirectory) {
  const detectedFriendHostBase = findFriendHostBase(luaDirectory);
  const friendHostBase = detectedFriendHostBase || path.join(luaDirectory, FRIENDHOST_DIRECTORY);
  const anticheatPath = path.join(luaDirectory, ANTICHEAT_PENDING_FILE);
  const logsPath = path.join(path.dirname(luaDirectory), 'Logs');
  const hasAnticheat = fs.existsSync(anticheatPath);
  const hasLogs = isDirectory(logsPath);
  return {
    luaDirectory,
    friendHostBase,
    anticheatPath,
    logsPath: hasLogs ? logsPath : '',
    hasFriendHost: Boolean(detectedFriendHostBase),
    hasAnticheat,
    score: (detectedFriendHostBase ? 4 : 0) + (hasAnticheat ? 3 : 0) + (hasLogs ? 1 : 0),
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
    CSV_BASE_PATH: selected.friendHostBase,
    ANTICHEAT_CSV_PATH: selected.anticheatPath,
    LOGS_PATH: selected.logsPath,
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

module.exports = {
  chooseCandidate,
  discoverAndPersistPzPaths,
  findFriendHostBase,
  findLuaDirectories,
  getLuaCandidate,
  persistEnvValues,
};
