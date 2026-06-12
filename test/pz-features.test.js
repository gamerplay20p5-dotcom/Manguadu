const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parseAlerts } = require('../lib/anticheat-alerts');
const { pzCommandNames, pzSlashCommandBuilders } = require('../lib/pz-commands');
const { createMapPng } = require('../lib/pz-map-renderer');
const { parsePair } = require('../lib/pz-wipe');

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

test('dados dos jogadores, mapas e coordenadas sao interpretados', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manguadu-pz-'));
  const playerDir = path.join(tempRoot, 'Jogadores', 'Menta');
  const serverDir = path.join(tempRoot, 'Servidor');
  const mapsPath = path.join(tempRoot, 'maps.json');

  fs.mkdirSync(playerDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(
    path.join(playerDir, 'player_Menta.csv'),
    'username;profession;traits;zombiekills;hourssurvived;x;y;z\nMenta;fireofficer;Strong,Brave;42;12.5;10600;9800;0\n',
  );
  fs.writeFileSync(path.join(playerDir, 'playerperks_Menta.csv'), 'username;fitness;strength\nMenta;6;8\n');
  fs.writeFileSync(path.join(serverDir, 'safehouses.csv'), 'title;owner;x;y;x2;y2\nBase;Menta;10500;9700;10600;9800\n');
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
