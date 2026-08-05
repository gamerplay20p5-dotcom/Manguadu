const fs = require('fs');
const path = require('path');

// FriendHost now writes semicolon-delimited .txt files. Older installations may
// still contain either .csv.txt or .csv, so readers prefer the current format
// while retaining deterministic legacy fallbacks.
const FRIENDHOST_EXTENSIONS = Object.freeze(['.txt', '.csv.txt', '.csv']);
const SERVER_FILE_STEMS = Object.freeze([
  'deaths',
  'event_history',
  'events',
  'factions',
  'players_online',
  'safehouses',
  'world',
  'world_history',
]);

function getDataFileCandidates(directory, stem) {
  if (!directory || !stem) return [];
  return FRIENDHOST_EXTENSIONS.map((extension) => path.join(directory, `${stem}${extension}`));
}

function resolveDataFile(directory, stem) {
  const candidates = getDataFileCandidates(directory, stem);
  return candidates.find((filePath) => fs.existsSync(filePath)) || candidates[0] || '';
}

function getPlayerFileStem(nick, kind = 'player') {
  if (kind === 'perks') return `playerperks_${nick}`;
  if (kind === 'inventory') return `playerinventory_${nick}`;
  return `player_${nick}`;
}

function getPlayerFileCandidates(playersBasePath, nick, kind = 'player') {
  if (!playersBasePath || !nick) return [];
  return getDataFileCandidates(path.join(playersBasePath, nick), getPlayerFileStem(nick, kind));
}

function resolvePlayerFile(playersBasePath, nick, kind = 'player') {
  const candidates = getPlayerFileCandidates(playersBasePath, nick, kind);
  return candidates.find((filePath) => fs.existsSync(filePath)) || candidates[0] || '';
}

function getServerFileCandidates(serverBasePath, stem) {
  return getDataFileCandidates(serverBasePath, stem);
}

function resolveServerFile(serverBasePath, stem) {
  return resolveDataFile(serverBasePath, stem);
}

function stripFriendHostExtension(fileName) {
  return String(fileName || '').replace(/(?:\.csv\.txt|\.txt|\.csv)$/i, '');
}

function isFriendHostPerksFile(fileName) {
  const stem = stripFriendHostExtension(path.basename(String(fileName || '')));
  return /^playerperks_.+/i.test(stem) && stem !== path.basename(String(fileName || ''));
}

function isFriendHostDataFile(fileName) {
  const baseName = path.basename(String(fileName || ''));
  const stem = stripFriendHostExtension(baseName);
  if (stem === baseName) return false;
  if (SERVER_FILE_STEMS.includes(stem.toLowerCase())) return true;
  if (/^player(?:perks|inventory)?_.+/i.test(stem)) return true;
  return /vehicles?/i.test(stem);
}

module.exports = {
  FRIENDHOST_EXTENSIONS,
  SERVER_FILE_STEMS,
  getDataFileCandidates,
  getPlayerFileCandidates,
  getServerFileCandidates,
  isFriendHostDataFile,
  isFriendHostPerksFile,
  resolveDataFile,
  resolvePlayerFile,
  resolveServerFile,
  stripFriendHostExtension,
};
