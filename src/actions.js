const fs = require('fs');
const cheerio = require('cheerio');
const config = require('./config');
const { sleep, normalizeWhitespace, resolvePathFromCwd } = require('./utils');

const ACTIONS = {
  CLICK: 'click',
  TYPE: 'type',
  SELECT: 'select',
  CHECK: 'check',
  UNCHECK: 'uncheck',
  SCROLL: 'scroll',
  WAIT: 'wait',
  GOTO: 'goto',
  FINISH: 'finish',
  FAIL: 'fail',
  UPLOAD: 'upload'
};

const VISUAL_CURSOR_ID = '__browser_agent_visual_cursor__';
const mouseState = new WeakMap();

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function isLikelyDynamicContentError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const patterns = [
    'execution context was destroyed',
    'most likely because of a navigation',
    'frame was detached',
    'element is not attached',
    'target closed',
    'no se encontró elemento',
    'cannot find context with specified id',
    'navigation',
    'net::err_aborted'
  ];
  return patterns.some((pattern) => message.includes(pattern));
}

async function withRetries(operation, { maxRetries = 3, retryBaseWaitMs = 350, description = 'operación' } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const retryable = isLikelyDynamicContentError(error);
      if (!retryable || attempt >= maxRetries) {
        throw error;
      }

      const waitMs = retryBaseWaitMs * attempt;
      console.warn(
        `[Retry ${attempt}/${maxRetries}] ${description} falló por contenido dinámico. Reintentando en ${waitMs}ms...`
      );
      await sleep(waitMs);
    }
  }

  throw lastError;
}

async function ensureVisualCursor(page) {
  await page
    .evaluate((cursorId) => {
      if (!document || document.getElementById(cursorId)) return;

      const cursor = document.createElement('div');
      cursor.id = cursorId;
      cursor.setAttribute('aria-hidden', 'true');
      cursor.style.position = 'fixed';
      cursor.style.left = '0';
      cursor.style.top = '0';
      cursor.style.width = '14px';
      cursor.style.height = '14px';
      cursor.style.borderRadius = '50%';
      cursor.style.background = 'rgba(255, 59, 48, 0.95)';
      cursor.style.border = '2px solid #fff';
      cursor.style.boxShadow = '0 0 0 2px rgba(0,0,0,0.25)';
      cursor.style.transform = 'translate(-100px, -100px)';
      cursor.style.zIndex = '2147483647';
      cursor.style.pointerEvents = 'none';
      cursor.style.transition = 'transform 35ms linear';
      document.documentElement.appendChild(cursor);
    }, VISUAL_CURSOR_ID)
    .catch(() => {});
}

async function updateVisualCursor(page, x, y) {
  await page
    .evaluate(
      ({ cursorId, xCoord, yCoord }) => {
        const cursor = document.getElementById(cursorId);
        if (!cursor) return;
        cursor.style.transform = `translate(${Math.round(xCoord)}px, ${Math.round(yCoord)}px)`;
      },
      { cursorId: VISUAL_CURSOR_ID, xCoord: x, yCoord: y }
    )
    .catch(() => {});
}

async function moveMouseHuman(page, targetPoint, { showCursor = true } = {}) {
  const from = mouseState.get(page) || { x: 40, y: 40 };
  const to = targetPoint;
  const steps = Math.max(12, Math.floor(Math.hypot(to.x - from.x, to.y - from.y) / 20));

  if (showCursor) {
    await ensureVisualCursor(page);
  }

  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const eased = t * t * (3 - 2 * t);
    const jitter = 0.75;
    const x = from.x + (to.x - from.x) * eased + randomBetween(-jitter, jitter);
    const y = from.y + (to.y - from.y) * eased + randomBetween(-jitter, jitter);

    await page.mouse.move(x, y);
    if (showCursor) {
      await updateVisualCursor(page, x, y);
    }
    await page.waitForTimeout(8).catch(() => {});
  }

  mouseState.set(page, { x: to.x, y: to.y });
}

