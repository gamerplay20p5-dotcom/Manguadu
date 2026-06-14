const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildDeathLeaderboard,
  buildRankingPanelPayload,
  buildServerPanelPayload,
  formatDuration,
} = require('../lib/panel-reports');
const { normalizeTheme, youtubeThumbnail } = require('../lib/panel-theme');

const theme = normalizeTheme({
  title: 'Organic RP',
  description: 'Uma comunidade premium.',
  primaryColor: '#12ab34',
  secondaryColor: 'ff9900',
  banner: { url: 'https://example.com/banner.gif' },
  rankingBackground: { url: 'https://example.com/ranking.png' },
});

test('tema normaliza cores e aceita GIF/YouTube', () => {
  assert.equal(theme.primaryColor, '#12AB34');
  assert.equal(theme.secondaryColor, '#FF9900');
  assert.equal(theme.banner.url, 'https://example.com/banner.gif');
  assert.equal(
    youtubeThumbnail('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  );
});

test('painel do servidor cria cards premium sem campos vazios', () => {
  const payload = buildServerPanelPayload(
    {
      isOnline: true,
      currentState: 'running',
      ptero: { ok: true, latencyMs: 42, resources: { uptime: 3_900_000 } },
      rconPlayers: { ok: false },
      onlinePlayers: { count: 1, names: ['Menta'], source: 'csv' },
      world: { gameDate: '14.06.2026', timeOfDay: '13:30', temperature: '21.5' },
    },
    {
      theme,
      maxSlots: 32,
      connectAddress: 'connect.example.com:16261',
      onlineProfiles: [{ nick: 'Menta', faction: 'Organic', onlineTime: '15m' }],
    },
  );

  assert.equal(payload.embeds.length, 2);
  const json = payload.embeds[0].toJSON();
  assert.equal(json.title, 'Organic RP');
  assert.equal(json.image.url, 'https://example.com/banner.gif');
  assert.ok(json.fields.some((field) => field.value.includes('1 / 32')));
  assert.ok(!JSON.stringify(json).includes('N/A'));
  assert.equal(formatDuration(3_900_000), '1h 5m');
});

test('ranking separa categorias e conta mortes do FriendHost', () => {
  const players = [
    { username: 'Menta', zombiekills: '120', hourssurvived: '50', factionname: 'Organic' },
    { username: 'Ana', zombiekills: '90', hourssurvived: '80', factionname: 'Organic' },
  ];
  const factions = [{ name: 'Organic', owner: 'Menta', players: 'Players(Menta, Ana)' }];
  const deaths = [
    ['2026-06-01', 'Menta', 'false'],
    ['2026-06-02', 'Menta', 'false'],
    ['2026-06-03', 'Ana', 'false'],
  ];

  assert.deepEqual(buildDeathLeaderboard(players, deaths), [
    ['Menta', 2],
    ['Ana', 1],
  ]);

  const payload = buildRankingPanelPayload(players, factions, deaths, { theme });
  const titles = payload.embeds.map((embed) => embed.toJSON().title);
  assert.ok(titles.includes('🧟 CAÇADORES DE ELITE'));
  assert.ok(titles.includes('⌛ VETERANOS DO APOCALIPSE'));
  assert.ok(titles.includes('🛡️ DOMÍNIO DAS FACÇÕES'));
  assert.ok(titles.includes('☠️ OS QUE MAIS VOLTARAM'));
  assert.ok(titles.includes('👑 FACÇÃO EM DESTAQUE'));
});
