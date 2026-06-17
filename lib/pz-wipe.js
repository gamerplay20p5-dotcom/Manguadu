const fs = require('fs');
const path = require('path');

const { cleanText, delay, getField, toNumber } = require('./utils');
const { findMapByName, getSafehouses } = require('./pz-data');
const { isLocalAbsolutePath, runLocalProcess } = require('./local-server-control');
const {
  createPteroBackup,
  deletePteroFiles,
  extractPteroError,
  fetchPteroResources,
  getPteroBackup,
  listPteroFiles,
} = require('./server-integrations');

const PROJECT_ROOT = path.join(__dirname, '..');

function getSaveRoot() {
  return cleanText(process.env.PZ_SAVE_ROOT);
}

function getLocalBackupDirectory() {
  return cleanText(process.env.PZ_LOCAL_BACKUP_DIR) || path.join(PROJECT_ROOT, 'data', 'local-wipe-backups');
}

function parsePair(value) {
  const match = cleanText(value).match(/^\s*(-?\d+)\s*[,;:]\s*(-?\d+)\s*$/);
  return match ? { x: Number.parseInt(match[1], 10), y: Number.parseInt(match[2], 10) } : null;
}

function normalizeSafehouse(row) {
  const x1 = toNumber(getField(row, ['x', 'x1']));
  const y1 = toNumber(getField(row, ['y', 'y1']));
  const x2 = toNumber(getField(row, ['x2']), x1);
  const y2 = toNumber(getField(row, ['y2']), y1);
  return {
    title: getField(row, ['title'], 'Sem titulo'),
    minX: Math.min(x1, x2),
    minY: Math.min(y1, y2),
    maxX: Math.max(x1, x2),
    maxY: Math.max(y1, y2),
  };
}

function rectanglesOverlap(left, right) {
  return left.minX <= right.maxX && left.maxX >= right.minX && left.minY <= right.maxY && left.maxY >= right.minY;
}

function getProtectedSafehouses(rectangle) {
  return getSafehouses().map(normalizeSafehouse).filter((safehouse) => rectanglesOverlap(rectangle, safehouse));
}

function cellRectangle(cellX, cellY) {
  return {
    minX: cellX * 300,
    minY: cellY * 300,
    maxX: cellX * 300 + 299,
    maxY: cellY * 300 + 299,
  };
}

function chunkRectangle(chunkX, chunkY) {
  return {
    minX: chunkX * 10,
    minY: chunkY * 10,
    maxX: chunkX * 10 + 9,
    maxY: chunkY * 10 + 9,
  };
}

function cellsForMap(map) {
  const cells = [];
  for (let x = Math.floor(map.minX / 300); x <= Math.floor(map.maxX / 300); x += 1) {
    for (let y = Math.floor(map.minY / 300); y <= Math.floor(map.maxY / 300); y += 1) {
      cells.push({ x, y });
    }
  }
  return cells;
}

function fileNamesForChunk(chunkX, chunkY) {
  return [`map_${chunkX}_${chunkY}.bin`, `chunkdata_${chunkX}_${chunkY}.bin`];
}

function fileNamesForCell(cellX, cellY) {
  const files = [`zpop_${cellX}_${cellY}.bin`];
  const startX = cellX * 30;
  const startY = cellY * 30;
  for (let chunkX = startX; chunkX < startX + 30; chunkX += 1) {
    for (let chunkY = startY; chunkY < startY + 30; chunkY += 1) {
      files.push(...fileNamesForChunk(chunkX, chunkY));
    }
  }
  return files;
}

function resolveCells(targetInput) {
  const pair = parsePair(targetInput);
  if (pair) {
    return { label: `celula ${pair.x},${pair.y}`, cells: [pair] };
  }

  const map = findMapByName(targetInput);
  if (!map) {
    return null;
  }
  return { label: map.name, map, cells: cellsForMap(map) };
}

function listLocalSaveFiles(root) {
  try {
    const files = fs.readdirSync(root, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }));
    return { ok: true, files };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function listSaveFiles(saveRoot) {
  if (isLocalAbsolutePath(saveRoot)) {
    return {
      ...(listLocalSaveFiles(saveRoot)),
      storage: 'local',
    };
  }

  const result = await listPteroFiles(saveRoot);
  return {
    ...result,
    storage: 'pterodactyl',
  };
}