async function moveMouseToLocator(page, locator, { showCursor = true } = {}) {
  const box = await locator.boundingBox();
  if (!box) return;

  const x = box.x + box.width / 2 + randomBetween(-Math.min(5, box.width / 8), Math.min(5, box.width / 8));
  const y = box.y + box.height / 2 + randomBetween(-Math.min(5, box.height / 8), Math.min(5, box.height / 8));
  await moveMouseHuman(page, { x, y }, { showCursor });
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRoleSelector(selector) {
  const match = selector.match(/^role=([^:]+)(?::(.+))?$/i);
  if (!match) return null;
  return {
    role: (match[1] || '').trim(),
    name: (match[2] || '').trim()
  };
}

function extractTextSearchHint(selector) {
  const value = String(selector || '').trim();
  if (!value) return '';

  const prefixes = ['text=', 'label=', 'role='];
  for (const prefix of prefixes) {
    if (value.toLowerCase().startsWith(prefix)) {
      const raw = value.slice(prefix.length);
      if (prefix === 'role=') {
        const parsed = parseRoleSelector(value);
        return parsed ? parsed.name : raw;
      }
      return raw.trim();
    }
  }

  return value;
}

async function firstExistingLocator(candidates = []) {
  for (const locator of candidates) {
    if (!locator) continue;
    try {
      const count = await locator.count();
      if (count > 0) {
        return locator.first();
      }
    } catch {
      // Ignore invalid locators and continue.
    }
  }
  return null;
}

function buildCheerioSelectorHint($element) {
  const id = ($element.attr('id') || '').trim();
  if (id) return `#${id}`;

  const name = ($element.attr('name') || '').trim();
  if (name) return `${$element[0].tagName}[name='${name.replace(/'/g, "\\'")}']`;

  const dataTestId = ($element.attr('data-testid') || '').trim();
  if (dataTestId) return `[data-testid='${dataTestId.replace(/'/g, "\\'")}']`;

  const ariaLabel = ($element.attr('aria-label') || '').trim();
  if (ariaLabel) return `text=${ariaLabel}`;

  const text = normalizeWhitespace($element.text());
  if (text) return `text=${text}`;

  return '';
}

async function resolveWithCheerioFallback(page, selector) {
  const hint = extractTextSearchHint(selector);
  if (!hint) return null;

  const html = await page.content().catch(() => '');
  if (!html) return null;
  const $ = cheerio.load(html);
  const wanted = hint.toLowerCase();

  const clickableSelector =
    'button, a, [role="button"], label, input[type="button"], input[type="submit"], input[type="checkbox"], input[type="radio"]';

  const candidates = [];
  $(clickableSelector).each((_, el) => {
    if (candidates.length >= 20) return false;
    const $el = $(el);
    const text = normalizeWhitespace($el.text());
    const value = normalizeWhitespace($el.attr('value') || '');
    const aria = normalizeWhitespace($el.attr('aria-label') || '');
    const bucket = `${text} ${value} ${aria}`.toLowerCase();

    if (bucket.includes(wanted)) {
      const selectorHint = buildCheerioSelectorHint($el);
      if (selectorHint) candidates.push(selectorHint);
    }
  });

  const locators = [];
  for (const selectorHint of candidates) {
    if (selectorHint.startsWith('text=')) {
      const textPart = selectorHint.slice(5);
      locators.push(page.getByText(new RegExp(escapeRegex(textPart), 'i')));
    } else {
      locators.push(page.locator(selectorHint));
    }
  }

  return firstExistingLocator(locators);
}

async function resolveSelector(page, selector) {
  const raw = String(selector || '').trim();
  if (!raw) return null;

  if (raw.toLowerCase().startsWith('text=')) {
    const text = raw.slice(5).trim();
    return firstExistingLocator([
      page.getByText(text, { exact: false }),
      page.getByText(new RegExp(escapeRegex(text), 'i'))
    ]);
  }

  if (raw.toLowerCase().startsWith('role=')) {
    const parsed = parseRoleSelector(raw);
    if (parsed && parsed.role) {
      if (parsed.name) {
        return firstExistingLocator([
          page.getByRole(parsed.role, { name: parsed.name, exact: false }),
          page.getByRole(parsed.role, { name: new RegExp(escapeRegex(parsed.name), 'i') })
        ]);
      }
      return firstExistingLocator([page.getByRole(parsed.role)]);
    }
  }

  if (raw.toLowerCase().startsWith('label=')) {
    const label = raw.slice(6).trim();
    return firstExistingLocator([
      page.getByLabel(label, { exact: false }),
      page.getByLabel(new RegExp(escapeRegex(label), 'i'))
    ]);
  }

  const cssLocator = await firstExistingLocator([page.locator(raw)]);
  if (cssLocator) return cssLocator;

  const genericText = extractTextSearchHint(raw);
  if (genericText) {
    const reg = new RegExp(escapeRegex(genericText), 'i');
    const fallbackLocator = await firstExistingLocator([
      page.getByRole('button', { name: reg }),
      page.getByRole('link', { name: reg }),
      page.getByLabel(reg),
      page.getByPlaceholder(reg),
      page.getByText(reg),
      page.locator(`button:has-text("${genericText}")`),
      page.locator(`a:has-text("${genericText}")`)
    ]);

    if (fallbackLocator) return fallbackLocator;
  }

  return resolveWithCheerioFallback(page, raw);
}

async function setupDialogHandler(page) {
  page.on('dialog', async (dialog) => {
    try {
      console.log(`[Dialog] ${dialog.type()}: ${dialog.message()}`);
      await dialog.accept();
    } catch {
      await dialog.dismiss().catch(() => {});
    }
  });
}

async function handleTransientUi(page) {
  const closeCandidates = [
    'button:has-text("Aceptar")',
    'button:has-text("Cerrar")',
    'button:has-text("Entendido")',
    'button:has-text("Close")',
    '[aria-label="Close"]',
    '[aria-label="Cerrar"]',
    '.modal button.close'
  ];

  for (const candidate of closeCandidates) {
    const locator = page.locator(candidate).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible())) {
        await locator.click({ timeout: 1000 });
        await page.waitForTimeout(200);
      }
    } catch {
      // Ignore if not clickable.
    }
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
}

