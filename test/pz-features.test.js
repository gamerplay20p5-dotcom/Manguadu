const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildAlertEmbed,
  groupAlerts,
  isAlertRecent,
  parseAlertTimestamp,
  parseAlerts,
} = require('../lib/anticheat-alerts');
const { pzCommandNames, pzSlashCommandBuilders } = require('../lib/pz-commands');
const { createMapPng } = require('../lib/pz-map-renderer');
const { buildWipePlan, formatWipePlan, parsePair } = require('../lib/pz-wipe');

test('todos os slash commands de PZ geram schemas validos e unicos', () => {
  const schemas = pzSlashCommandBuilders.map((builder) => builder.toJSON());
  const names = schemas.map((schema) => schema.name);

  assert.ok(names.length >= 30);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(new Set(names), pzCommandNames);
});

test('renderizador gera um PNG valido', () => {
  const image = createMapPng({
    width: 320,
    height: 220,
    bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
    maps: [{ minX: 100, minY: 100, maxX: 900, maxY: 900 }],
    safehouses: [{ x: 200, y: 200, x2: 250, y2: 250 }],
    points: [{ nick: 'Menta', x: 400, y: 500 }],
    focus: 'Menta',
  });

  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(image.length > 1000);
});

test('parser do anticheat aceita o CSV emitido pelo mod', () => {
  const content = [
    'timestamp,username,steam_id,cheat,count,detail,pos',
    '2026-06-12 15:30:00,Menta,76561198000000000,teleport,2,"salto, impossivel","100,200,0"',
  ].join('\n');
  const alerts = parseAlerts(content);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].username, 'Menta');
  assert.equal(alerts[0].detail, 'salto, impossivel');
  assert.equal(alerts[0].pos, '100,200,0');
});

test('anticheat interpreta horario local e descarta registros antigos', () => {
  process.env.ANTICHEAT_TIMEZONE = 'America/Sao_Paulo';
  process.env.ANTICHEAT_MAX_ALERT_AGE_MINUTES = '10';

  const timestamp = parseAlertTimestamp('2026-06-15 12:00:00');
  assert.equal(timestamp.toISOString(), '2026-06-15T15:00:00.000Z');
  assert.equal(
    isAlertRecent({ timestamp: '2026-06-15 11:40:00' }, Date.parse('2026-06-15T15:00:00Z')),
    false,
  );
  assert.equal(
    isAlertRecent({ timestamp: '2026-06-15 11:55:00' }, Date.parse('2026-06-15T15:00:00Z')),
    true,
  );

  delete process.env.ANTICHEAT_TIMEZONE;
  delete process.env.ANTICHEAT_MAX_ALERT_AGE_MINUTES;
});

test('anticheat agrupa repeticoes em um embed minimalista', () => {
  const groups = groupAlerts([
    { timestamp: '2026-06-15 12:00:00', username: 'Menta', steamId: '123', cheat: 'teleport', count: '1', detail: 'salto', pos: '1,2,0' },
    { timestamp: '2026-06-15 12:00:02', username: 'Menta', steamId: '123', cheat: 'teleport', count: '2', detail: 'salto', pos: '2,3,0' },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);

  const embed = buildAlertEmbed(groups).toJSON();
  assert.equal(embed.title, 'Alerta anticheat');
  assert.match(embed.description, /Menta/);
  assert.match(embed.description, /2 ocorrencias/);
  assert.equal(embed.fields, undefined);
});

test('dados dos jogadores, mapas e coordenadas sao interpretados', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manguadu-pz-'));
  const playerDir = path.join(tempRoot, 'Jogadores', 'Menta');
  const serverDir = path.join(tempRoot, 'Servidor');
  const mapsPath = path.join(tempRoot, 'maps.json');

  fs.mkdirSync(playerDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(
    path.join(playerDir, 'player_Menta.txt'),
    'username;profession;traits;zombiekills;hourssurvived;x;y;z\nMenta;fireofficer;Strong,Brave;42;12.5;10600;9800;0\n',
  );
  fs.writeFileSync(path.join(playerDir, 'playerperks_Menta.txt'), 'username;fitness;strength\nMenta;6;8\n');
  fs.writeFileSync(path.join(serverDir, 'safehouses.txt'), 'title;owner;x;y;x2;y2\nBase;Menta;10500;9700;10600;9800\n');
  fs.writeFileSync(mapsPath, JSON.stringify({ maps: [{ id: 'teste', name: 'Teste', minX: 9000, minY: 9000, maxX: 12000, maxY: 12000 }] }));

  process.env.CSV_BASE_PATH = tempRoot;
  process.env.PZ_MAPS_CONFIG_PATH = mapsPath;
  const data = require('../lib/pz-data');

  const record = data.findPlayerRecord('menta');
  assert.equal(record.nick, 'Menta');
  assert.equal(data.getPlayerRank('Menta').entry.value, 42);
  assert.deepEqual(data.getPlayerPoint(record), { nick: 'Menta', x: 10600, y: 9800, z: 0 });
  assert.equal(data.getMaps()[0].id, 'teste');
  assert.equal(data.getSafehouses()[0].owner, 'Menta');
  assert.deepEqual(parsePair('-2,15'), { x: -2, y: 15 });

  fs.rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.CSV_BASE_PATH;
  delete process.env.PZ_MAPS_CONFIG_PATH;
});

test('wipe chunk usa pasta chunkdata e descreve intervalo real', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manguadu-wipe-chunk-'));
  const saveRoot = path.join(tempRoot, 'Saves', 'Multiplayer', 'Pterodactyl');
  fs.mkdirSync(path.join(saveRoot, 'chunkdata'), { recursive: true });
  fs.writeFileSync(path.join(saveRoot, 'chunkdata', 'map_744_1648.bin'), '');

  process.env.PZ_SAVE_ROOT = saveRoot;
  process.env.CSV_BASE_PATH = tempRoot;

  const plan = await buildWipePlan({ kind: 'chunk', target: '744,1648', force: true });
  const formatted = formatWipePlan(plan);

  assert.equal(plan.ok, true);
  assert.equal(plan.storage, 'local');
  assert.deepEqual(plan.files, ['chunkdata/map_744_1648.bin']);
  assert.match(formatted, /Chunks: 744,1648 ate 744,1648/);
  assert.match(formatted, /X 7440-7449/);

  fs.rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.PZ_SAVE_ROOT;
  delete process.env.CSV_BASE_PATH;
});

test('wipe global mira db Logs e Saves no cache do servidor', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manguadu-wipe-global-'));
  fs.mkdirSync(path.join(tempRoot, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'Logs'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'Saves'), { recursive: true });

  process.env.PZ_CACHE_ROOT = tempRoot;

  const plan = await buildWipePlan({ kind: 'global' });
  const formatted = formatWipePlan(plan);

  assert.equal(plan.ok, true);
  assert.equal(plan.kind, 'global');
  assert.deepEqual(plan.files, ['db', 'Logs', 'Saves']);
  assert.match(formatted, /Pastas alvo: db, Logs, Saves/);

  fs.rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.PZ_CACHE_ROOT;
});
