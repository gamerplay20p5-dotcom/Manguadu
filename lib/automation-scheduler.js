const fs = require('fs');
const path = require('path');

const { cleanText, logError, logInfo } = require('./utils');
const {
  createPteroBackup,
  extractPteroError,
  manageServer,
  prunePteroBackups,
  runServerConsoleCommand,
} = require('./server-integrations');

const STORE_FILE = path.join(__dirname, '..', 'data', 'automations.json');
const DEFAULT_TIMEZONE = 'America/Sao_Paulo';
const DEFAULT_BACKUP_KEEP = 5;
const BACKUP_PREFIX = 'Bot automatico - ';

const AUTOMATION_ACTIONS = {
  start: 'Ligar servidor',
  stop: 'Desligar servidor',
  restart: 'Reiniciar servidor',
  backup: 'Criar backup',
  save: 'Salvar mundo',
  command: 'Comando do console',
};

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DAY_LABELS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const DAY_ALIASES = new Map([
  ['domingo', 0],
  ['dom', 0],
  ['sun', 0],
  ['sunday', 0],
  ['segunda', 1],
  ['seg', 1],
  ['mon', 1],
  ['monday', 1],
  ['terca', 2],
  ['ter', 2],
  ['tue', 2],
  ['tuesday', 2],
  ['quarta', 3],
  ['qua', 3],
  ['wed', 3],
  ['wednesday', 3],
  ['quinta', 4],
  ['qui', 4],
  ['thu', 4],
  ['thursday', 4],
  ['sexta', 5],
  ['sex', 5],
  ['fri', 5],
  ['friday', 5],
  ['sabado', 6],
  ['sab', 6],
  ['sat', 6],
  ['saturday', 6],
]);

let automationLoop = null;
let automationLoopRunning = false;

function stripAccents(value) {
  return cleanText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getAutomationTimezone() {
  return cleanText(process.env.AUTOMATION_TIMEZONE) || cleanText(process.env.TZ) || DEFAULT_TIMEZONE;
}

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
}

function normalizeTime(value) {
  const normalized = stripAccents(value).toLowerCase().replace(/\s+/g, '').replace('h', ':');
  const match = normalized.match(/^(\d{1,2})(?::?(\d{2}))$/);
  if (!match) {
    return '';
  }

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return '';
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseDaysInput(input) {
  const normalized = stripAccents(input).toLowerCase();
  if (!normalized) {
    return ALL_DAYS.slice();
  }

  if (/\b(todo|todos|diario|diaria|daily)\b/.test(normalized)) {
    return ALL_DAYS.slice();
  }

  if (/\b(uteis|util|weekday|weekdays)\b/.test(normalized)) {
    return [1, 2, 3, 4, 5];
  }

  if (/\b(fim|fds|weekend)\b/.test(normalized)) {
    return [0, 6];
  }

  const days = new Set();
  const tokens = normalized
    .replace(/[;|/]+/g, ',')
    .split(/[\s,]+/)
    .map((token) => cleanText(token))
    .filter(Boolean);

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const number = Number.parseInt(token, 10);
      if (number === 0 || number === 7) {
        days.add(0);
      } else if (number >= 1 && number <= 6) {
        days.add(number);
      }
      continue;
    }

    if (DAY_ALIASES.has(token)) {
      days.add(DAY_ALIASES.get(token));
    }
  }

  return Array.from(days).sort((left, right) => left - right);
}

function formatDays(days) {
  const normalizedDays = Array.isArray(days) ? days : [];
  if (normalizedDays.length === 7) {
    return 'todos os dias';
  }

  if (normalizedDays.join(',') === '1,2,3,4,5') {
    return 'dias uteis';
  }

  if (normalizedDays.join(',') === '0,6') {
    return 'fim de semana';
  }

  return normalizedDays.map((day) => DAY_LABELS[day]).filter(Boolean).join(', ') || 'sem dias';
}

function normalizeAction(action) {
  const normalized = cleanText(action).toLowerCase();
  return AUTOMATION_ACTIONS[normalized] ? normalized : '';
}

