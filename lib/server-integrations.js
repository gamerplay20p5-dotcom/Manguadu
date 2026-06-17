const { cleanText, readTextFile } = require('./utils');
const { Rcon } = require('rcon-client');
const path = require('path');
const fs = require('fs');
const {
  fetchDockerResources,
  manageDockerServer,
} = require('./local-server-control');

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

function getPlayerNames() {
  const playersBasePath = getPlayersBasePath();
  if (!playersBasePath || !fs.existsSync(playersBasePath)) {
    return [];
  }

  return fs
    .readdirSync(playersBasePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => cleanText(entry.name))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'pt-BR'));
}

function readPlayersOnlineFallback() {
  const serverBasePath = getServerBasePath();
  if (!serverBasePath) {
    return [];
  }

  const filePath = path.join(serverBasePath, 'players_online.csv');
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.trim()) {
    return [];
  }

  return content
    .split(';')
    .map((value) => cleanText(value))
    .filter(Boolean);
}

function parseWorldCsvLine(rawLine) {
  const values = String(rawLine || '')
    .split(';')
    .map((value) => cleanText(value).replace(/^"|"$/g, ''))
    .filter((value) => value !== '');

  const gameTimeToken = values.find((value) => /^\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}$/.test(value));
  const numericCandidates = values
    .map((value) => ({
      raw: value,
      number: Number.parseFloat(value.replace(',', '.')),
    }))
    .filter((entry) => Number.isFinite(entry.number) && !/^\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}$/.test(entry.raw));

  let temperature = '';
  const temperatureCandidate = numericCandidates.find((entry) => {
    if (Math.abs(entry.number) > 60) {
      return false;
    }

    if (/^\d+$/.test(entry.raw)) {
      return false;
    }

    if (entry.number >= 0 && entry.number <= 1) {
      return false;
    }

    return true;
  });

  if (temperatureCandidate) {
    temperature = temperatureCandidate.number.toFixed(1);
  }

  const result = {
    raw: rawLine,
    gameTime: gameTimeToken || '',
    gameDate: '',
    timeOfDay: '',
    temperature,
  };

  if (gameTimeToken) {
    const match = gameTimeToken.match(/^(\d{1,2}\.\d{1,2}\.\d{4})\s+(\d{1,2}:\d{2})$/);
    if (match) {
      result.gameDate = match[1];
      result.timeOfDay = match[2];
    }
  }

  return result;
}

function readWorldSnapshotFromWorldCsv() {
  const serverBasePath = getServerBasePath();
  if (!serverBasePath) {
    return null;
  }

  const filePath = path.join(serverBasePath, 'world.csv');
  const content = readTextFile(filePath);
  if (!content.trim()) {
    return null;
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  return {
    source: 'world.csv',
    ...parseWorldCsvLine(lines[lines.length - 1]),
  };
}

function readWorldSnapshotFromPlayersFallback() {
  const playersBasePath = getPlayersBasePath();
  if (!playersBasePath || !fs.existsSync(playersBasePath)) {
    return null;
  }

  const playerFiles = getPlayerNames()
    .map((nick) => path.join(playersBasePath, nick, `player_${nick}.csv`))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => ({
      filePath,
      modifiedAt: fs.statSync(filePath).mtimeMs,
    }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  if (playerFiles.length === 0) {
    return null;
  }

  const latestFile = playerFiles[0].filePath;
  const content = readTextFile(latestFile);
  if (!content.trim()) {
    return null;
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);

  if (lines.length < 2) {
    return null;
  }

  const headers = lines[0].split(';').map((value) => cleanText(value).replace(/^"|"$/g, '').toLowerCase());
  const values = lines[lines.length - 1].split(';').map((value) => cleanText(value).replace(/^"|"$/g, ''));
  const gametimeIndex = headers.findIndex((header) => header === 'gametime');

  if (gametimeIndex === -1 || !values[gametimeIndex]) {
    return null;
  }

  const parsed = parseWorldCsvLine(values[gametimeIndex]);
  return {
    source: 'player.csv',
    ...parsed,
    temperature: '',
  };
}

function readWorldSnapshot() {
  const worldSnapshot = readWorldSnapshotFromWorldCsv();
  const fallbackSnapshot = readWorldSnapshotFromPlayersFallback();

  return {
    source: worldSnapshot?.source || fallbackSnapshot?.source || 'indisponivel',
    gameTime: worldSnapshot?.gameTime || fallbackSnapshot?.gameTime || '',
    gameDate: worldSnapshot?.gameDate || fallbackSnapshot?.gameDate || '',
    timeOfDay: worldSnapshot?.timeOfDay || fallbackSnapshot?.timeOfDay || '',
    temperature: worldSnapshot?.temperature || '',
  };
}

function buildPteroUrl(endpoint) {
  const baseUrl = cleanText(process.env.PTERO_URL);
  const serverId = cleanText(process.env.PTERO_SERVER_ID);

  if (!baseUrl || !serverId) {
    return null;
  }

  const sanitizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(`api/client/servers/${serverId}/${endpoint}`, sanitizedBaseUrl).toString();
}

function extractPteroError(result) {
  if (!result) {
    return 'Falha desconhecida.';
  }

  if (result.error) {
    return result.error;
  }

  if (result.pteroError && result.dockerError) {
    return `Pterodactyl: ${result.pteroError} | Docker/local: ${result.dockerError}`;
  }

  if (result.dockerError) {
    return `Docker/local: ${result.dockerError}`;
  }

  const apiError = result.json?.errors?.[0]?.detail || result.json?.error || result.text;
  return cleanText(apiError) || `HTTP ${result.status || 'desconhecido'}`;
}

async function callPterodactyl(endpoint, options = {}) {
  const apiKey = cleanText(process.env.PTERO_API_KEY);
  const url = buildPteroUrl(endpoint);

  if (!apiKey || !url) {
    return {
      ok: false,
      error: 'Configuracao do Pterodactyl incompleta.',
    };
  }

  try {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'Application/vnd.pterodactyl.v1+json',
      'User-Agent': 'FriendHostBot/2.0',
      ...(options.headers || {}),
    };

    if (options.body && options.rawBody === undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.rawBody !== undefined ? options.rawBody : options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs || 15000),
    });

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (error) {
      json = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      text,
      json,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
    };
  }
}

