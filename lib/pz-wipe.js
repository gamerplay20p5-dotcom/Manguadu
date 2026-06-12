const { cleanText, delay, getField, toNumber } = require('./utils');
const { findMapByName, getSafehouses } = require('./pz-data');
const {
  createPteroBackup,
  deletePteroFiles,
  extractPteroError,
  fetchPteroResources,
  getPteroBackup,
  listPteroFiles,
} = require('./server-integrations');

function getSaveRoot() {
  return cleanText(process.env.PZ_SAVE_ROOT);
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

async function buildWipePlan(options = {}) {
  const saveRoot = getSaveRoot();
  if (!saveRoot) {
    return { ok: false, error: 'PZ_SAVE_ROOT nao configurado no .env da VM.' };
  }

  const listResult = await listPteroFiles(saveRoot);
  if (!listResult.ok) {
    return { ok: false, error: `Falha ao listar save no Pterodactyl: ${extractPteroError(listResult)}` };
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

  const backupResult = await createPteroBackup({
    name: `Pre-wipe ${new Date().toISOString()} - ${plan.label}`,
    isLocked: true,
  });
  if (!backupResult.ok || !backupResult.backup?.uuid) {
    return { ok: false, error: `Falha ao iniciar backup pre-wipe: ${extractPteroError(backupResult)}` };
  }

  const completed = await waitForBackup(backupResult.backup.uuid);
  if (!completed.ok) {
    return { ok: false, error: completed.error, backup: backupResult.backup };
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
  executeWipePlan,
  formatWipePlan,
  getSaveRoot,
  parsePair,
};
