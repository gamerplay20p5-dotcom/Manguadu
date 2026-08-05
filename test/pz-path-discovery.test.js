const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  choosePteroSaveCandidate,
  discoverAndPersistPzPaths,
  scorePteroSaveDirectory,
} = require('../lib/pz-path-discovery');

const ENV_KEYS = [
  'PZ_AUTO_DISCOVER_PATHS',
  'PZ_LUA_PATH',
  'PZ_CACHE_ROOT',
  'PTERO_SERVER_ID',
  'PTERO_VOLUME_ID',
  'PZ_PATH_SCAN_ROOTS',
  'CSV_BASE_PATH',
  'ANTICHEAT_CSV_PATH',
  'LOGS_PATH',
  'PZ_SAVE_ROOT',
];

function preserveEnvironment() {
  const snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function createPzLayout(root, name = 'server-a') {
  const zomboid = path.join(root, name, 'Zomboid');
  const lua = path.join(zomboid, 'Lua');
  const friendHost = path.join(lua, 'FriendHost_Data');
  fs.mkdirSync(path.join(friendHost, 'Jogadores'), { recursive: true });
  fs.mkdirSync(path.join(friendHost, 'Servidor'), { recursive: true });
  fs.mkdirSync(path.join(zomboid, 'Logs'), { recursive: true });
  fs.writeFileSync(path.join(lua, 'PZAntiCheat_pending_alerts.csv'), 'timestamp,username,steam_id,cheat,count,detail,pos\n');
  return { lua, friendHost, logs: path.join(zomboid, 'Logs') };
}

function createPteroCacheLayout(root, volumeId = 'd0db1408-0ecd-40fe-9af0-7d5a67442464') {
  const cacheRoot = path.join(root, volumeId, '.cache');
  const lua = path.join(cacheRoot, 'Lua');
  const friendHost = path.join(lua, 'FriendHost_Data');
  const saveRoot = path.join(cacheRoot, 'Saves', 'Multiplayer', 'organic');
  fs.mkdirSync(path.join(friendHost, 'Jogadores'), { recursive: true });
  fs.mkdirSync(path.join(friendHost, 'Servidor'), { recursive: true });
  fs.mkdirSync(path.join(cacheRoot, 'Logs'), { recursive: true });
  fs.mkdirSync(saveRoot, { recursive: true });
  fs.writeFileSync(path.join(lua, 'PZAntiCheat_pending_alerts.csv'), 'timestamp,username,steam_id,cheat,count,detail,pos\n');
  fs.writeFileSync(path.join(saveRoot, 'players.db'), '');
  fs.writeFileSync(path.join(saveRoot, 'map_meta.bin'), '');
  fs.writeFileSync(path.join(saveRoot, 'map_100_200.bin'), '');
  fs.writeFileSync(path.join(saveRoot, 'zpop_3_4.bin'), '');
  return { cacheRoot, lua, friendHost, logs: path.join(cacheRoot, 'Logs'), saveRoot, volumeId };
}

test('descobre os CSVs em Zomboid/Lua e preenche campos vazios do .env', () => {
  const restoreEnvironment = preserveEnvironment();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manguadu-paths-'));
  const layout = createPzLayout(root);
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, 'CSV_BASE_PATH=\nANTICHEAT_CSV_PATH=\nLOGS_PATH=\n');

  process.env.PZ_AUTO_DISCOVER_PATHS = '1';
  process.env.PZ_PATH_SCAN_ROOTS = root;
  delete process.env.PZ_LUA_PATH;
  delete process.env.CSV_BASE_PATH;
  delete process.env.ANTICHEAT_CSV_PATH;
  delete process.env.LOGS_PATH;

  const result = discoverAndPersistPzPaths({ envPath });
  const envContent = fs.readFileSync(envPath, 'utf8');

  assert.equal(result.ambiguous, undefined);
  assert.equal(process.env.PZ_LUA_PATH, layout.lua);
  assert.equal(process.env.CSV_BASE_PATH, layout.friendHost);
  assert.equal(process.env.ANTICHEAT_CSV_PATH, path.join(layout.lua, 'PZAntiCheat_pending_alerts.csv'));
  assert.equal(process.env.LOGS_PATH, layout.logs);
  assert.match(envContent, /PZ_LUA_PATH=/);
  assert.match(envContent, /CSV_BASE_PATH=.*FriendHost_Data/);
  assert.match(envContent, /ANTICHEAT_CSV_PATH=.*PZAntiCheat_pending_alerts\.csv/);

  restoreEnvironment();
  fs.rmSync(root, { recursive: true, force: true });
});

