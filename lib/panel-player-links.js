const fs = require('fs');
const path = require('path');

const { cleanText } = require('./utils');

const LINKS_FILE = path.join(__dirname, '..', 'data', 'panel-player-links.json');

function loadPlayerLinks() {
  try {
    if (!fs.existsSync(LINKS_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function savePlayerLinks(links) {
  fs.mkdirSync(path.dirname(LINKS_FILE), { recursive: true });
  const tempPath = `${LINKS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(links, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, LINKS_FILE);
}

function setPlayerLink(nickInput, discordUserId) {
  const nick = cleanText(nickInput);
  const userId = cleanText(discordUserId);
  if (!nick || !userId) return false;
  const links = loadPlayerLinks();
  const existingKey = Object.keys(links).find((key) => key.toLowerCase() === nick.toLowerCase());
  if (existingKey && existingKey !== nick) delete links[existingKey];
  links[nick] = userId;
  savePlayerLinks(links);
  return true;
}

function removePlayerLink(nickInput) {
  const nick = cleanText(nickInput);
  const links = loadPlayerLinks();
  const key = Object.keys(links).find((entry) => entry.toLowerCase() === nick.toLowerCase());
  if (!key) return false;
  delete links[key];
  savePlayerLinks(links);
  return true;
}

function getPlayerLink(nickInput) {
  const nick = cleanText(nickInput);
  const links = loadPlayerLinks();
  const key = Object.keys(links).find((entry) => entry.toLowerCase() === nick.toLowerCase());
  return key ? cleanText(links[key]) : '';
}

module.exports = {
  getPlayerLink,
  loadPlayerLinks,
  removePlayerLink,
  setPlayerLink,
};