async function buildWipePlan(options = {}) {
  const saveRoot = getSaveRoot();
  if (!saveRoot) {
    return { ok: false, error: 'PZ_SAVE_ROOT nao configurado no .env da VM.' };
  }

  const listResult = await listSaveFiles(saveRoot);
  if (!listResult.ok) {
    return { ok: false, error: `Falha ao listar save: ${extractPteroError(listResult)}` };
  }

  const existingNames = new Set(listResult.files.filter((file) => file.isFile).map((file) => file.name));
  const force = Boolean(options.force);
  const skipped = [];
  const requested = new Set();
  let label = '';

  if (options.kind === 'zeds') {
    const target = cleanText(options.target);
    if (!target || target.toLowerCase() === 'todos') {
      label = 'todos os mapas';
      for (const name of existingNames) {
        if (/^zpop_-?\d+_-?\d+\.bin$/i.test(name)) {
          requested.add(name);
        }
      }
    } else {
      const resolved = resolveCells(target);
      if (!resolved) {
        return { ok: false, error: 'Mapa/celula nao encontrado. Use /mapas ou informe x,y.' };
      }
      label = resolved.label;
      for (const cell of resolved.cells) {
        requested.add(`zpop_${cell.x}_${cell.y}.bin`);
      }
    }
  } else if (options.kind === 'chunk') {
    const chunk = parsePair(options.target);
    if (!chunk) {
      return { ok: false, error: 'Chunk invalido. Informe no formato x,y.' };
    }
    label = `chunk ${chunk.x},${chunk.y}`;
    const protectedBy = getProtectedSafehouses(chunkRectangle(chunk.x, chunk.y));
    if (!force && protectedBy.length > 0) {
      skipped.push({ target: label, safehouses: protectedBy.map((safehouse) => safehouse.title) });
    } else {
      fileNamesForChunk(chunk.x, chunk.y).forEach((name) => requested.add(name));
    }
  } else {
    const resolved = resolveCells(options.target);
    if (!resolved) {
      return { ok: false, error: 'Mapa/celula nao encontrado. Use /mapas ou informe x,y.' };
    }
    label = resolved.label;
    for (const cell of resolved.cells) {
      const protectedBy = getProtectedSafehouses(cellRectangle(cell.x, cell.y));
      if (!force && protectedBy.length > 0) {
        skipped.push({ target: `celula ${cell.x},${cell.y}`, safehouses: protectedBy.map((safehouse) => safehouse.title) });
        continue;
      }
      fileNamesForCell(cell.x, cell.y).forEach((name) => requested.add(name));
    }
  }

  const files = [...requested].filter((name) => existingNames.has(name)).sort();
  return {
    ok: true,
    root: saveRoot,
    storage: listResult.storage,
    kind: options.kind,
    label,
    force,
    files,
    skipped,
    availableFileCount: existingNames.size,
  };
}

async function waitForBackup(backupUuid) {
  const timeoutMs = Math.max(60000, Number.parseInt(process.env.PZ_WIPE_BACKUP_WAIT_MS, 10) || 10 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await getPteroBackup(backupUuid);
    if (!result.ok) {
      return { ok: false, error: extractPteroError(result) };
    }
    const backup = result.backup;
    if (backup?.completedAt) {
      return backup.isSuccessful
        ? { ok: true, backup }
        : { ok: false, error: 'O backup pre-wipe terminou com falha.' };
    }
    await delay(10000);
  }
  return { ok: false, error: 'Tempo limite aguardando o backup pre-wipe.' };
}

function assertSafeLocalFileName(fileName) {
  const normalized = cleanText(fileName);
  return Boolean(normalized && path.basename(normalized) === normalized && !normalized.includes('..'));
}