test('configuracao manual tem prioridade sobre a descoberta automatica', () => {
  const restoreEnvironment = preserveEnvironment();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manguadu-manual-'));
  createPzLayout(root);
  const manualPath = path.join(root, 'meus-csvs');
  fs.mkdirSync(manualPath);
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, `CSV_BASE_PATH=${manualPath}\nANTICHEAT_CSV_PATH=\n`);

  process.env.PZ_AUTO_DISCOVER_PATHS = '1';
  process.env.PZ_PATH_SCAN_ROOTS = root;
  process.env.CSV_BASE_PATH = manualPath;
  delete process.env.PZ_LUA_PATH;
  delete process.env.ANTICHEAT_CSV_PATH;
  delete process.env.LOGS_PATH;

  discoverAndPersistPzPaths({ envPath });

  assert.equal(process.env.CSV_BASE_PATH, manualPath);
  assert.match(fs.readFileSync(envPath, 'utf8'), new RegExp(`CSV_BASE_PATH=${manualPath.replace(/\\/g, '\\\\')}`));

  restoreEnvironment();
  fs.rmSync(root, { recursive: true, force: true });
});

test('descobre layout real do volume Pterodactyl em .cache', () => {
  const restoreEnvironment = preserveEnvironment();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manguadu-ptero-cache-'));
  const root = path.join(tempRoot, 'var', 'lib', 'pterodactyl', 'volumes');
  const layout = createPteroCacheLayout(root);
  const envPath = path.join(tempRoot, '.env');
  fs.writeFileSync(envPath, 'PZ_LUA_PATH=\nPZ_CACHE_ROOT=\nPTERO_VOLUME_ID=\nCSV_BASE_PATH=\nANTICHEAT_CSV_PATH=\nLOGS_PATH=\nPZ_SAVE_ROOT=\n');

  process.env.PZ_AUTO_DISCOVER_PATHS = '1';
  process.env.PZ_PATH_SCAN_ROOTS = root;
  process.env.PTERO_SERVER_ID = 'd0db1408';
  delete process.env.PZ_LUA_PATH;
  delete process.env.PZ_CACHE_ROOT;
  delete process.env.PTERO_VOLUME_ID;
  delete process.env.CSV_BASE_PATH;
  delete process.env.ANTICHEAT_CSV_PATH;
  delete process.env.LOGS_PATH;
  delete process.env.PZ_SAVE_ROOT;

  discoverAndPersistPzPaths({ envPath });

  assert.equal(process.env.PZ_LUA_PATH, layout.lua);
  assert.equal(process.env.PZ_CACHE_ROOT, layout.cacheRoot);
  assert.equal(process.env.PTERO_VOLUME_ID, layout.volumeId);
  assert.equal(process.env.CSV_BASE_PATH, layout.friendHost);
  assert.equal(process.env.LOGS_PATH, layout.logs);
  assert.equal(process.env.PZ_SAVE_ROOT, layout.saveRoot);

  restoreEnvironment();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('prepara os caminhos esperados mesmo antes dos mods criarem os CSVs', () => {
  const restoreEnvironment = preserveEnvironment();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manguadu-first-boot-'));
  const lua = path.join(root, 'server-a', 'Zomboid', 'Lua');
  fs.mkdirSync(lua, { recursive: true });
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, 'PZ_LUA_PATH=\nCSV_BASE_PATH=\nANTICHEAT_CSV_PATH=\n');

  process.env.PZ_AUTO_DISCOVER_PATHS = '1';
  process.env.PZ_PATH_SCAN_ROOTS = root;
  delete process.env.PZ_LUA_PATH;
  delete process.env.CSV_BASE_PATH;
  delete process.env.ANTICHEAT_CSV_PATH;
  delete process.env.LOGS_PATH;

  discoverAndPersistPzPaths({ envPath });

  assert.equal(process.env.PZ_LUA_PATH, lua);
  assert.equal(process.env.CSV_BASE_PATH, path.join(lua, 'FriendHost_Data'));
  assert.equal(process.env.ANTICHEAT_CSV_PATH, path.join(lua, 'PZAntiCheat_pending_alerts.csv'));

  restoreEnvironment();
  fs.rmSync(root, { recursive: true, force: true });
});

test('nao escolhe automaticamente quando dois servidores empatam', () => {
  const restoreEnvironment = preserveEnvironment();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manguadu-ambiguous-'));
  createPzLayout(root, 'server-a');
  createPzLayout(root, 'server-b');
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, 'PZ_LUA_PATH=\nCSV_BASE_PATH=\n');

  process.env.PZ_AUTO_DISCOVER_PATHS = '1';
  process.env.PZ_PATH_SCAN_ROOTS = root;
  delete process.env.PZ_LUA_PATH;
  delete process.env.CSV_BASE_PATH;
  delete process.env.ANTICHEAT_CSV_PATH;
  delete process.env.LOGS_PATH;

  const result = discoverAndPersistPzPaths({ envPath });

  assert.equal(result.ambiguous, true);
  assert.equal(process.env.CSV_BASE_PATH, undefined);
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'PZ_LUA_PATH=\nCSV_BASE_PATH=\n');

  restoreEnvironment();
  fs.rmSync(root, { recursive: true, force: true });
});