async function executeAction(
  page,
  action,
  {
    defaultWaitMs = 1500,
    enableHumanCursor: enableHumanCursorOpt,
    maxRetries: maxRetriesOpt,
    retryBaseWaitMs: retryBaseWaitMsOpt
  } = {}
) {
  const normalizedAction = String(action.action || '').toLowerCase().trim();
  const selector = action.selector || '';
  const value = action.value == null ? '' : String(action.value);
  const enableHumanCursor =
    enableHumanCursorOpt == null
      ? action.enableHumanCursor == null
        ? config.enableHumanCursor
        : Boolean(action.enableHumanCursor)
      : Boolean(enableHumanCursorOpt);
  const maxRetries = maxRetriesOpt || action.maxRetries || config.actionMaxRetries;
  const retryBaseWaitMs = retryBaseWaitMsOpt || action.retryBaseWaitMs || config.retryBaseWaitMs;

  if (normalizedAction === ACTIONS.FINISH || normalizedAction === ACTIONS.FAIL) {
    return { executed: false, status: normalizedAction };
  }

  if (normalizedAction === ACTIONS.WAIT) {
    const waitMs = Number.parseInt(value, 10);
    await sleep(Number.isNaN(waitMs) ? defaultWaitMs : waitMs);
    return { executed: true, status: ACTIONS.WAIT };
  }

  if (normalizedAction === ACTIONS.GOTO) {
    return withRetries(
      async () => {
        const target = value || selector;
        if (!target) {
          throw new Error('Acción goto requiere URL en value o selector');
        }
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        return { executed: true, status: ACTIONS.GOTO };
      },
      { maxRetries, retryBaseWaitMs, description: 'goto' }
    );
  }

  return withRetries(
    async () => {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});

      if (normalizedAction === ACTIONS.SCROLL) {
        const numeric = Number.parseInt(value, 10);
        const amount = Number.isNaN(numeric) ? 600 : numeric;

        if (selector) {
          const locatorForScroll = await resolveSelector(page, selector);
          if (!locatorForScroll) {
            throw new Error(`No se encontró elemento para scroll con selector: ${selector}`);
          }
          await locatorForScroll.scrollIntoViewIfNeeded();
          if (enableHumanCursor) {
            await moveMouseToLocator(page, locatorForScroll, { showCursor: true });
          }
        } else {
          await page.evaluate((y) => window.scrollBy(0, y), amount);
        }

        await page.waitForTimeout(250);
        return { executed: true, status: ACTIONS.SCROLL };
      }

      const locator = await resolveSelector(page, selector);
      if (!locator) {
        throw new Error(`No se encontró elemento con selector: ${selector}`);
      }

      await locator.scrollIntoViewIfNeeded().catch(() => {});

      if (enableHumanCursor) {
        await moveMouseToLocator(page, locator, { showCursor: true });
      }

      switch (normalizedAction) {
        case ACTIONS.CLICK:
          await locator.click({ timeout: 10000 });
          break;

        case ACTIONS.TYPE: {
          const isFileInput = await locator
            .evaluate((el) => el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file')
            .catch(() => false);

          if (isFileInput && value) {
            const filePath = resolvePathFromCwd(value);
            if (!fs.existsSync(filePath)) {
              throw new Error(`Archivo no encontrado para subir: ${filePath}`);
            }
            await locator.setInputFiles(filePath);
          } else {
            await locator.click({ timeout: 5000 }).catch(() => {});
            await locator.fill(value, { timeout: 10000 });
          }
          break;
        }

        case ACTIONS.SELECT:
          await locator.selectOption(value);
          break;

        case ACTIONS.CHECK:
          await locator.check({ timeout: 10000 });
          break;

        case ACTIONS.UNCHECK:
          await locator.uncheck({ timeout: 10000 });
          break;

        case ACTIONS.UPLOAD: {
          const filePath = resolvePathFromCwd(value);
          if (!fs.existsSync(filePath)) {
            throw new Error(`Archivo no encontrado para upload: ${filePath}`);
          }
          await locator.setInputFiles(filePath);
          break;
        }

        default:
          throw new Error(`Acción no soportada: ${normalizedAction}`);
      }

      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 7000 }).catch(() => {});

      return { executed: true, status: normalizedAction };
    },
    { maxRetries, retryBaseWaitMs, description: `acción ${normalizedAction}` }
  );
}

module.exports = {
  ACTIONS,
  resolveSelector,
  executeAction,
  setupDialogHandler,
  handleTransientUi
};
