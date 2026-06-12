const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { cleanText, logError, logInfo, truncate } = require('./utils');

const DEFAULT_PM2_APP_NAME = 'manguadu';
const DEFAULT_UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_AUTO_UPDATE_INTERVAL_MS = 2 * 60 * 1000;
const UPDATE_LOG_FILE = path.join(__dirname, '..', 'data', 'update-bot.log');

let autoUpdateLoop = null;
let autoUpdateRunning = false;

function getProjectRoot() {
  return path.join(__dirname, '..');
}

function getPm2AppName() {
  return cleanText(process.env.PM2_APP_NAME) || DEFAULT_PM2_APP_NAME;
}

function getUpdateScriptPath() {
  return cleanText(process.env.BOT_UPDATE_SCRIPT) || path.join(getProjectRoot(), 'scripts', 'update-bot.sh');
}

function getUpdateTimeoutMs() {
  const parsed = Number.parseInt(cleanText(process.env.BOT_UPDATE_TIMEOUT_MS), 10);
  return Number.isFinite(parsed) && parsed >= 30000 ? parsed : DEFAULT_UPDATE_TIMEOUT_MS;
}

function isAutoUpdateEnabled() {
  const value = cleanText(process.env.BOT_AUTO_UPDATE_ENABLED).toLowerCase();
  return ['1', 'true', 'sim', 'yes', 'on'].includes(value);
}

function getAutoUpdateIntervalMs() {
  const parsed = Number.parseInt(cleanText(process.env.BOT_AUTO_UPDATE_INTERVAL_MS), 10);
  return Number.isFinite(parsed) && parsed >= 60000 ? parsed : DEFAULT_AUTO_UPDATE_INTERVAL_MS;
}

function getGitHubToken(environment = process.env) {
  return cleanText(environment.BOT_GITHUB_TOKEN) || cleanText(environment.GITHUB_TOKEN);
}