function normalizePteroFile(rawFile) {
  const attributes = rawFile?.attributes || rawFile || {};
  return {
    name: cleanText(attributes.name),
    mode: cleanText(attributes.mode),
    size: Number(attributes.size) || 0,
    isFile: attributes.is_file === true,
    isDirectory: attributes.is_file === false,
    modifiedAt: cleanText(attributes.modified_at),
    raw: rawFile,
  };
}

async function listPteroFiles(directory = '/') {
  const normalizedDirectory = cleanText(directory) || '/';
  const result = await callPterodactyl(`files/list?directory=${encodeURIComponent(normalizedDirectory)}`);
  if (!result.ok) {
    return result;
  }

  const data = Array.isArray(result.json?.data) ? result.json.data : [];
  return {
    ok: true,
    status: result.status,
    directory: normalizedDirectory,
    files: data.map(normalizePteroFile).filter((file) => file.name),
  };
}

async function readPteroFile(filePath) {
  const normalizedPath = cleanText(filePath);
  if (!normalizedPath) {
    return { ok: false, error: 'Caminho do arquivo ausente.' };
  }

  return callPterodactyl(`files/contents?file=${encodeURIComponent(normalizedPath)}`);
}

async function writePteroFile(filePath, content) {
  const normalizedPath = cleanText(filePath);
  if (!normalizedPath) {
    return { ok: false, error: 'Caminho do arquivo ausente.' };
  }

  return callPterodactyl(`files/write?file=${encodeURIComponent(normalizedPath)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    rawBody: String(content ?? ''),
    timeoutMs: 60000,
  });
}

async function deletePteroFiles(root, files) {
  const normalizedRoot = cleanText(root) || '/';
  const normalizedFiles = Array.from(new Set((files || []).map(cleanText).filter(Boolean)));
  if (normalizedFiles.length === 0) {
    return { ok: true, status: 204, deleted: [] };
  }

  const result = await callPterodactyl('files/delete', {
    method: 'POST',
    body: {
      root: normalizedRoot,
      files: normalizedFiles,
    },
    timeoutMs: 60000,
  });

  return {
    ...result,
    deleted: result.ok ? normalizedFiles : [],
  };
}

async function compressPteroFiles(root, files) {
  const normalizedRoot = cleanText(root) || '/';
  const normalizedFiles = Array.from(new Set((files || []).map(cleanText).filter(Boolean)));
  if (normalizedFiles.length === 0) {
    return { ok: false, error: 'Nenhum arquivo informado para compactar.' };
  }

  return callPterodactyl('files/compress', {
    method: 'POST',
    body: {
      root: normalizedRoot,
      files: normalizedFiles,
    },
    timeoutMs: 120000,
  });
}

async function fetchPteroResources() {
  const startedAt = Date.now();
  const result = await callPterodactyl('resources');
  if (!result.ok) {
    const dockerResult = await fetchDockerResources();
    if (dockerResult.ok) {
      return {
        ...dockerResult,
        pteroError: extractPteroError(result),
      };
    }
    return {
      ...result,
      dockerError: dockerResult.error,
    };
  }

  const attributes = result.json?.attributes || result.json || {};
  return {
    ok: true,
    status: result.status,
    state: cleanText(attributes.current_state || attributes.state || 'desconhecido'),
    resources: attributes.resources || {},
    latencyMs: Date.now() - startedAt,
    transport: 'pterodactyl',
    text: result.text,
  };
}

async function sendPteroConsoleCommand(command) {
  return callPterodactyl('command', {
    method: 'POST',
    body: { command },
  });
}

async function manageServer(action) {
  const result = await callPterodactyl('power', {
    method: 'POST',
    body: { signal: action },
  });
  if (result.ok) {
    return {
      ...result,
      transport: 'pterodactyl',
    };
  }

  const dockerResult = await manageDockerServer(action);
  if (dockerResult.ok) {
    return {
      ...dockerResult,
      pteroError: extractPteroError(result),
    };
  }

  return {
    ...result,
    dockerError: dockerResult.error,
  };
}

function normalizePteroBackup(rawBackup) {
  const attributes = rawBackup?.attributes || rawBackup || {};
  const uuid = cleanText(attributes.uuid || attributes.identifier || rawBackup?.uuid || rawBackup?.identifier);

  return {
    uuid,
    name: cleanText(attributes.name || 'Backup sem nome'),
    createdAt: cleanText(attributes.created_at),
    completedAt: cleanText(attributes.completed_at),
    isLocked: Boolean(attributes.is_locked),
    isSuccessful: attributes.is_successful === true,
    bytes: attributes.bytes || 0,
    raw: rawBackup,
  };
}

async function listPteroBackups() {
  const result = await callPterodactyl('backups?per_page=100');
  if (!result.ok) {
    return result;
  }

  const rawBackups = Array.isArray(result.json?.data) ? result.json.data : [];
  return {
    ok: true,
    status: result.status,
    backups: rawBackups.map(normalizePteroBackup).filter((backup) => backup.uuid),
    text: result.text,
  };
}

async function getPteroBackup(backupUuid) {
  const uuid = cleanText(backupUuid);
  if (!uuid) {
    return { ok: false, error: 'UUID do backup ausente.' };
  }

  const result = await callPterodactyl(`backups/${encodeURIComponent(uuid)}`);
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    status: result.status,
    backup: normalizePteroBackup(result.json),
    text: result.text,
  };
}

async function createPteroBackup(options = {}) {
  const body = {};
  const name = cleanText(options.name);
  const ignored = cleanText(options.ignored);

  if (name) {
    body.name = name;
  }

  if (ignored) {
    body.ignored = ignored;
  }

  if (options.isLocked !== undefined) {
    body.is_locked = Boolean(options.isLocked);
  }

  const result = await callPterodactyl('backups', {
    method: 'POST',
    body,
  });

  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    status: result.status,
    backup: normalizePteroBackup(result.json),
    text: result.text,
    json: result.json,
  };
}

async function deletePteroBackup(backupUuid) {
  const uuid = cleanText(backupUuid);
  if (!uuid) {
    return {
      ok: false,
      error: 'UUID do backup ausente.',
    };
  }

  return callPterodactyl(`backups/${encodeURIComponent(uuid)}`, {
    method: 'DELETE',
  });
}

async function restorePteroBackup(backupUuid, options = {}) {
  const uuid = cleanText(backupUuid);
  if (!uuid) {
    return {
      ok: false,
      error: 'UUID do backup ausente.',
    };
  }

  return callPterodactyl(`backups/${encodeURIComponent(uuid)}/restore`, {
    method: 'POST',
    body: {
      truncate: Boolean(options.truncate),
    },
    timeoutMs: 60000,
  });
}

async function prunePteroBackups(options = {}) {
  const parsedKeep = Number.parseInt(options.keep, 10);
  const keep = Number.isFinite(parsedKeep) ? Math.max(0, parsedKeep) : 1;
  const prefix = cleanText(options.prefix);
  const managedOnly = options.managedOnly !== false;
  const listResult = await listPteroBackups();

  if (!listResult.ok) {
    return listResult;
  }

  const candidates = listResult.backups
    .filter((backup) => !backup.isLocked)
    .filter((backup) => !managedOnly || !prefix || backup.name.startsWith(prefix))
    .sort((left, right) => {
      const leftTime = Date.parse(left.createdAt) || 0;
      const rightTime = Date.parse(right.createdAt) || 0;
      return rightTime - leftTime;
    });

  const toDelete = candidates.slice(keep);
  const deleted = [];
  const failed = [];

  for (const backup of toDelete) {
    const deleteResult = await deletePteroBackup(backup.uuid);
    if (deleteResult.ok || deleteResult.status === 204) {
      deleted.push(backup);
    } else {
      failed.push({
        backup,
        error: extractPteroError(deleteResult),
      });
    }
  }

  return {
    ok: failed.length === 0,
    backups: listResult.backups,
    candidates,
    deleted,
    failed,
  };
}

async function sendRconCommand(command) {
  const host = cleanText(process.env.RCON_HOST);
  const port = Number.parseInt(cleanText(process.env.RCON_PORT), 10);
  const password = cleanText(process.env.RCON_PASSWORD);

  if (!host || !port || !password) {
    return {
      ok: false,
      error: 'Configuracao do RCON incompleta.',
    };
  }

  const candidateHosts = Array.from(
    new Set(
      [host, '127.0.0.1', 'localhost']
        .map((value) => cleanText(value))
        .filter(Boolean),
    ),
  );

  const failures = [];

  for (const candidateHost of candidateHosts) {
    let rcon = null;

    try {
      rcon = await Rcon.connect({
        host: candidateHost,
        port,
        password,
        timeout: 10000,
      });

      const output = await rcon.send(command);

      return {
        ok: true,
        output: cleanText(output),
        host: candidateHost,
      };
    } catch (error) {
      failures.push(`${candidateHost}:${port} -> ${error.message}`);
    } finally {
      if (rcon) {
        try {
          await rcon.end();
        } catch (error) {
          // ignore
        }
      }
    }
  }

  return {
    ok: false,
    error: failures.join(' | '),
  };
}

async function runServerConsoleCommand(command) {
  const rconResult = await sendRconCommand(command);
  if (rconResult.ok) {
    return {
      ok: true,
      transport: 'rcon',
      output: rconResult.output,
    };
  }

  const pteroResult = await sendPteroConsoleCommand(command);
  if (pteroResult.ok) {
    return {
      ok: true,
      transport: 'pterodactyl',
      output: '',
      warning: rconResult.error,
    };
  }

  return {
    ok: false,
    rconError: rconResult.error,
    pteroError: extractPteroError(pteroResult),
  };
}

function parsePlayersRconResponse(responseText) {
  const lines = cleanText(responseText)
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);

  if (lines.length === 0) {
    return {
      count: 0,
      names: [],
    };
  }

  const joinedText = lines.join('\n');
  const countMatch =
    joinedText.match(/\((\d+)\)/) ||
    joinedText.match(/players?[^\d]*(\d+)/i) ||
    joinedText.match(/connected[^\d]*(\d+)/i);

  let names = [];

  if (lines.length > 1) {
    names = lines
      .slice(1)
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean);
  } else if (/:/.test(lines[0])) {
    const pieces = lines[0].split(':').slice(1).join(':');
    names = pieces
      .split(/[,;]+/)
      .map((piece) => cleanText(piece))
      .filter((piece) => piece && !/^\d+$/.test(piece));
  }

  const count = countMatch ? Number.parseInt(countMatch[1], 10) : names.length;
  return {
    count: Number.isFinite(count) ? count : names.length,
    names,
  };
}

async function buildServerOverview() {
  const ptero = await fetchPteroResources();
  const rconPlayers = await sendRconCommand('players');
  const world = readWorldSnapshot();

  let currentState = ptero.ok ? ptero.state : '';
  let onlinePlayers = {
    count: 0,
    names: [],
    source: 'none',
  };

  if (rconPlayers.ok) {
    const parsed = parsePlayersRconResponse(rconPlayers.output);
    onlinePlayers = {
      count: parsed.count,
      names: parsed.names,
      source: 'rcon',
    };
  } else if (!ptero.ok || ['running', 'starting'].includes(currentState.toLowerCase())) {
    const fallbackPlayers = readPlayersOnlineFallback();
    if (fallbackPlayers.length > 0) {
      onlinePlayers = {
        count: fallbackPlayers.length,
        names: fallbackPlayers,
        source: 'csv',
      };
    }
  }

  if (!currentState) {
    currentState = onlinePlayers.source !== 'none' ? 'running' : 'offline';
  }

  const normalizedState = currentState.toLowerCase();
  const isOnline = ['running', 'starting'].includes(normalizedState) || (onlinePlayers.count > 0 && normalizedState !== 'offline');

  return {
    isOnline,
    currentState,
    ptero,
    rconPlayers,
    onlinePlayers,
    world,
  };
}

module.exports = {
  buildPteroUrl,
  buildServerOverview,
  callPterodactyl,
  createPteroBackup,
  deletePteroBackup,
  deletePteroFiles,
  extractPteroError,
  fetchPteroResources,
  getPteroBackup,
  listPteroBackups,
  listPteroFiles,
  manageServer,
  parsePlayersRconResponse,
  prunePteroBackups,
  readPteroFile,
  readWorldSnapshot,
  readPlayersOnlineFallback,
  runServerConsoleCommand,
  compressPteroFiles,
  restorePteroBackup,
  sendPteroConsoleCommand,
  sendRconCommand,
  writePteroFile,
};
