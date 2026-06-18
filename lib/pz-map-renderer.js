const zlib = require('zlib');

const WIDTH = 1000;
const HEIGHT = 700;
const PADDING = 42;

const COLORS = {
  background: [13, 18, 20, 255],
  panel: [20, 28, 31, 255],
  grid: [43, 55, 60, 255],
  gridMajor: [72, 92, 98, 255],
  border: [132, 158, 154, 255],
  map: [49, 112, 80, 255],
  mapFill: [24, 52, 42, 255],
  safehouse: [226, 176, 64, 255],
  focusCell: [100, 128, 82, 255],
  focusChunk: [188, 83, 74, 255],
  player: [80, 200, 255, 255],
  focus: [255, 82, 82, 255],
  text: [220, 234, 231, 255],
  mutedText: [139, 164, 162, 255],
};

const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '01100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createCanvas(width = WIDTH, height = HEIGHT) {
  const pixels = Buffer.alloc(width * height * 4);
  function setPixel(x, y, color) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= width || py >= height) {
      return;
    }
    const offset = (py * width + px) * 4;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = color[3] ?? 255;
  }

  function fill(color) {
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3] ?? 255;
    }
  }

  function fillRectangle(x1, y1, x2, y2, color) {
    const minX = Math.max(0, Math.floor(Math.min(x1, x2)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y1, y2)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(y1, y2)));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        setPixel(x, y, color);
      }
    }
  }

  function line(x1, y1, x2, y2, color, thickness = 1) {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const steps = Math.max(dx, dy, 1);
    for (let step = 0; step <= steps; step += 1) {
      const x = x1 + ((x2 - x1) * step) / steps;
      const y = y1 + ((y2 - y1) * step) / steps;
      for (let ox = -Math.floor(thickness / 2); ox <= Math.floor(thickness / 2); ox += 1) {
        for (let oy = -Math.floor(thickness / 2); oy <= Math.floor(thickness / 2); oy += 1) {
          setPixel(x + ox, y + oy, color);
        }
      }
    }
  }

  function rectangle(x1, y1, x2, y2, color, thickness = 1) {
    line(x1, y1, x2, y1, color, thickness);
    line(x2, y1, x2, y2, color, thickness);
    line(x2, y2, x1, y2, color, thickness);
    line(x1, y2, x1, y1, color, thickness);
  }

  function circle(cx, cy, radius, color, filled = true) {
    for (let y = -radius; y <= radius; y += 1) {
      for (let x = -radius; x <= radius; x += 1) {
        const distance = x * x + y * y;
        if ((filled && distance <= radius * radius) || (!filled && Math.abs(distance - radius * radius) <= radius)) {
          setPixel(cx + x, cy + y, color);
        }
      }
    }
  }

  return { width, height, pixels, setPixel, fill, fillRectangle, line, rectangle, circle };
}

function normalizeBounds(bounds) {
  const minX = Number(bounds?.minX) || 0;
  const minY = Number(bounds?.minY) || 0;
  const maxX = Number(bounds?.maxX) || minX + 1;
  const maxY = Number(bounds?.maxY) || minY + 1;
  const marginX = Math.max(100, (maxX - minX) * 0.04);
  const marginY = Math.max(100, (maxY - minY) * 0.04);
  return { minX: minX - marginX, minY: minY - marginY, maxX: maxX + marginX, maxY: maxY + marginY };
}

function projectPoint(point, bounds, width, height) {
  const usableWidth = width - PADDING * 2;
  const usableHeight = height - PADDING * 2;
  const xRatio = (point.x - bounds.minX) / Math.max(1, bounds.maxX - bounds.minX);
  const yRatio = (point.y - bounds.minY) / Math.max(1, bounds.maxY - bounds.minY);
  return {
    x: PADDING + xRatio * usableWidth,
    y: PADDING + yRatio * usableHeight,
  };
}

function sanitizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .,:/\-]/g, '');
}

function drawText(canvas, text, x, y, color = COLORS.text, scale = 2) {
  let cursorX = Math.round(x);
  const normalized = sanitizeText(text);
  for (const character of normalized) {
    const glyph = FONT[character] || FONT[' '];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] !== '1') {
          continue;
        }
        canvas.fillRectangle(
          cursorX + column * scale,
          y + row * scale,
          cursorX + column * scale + scale - 1,
          y + row * scale + scale - 1,
          color,
        );
      }
    }
    cursorX += 6 * scale;
  }
}

function worldLineX(canvas, bounds, worldX, color, thickness = 1) {
  const start = projectPoint({ x: worldX, y: bounds.minY }, bounds, canvas.width, canvas.height);
  const end = projectPoint({ x: worldX, y: bounds.maxY }, bounds, canvas.width, canvas.height);
  canvas.line(start.x, start.y, end.x, end.y, color, thickness);
}

function worldLineY(canvas, bounds, worldY, color, thickness = 1) {
  const start = projectPoint({ x: bounds.minX, y: worldY }, bounds, canvas.width, canvas.height);
  const end = projectPoint({ x: bounds.maxX, y: worldY }, bounds, canvas.width, canvas.height);
  canvas.line(start.x, start.y, end.x, end.y, color, thickness);
}