function normalizeAutomation(rawAutomation) {
  const action = normalizeAction(rawAutomation?.action);
  const time = normalizeTime(rawAutomation?.time);
  const days = Array.isArray(rawAutomation?.days)
    ? rawAutomation.days.map((day) => Number.parseInt(day, 10)).filter((day) => day >= 0 && day <= 6)
    : parseDaysInput(rawAutomation?.days);

  if (!rawAutomation?.id || !action || !time || days.length === 0) {
    return null;
  }

  return {
    id: cleanText(rawAutomation.id),
    action,
    time,
    days: Array.from(new Set(days)).sort((left, right) => left - right),
    enabled: rawAutomation.enabled !== false,
    command: cleanText(rawAutomation.command),
    retainBackups: Math.max(1, Number.parseInt(rawAutomation.retainBackups, 10) || DEFAULT_BACKUP_KEEP),
    createdAt: cleanText(rawAutomation.createdAt),
    updatedAt: cleanText(rawAutomation.updatedAt),
    lastRunKey: cleanText(rawAutomation.lastRunKey),
    lastRunAt: cleanText(rawAutomation.lastRunAt),
    lastResult: rawAutomation.lastResult || null,
  };
}

function normalizeStore(rawStore) {
  const automations = Array.isArray(rawStore)
    ? rawStore
    : Array.isArray(rawStore?.automations)
      ? rawStore.automations
      : [];

  return {
    version: 1,
    automations: automations.map(normalizeAutomation).filter(Boolean),
  };
}

