const fs = require('fs');
const path = require('path');

function logInfo(message) {
  console.log(`[INFO] ${message}`);
}

function logWarn(message) {
  console.warn(`[WARN] ${message}`);
}

function logError(scope, error) {
  const message = error && error.message ? error.message : String(error);
  console.error(`[ERROR] ${scope}: ${message}`);
}

function cleanText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function normalizeHeader(header) {
  return cleanText(header).replace(/^[\uFEFF\u200B]+/g, '').toLowerCase();
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (error) {
    return false;
  }
}

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (error) {
    return false;
  }
}

function readTextFile(filePath) {
  if (!fileExists(filePath)) {
    return '';
  }

  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    logError(`Falha ao ler ${filePath}`, error);
    return '';
  }
}

function stripBom(value) {
  return String(value || '').replace(/^\uFEFF/, '');
}

function parseDelimitedCsv(content, options = {}) {
  const delimiter = options.delimiter || ';';
  const trim = options.trim !== false;
  const skipEmptyLines = options.skipEmptyLines !== false;
  const rows = [];

  let currentRow = [];
  let currentValue = '';
  let insideQuotes = false;

  const normalizedContent = stripBom(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  function pushValue() {
    currentRow.push(trim ? currentValue.trim() : currentValue);
    currentValue = '';
  }

  function pushRow() {
    const row = currentRow.slice();
    const isEmpty = row.every((cell) => cleanText(cell) === '');
    if (!(skipEmptyLines && isEmpty)) {
      rows.push(row);
    }
    currentRow = [];
  }

  for (let index = 0; index < normalizedContent.length; index += 1) {
    const char = normalizedContent[index];
    const nextChar = normalizedContent[index + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentValue += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (char === delimiter && !insideQuotes) {
      pushValue();
      continue;
    }

    if (char === '\n' && !insideQuotes) {
      pushValue();
      pushRow();
      continue;
    }

    currentValue += char;
  }

  if (currentValue.length > 0 || currentRow.length > 0) {
    pushValue();
    pushRow();
  }

  return rows;
}

function readCsvRows(filePath) {
  const content = readTextFile(filePath);
  if (!content.trim()) {
    return [];
  }

  try {
    const rawRows = parseDelimitedCsv(content, {
      delimiter: ';',
      skipEmptyLines: true,
      trim: true,
    });

    if (rawRows.length === 0) {
      return [];
    }

    const headers = rawRows[0].map(normalizeHeader);
    return rawRows.slice(1).map((row) => {
      const record = {};
      for (let index = 0; index < headers.length; index += 1) {
        const header = headers[index];
        if (!header) {
          continue;
        }
        record[header] = row[index] !== undefined ? cleanText(row[index]) : '';
      }
      return record;
    });
  } catch (error) {
    logError(`Falha ao parsear CSV ${filePath}`, error);
    return [];
  }
}

function readCsvRawRows(filePath) {
  const content = readTextFile(filePath);
  if (!content.trim()) {
    return [];
  }

  try {
    return parseDelimitedCsv(content, {
      delimiter: ';',
      skipEmptyLines: true,
      trim: true,
    });
  } catch (error) {
    logError(`Falha ao parsear CSV bruto ${filePath}`, error);
    return [];
  }
}

function readLatestCsvRow(filePath) {
  const rows = readCsvRows(filePath);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

function getField(record, keys, fallback = '') {
  if (!record) {
    return fallback;
  }

  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && cleanText(value) !== '') {
      return cleanText(value);
    }
  }

  return fallback;
}

function toNumber(value, fallback = 0) {
  const normalized = Number.parseFloat(cleanText(value).replace(',', '.'));
  return Number.isFinite(normalized) ? normalized : fallback;
}

function toBoolean(value) {
  const normalized = cleanText(value).toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'sim' || normalized === 'yes';
}

function escapeCodeBlock(text) {
  return String(text || '').replace(/```/g, '`` `');
}

function truncate(text, maxLength = 1900) {
  const value = cleanText(text);
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function truncateLine(text, maxLength = 160) {
  return truncate(String(text || '').replace(/\r?\n/g, ' '), maxLength);
}

function joinLinesLimited(lines, maxLength = 1024) {
  if (!lines || lines.length === 0) {
    return 'Sem dados.';
  }

  let output = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = output ? `${output}\n${line}` : line;
    if (next.length > maxLength) {
      const remaining = lines.length - index;
      return output ? `${output}\n... e mais ${remaining} linha(s)` : truncate(line, maxLength);
    }
    output = next;
  }

  return output || 'Sem dados.';
}

function collectFilesRecursively(dirPath, predicate, maxDepth = 5, results = [], maxResults = 500) {
  if (!isDirectory(dirPath) || maxDepth < 0 || results.length >= maxResults) {
    return results;
  }

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (results.length >= maxResults) {
      break;
    }

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      collectFilesRecursively(fullPath, predicate, maxDepth - 1, results, maxResults);
      continue;
    }

    if (predicate(fullPath, entry)) {
      results.push(fullPath);
    }
  }

  return results;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  cleanText,
  collectFilesRecursively,
  delay,
  escapeCodeBlock,
  fileExists,
  getField,
  isDirectory,
  joinLinesLimited,
  logError,
  logInfo,
  logWarn,
  normalizeHeader,
  parseDelimitedCsv,
  readCsvRawRows,
  readCsvRows,
  readLatestCsvRow,
  readTextFile,
  toBoolean,
  toNumber,
  truncate,
  truncateLine,
};
