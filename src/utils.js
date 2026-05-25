const fs = require('fs');
const path = require('path');

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

function timestampForFilename(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}-${hh}${mi}${ss}`;
}

function parseCliArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];

    if (!current.startsWith('--')) {
      continue;
    }

    if (current.includes('=')) {
      const [rawKey, ...rest] = current.slice(2).split('=');
      args[rawKey] = rest.join('=').trim();
      continue;
    }

    const key = current.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text, max = 2000) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function normalizeWhitespace(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractJsonObject(rawText) {
  const direct = safeJsonParse(rawText);
  if (direct) return direct;

  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return safeJsonParse(rawText.slice(start, end + 1));
}

function actionSignature(action = {}) {
  const actionPart = (action.action || '').toLowerCase().trim();
  const selectorPart = normalizeWhitespace((action.selector || '').toLowerCase());
  const valuePart = normalizeWhitespace((action.value || '').toLowerCase());
  return `${actionPart}|${selectorPart}|${valuePart}`;
}

function resolvePathFromCwd(relativeOrAbsolutePath) {
  if (!relativeOrAbsolutePath) return '';
  return path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.resolve(process.cwd(), relativeOrAbsolutePath);
}

module.exports = {
  ensureDir,
  timestampForFilename,
  parseCliArgs,
  sleep,
  truncate,
  normalizeWhitespace,
  safeJsonParse,
  extractJsonObject,
  actionSignature,
  resolvePathFromCwd
};
