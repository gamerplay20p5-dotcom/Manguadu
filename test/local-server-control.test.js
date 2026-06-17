const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getVolumeIdFromPath,
  parseDockerPsJson,
  scoreDockerContainer,
} = require('../lib/local-server-control');

test('extrai o volume do caminho local do Pterodactyl', () => {
  const volumeId = getVolumeIdFromPath('/var/lib/pterodactyl/volumes/d0db1408-0ecd-40fe-9af0-7d5a67442464/.cache/Lua');

  assert.equal(volumeId, 'd0db1408-0ecd-40fe-9af0-7d5a67442464');
});

test('pontua container Docker pelo volume ou server id', () => {
  const containers = parseDockerPsJson(
    [
      JSON.stringify({ ID: 'abc', Names: 'mariadb', Labels: '', Mounts: '' }),
      JSON.stringify({
        ID: 'def',
        Names: 'ptero-server',
        Labels: 'io.pterodactyl.server.uuid=d0db1408-0ecd-40fe-9af0-7d5a67442464',
        Mounts: '/var/lib/pterodactyl/volumes/d0db1408-0ecd-40fe-9af0-7d5a67442464/.cache',
      }),
    ].join('\n'),
  );

  assert.equal(containers.length, 2);
  assert.equal(scoreDockerContainer(containers[0], ['d0db1408']), 0);
  assert.ok(scoreDockerContainer(containers[1], ['d0db1408']) > 0);
});
