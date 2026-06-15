const fs = require('fs');
const os = require('os');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { extractPteroError, readPteroFile, writePteroFile } = require('./server-integrations');

const {
  cleanText,
  logError,
  logInfo,
  logWarn,
  normalizeHeader,
  parseDelimitedCsv,
  toNumber,
  truncate,
} = require('./utils');

const DEFAULT_PENDING_FILE = path.join(os.homedir(), 'Zomboid', 'Lua', 'PZAntiCheat_pending_alerts.csv');
const DEFAULT_HEADER = 'timestamp,username,steam_id,cheat,count,detail,pos\n';
const STATE_FILE = path.join(__dirname, '..', 'data', 'anticheat-alerts-state.json');
const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

let alertLoop = null;
let alertLoopRunning = false;
let missingFileWarned = false;

function isEnabled() {
  const value = cleanText(process.env.ANTICHEAT_ALERTS_ENABLED || '1').toLowerCase();
  return !['0', 'false', 'nao', 'no', 'off'].includes(value);
}

function shouldClearPendingFile() {
  const value = cleanText(process.env.ANTICHEAT_CLEAR_PENDING || '1').toLowerCase();
  return !['0', 'false', 'nao', 'no', 'off'].includes(value);
}

function getPollIntervalMs() {
  return Math.max(5000, toNumber(process.env.ANTICHEAT_POLL_INTERVAL_MS, 15000));
}

function getMaxAlertsPerTick() {
  return Math.max(1, Math.min(25, toNumber(process.env.ANTICHEAT_MAX_ALERTS_PER_TICK, 10)));
}

function getMaxAlertAgeMs() {
  return Math.max(0, toNumber(process.env.ANTICHEAT_MAX_ALERT_AGE_MINUTES, 10)) * 60 * 1000;
}

function getAlertCooldownMs() {
  return Math.max(0, toNumber(process.env.ANTICHEAT_ALERT_COOLDOWN_MINUTES, 10)) * 60 * 1000;
}

function shouldIgnoreExistingOnStart() {
  const value = cleanText(process.env.ANTICHEAT_IGNORE_EXISTING_ON_START || '1').toLowerCase();
  return !['0', 'false', 'nao', 'no', 'off'].includes(value);
}

function getAlertTimezone() {
  return cleanText(process.env.ANTICHEAT_TIMEZONE)
    || cleanText(process.env.AUTOMATION_TIMEZONE)
    || cleanText(process.env.TZ)
    || DEFAULT_TIMEZONE;
}

function getAlertChannelId() {
  return cleanText(process.env.ANTICHEAT_ALERT_CHANNEL_ID) || cleanText(process.env.ID_CANAL_ADMIN);
}

function getPendingCsvPath() {
  return cleanText(process.env.ANTICHEAT_CSV_PATH) || DEFAULT_PENDING_FILE;
}

function getPendingPteroPath() {
  return cleanText(process.env.ANTICHEAT_PTERO_CSV_PATH);
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { initialized: false, sentKeys: [], recentGroups: {} };
    }

    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      initialized: true,
      sentKeys: Array.isArray(parsed.sentKeys) ? parsed.sentKeys.map(cleanText).filter(Boolean) : [],
      recentGroups: parsed.recentGroups && typeof parsed.recentGroups === 'object'
        ? parsed.recentGroups
        : {},
    };
  } catch (error) {
    logError('PZAntiCheat state', error);
    return { initialized: false, sentKeys: [], recentGroups: {} };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const uniqueKeys = [...new Set((state.sentKeys || []).map(cleanText).filter(Boolean))].slice(-5000);
    const recentGroups = Object.fromEntries(
      Object.entries(state.recentGroups || {})
        .filter(([, timestamp]) => Number.isFinite(Number(timestamp)))
        .sort((left, right) => Number(left[1]) - Number(right[1]))
        .slice(-1000),
    );
    const tempPath = `${STATE_FILE}.tmp`;
    fs.writeFileSync(
      tempPath,
      `${JSON.stringify({ initializedAt: state.initializedAt || new Date().toISOString(), sentKeys: uniqueKeys, recentGroups }, null, 2)}\n`,
      'utf8',
    );
    fs.renameSync(tempPath, STATE_FILE);
  } catch (error) {
    logError('PZAntiCheat state save', error);
  }
}

function readPendingFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return '';
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    logError(`PZAntiCheat CSV read ${filePath}`, error);
    return '';
  }
}

async function readPendingSource() {
  const localPath = getPendingCsvPath();
  if (fs.existsSync(localPath)) {
    return { ok: true, type: 'local', path: localPath, content: readPendingFile(localPath) };
  }

  const pteroPath = getPendingPteroPath();
  if (!pteroPath) {
    return { ok: false, missing: true, path: localPath };
  }

  const result = await readPteroFile(pteroPath);
  if (!result.ok) {
    return { ok: false, path: pteroPath, error: extractPteroError(result) };
  }

  return { ok: true, type: 'ptero', path: pteroPath, content: result.text || '' };
}

function parseAlerts(content) {
  if (!cleanText(content)) {
    return [];
  }

  const rows = parseDelimitedCsv(content, {
    delimiter: ',',
    skipEmptyLines: true,
    trim: true,
  });

  if (rows.length <= 1) {
    return [];
  }

  const headers = rows[0].map(normalizeHeader);
  return rows
    .slice(1)
    .map((row) => {
      const record = {};
      for (let index = 0; index < headers.length; index += 1) {
        const header = headers[index];
        if (header) {
          record[header] = row[index] !== undefined ? cleanText(row[index]) : '';
        }
      }

      return {
        timestamp: cleanText(record.timestamp),
        username: cleanText(record.username),
        steamId: cleanText(record.steam_id || record.steamid || record.steam),
        cheat: cleanText(record.cheat || record.type),
        count: cleanText(record.count),
        detail: cleanText(record.detail),
        pos: cleanText(record.pos || record.position),
      };
    })
    .filter((alert) => alert.timestamp || alert.username || alert.steamId || alert.cheat || alert.detail);
}

function getAlertKey(alert) {
  return [
    alert.timestamp,
    alert.username,
    alert.steamId,
    alert.cheat,
    alert.count,
    alert.detail,
    alert.pos,
  ].map(cleanText).join('|');
}

function getAlertGroupKey(alert) {
  const player = cleanText(alert.steamId || alert.username || 'desconhecido').toLowerCase();
  const cheat = cleanText(alert.cheat || 'alerta').toLowerCase();
  return `${player}|${cheat}`;
}

function getTimeZoneOffsetMs(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const representedAsUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );
    return representedAsUtc - date.getTime();
  } catch (error) {
    return 0;
  }
}

