const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  getPteroBackup,
  listPteroFiles,
  readPteroFile,
  writePteroFile,
} = require('../lib/server-integrations');

test('integracao usa os endpoints e formatos da Client API do Pterodactyl', async (context) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: request.method, url: request.url, body, authorization: request.headers.authorization });

      if (request.url.startsWith('/api/client/servers/server-id/files/list')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data: [{ attributes: { name: 'map_1_2.bin', is_file: true, size: 123 } }] }));
        return;
      }
      if (request.url.startsWith('/api/client/servers/server-id/files/contents')) {
        response.setHeader('Content-Type', 'text/plain');
        response.end('timestamp,username\n');
        return;
      }
      if (request.url.startsWith('/api/client/servers/server-id/files/write')) {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.url === '/api/client/servers/server-id/backups/backup-id') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ attributes: { uuid: 'backup-id', name: 'Pre-wipe', completed_at: '2026-06-12T10:00:00Z', is_successful: true } }));
        return;
      }

      response.statusCode = 404;
      response.end('not found');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  process.env.PTERO_URL = `http://127.0.0.1:${address.port}`;
  process.env.PTERO_SERVER_ID = 'server-id';
  process.env.PTERO_API_KEY = 'test-key';
  context.after(() => {
    delete process.env.PTERO_URL;
    delete process.env.PTERO_SERVER_ID;
    delete process.env.PTERO_API_KEY;
  });

  const files = await listPteroFiles('/Zomboid/Saves/Multiplayer/teste');
  const read = await readPteroFile('/Zomboid/Lua/PZAntiCheat_pending_alerts.csv');
  const write = await writePteroFile('/Zomboid/Lua/PZAntiCheat_pending_alerts.csv', 'timestamp,username\n');
  const backup = await getPteroBackup('backup-id');

  assert.equal(files.files[0].name, 'map_1_2.bin');
  assert.equal(read.text, 'timestamp,username\n');
  assert.equal(write.ok, true);
  assert.equal(backup.backup.isSuccessful, true);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.authorization === 'Bearer test-key'));
  assert.equal(requests.find((request) => request.url.includes('/files/write')).body, 'timestamp,username\n');
});
