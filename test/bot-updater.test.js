const assert = require('node:assert/strict');
const test = require('node:test');

const { buildGitEnvironment } = require('../lib/bot-updater');

test('token do GitHub e convertido em header temporario sem alterar remote', () => {
  const environment = buildGitEnvironment({
    PATH: '/usr/bin',
    BOT_GITHUB_TOKEN: 'github-token-teste',
  });

  assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
  assert.equal(environment.GIT_CONFIG_COUNT, '1');
  assert.equal(environment.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.match(environment.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /);

  const encoded = environment.GIT_CONFIG_VALUE_0.replace(/^AUTHORIZATION: basic /, '');
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'x-access-token:github-token-teste');
  assert.equal(environment.PATH, '/usr/bin');
});

test('git desativa prompts mesmo sem token configurado', () => {
  const environment = buildGitEnvironment({ PATH: '/usr/bin' });

  assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
  assert.equal(environment.GIT_CONFIG_VALUE_0, undefined);
});
