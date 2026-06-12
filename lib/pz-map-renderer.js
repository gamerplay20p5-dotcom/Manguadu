const zlib = require('zlib');

const WIDTH = 1000;
const HEIGHT = 700;
const PADDING = 42;

const COLORS = {
  background: [20, 25, 28, 255],
  grid: [48, 58, 62, 255],
  border: [112, 135, 132, 255],
  map: [46, 96, 76, 255],
  safehouse: [226, 176, 64, 255],
  player: [80, 200, 255, 255],
  focus: [255, 82, 82, 255],
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

  return { width, height, pixels, fill, line, rectangle, circle };
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

  for (let index = 0; index <= 10; index += 1) {
    const x = PADDING + ((canvas.width - PADDING * 2) * index) / 10;
    const y = PADDING + ((canvas.height - PADDING * 2) * index) / 10;
    canvas.line(x, PADDING, x, canvas.height - PADDING, COLORS.grid);
    canvas.line(PADDING, y, canvas.width - PADDING, y, COLORS.grid);
  }
  canvas.rectangle(PADDING, PADDING, canvas.width - PADDING, canvas.height - PADDING, COLORS.border, 2);

  for (const map of options.maps || []) {
    const first = projectPoint({ x: map.minX, y: map.minY }, bounds, canvas.width, canvas.height);
    const second = projectPoint({ x: map.maxX, y: map.maxY }, bounds, canvas.width, canvas.height);
    canvas.rectangle(first.x, first.y, second.x, second.y, COLORS.map, 3);
  }

  for (const safehouse of options.safehouses || []) {
    const x1 = Number(safehouse.x ?? safehouse.minX);
    const y1 = Number(safehouse.y ?? safehouse.minY);
    const x2 = Number(safehouse.x2 ?? safehouse.maxX);
    const y2 = Number(safehouse.y2 ?? safehouse.maxY);
    if (![x1, y1, x2, y2].every(Number.isFinite)) {
      continue;
    }
    const first = projectPoint({ x: x1, y: y1 }, bounds, canvas.width, canvas.height);
    const second = projectPoint({ x: x2, y: y2 }, bounds, canvas.width, canvas.height);
    canvas.rectangle(first.x, first.y, second.x, second.y, COLORS.safehouse, 2);
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
    }
  }

  return encodePng(canvas);
}

module.exports = {
  createMapPng,
};
