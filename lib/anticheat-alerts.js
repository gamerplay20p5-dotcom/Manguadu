const fs = require('fs');
const os = require('os');
const path = require('path');
const { EmbedBuilder } = require('discord.js');

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
  return Math.max(1, Math.min(100, toNumber(process.env.ANTICHEAT_MAX_ALERTS_PER_TICK, 25)));
}

function getAlertChannelId() {
  return cleanText(process.env.ANTICHEAT_ALERT_CHANNEL_ID) || cleanText(process.env.ID_CANAL_ADMIN);
}

function getPendingCsvPath() {
  return cleanText(process.env.ANTICHEAT_CSV_PATH) || DEFAULT_PENDING_FILE;
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { sentKeys: [] };
    }

    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      sentKeys: Array.isArray(parsed.sentKeys) ? parsed.sentKeys.map(cleanText).filter(Boolean) : [],
    };
  } catch (error) {
    logError('PZAntiCheat state', error);
    return { sentKeys: [] };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const uniqueKeys = [...new Set((state.sentKeys || []).map(cleanText).filter(Boolean))].slice(-2000);
    const tempPath = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify({ sentKeys: uniqueKeys }, null, 2)}\n`, 'utf8');
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

function formatAlertField(alert) {
  const details = [
    alert.steamId ? `Steam: \`${alert.steamId}\`` : '',
    alert.count ? `Contagem: \`${alert.count}\`` : '',
    alert.pos ? `Pos: \`${alert.pos}\`` : '',
    alert.timestamp ? `Hora: \`${alert.timestamp}\`` : '',
    alert.detail ? `Detalhe: ${truncate(alert.detail, 500)}` : '',
  ].filter(Boolean);

  return {
    name: truncate(`${alert.username || 'Jogador desconhecido'} - ${alert.cheat || 'Alerta'}`, 256),
    value: truncate(details.join('\n') || 'Sem detalhes adicionais.', 1024),
  };
}

function buildAlertEmbeds(alerts) {
  const embeds = [];
  for (let index = 0; index < alerts.length; index += 5) {
    const chunk = alerts.slice(index, index + 5);
    embeds.push(
      new EmbedBuilder()
        .setColor(0xd63c3c)
        .setTitle('PZAntiCheat - alertas detectados')
        .setDescription(`Novos alertas enviados pelo CSV pending: ${chunk.length}`)
        .setTimestamp(new Date())
        .addFields(chunk.map(formatAlertField)),
    );
  }
  return embeds;
}

async function sendAlerts(fetchTextChannel, alerts) {
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

  const embeds = buildAlertEmbeds(alerts);
  for (let index = 0; index < embeds.length; index += 10) {
    await channel.send({ embeds: embeds.slice(index, index + 10) });
  }

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

  const filePath = getPendingCsvPath();
  if (!fs.existsSync(filePath)) {
    if (!missingFileWarned) {
      missingFileWarned = true;
      logWarn(`CSV pending do PZAntiCheat ainda nao encontrado: ${filePath}`);
    }
    return;
  }
  missingFileWarned = false;

  const originalContent = readPendingFile(filePath);
  const alerts = parseAlerts(originalContent);
  if (alerts.length === 0) {
    return;
  }

  const state = loadState();
  const sentKeys = new Set(state.sentKeys || []);
  const pendingAlerts = alerts.filter((alert) => !sentKeys.has(getAlertKey(alert)));

  if (pendingAlerts.length === 0) {
    clearProcessedPendingFile(filePath, originalContent);
    return;
  }

  const maxAlerts = getMaxAlertsPerTick();
  const alertsToSend = pendingAlerts.slice(0, maxAlerts);
  const sent = await sendAlerts(fetchTextChannel, alertsToSend);
  if (!sent) {
    return;
  }

  for (const alert of alertsToSend) {
    sentKeys.add(getAlertKey(alert));
  }
  saveState({ sentKeys: [...sentKeys] });

  if (alertsToSend.length === pendingAlerts.length) {
    clearProcessedPendingFile(filePath, originalContent);
  } else {
    logInfo(`PZAntiCheat enviou ${alertsToSend.length}/${pendingAlerts.length} alerta(s); restante fica para o proximo ciclo.`);
  }
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
  logInfo(`Leitor PZAntiCheat ativo: ${getPendingCsvPath()} (${intervalMs}ms)`);
  return alertLoop;
}

module.exports = {
  getPendingCsvPath,
  scanAntiCheatAlerts,
  startAntiCheatAlertLoop,
};
