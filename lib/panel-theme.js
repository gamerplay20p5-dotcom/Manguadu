const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AttachmentBuilder } = require('discord.js');

const { cleanText } = require('./utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'panel-media');
const THEME_FILE = path.join(DATA_DIR, 'panel-theme.json');
const DRAFT_FILE = path.join(DATA_DIR, 'panel-theme-draft.json');

const DEFAULT_THEME = Object.freeze({
  title: 'Servidor Project Zomboid',
  description: 'Sobreviva. Evolua. Deixe sua marca no apocalipse.',
  primaryColor: '#28d17c',
  secondaryColor: '#f0a93b',
  banner: null,
  thumbnail: null,
  rankingBackground: null,
});

function cloneDefaultTheme() {
  return JSON.parse(JSON.stringify(DEFAULT_THEME));
}

function normalizeColor(value, fallback) {
  const normalized = cleanText(value).replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(normalized) ? `#${normalized.toUpperCase()}` : fallback;
}

function normalizeMedia(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const url = cleanText(value.url);
  const filePath = cleanText(value.filePath);
  if (!url && !filePath) {
    return null;
  }
  return {
    url,
    filePath,
    filename: cleanText(value.filename) || (filePath ? path.basename(filePath) : ''),
  };
}

function normalizeTheme(rawTheme = {}) {
  return {
    title: cleanText(rawTheme.title) || DEFAULT_THEME.title,
    description: cleanText(rawTheme.description) || DEFAULT_THEME.description,
    primaryColor: normalizeColor(rawTheme.primaryColor, DEFAULT_THEME.primaryColor),
    secondaryColor: normalizeColor(rawTheme.secondaryColor, DEFAULT_THEME.secondaryColor),
    banner: normalizeMedia(rawTheme.banner),
    thumbnail: normalizeMedia(rawTheme.thumbnail),
    rankingBackground: normalizeMedia(rawTheme.rankingBackground),
  };
}

function readThemeFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return normalizeTheme(fallback);
    }
    return normalizeTheme(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    return normalizeTheme(fallback);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function getSavedTheme() {
  return readThemeFile(THEME_FILE, cloneDefaultTheme());
}

function getDraftTheme() {
  return readThemeFile(DRAFT_FILE, getSavedTheme());
}

function updateDraftTheme(patch) {
  const nextTheme = normalizeTheme({ ...getDraftTheme(), ...patch });
  writeJsonAtomic(DRAFT_FILE, nextTheme);
  return nextTheme;
}

function saveDraftTheme() {
  const draft = getDraftTheme();
  writeJsonAtomic(THEME_FILE, draft);
  writeJsonAtomic(DRAFT_FILE, draft);
  return draft;
}

function colorToNumber(value, fallback = 0x28d17c) {
  const normalized = normalizeColor(value, '');
  return normalized ? Number.parseInt(normalized.slice(1), 16) : fallback;
}

function youtubeThumbnail(urlInput) {
  const value = cleanText(urlInput);
  if (!value) {
    return '';
  }
  try {
    const url = new URL(value);
    let videoId = '';
    if (url.hostname === 'youtu.be') {
      videoId = url.pathname.split('/').filter(Boolean)[0] || '';
    } else if (url.hostname.endsWith('youtube.com')) {
      videoId = url.searchParams.get('v') || url.pathname.match(/\/(?:shorts|embed)\/([^/?]+)/)?.[1] || '';
    }
    return videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : '';
  } catch (error) {
    return '';
  }
}

function sanitizeFilename(value, fallback) {
  const extension = path.extname(cleanText(value)).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const base = path.basename(cleanText(value), path.extname(cleanText(value))).replace(/[^a-z0-9_-]/gi, '-').slice(0, 50);
  return `${base || fallback}${extension || '.bin'}`;
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) {
    throw new Error(`Falha ao baixar midia: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 25 * 1024 * 1024) {
    throw new Error('A midia excede o limite de 25 MB.');
  }
  fs.writeFileSync(destination, buffer);
}

function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-i', inputPath, '-frames:v', '1', '-vf', 'scale=1280:-2', outputPath], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorOutput = '';
    child.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });
    child.on('error', () => reject(new Error('ffmpeg nao encontrado. Instale-o na VM para converter videos.')));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Falha ao converter video com ffmpeg: ${errorOutput.slice(-300)}`));
    });
  });
}

