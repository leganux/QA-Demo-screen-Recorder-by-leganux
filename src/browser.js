const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { timestampForFilename } = require('./utils');

function safeSerialize(arg) {
  try {
    if (arg == null) return String(arg);
    if (typeof arg === 'string') return arg;
    return JSON.stringify(arg);
  } catch {
    return '[Unserializable value]';
  }
}

async function setupBrowserErrorLogger(page, { logsDir, enabled = true } = {}) {
  if (!enabled || !logsDir) {
    console.log('[Browser] Log de errores del navegador desactivado.');
    return {
      logFilePath: '',
      stop: async () => {}
    };
  }

  const logFilePath = path.join(logsDir, `browser-errors-${timestampForFilename()}.log`);
  console.log(`[Browser] Inicializando archivo de log de errores: ${logFilePath}`);
  const stream = fs.createWriteStream(logFilePath, { flags: 'a' });

  const write = (line) => {
    const ts = new Date().toISOString();
    stream.write(`[${ts}] ${line}\n`);
  };

  const onConsole = (msg) => {
    if (msg.type() !== 'error') return;
    write(`[console.error] ${msg.text()}`);
  };

  const onPageError = (error) => {
    write(`[pageerror] ${error?.stack || error?.message || String(error)}`);
  };

  const onRequestFailed = (request) => {
    const failure = request.failure();
    write(`[requestfailed] ${request.method()} ${request.url()} :: ${failure?.errorText || 'unknown'}`);
  };

  const onResponse = async (response) => {
    try {
      const status = response.status();
      if (status >= 400) {
        write(`[http ${status}] ${response.request().method()} ${response.url()}`);
      }
    } catch {
      // ignore
    }
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);

  write('=== Browser error log started ===');

  return {
    logFilePath,
    stop: async () => {
      console.log('[Browser] Cerrando logger de errores de navegador...');
      try {
        page.off('console', onConsole);
        page.off('pageerror', onPageError);
        page.off('requestfailed', onRequestFailed);
        page.off('response', onResponse);
      } catch {
        // ignore
      }

      write('=== Browser error log finished ===');

      await new Promise((resolve) => {
        stream.end(resolve);
      });

      console.log('[Browser] Logger de errores de navegador cerrado.');
    }
  };
}

async function startBrowserSession({
  url,
  viewport,
  outputDir,
  sessionDir,
  clearCache = false,
  logsDir,
  enableBrowserErrorLog = true
}) {
  console.log('[Browser] Iniciando navegador...');
  console.log(
    `[Browser] Configuración -> viewport=${viewport?.width || 0}x${viewport?.height || 0}, videoDir=${outputDir}, sessionDir=${sessionDir}`
  );

  if (clearCache && sessionDir) {
    console.log('[Browser] Limpiando caché/sesión guardada...');
    await fs.promises.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log('[Browser] Lanzando contexto persistente de Playwright con grabación de video...');

  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    slowMo: 50,
    viewport,
    recordVideo: {
      dir: outputDir,
      size: viewport
    }
  });

  const browser = context.browser();
  const page = await context.newPage();
  console.log('[Browser] Página principal creada.');
  const browserLogger = await setupBrowserErrorLogger(page, {
    logsDir,
    enabled: enableBrowserErrorLog
  });

  if (browserLogger.logFilePath) {
    console.log(`[Browser] Log de errores navegador: ${browserLogger.logFilePath}`);
  }

  console.log(`[Browser] Abriendo URL: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  console.log('[Browser] URL cargada y navegador listo para automatización.');

  return { browser, context, page, browserLogger };
}

async function closeBrowserSession({ browser, context, browserLogger }) {
  try {
    if (browserLogger && typeof browserLogger.stop === 'function') {
      await browserLogger.stop();
    }

    if (context) {
      console.log('[Browser] Cerrando contexto de Playwright...');
      await context.close();
      console.log('[Browser] Contexto cerrado.');
    }
  } finally {
    if (browser && browser.isConnected()) {
      console.log('[Browser] Cerrando instancia de browser...');
      await browser.close();
      console.log('[Browser] Browser cerrado.');
    }
  }
}

module.exports = {
  startBrowserSession,
  closeBrowserSession,
  setupBrowserErrorLogger
};
