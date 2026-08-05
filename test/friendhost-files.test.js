const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  getPlayerFileCandidates,
  isFriendHostDataFile,
  resolvePlayerFile,
  resolveServerFile,
  stripFriendHostExtension,
} = require('../lib/friendhost-files');
const { readPlayersOnlineFallback, readWorldSnapshot } = require('../lib/server-integrations');

test('prefere FriendHost .txt e conserva fallback para formatos antigos', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manguadu-friendhost-'));
  const playerDir = path.join(root, 'Jogadores', 'Menta');
  const serverDir = path.join(root, 'Servidor');
  fs.mkdirSync(playerDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  const candidates = getPlayerFileCandidates(path.join(root, 'Jogadores'), 'Menta', 'player');
  fs.writeFileSync(candidates[2], 'legacy csv');
  assert.equal(resolvePlayerFile(path.join(root, 'Jogadores'), 'Menta', 'player'), candidates[2]);

  fs.writeFileSync(candidates[1], 'legacy csv txt');
  assert.equal(resolvePlayerFile(path.join(root, 'Jogadores'), 'Menta', 'player'), candidates[1]);

  fs.writeFileSync(candidates[0], 'current txt');
  assert.equal(resolvePlayerFile(path.join(root, 'Jogadores'), 'Menta', 'player'), candidates[0]);

  const deathsTxt = path.join(serverDir, 'deaths.txt');
  fs.writeFileSync(deathsTxt, 'death');
  assert.equal(resolveServerFile(serverDir, 'deaths'), deathsTxt);
  assert.equal(stripFriendHostExtension('playerperks_Menta.csv.txt'), 'playerperks_Menta');
  assert.equal(isFriendHostDataFile('world_history.txt'), true);
  assert.equal(isFriendHostDataFile('README.txt'), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('integracoes do servidor leem players_online.txt e world.txt atuais', () => {
  const previousBasePath = process.env.CSV_BASE_PATH;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manguadu-friendhost-server-'));
  const serverDir = path.join(root, 'Servidor');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'players_online.txt'), 'Menta;Malaio');
  fs.writeFileSync(path.join(serverDir, 'world.txt'), '04.08.2026;17:54:00;04.08.2026 12:00;20;22.5;2');
  process.env.CSV_BASE_PATH = root;

  assert.deepEqual(readPlayersOnlineFallback(), ['Menta', 'Malaio']);
  const snapshot = readWorldSnapshot();
  assert.equal(snapshot.source, 'world.txt');
  assert.equal(snapshot.gameDate, '04.08.2026');
  assert.equal(snapshot.timeOfDay, '12:00');
  assert.equal(snapshot.temperature, '22.5');

  if (previousBasePath === undefined) delete process.env.CSV_BASE_PATH;
  else process.env.CSV_BASE_PATH = previousBasePath;
  fs.rmSync(root, { recursive: true, force: true });
});
