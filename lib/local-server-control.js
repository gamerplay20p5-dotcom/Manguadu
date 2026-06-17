const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { cleanText, toNumber } = require('./utils');

const PTERO_VOLUME_PATTERN = /\/var\/lib\/pterodactyl\/volumes\/([^/]+)/i;

function isLocalFallbackEnabled() {
  const value = cleanText(process.env.PTERO_LOCAL_FALLBACK_ENABLED || '1').toLowerCase();
  return !['0', 'false', 'nao', 'no', 'off'].includes(value);
}

function getVolumeIdFromPath(value) {
  const normalized = cleanText(value).replace(/\\/g, '/');
  const match = normalized.match(PTERO_VOLUME_PATTERN);
  return match ? cleanText(match[1]) : '';
}

function getKnownVolumeId() {
  return cleanText(process.env.PTERO_VOLUME_ID)
    || getVolumeIdFromPath(process.env.PZ_LUA_PATH)
    || getVolumeIdFromPath(process.env.PZ_SAVE_ROOT)
    || getVolumeIdFromPath(process.env.CSV_BASE_PATH)
    || getVolumeIdFromPath(process.env.ANTICHEAT_CSV_PATH);
}

function getServerIdentifiers() {
  return Array.from(
    new Set(
      [
        process.env.PTERO_DOCKER_CONTAINER,
        process.env.PTERO_SERVER_UUID,
        process.env.PTERO_VOLUME_ID,
        getKnownVolumeId(),
        process.env.PTERO_SERVER_ID,
      ]
        .map(cleanText)
        .filter(Boolean),
    ),
  );
}

function runLocalProcess(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      windowsHide: true,
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        error: `Tempo limite excedido (${Math.round((options.timeoutMs || 30000) / 1000)}s).`,
      });
    }, options.timeoutMs || 30000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        error: code === 0 ? '' : cleanText(stderr) || `Processo finalizou com codigo ${code}.`,
      });
    });
  });
}

function parseDockerPsJson(output) {
  return cleanText(output)
    .split(/\r?\n/)
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        return {
          id: cleanText(parsed.ID),
          names: cleanText(parsed.Names),
          image: cleanText(parsed.Image),
          state: cleanText(parsed.State),
          status: cleanText(parsed.Status),
          labels: cleanText(parsed.Labels),
          mounts: cleanText(parsed.Mounts),
        };
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

function scoreDockerContainer(container, identifiers = getServerIdentifiers()) {
  const haystack = [
    container.id,
    container.names,
    container.image,
    container.labels,
    container.mounts,
  ].map((value) => cleanText(value).toLowerCase());

  let score = 0;
  for (const identifier of identifiers) {
    const normalized = cleanText(identifier).toLowerCase();
    if (!normalized) continue;
    if (haystack.some((value) => value.includes(normalized))) {
      score += normalized.length >= 8 ? 10 : 3;
    }
  }

  if (/pterodactyl|wings|io\.pterodactyl\.server/i.test(container.labels)) {
    score += 2;
  }

  return score;
}

async function listDockerContainers() {
  const result = await runLocalProcess('docker', ['ps', '-a', '--format', '{{json .}}'], { timeoutMs: 15000 });
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    containers: parseDockerPsJson(result.stdout),
    durationMs: result.durationMs,
  };
}

async function findDockerContainer() {
  if (!isLocalFallbackEnabled()) {
    return { ok: false, error: 'Fallback local/Docker desativado.' };
  }

  const configured = cleanText(process.env.PTERO_DOCKER_CONTAINER);
  if (configured) {
    return { ok: true, container: { id: configured, names: configured, configured: true } };
  }

  const listResult = await listDockerContainers();
  if (!listResult.ok) {
    return { ok: false, error: listResult.error || cleanText(listResult.stderr) || 'Docker indisponivel.' };
  }

  const ranked = listResult.containers
    .map((container) => ({ ...container, score: scoreDockerContainer(container) }))
    .filter((container) => container.score > 0)
    .sort((left, right) => right.score - left.score);

  if (ranked.length === 0) {
    return { ok: false, error: 'Nenhum container Docker do servidor foi encontrado.' };
  }

  const best = ranked.filter((container) => container.score === ranked[0].score);
  if (best.length > 1) {
    return {
      ok: false,
      error: `Mais de um container possivel: ${best.map((container) => container.names || container.id).join(', ')}. Configure PTERO_DOCKER_CONTAINER.`,
    };
  }

  return { ok: true, container: best[0] };
}