function buildGitEnvironment(environment = process.env) {
  const env = {
    ...environment,
    GIT_TERMINAL_PROMPT: '0',
  };
  const token = getGitHubToken(environment);
  if (!token) {
    return env;
  }

  const basicAuth = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
  env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basicAuth}`;
  return env;
}

function readLastUpdateLog(maxLength = 1800) {
  try {
    if (!fs.existsSync(UPDATE_LOG_FILE)) {
      return 'Nenhum log de atualizacao encontrado ainda.';
    }

    const content = fs.readFileSync(UPDATE_LOG_FILE, 'utf8');
    return truncate(content.slice(-maxLength), maxLength);
  } catch (error) {
    return `Falha ao ler log: ${error.message}`;
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || getProjectRoot(),
      env: options.env || process.env,
      windowsHide: true,
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
        error: `Tempo limite excedido (${Math.round((options.timeoutMs || DEFAULT_UPDATE_TIMEOUT_MS) / 1000)}s).`,
      });
    }, options.timeoutMs || DEFAULT_UPDATE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr,
        error: error.message,
      });
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        error: code === 0 ? '' : `Processo finalizou com codigo ${code}.`,
      });
    });
  });
}

async function runGit(args, timeoutMs = 60000) {
  return runProcess('git', args, {
    cwd: getProjectRoot(),
    timeoutMs,
    env: buildGitEnvironment(),
  });
}

async function checkForRemoteUpdate() {
  const branchFromEnv = cleanText(process.env.BOT_UPDATE_BRANCH);
  const branchResult = branchFromEnv
    ? { ok: true, stdout: branchFromEnv }
    : await runGit(['branch', '--show-current'], 15000);

  if (!branchResult.ok || !cleanText(branchResult.stdout)) {
    return {
      ok: false,
      error: branchResult.error || 'Nao consegui descobrir a branch atual.',
    };
  }

  const branch = cleanText(branchResult.stdout);
  const fetchResult = await runGit(['fetch', '--prune', 'origin'], 60000);
  if (!fetchResult.ok) {
    return {
      ok: false,
      error: cleanText(fetchResult.stderr) || fetchResult.error || 'Falha no git fetch.',
    };
  }

  const localResult = await runGit(['rev-parse', 'HEAD'], 15000);
  const remoteResult = await runGit(['rev-parse', `origin/${branch}`], 15000);
  if (!localResult.ok || !remoteResult.ok) {
    return {
      ok: false,
      error: localResult.error || remoteResult.error || 'Falha ao comparar commits local/remoto.',
    };
  }

  const local = cleanText(localResult.stdout);
  const remote = cleanText(remoteResult.stdout);
  return {
    ok: true,
    branch,
    local,
    remote,
    hasUpdate: Boolean(local && remote && local !== remote),
  };
}

async function runBotUpdate() {
  const scriptPath = getUpdateScriptPath();
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      error: `Script de atualizacao nao encontrado: ${scriptPath}`,
      output: '',
    };
  }

  const env = {
    ...process.env,
    BOT_UPDATE_SKIP_RESTART: '1',
  };

  const result = await runProcess('bash', [scriptPath], {
    cwd: getProjectRoot(),
    env,
    timeoutMs: getUpdateTimeoutMs(),
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');

  return {
    ok: result.ok,
    error: result.error,
    code: result.code,
    output: truncate(output, 1800),
  };
}

function scheduleBotRestart(delayMs = 3000) {
  const pm2Bin = cleanText(process.env.PM2_BIN) || 'pm2';
  const appName = getPm2AppName();

  setTimeout(() => {
    try {
      const child = spawn(pm2Bin, ['restart', appName, '--update-env'], {
        cwd: getProjectRoot(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });

      child.on('error', (error) => logError('Reinicio do bot pelo PM2', error));
      child.unref();
    } catch (error) {
      logError('Reinicio do bot pelo PM2', error);
    }
  }, delayMs);
}

async function notifyAutoUpdate(options, message) {
  if (typeof options.notify !== 'function') {
    return;
  }

  try {
    await options.notify(message);
  } catch (error) {
    logError('Notificacao de auto-update', error);
  }
}

async function runAutoUpdateCheck(options = {}) {
  if (!isAutoUpdateEnabled() || autoUpdateRunning) {
    return;
  }

  autoUpdateRunning = true;
  try {
    const check = await checkForRemoteUpdate();
    if (!check.ok) {
      logError('Verificacao de auto-update', check.error || 'Falha desconhecida');
      return;
    }

    if (!check.hasUpdate) {
      return;
    }

    const shortLocal = check.local.slice(0, 7);
    const shortRemote = check.remote.slice(0, 7);
    await notifyAutoUpdate(options, `[BOT] Atualizacao encontrada na branch ${check.branch}: ${shortLocal} -> ${shortRemote}.`);

    const result = await runBotUpdate();
    if (!result.ok) {
      await notifyAutoUpdate(options, `[BOT] Auto-update falhou.\n${truncate(result.error || result.output || 'Sem detalhes.', 1500)}`);
      return;
    }

    await notifyAutoUpdate(options, '[BOT] Auto-update concluido. Reiniciando o bot.');
    scheduleBotRestart();
  } catch (error) {
    logError('Auto-update do bot', error);
  } finally {
    autoUpdateRunning = false;
  }
}

function startBotAutoUpdateLoop(options = {}) {
  if (!isAutoUpdateEnabled() || autoUpdateLoop) {
    return false;
  }

  const intervalMs = getAutoUpdateIntervalMs();
  autoUpdateLoop = setInterval(() => {
    runAutoUpdateCheck(options).catch((error) => logError('Loop de auto-update do bot', error));
  }, intervalMs);

  runAutoUpdateCheck(options).catch((error) => logError('Execucao inicial do auto-update do bot', error));
  logInfo(`Auto-update do bot ativado a cada ${Math.round(intervalMs / 1000)}s.`);
  return true;
}

function getBotUpdateStatus() {
  return {
    projectRoot: getProjectRoot(),
    scriptPath: getUpdateScriptPath(),
    scriptExists: fs.existsSync(getUpdateScriptPath()),
    pm2AppName: getPm2AppName(),
    timeoutMs: getUpdateTimeoutMs(),
    autoUpdateEnabled: isAutoUpdateEnabled(),
    autoUpdateIntervalMs: getAutoUpdateIntervalMs(),
    gitHubAuthConfigured: Boolean(getGitHubToken()),
    logFile: UPDATE_LOG_FILE,
  };
}

module.exports = {
  buildGitEnvironment,
  checkForRemoteUpdate,
  getBotUpdateStatus,
  readLastUpdateLog,
  runBotUpdate,
  scheduleBotRestart,
  startBotAutoUpdateLoop,
};