async function createLocalWipeBackup(plan) {
  const backupDirectory = getLocalBackupDirectory();
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = path.join(backupDirectory, `pre-wipe-${timestamp}.tar.gz`);
  const listPath = path.join(backupDirectory, `pre-wipe-${timestamp}.files`);
  const safeFiles = plan.files.filter(assertSafeLocalFileName);
  if (safeFiles.length !== plan.files.length) {
    return { ok: false, error: 'Plano contem arquivo inseguro para backup local.' };
  }

  fs.writeFileSync(listPath, `${safeFiles.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    const result = await runLocalProcess('tar', ['-czf', archivePath, '-C', plan.root, '-T', listPath], {
      timeoutMs: Math.max(60000, Number.parseInt(process.env.PZ_WIPE_BACKUP_WAIT_MS, 10) || 10 * 60 * 1000),
    });
    if (!result.ok) {
      return { ok: false, error: result.error || cleanText(result.stderr) || 'Falha no tar local.' };
    }
    return {
      ok: true,
      backup: {
        uuid: `local:${path.basename(archivePath)}`,
        name: path.basename(archivePath),
        completedAt: new Date().toISOString(),
        isSuccessful: true,
        archivePath,
      },
    };
  } finally {
    try {
      fs.rmSync(listPath, { force: true });
    } catch (error) {
      // ignore
    }
  }
}

async function createPreWipeBackup(plan) {
  const backupResult = await createPteroBackup({
    name: `Pre-wipe ${new Date().toISOString()} - ${plan.label}`,
    isLocked: true,
  });
  if (backupResult.ok && backupResult.backup?.uuid) {
    const completed = await waitForBackup(backupResult.backup.uuid);
    if (completed.ok) {
      return completed;
    }
    if (plan.storage === 'local') {
      return createLocalWipeBackup(plan);
    }
    return { ...completed, backup: backupResult.backup };
  }

  if (plan.storage === 'local') {
    return createLocalWipeBackup(plan);
  }

  return { ok: false, error: `Falha ao iniciar backup pre-wipe: ${extractPteroError(backupResult)}` };
}

function deleteLocalWipeFiles(plan) {
  const deleted = [];
  for (const file of plan.files) {
    if (!assertSafeLocalFileName(file)) {
      return { ok: false, error: `Arquivo inseguro no plano: ${file}`, deleted };
    }

    try {
      fs.rmSync(path.join(plan.root, file), { force: true });
      deleted.push(file);
    } catch (error) {
      return { ok: false, error: `Falha ao apagar ${file}: ${error.message}`, deleted };
    }
  }
  return { ok: true, deleted };
}

async function executeWipePlan(plan, options = {}) {
  if (!plan?.ok) {
    return plan;
  }
  if (options.dryRun) {
    return { ok: true, dryRun: true, plan };
  }
  if (plan.files.length === 0) {
    return { ok: false, error: 'Nenhum arquivo correspondente foi encontrado; nada foi apagado.', plan };
  }

  const resources = await fetchPteroResources();
  if (!resources.ok) {
    return { ok: false, error: `Nao foi possivel confirmar o estado do servidor: ${extractPteroError(resources)}` };
  }
  if (cleanText(resources.state).toLowerCase() !== 'offline') {
    return { ok: false, error: `Servidor precisa estar offline para wipe. Estado atual: ${resources.state}.` };
  }

  const completed = await createPreWipeBackup(plan);
  if (!completed.ok) {
    return { ok: false, error: completed.error, backup: completed.backup };
  }

  if (plan.storage === 'local') {
    const localDelete = deleteLocalWipeFiles(plan);
    return localDelete.ok
      ? { ok: true, plan, deleted: localDelete.deleted, backup: completed.backup }
      : { ok: false, error: localDelete.error, deleted: localDelete.deleted, backup: completed.backup };
  }

  const deleted = [];
  for (let index = 0; index < plan.files.length; index += 100) {
    const batch = plan.files.slice(index, index + 100);
    const deleteResult = await deletePteroFiles(plan.root, batch);
    if (!deleteResult.ok) {
      return {
        ok: false,
        error: `Falha ao apagar lote: ${extractPteroError(deleteResult)}`,
        deleted,
        backup: completed.backup,
      };
    }
    deleted.push(...batch);
  }

  return { ok: true, plan, deleted, backup: completed.backup };
}

function formatWipePlan(plan, maxFiles = 30) {
  if (!plan?.ok) {
    return plan?.error || 'Plano de wipe invalido.';
  }
  const lines = [
    `Alvo: ${plan.label}`,
    `Raiz: ${plan.root}`,
    `Modo: ${plan.storage === 'local' ? 'local/VM' : 'Pterodactyl API'}`,
    `Arquivos encontrados: ${plan.files.length}`,
    `Protecao de safehouse: ${plan.force ? 'IGNORADA (force)' : 'ATIVA'}`,
    `Alvos protegidos ignorados: ${plan.skipped.length}`,
  ];
  if (plan.skipped.length > 0) {
    lines.push(...plan.skipped.slice(0, 10).map((entry) => `- ${entry.target}: ${entry.safehouses.join(', ')}`));
  }
  if (plan.files.length > 0) {
    lines.push('', 'Amostra de arquivos:', ...plan.files.slice(0, maxFiles).map((file) => `- ${file}`));
    if (plan.files.length > maxFiles) {
      lines.push(`... e mais ${plan.files.length - maxFiles}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  buildWipePlan,
  createLocalWipeBackup,
  executeWipePlan,
  formatWipePlan,
  getSaveRoot,
  parsePair,
};