function normalizeDockerState(status) {
  const state = cleanText(status).toLowerCase();
  if (state === 'running') return 'running';
  if (['created', 'exited', 'dead'].includes(state)) return 'offline';
  if (state === 'restarting') return 'starting';
  if (state === 'paused') return 'stopping';
  return state || 'desconhecido';
}

async function inspectDockerContainer(containerId) {
  const result = await runLocalProcess('docker', ['inspect', containerId], { timeoutMs: 15000 });
  if (!result.ok) {
    return result;
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return { ok: true, inspect: parsed[0] || {}, durationMs: result.durationMs };
  } catch (error) {
    return { ok: false, error: `Falha ao interpretar docker inspect: ${error.message}` };
  }
}

function parsePercent(value) {
  return toNumber(cleanText(value).replace('%', ''), 0);
}

function parseHumanBytes(value) {
  const match = cleanText(value).match(/^([\d.,]+)\s*([kmgtp]?i?b)?/i);
  if (!match) return 0;
  const number = toNumber(match[1], 0);
  const unit = cleanText(match[2]).toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  return Math.round(number * (multipliers[unit] || 1));
}

async function fetchDockerStats(containerId) {
  const result = await runLocalProcess('docker', ['stats', '--no-stream', '--format', '{{json .}}', containerId], { timeoutMs: 15000 });
  if (!result.ok) {
    return {};
  }

  try {
    const parsed = JSON.parse(cleanText(result.stdout).split(/\r?\n/)[0]);
    const memoryUsage = cleanText(parsed.MemUsage).split('/')[0];
    return {
      cpu_absolute: parsePercent(parsed.CPUPerc),
      memory_bytes: parseHumanBytes(memoryUsage),
    };
  } catch (error) {
    return {};
  }
}

async function fetchDockerResources() {
  const startedAt = Date.now();
  const found = await findDockerContainer();
  if (!found.ok) {
    return found;
  }

  const containerId = found.container.id || found.container.names;
  const inspected = await inspectDockerContainer(containerId);
  if (!inspected.ok) {
    return inspected;
  }

  const dockerState = inspected.inspect.State || {};
  const state = normalizeDockerState(dockerState.Status);
  const stats = dockerState.Running ? await fetchDockerStats(containerId) : {};

  return {
    ok: true,
    status: 200,
    state,
    resources: {
      ...stats,
      uptime: dockerState.StartedAt ? Math.max(0, Date.now() - (Date.parse(dockerState.StartedAt) || Date.now())) : 0,
    },
    latencyMs: Date.now() - startedAt,
    transport: 'docker',
    container: found.container.names || containerId,
  };
}

async function manageDockerServer(action) {
  const actionMap = {
    start: 'start',
    stop: 'stop',
    restart: 'restart',
    kill: 'kill',
  };
  const dockerAction = actionMap[cleanText(action).toLowerCase()];
  if (!dockerAction) {
    return { ok: false, error: `Acao local nao suportada: ${action}` };
  }

  const found = await findDockerContainer();
  if (!found.ok) {
    return found;
  }

  const containerId = found.container.id || found.container.names;
  const result = await runLocalProcess('docker', [dockerAction, containerId], { timeoutMs: 120000 });
  return {
    ok: result.ok,
    status: result.ok ? 204 : 500,
    error: result.error,
    text: result.stdout,
    transport: 'docker',
    container: found.container.names || containerId,
  };
}

function isLocalAbsolutePath(value) {
  const normalized = cleanText(value);
  return Boolean(normalized && path.isAbsolute(normalized) && fs.existsSync(normalized));
}

module.exports = {
  fetchDockerResources,
  findDockerContainer,
  getKnownVolumeId,
  getServerIdentifiers,
  getVolumeIdFromPath,
  isLocalAbsolutePath,
  manageDockerServer,
  parseDockerPsJson,
  runLocalProcess,
  scoreDockerContainer,
};