function loadStore() {
  if (!fs.existsSync(STORE_FILE)) {
    return normalizeStore({});
  }

  try {
    return normalizeStore(JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')));
  } catch (error) {
    logError('Leitura das automacoes', error);
    return normalizeStore({});
  }
}

function saveStore(store) {
  ensureStoreDir();
  const normalizedStore = normalizeStore(store);
  const tempPath = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(normalizedStore, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, STORE_FILE);
}

function getAutomations() {
  return loadStore().automations;
}

function generateAutomationId() {
  const timestamp = Date.now().toString(36);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${timestamp}-${suffix}`;
}

function createAutomation(input = {}) {
  const action = normalizeAction(input.action);
  if (!action) {
    return {
      ok: false,
      error: 'Tipo de automacao invalido.',
    };
  }

  const time = normalizeTime(input.time);
  if (!time) {
    return {
      ok: false,
      error: 'Horario invalido. Use HH:MM, por exemplo 03:30.',
    };
  }

  const days = parseDaysInput(input.days);
  if (days.length === 0) {
    return {
      ok: false,
      error: 'Dias invalidos. Use todos, uteis, fds ou nomes como seg, qua, sex.',
    };
  }

  const command = cleanText(input.command);
  if (action === 'command' && !command) {
    return {
      ok: false,
      error: 'Informe o comando do console para automacao do tipo comando.',
    };
  }

  const now = new Date().toISOString();
  const automation = {
    id: generateAutomationId(),
    action,
    time,
    days,
    enabled: true,
    command,
    retainBackups: Math.max(1, Number.parseInt(input.retainBackups, 10) || DEFAULT_BACKUP_KEEP),
    createdAt: now,
    updatedAt: now,
    lastRunKey: '',
    lastRunAt: '',
    lastResult: null,
  };

  const store = loadStore();
  store.automations.push(automation);
  saveStore(store);

  return {
    ok: true,
    automation,
  };
}

function removeAutomation(id) {
  const normalizedId = cleanText(id);
  const store = loadStore();
  const originalLength = store.automations.length;
  store.automations = store.automations.filter((automation) => automation.id !== normalizedId);

  if (store.automations.length === originalLength) {
    return {
      ok: false,
      error: 'Automacao nao encontrada.',
    };
  }

  saveStore(store);
  return {
    ok: true,
  };
}

function updateAutomation(id, updater) {
  const normalizedId = cleanText(id);
  const store = loadStore();
  const automation = store.automations.find((item) => item.id === normalizedId);

  if (!automation) {
    return null;
  }

  updater(automation);
  automation.updatedAt = new Date().toISOString();
  saveStore(store);
  return automation;
}

function setAutomationEnabled(id, enabled) {
  const automation = updateAutomation(id, (item) => {
    item.enabled = Boolean(enabled);
  });

  if (!automation) {
    return {
      ok: false,
      error: 'Automacao nao encontrada.',
    };
  }

  return {
    ok: true,
    automation,
  };
}

function getZonedParts(date = new Date()) {
  const timezone = getAutomationTimezone();

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    const year = Number.parseInt(parts.year, 10);
    const month = Number.parseInt(parts.month, 10);
    const day = Number.parseInt(parts.day, 10);
    const hour = Number.parseInt(parts.hour, 10);
    const minute = Number.parseInt(parts.minute, 10);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
    const timeKey = `${parts.hour}:${parts.minute}`;

    return {
      timezone,
      year,
      month,
      day,
      hour,
      minute,
      weekday,
      dateKey,
      timeKey,
      runKey: `${dateKey} ${timeKey}`,
    };
  } catch (error) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hour = date.getHours();
    const minute = date.getMinutes();
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const timeKey = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

    return {
      timezone: 'local',
      year,
      month,
      day,
      hour,
      minute,
      weekday: date.getDay(),
      dateKey,
      timeKey,
      runKey: `${dateKey} ${timeKey}`,
    };
  }
}

function isAutomationDue(automation, nowParts) {
  return (
    automation.enabled !== false &&
    automation.time === nowParts.timeKey &&
    automation.days.includes(nowParts.weekday) &&
    automation.lastRunKey !== nowParts.runKey
  );
}

function buildBackupName(date = new Date()) {
  const parts = getZonedParts(date);
  return `${BACKUP_PREFIX}${parts.dateKey} ${parts.timeKey}`;
}

async function runBackupTask(retainBackups = DEFAULT_BACKUP_KEEP) {
  const keep = Math.max(1, Number.parseInt(retainBackups, 10) || DEFAULT_BACKUP_KEEP);
  const ignored = cleanText(process.env.PTERO_BACKUP_IGNORED);
  let prePrune = null;
  let createResult = await createPteroBackup({
    name: buildBackupName(),
    ignored,
    isLocked: false,
  });

  if (!createResult.ok) {
    const firstError = extractPteroError(createResult);
    const normalizedError = stripAccents(firstError).toLowerCase();
    const looksLikeBackupLimit = /limit|maximum|maximo|too many|atingiu|chegou|quota/.test(normalizedError);

    if (looksLikeBackupLimit) {
      prePrune = await prunePteroBackups({
        keep: Math.max(0, keep - 1),
        prefix: BACKUP_PREFIX,
        managedOnly: true,
      });
      createResult = await createPteroBackup({
        name: buildBackupName(),
        ignored,
        isLocked: false,
      });
    }

    if (!createResult.ok) {
      return {
        ok: false,
        message: `Falha ao criar backup: ${firstError}`,
      };
    }
  }

  const postPrune = await prunePteroBackups({
    keep,
    prefix: BACKUP_PREFIX,
    managedOnly: true,
  });
  const deletedCount = (prePrune?.deleted?.length || 0) + (postPrune.deleted?.length || 0);
  const failedCount = (prePrune?.failed?.length || 0) + (postPrune.failed?.length || 0);
  const backupName = createResult.backup?.name || 'backup automatico';

  if (prePrune?.ok === false || postPrune.ok === false || failedCount > 0) {
    return {
      ok: false,
      message: `Backup solicitado (${backupName}), mas a limpeza de backups antigos falhou.`,
    };
  }

  return {
    ok: true,
    message: `Backup solicitado (${backupName}). Backups antigos apagados: ${deletedCount}.`,
  };
}

async function executeAutomation(automation, options = {}) {
  const action = normalizeAction(automation?.action);
  if (!action) {
    return {
      ok: false,
      message: 'Tipo de automacao invalido.',
    };
  }

  if (action === 'backup') {
    return runBackupTask(automation.retainBackups);
  }

  if (action === 'save') {
    const result = await runServerConsoleCommand('save');
    return result.ok
      ? {
          ok: true,
          message: `Save enviado via ${result.transport}.`,
        }
      : {
          ok: false,
          message: `Falha ao enviar save. RCON: ${result.rconError || 'N/A'} | Pterodactyl: ${result.pteroError || 'N/A'}`,
        };
  }

  if (action === 'command') {
    const command = cleanText(automation.command);
    if (!command) {
      return {
        ok: false,
        message: 'Comando do console ausente.',
      };
    }

    const result = await runServerConsoleCommand(command);
    return result.ok
      ? {
          ok: true,
          message: `Comando "${command}" enviado via ${result.transport}.`,
        }
      : {
          ok: false,
          message: `Falha no comando "${command}". RCON: ${result.rconError || 'N/A'} | Pterodactyl: ${result.pteroError || 'N/A'}`,
        };
  }

  const result = await manageServer(action);
  return result.ok
    ? {
        ok: true,
        message: `${AUTOMATION_ACTIONS[action]} enviado ao Pterodactyl.`,
      }
    : {
        ok: false,
        message: `Falha ao executar ${AUTOMATION_ACTIONS[action]}: ${extractPteroError(result)}`,
      };
}

async function notifyAutomation(options, message) {
  if (typeof options.notify !== 'function') {
    return;
  }

  try {
    await options.notify(message);
  } catch (error) {
    logError('Notificacao de automacao', error);
  }
}

async function runDueAutomations(options = {}) {
  if (automationLoopRunning) {
    return;
  }

  automationLoopRunning = true;
  try {
    const nowParts = getZonedParts();
    const store = loadStore();
    const dueAutomations = store.automations.filter((automation) => isAutomationDue(automation, nowParts));

    if (dueAutomations.length === 0) {
      return;
    }

    for (const automation of dueAutomations) {
      updateAutomation(automation.id, (item) => {
        item.lastRunKey = nowParts.runKey;
        item.lastRunAt = new Date().toISOString();
      });

      logInfo(`Executando automacao ${automation.id}: ${AUTOMATION_ACTIONS[automation.action]}`);
      const result = await executeAutomation(automation, { scheduled: true });
      updateAutomation(automation.id, (item) => {
        item.lastResult = {
          ok: result.ok,
          message: result.message,
          at: new Date().toISOString(),
        };
      });

      await notifyAutomation(
        options,
        `[AUTOMACAO] ${result.ok ? 'OK' : 'FALHA'} ${AUTOMATION_ACTIONS[automation.action]} (${automation.id})\n${result.message}`,
      );
    }
  } catch (error) {
    logError('Loop de automacoes', error);
  } finally {
    automationLoopRunning = false;
  }
}

function startAutomationLoop(options = {}) {
  if (automationLoop) {
    return;
  }

  const intervalMs = Math.max(5000, Number.parseInt(options.intervalMs, 10) || 30000);
  runDueAutomations(options).catch((error) => logError('Execucao inicial das automacoes', error));
  automationLoop = setInterval(() => {
    runDueAutomations(options).catch((error) => logError('Execucao periodica das automacoes', error));
  }, intervalMs);
  logInfo(`Automacoes ativadas em ${getAutomationTimezone()} a cada ${Math.round(intervalMs / 1000)}s.`);
}

async function runAutomationNow(id) {
  const automation = getAutomations().find((item) => item.id === cleanText(id));
  if (!automation) {
    return {
      ok: false,
      error: 'Automacao nao encontrada.',
    };
  }

  const result = await executeAutomation(automation, { manual: true });
  updateAutomation(automation.id, (item) => {
    item.lastRunAt = new Date().toISOString();
    item.lastResult = {
      ok: result.ok,
      message: result.message,
      at: new Date().toISOString(),
      manual: true,
    };
  });

  return {
    ok: result.ok,
    automation,
    message: result.message,
  };
}

async function runBackupNow(retainBackups = DEFAULT_BACKUP_KEEP) {
  return runBackupTask(retainBackups);
}

function formatAutomationLine(automation) {
  const status = automation.enabled ? 'ativa' : 'pausada';
  const actionLabel = AUTOMATION_ACTIONS[automation.action] || automation.action;
  const backupInfo = automation.action === 'backup' ? ` | manter ${automation.retainBackups} backup(s)` : '';
  const commandInfo = automation.action === 'command' ? ` | ${automation.command}` : '';
  const lastInfo = automation.lastResult?.message ? ` | ultimo: ${automation.lastResult.ok ? 'OK' : 'FALHA'}` : '';
  return `\`${automation.id}\` ${status} | ${actionLabel} | ${automation.time} | ${formatDays(automation.days)}${backupInfo}${commandInfo}${lastInfo}`;
}

function formatAutomationsList(automations = getAutomations()) {
  if (!automations.length) {
    return 'Nenhuma automacao criada ainda.';
  }

  return automations.map(formatAutomationLine).join('\n');
}

module.exports = {
  AUTOMATION_ACTIONS,
  BACKUP_PREFIX,
  DEFAULT_BACKUP_KEEP,
  createAutomation,
  executeAutomation,
  formatAutomationLine,
  formatAutomationsList,
  getAutomations,
  getAutomationTimezone,
  parseDaysInput,
  removeAutomation,
  runAutomationNow,
  runBackupNow,
  startAutomationLoop,
  setAutomationEnabled,
};