test('reconhece FriendHost parcial com os novos arquivos txt', () => {
  const restoreEnvironment = preserveEnvironment();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manguadu-partial-'));
  const lua = path.join(root, 'server-a', '.cache', 'Lua');
  const friendHost = path.join(lua, 'FriendHost_Data');
  fs.mkdirSync(path.join(friendHost, 'Servidor'), { recursive: true });
  fs.writeFileSync(path.join(friendHost, 'Servidor', 'world.txt'), '2026;12:00');
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, 'PZ_LUA_PATH=\nCSV_BASE_PATH=\n');

  process.env.PZ_AUTO_DISCOVER_PATHS = '1';
  process.env.PZ_PATH_SCAN_ROOTS = root;
  delete process.env.PZ_LUA_PATH;
  delete process.env.CSV_BASE_PATH;
  delete process.env.ANTICHEAT_CSV_PATH;
  delete process.env.LOGS_PATH;

  discoverAndPersistPzPaths({ envPath });
  assert.equal(process.env.PZ_LUA_PATH, lua);
  assert.equal(process.env.CSV_BASE_PATH, friendHost);

  restoreEnvironment();
  fs.rmSync(root, { recursive: true, force: true });
});

test('seleciona o unico save do Pterodactyl mesmo no primeiro boot', () => {
  const selection = choosePteroSaveCandidate([
    scorePteroSaveDirectory('/Zomboid/Saves/Multiplayer/organic', []),
  ]);

  assert.equal(selection.ambiguous, false);
  assert.equal(selection.candidate.directory, '/Zomboid/Saves/Multiplayer/organic');
});

test('prioriza o save que possui as assinaturas reais do mundo PZ', () => {
  const selection = choosePteroSaveCandidate([
    scorePteroSaveDirectory('/Zomboid/Saves/Multiplayer/vazio', []),
    scorePteroSaveDirectory('/Zomboid/Saves/Multiplayer/organic', [
      { name: 'players.db', isFile: true },
      { name: 'map_meta.bin', isFile: true },
      { name: 'map_100_200.bin', isFile: true },
      { name: 'zpop_3_4.bin', isFile: true },
    ]),
  ]);

  assert.equal(selection.candidate.directory, '/Zomboid/Saves/Multiplayer/organic');
});