function drawWorldGrid(canvas, bounds, step, color, thickness = 1) {
  if (!Number.isFinite(step) || step <= 0) {
    return;
  }
  const startX = Math.floor(bounds.minX / step) * step;
  const endX = Math.ceil(bounds.maxX / step) * step;
  const startY = Math.floor(bounds.minY / step) * step;
  const endY = Math.ceil(bounds.maxY / step) * step;
  for (let x = startX; x <= endX; x += step) {
    worldLineX(canvas, bounds, x, color, thickness);
  }
  for (let y = startY; y <= endY; y += step) {
    worldLineY(canvas, bounds, y, color, thickness);
  }
}

function drawWorldRectangle(canvas, bounds, rectangle, color, thickness = 1, fillColor = null) {
  const first = projectPoint({ x: rectangle.minX, y: rectangle.minY }, bounds, canvas.width, canvas.height);
  const second = projectPoint({ x: rectangle.maxX, y: rectangle.maxY }, bounds, canvas.width, canvas.height);
  if (fillColor) {
    canvas.fillRectangle(first.x, first.y, second.x, second.y, fillColor);
  }
  canvas.rectangle(first.x, first.y, second.x, second.y, color, thickness);
  return { first, second };
}

function encodePng(canvas) {
  const scanlines = Buffer.alloc((canvas.width * 4 + 1) * canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    const targetOffset = y * (canvas.width * 4 + 1);
    scanlines[targetOffset] = 0;
    canvas.pixels.copy(scanlines, targetOffset + 1, y * canvas.width * 4, (y + 1) * canvas.width * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(canvas.width, 0);
  header.writeUInt32BE(canvas.height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createMapPng(options = {}) {
  const canvas = createCanvas(options.width || WIDTH, options.height || HEIGHT);
  const bounds = normalizeBounds(options.bounds || {});
  canvas.fill(COLORS.background);
  canvas.fillRectangle(0, 0, canvas.width, PADDING - 8, COLORS.panel);

  drawText(canvas, options.title || 'PROJECT ZOMBOID MAPA', 16, 12, COLORS.text, 2);
  if (options.subtitle) {
    drawText(canvas, options.subtitle, Math.max(16, canvas.width - 560), 14, COLORS.mutedText, 1);
  }

  drawWorldGrid(canvas, bounds, options.minorGridStep || 100, COLORS.grid, 1);
  drawWorldGrid(canvas, bounds, options.majorGridStep || 300, COLORS.gridMajor, 1);
  canvas.rectangle(PADDING, PADDING, canvas.width - PADDING, canvas.height - PADDING, COLORS.border, 2);

  for (const map of options.maps || []) {
    const projected = drawWorldRectangle(canvas, bounds, map, COLORS.map, 3, COLORS.mapFill);
    if (map.name) {
      drawText(canvas, map.name, projected.first.x + 8, projected.first.y + 8, COLORS.mutedText, 1);
    }
  }

  // Keep the real PZ grid visible over filled map regions.
  drawWorldGrid(canvas, bounds, options.minorGridStep || 100, COLORS.grid, 1);
  drawWorldGrid(canvas, bounds, options.majorGridStep || 300, COLORS.gridMajor, 1);

  for (const map of options.maps || []) {
    if (!map.name) {
      continue;
    }
    const projected = projectPoint({ x: map.minX, y: map.minY }, bounds, canvas.width, canvas.height);
    drawText(canvas, map.name, projected.x + 8, projected.y + 8, COLORS.mutedText, 1);
  }

  if (options.focusCell) {
    drawWorldRectangle(canvas, bounds, options.focusCell, COLORS.focusCell, 2);
  }

  if (options.focusChunk) {
    drawWorldRectangle(canvas, bounds, options.focusChunk, COLORS.focusChunk, 3);
  }

  for (const safehouse of options.safehouses || []) {
    const x1 = Number(safehouse.x ?? safehouse.minX);
    const y1 = Number(safehouse.y ?? safehouse.minY);
    const x2 = Number(safehouse.x2 ?? safehouse.maxX);
    const y2 = Number(safehouse.y2 ?? safehouse.maxY);
    if (![x1, y1, x2, y2].every(Number.isFinite)) {
      continue;
    }
    drawWorldRectangle(canvas, bounds, { minX: x1, minY: y1, maxX: x2, maxY: y2 }, COLORS.safehouse, 2);
  }

  for (const point of options.points || []) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      continue;
    }
    const projected = projectPoint(point, bounds, canvas.width, canvas.height);
    const isFocus = options.focus && point.nick === options.focus;
    canvas.circle(projected.x, projected.y, isFocus ? 8 : 5, isFocus ? COLORS.focus : COLORS.player, true);
    if (isFocus) {
      canvas.circle(projected.x, projected.y, 13, COLORS.focus, false);
      drawText(canvas, point.nick || 'PLAYER', projected.x + 18, projected.y - 10, COLORS.text, 1);
    } else if (options.showPlayerLabels) {
      drawText(canvas, point.nick || '', projected.x + 8, projected.y - 6, COLORS.mutedText, 1);
    }
  }

  const footer = `X ${Math.round(bounds.minX)}-${Math.round(bounds.maxX)}  Y ${Math.round(bounds.minY)}-${Math.round(bounds.maxY)}  GRID ${options.majorGridStep || 300}`;
  drawText(canvas, footer, 16, canvas.height - 24, COLORS.mutedText, 1);

  return encodePng(canvas);
}

module.exports = {
  createMapPng,
};