async function storePanelMedia(kind, options = {}) {
  const externalUrl = cleanText(options.url);
  const youtubeUrl = youtubeThumbnail(externalUrl);
  if (youtubeUrl) {
    return { url: youtubeUrl, filePath: '', filename: '' };
  }
  if (externalUrl && !options.attachment) {
    try {
      const parsed = new URL(externalUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Protocolo de URL invalido.');
      }
      if (/\.(?:mp4|webm|mov|mkv)(?:$|\?)/i.test(parsed.toString())) {
        fs.mkdirSync(MEDIA_DIR, { recursive: true });
        const videoName = `${kind}-${Date.now()}${path.extname(parsed.pathname) || '.mp4'}`;
        const videoPath = path.join(MEDIA_DIR, videoName);
        const thumbnailName = `${kind}-${Date.now()}.png`;
        const thumbnailPath = path.join(MEDIA_DIR, thumbnailName);
        await downloadFile(parsed.toString(), videoPath);
        try {
          await runFfmpeg(videoPath, thumbnailPath);
        } finally {
          fs.rmSync(videoPath, { force: true });
        }
        return { url: '', filePath: thumbnailPath, filename: thumbnailName };
      }
      return { url: parsed.toString(), filePath: '', filename: '' };
    } catch (error) {
      throw new Error('Informe uma URL HTTP/HTTPS valida.');
    }
  }

  const attachment = options.attachment;
  if (!attachment?.url) {
    throw new Error('Envie um arquivo ou informe uma URL.');
  }

  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const filename = `${kind}-${Date.now()}-${sanitizeFilename(attachment.name, kind)}`;
  const destination = path.join(MEDIA_DIR, filename);
  await downloadFile(attachment.url, destination);

  const contentType = cleanText(attachment.contentType).toLowerCase();
  if (contentType.startsWith('video/') || /\.(?:mp4|webm|mov|mkv)$/i.test(attachment.name || '')) {
    const thumbnailName = `${kind}-${Date.now()}.png`;
    const thumbnailPath = path.join(MEDIA_DIR, thumbnailName);
    try {
      await runFfmpeg(destination, thumbnailPath);
    } finally {
      fs.rmSync(destination, { force: true });
    }
    return { url: '', filePath: thumbnailPath, filename: thumbnailName };
  }
  if (contentType && !contentType.startsWith('image/')) {
    fs.rmSync(destination, { force: true });
    throw new Error('O arquivo precisa ser imagem, GIF ou video.');
  }

  return { url: '', filePath: destination, filename };
}

function getMediaUrl(media) {
  if (!media) {
    return '';
  }
  if (media.url) {
    return media.url;
  }
  return media.filename ? `attachment://${media.filename}` : '';
}

function getThemeAttachments(theme, panelType = 'status') {
  const mediaItems = [theme.thumbnail, panelType === 'ranking' ? theme.rankingBackground : theme.banner].filter(Boolean);
  const seen = new Set();
  return mediaItems
    .filter((media) => media.filePath && fs.existsSync(media.filePath) && !seen.has(media.filePath) && seen.add(media.filePath))
    .map((media) => new AttachmentBuilder(media.filePath, { name: media.filename }));
}

module.exports = {
  DEFAULT_THEME,
  colorToNumber,
  getDraftTheme,
  getMediaUrl,
  getSavedTheme,
  getThemeAttachments,
  normalizeTheme,
  saveDraftTheme,
  storePanelMedia,
  updateDraftTheme,
  youtubeThumbnail,
};