function parseAlertTimestamp(value, timeZone = getAlertTimezone()) {
  const timestamp = cleanText(value);
  if (!timestamp) {
    return null;
  }

  if (/^\d{10,13}$/.test(timestamp)) {
    const numeric = Number(timestamp);
    const date = new Date(timestamp.length === 10 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const localMatch = timestamp.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/,
  );
  if (localMatch) {
    const [, year, month, day, hour, minute, second = '0'] = localMatch;
    const utcGuess = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
    let resolved = utcGuess - getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
    resolved = utcGuess - getTimeZoneOffsetMs(new Date(resolved), timeZone);
    const date = new Date(resolved);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isAlertRecent(alert, now = Date.now()) {
  const maxAgeMs = getMaxAlertAgeMs();
  if (maxAgeMs === 0) {
    return true;
  }

  const timestamp = parseAlertTimestamp(alert.timestamp);
  if (!timestamp) {
    return true;
  }

  const ageMs = now - timestamp.getTime();
  return ageMs >= -2 * 60 * 1000 && ageMs <= maxAgeMs;
}

function groupAlerts(alerts) {
  const groups = new Map();
  for (const alert of alerts) {
    const key = getAlertGroupKey(alert);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { key, count: 1, alert });
      continue;
    }

    current.count += 1;
    const currentDate = parseAlertTimestamp(current.alert.timestamp);
    const nextDate = parseAlertTimestamp(alert.timestamp);
    if (!currentDate || (nextDate && nextDate.getTime() >= currentDate.getTime())) {
      current.alert = alert;
    }
  }
  return [...groups.values()];
}

function getHeaderFromContent(content) {
  const firstLine = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')[0];
  return cleanText(firstLine) ? `${firstLine}\n` : DEFAULT_HEADER;
}

function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function clearProcessedPendingFile(filePath, originalContent) {
  if (!shouldClearPendingFile()) {
    return;
  }

  try {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const currentContent = fs.readFileSync(filePath, 'utf8');
    const header = getHeaderFromContent(originalContent);

    if (currentContent === originalContent) {
      writeFileAtomic(filePath, header);
      return;
    }

    if (currentContent.startsWith(originalContent)) {
      const appendedContent = currentContent.slice(originalContent.length).replace(/^\r?\n+/, '');
      writeFileAtomic(filePath, `${header}${appendedContent}`);
      return;
    }

    logWarn('PZAntiCheat CSV mudou durante o envio; mantendo pending para evitar perda de alerta.');
  } catch (error) {
    logError('PZAntiCheat CSV clear', error);
  }
}

function getClearedPendingContent(currentContent, originalContent) {
  const header = getHeaderFromContent(originalContent);
  if (currentContent === originalContent) {
    return header;
  }
  if (currentContent.startsWith(originalContent)) {
    const appendedContent = currentContent.slice(originalContent.length).replace(/^\r?\n+/, '');
    return `${header}${appendedContent}`;
  }
  return null;
}

async function clearProcessedSource(source, originalContent) {
  if (!shouldClearPendingFile()) {
    return;
  }
  if (source.type === 'local') {
    clearProcessedPendingFile(source.path, originalContent);
    return;
  }

  const currentResult = await readPteroFile(source.path);
  if (!currentResult.ok) {
    logError('PZAntiCheat Pterodactyl CSV read', new Error(extractPteroError(currentResult)));
    return;
  }
  const nextContent = getClearedPendingContent(currentResult.text || '', originalContent);
  if (nextContent === null) {
    logWarn('PZAntiCheat CSV mudou durante o envio; mantendo pending para evitar perda de alerta.');
    return;
  }
  const writeResult = await writePteroFile(source.path, nextContent);
  if (!writeResult.ok) {
    logError('PZAntiCheat Pterodactyl CSV clear', new Error(extractPteroError(writeResult)));
  }
}

function formatAlertGroup(group) {
  const { alert } = group;
  const sourceCount = Math.max(0, toNumber(alert.count, 0));
  const repetitions = Math.max(group.count, sourceCount);
  const title = `**${truncate(alert.username || 'Jogador desconhecido', 80)}** · \`${truncate(alert.cheat || 'alerta', 50)}\``;
  const metadata = [
    repetitions > 1 ? `${repetitions} ocorrencias` : '',
    alert.pos ? `pos. ${truncate(alert.pos, 60)}` : '',
  ].filter(Boolean).join(' · ');
  const detail = alert.detail ? truncate(alert.detail, 180) : '';

  return [title, metadata, detail].filter(Boolean).join('\n');
}

function buildAlertEmbed(groups, omittedCount = 0) {
  const lines = groups.map(formatAlertGroup);
  if (omittedCount > 0) {
    lines.push(`*+ ${omittedCount} deteccoes agrupadas nesta varredura.*`);
  }

  return new EmbedBuilder()
    .setColor(0xd63c3c)
    .setTitle('Alerta anticheat')
    .setDescription(truncate(lines.join('\n\n'), 4096))
    .setFooter({ text: `${groups.length + omittedCount} deteccao(oes) nova(s)` })
    .setTimestamp(new Date());
}

async function sendAlerts(fetchTextChannel, groups, omittedCount = 0) {
  const channelId = getAlertChannelId();
  if (!channelId) {
    logWarn('ANTICHEAT_ALERT_CHANNEL_ID/ID_CANAL_ADMIN ausente; alertas PZAntiCheat nao enviados.');
    return false;
  }

  const channel = await fetchTextChannel(channelId);
  if (!channel) {
    logWarn(`Canal de alertas PZAntiCheat nao encontrado: ${channelId}`);
    return false;
  }

  await channel.send({ embeds: [buildAlertEmbed(groups, omittedCount)] });

  return true;
}

async function scanAntiCheatAlerts(options = {}) {
  if (!isEnabled()) {
    return;
  }

  const fetchTextChannel = options.fetchTextChannel;
  if (typeof fetchTextChannel !== 'function') {
    logWarn('PZAntiCheat alert loop sem fetchTextChannel.');
    return;
  }

  const source = await readPendingSource();
  if (!source.ok) {
    if (!missingFileWarned) {
      missingFileWarned = true;
      logWarn(
        source.missing
          ? `CSV pending do PZAntiCheat ainda nao encontrado: ${source.path}`
          : `Falha ao ler CSV pending do PZAntiCheat (${source.path}): ${source.error}`,
      );
    }
    return;
  }
  missingFileWarned = false;

  const originalContent = source.content;
  const alerts = parseAlerts(originalContent);
  if (alerts.length === 0) {
    return;
  }

  const state = loadState();
  const sentKeys = new Set(state.sentKeys || []);
  const recentGroups = state.recentGroups || {};

  if (!state.initialized && shouldIgnoreExistingOnStart()) {
    for (const alert of alerts) {
      sentKeys.add(getAlertKey(alert));
    }
    saveState({ sentKeys: [...sentKeys], recentGroups });
    await clearProcessedSource(source, originalContent);
    logInfo(`PZAntiCheat inicializado ignorando ${alerts.length} registro(s) ja existente(s).`);
    return;
  }

  const now = Date.now();
  const unseenAlerts = alerts.filter((alert) => !sentKeys.has(getAlertKey(alert)));
  const recentAlerts = [];
  for (const alert of unseenAlerts) {
    sentKeys.add(getAlertKey(alert));
    if (isAlertRecent(alert, now)) {
      recentAlerts.push(alert);
    }
  }

  if (unseenAlerts.length === 0) {
    await clearProcessedSource(source, originalContent);
    return;
  }

  const cooldownMs = getAlertCooldownMs();
  const pendingGroups = groupAlerts(recentAlerts).filter((group) => {
    const lastSentAt = Number(recentGroups[group.key] || 0);
    return cooldownMs === 0 || now - lastSentAt >= cooldownMs;
  });

  if (pendingGroups.length === 0) {
    saveState({ sentKeys: [...sentKeys], recentGroups });
    await clearProcessedSource(source, originalContent);
    return;
  }

  const maxAlerts = getMaxAlertsPerTick();
  const groupsToSend = pendingGroups.slice(0, maxAlerts);
  const omittedCount = Math.max(0, pendingGroups.length - groupsToSend.length);
  const sent = await sendAlerts(fetchTextChannel, groupsToSend, omittedCount);
  if (!sent) {
    return;
  }

  for (const group of pendingGroups) {
    recentGroups[group.key] = now;
  }
  saveState({ sentKeys: [...sentKeys], recentGroups });
  await clearProcessedSource(source, originalContent);
}

function startAntiCheatAlertLoop(options = {}) {
  if (!isEnabled()) {
    logInfo('Alertas PZAntiCheat desativados por ANTICHEAT_ALERTS_ENABLED.');
    return null;
  }

  if (alertLoop) {
    return alertLoop;
  }

  const intervalMs = getPollIntervalMs();
  const run = async () => {
    if (alertLoopRunning) {
      return;
    }

    alertLoopRunning = true;
    try {
      await scanAntiCheatAlerts(options);
    } catch (error) {
      logError('PZAntiCheat alert loop', error);
    } finally {
      alertLoopRunning = false;
    }
  };

  run();
  alertLoop = setInterval(run, intervalMs);
  const sourceDescription = getPendingPteroPath()
    ? `${getPendingCsvPath()} (local) ou ${getPendingPteroPath()} (Pterodactyl)`
    : getPendingCsvPath();
  logInfo(`Leitor PZAntiCheat ativo: ${sourceDescription} (${intervalMs}ms)`);
  return alertLoop;
}

module.exports = {
  buildAlertEmbed,
  getPendingCsvPath,
  getPendingPteroPath,
  groupAlerts,
  isAlertRecent,
  parseAlertTimestamp,
  parseAlerts,
  scanAntiCheatAlerts,
  startAntiCheatAlertLoop,
};
