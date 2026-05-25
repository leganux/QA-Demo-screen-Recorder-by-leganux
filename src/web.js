const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOST = process.env.WEB_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.WEB_PORT || '8787', 10);

const uiPath = path.join(__dirname, 'web-ui.html');

const state = {
  status: 'idle',
  startedAt: '',
  finishedAt: '',
  pid: null,
  logs: [],
  process: null,
  lastRunArgs: null
};

function nowIso() {
  return new Date().toISOString();
}

function appendLog(line) {
  const entry = `[${nowIso()}] ${line}`;
  state.logs.push(entry);
  if (state.logs.length > 1500) {
    state.logs = state.logs.slice(-1500);
  }
}

function setStatus(status) {
  state.status = status;
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, code, data, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Payload demasiado grande'));
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function ensureNotRunning() {
  return !(state.process && state.status === 'running');
}

function buildArgs(payload) {
  const args = [];

  const url = String(payload.url || '').trim();
  const prompt = String(payload.prompt || '').trim();

  if (!url) {
    throw new Error('La URL es requerida');
  }

  if (!prompt) {
    throw new Error('El prompt es requerido');
  }

  args.push('--url', url);
  args.push('--prompt', prompt);

  if (parseBoolean(payload.clearCache, false)) {
    args.push('--clear-cache=true');
  }

  if (payload.humanCursor != null && payload.humanCursor !== '') {
    args.push(`--human-cursor=${parseBoolean(payload.humanCursor, true)}`);
  }

  if (payload.browserErrorLog != null && payload.browserErrorLog !== '') {
    args.push(`--browser-error-log=${parseBoolean(payload.browserErrorLog, true)}`);
  }

  return args;
}

function startRun(payload) {
  if (!ensureNotRunning()) {
    throw new Error('Ya hay una ejecución en curso');
  }

  const args = buildArgs(payload);
  state.logs = [];
  state.startedAt = nowIso();
  state.finishedAt = '';
  state.lastRunArgs = args;
  setStatus('running');

  appendLog(`[Web] Iniciando ejecución CLI con args: ${args.join(' ')}`);

  const child = spawn(process.execPath, [path.join(__dirname, 'app.js'), ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  state.process = child;
  state.pid = child.pid;

  child.stdout.on('data', (chunk) => {
    String(chunk)
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .forEach((line) => appendLog(`[STDOUT] ${line}`));
  });

  child.stderr.on('data', (chunk) => {
    String(chunk)
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .forEach((line) => appendLog(`[STDERR] ${line}`));
  });

  child.on('error', (error) => {
    appendLog(`[Web] Error en proceso hijo: ${error.message}`);
    setStatus('error');
    state.finishedAt = nowIso();
    state.process = null;
    state.pid = null;
  });

  child.on('close', (code, signal) => {
    if (signal) {
      appendLog(`[Web] Proceso terminado por señal: ${signal}`);
      setStatus('stopped');
    } else if (code === 0) {
      appendLog('[Web] Proceso finalizado correctamente.');
      setStatus('done');
    } else {
      appendLog(`[Web] Proceso finalizó con código ${code}.`);
      setStatus('error');
    }

    state.finishedAt = nowIso();
    state.process = null;
    state.pid = null;
  });

  return {
    ok: true,
    status: state.status,
    pid: state.pid,
    startedAt: state.startedAt
  };
}

function stopRun() {
  if (!state.process || state.status !== 'running') {
    return { ok: false, message: 'No hay ejecución activa' };
  }

  appendLog('[Web] Solicitud de detención recibida. Enviando SIGTERM...');
  state.process.kill('SIGTERM');
  return { ok: true, message: 'Se solicitó detener la ejecución' };
}

function getPublicState() {
  return {
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    pid: state.pid,
    logs: state.logs,
    lastRunArgs: state.lastRunArgs || []
  };
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const requestUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (method === 'GET' && requestUrl.pathname === '/') {
    const html = await fs.promises.readFile(uiPath, 'utf8');
    return sendText(res, 200, html, 'text/html; charset=utf-8');
  }

  if (method === 'GET' && requestUrl.pathname === '/api/status') {
    return sendJson(res, 200, getPublicState());
  }

  if (method === 'POST' && requestUrl.pathname === '/api/run') {
    try {
      const raw = await readRequestBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      const result = startRun(payload);
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error.message });
    }
  }

  if (method === 'POST' && requestUrl.pathname === '/api/stop') {
    const result = stopRun();
    const code = result.ok ? 200 : 409;
    return sendJson(res, code, result);
  }

  return sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[WebUI] Interfaz lista en: http://${HOST}:${PORT}`);
  console.log('[WebUI] Esta interfaz NO reemplaza la consola; puedes seguir usando npm run start');
});
