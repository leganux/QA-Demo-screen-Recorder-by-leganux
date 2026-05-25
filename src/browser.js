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
    return {
      logFilePath: '',
      stop: async () => {}
    };
  }

  const logFilePath = path.join(logsDir, `browser-errors-${timestampForFilename()}.log`);
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
  console.log('Iniciando navegador...');

  if (clearCache && sessionDir) {
    console.log('Limpiando caché/sesión guardada...');
    await fs.promises.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  }

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
  const browserLogger = await setupBrowserErrorLogger(page, {
    logsDir,
    enabled: enableBrowserErrorLog
  });

  if (browserLogger.logFilePath) {
    console.log(`Log de errores navegador: ${browserLogger.logFilePath}`);
  }

  console.log('Abriendo URL...');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  return { browser, context, page, browserLogger };
}

async function closeBrowserSession({ browser, context, browserLogger }) {
  try {
    if (browserLogger && typeof browserLogger.stop === 'function') {
      await browserLogger.stop();
    }

    if (context) {
      await context.close();
    }
  } finally {
    if (browser && browser.isConnected()) {
      await browser.close();
    }
  }
}

module.exports = {
  startBrowserSession,
  closeBrowserSession,
  setupBrowserErrorLogger
};
