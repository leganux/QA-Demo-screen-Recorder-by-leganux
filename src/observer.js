const path = require('path');
const cheerio = require('cheerio');
const { sleep, truncate, normalizeWhitespace, timestampForFilename } = require('./utils');

function buildCandidateSelector($element) {
  const id = ($element.attr('id') || '').trim();
  if (id) return `#${id}`;

  const name = ($element.attr('name') || '').trim();
  if (name) return `${$element[0].tagName}[name='${name.replace(/'/g, "\\'")}']`;

  const dataTestId = ($element.attr('data-testid') || '').trim();
  if (dataTestId) return `[data-testid='${dataTestId.replace(/'/g, "\\'")}']`;

  const classes = ($element.attr('class') || '')
    .split(' ')
    .map((cls) => cls.trim())
    .filter(Boolean)
    .slice(0, 2);

  if (classes.length > 0) {
    return `${$element[0].tagName}.${classes.join('.')}`;
  }

  return $element[0].tagName;
}

function collectElements($, selector, max = 25) {
  const items = [];
  $(selector).each((_, el) => {
    if (items.length >= max) return false;
    const $el = $(el);
    const text = normalizeWhitespace($el.text());

    const visibleLike =
      ($el.attr('type') || '').toLowerCase() !== 'hidden' &&
      !$el.attr('hidden') &&
      !String($el.attr('style') || '').includes('display:none');

    if (!visibleLike) {
      return;
    }

    items.push({
      tag: el.tagName,
      text: truncate(text, 140),
      selectorHint: buildCandidateSelector($el)
    });
  });

  return items;
}

function getMainVisibleText($) {
  const preferred = ['main', '[role="main"]', 'body'];
  for (const sel of preferred) {
    const text = normalizeWhitespace($(sel).first().text());
    if (text) return truncate(text, 3000);
  }
  return '';
}

function getFormSummaries($, maxForms = 10) {
  const forms = [];
  $('form').each((idx, form) => {
    if (idx >= maxForms) return false;
    const $form = $(form);

    const fields = [];
    $form.find('input, select, textarea').each((_, field) => {
      if (fields.length >= 20) return false;
      const $field = $(field);
      const type = ($field.attr('type') || field.tagName || '').toLowerCase();
      const name = ($field.attr('name') || '').trim();
      const id = ($field.attr('id') || '').trim();
      const placeholder = ($field.attr('placeholder') || '').trim();

      fields.push({
        type,
        name,
        id,
        placeholder,
        selectorHint: buildCandidateSelector($field)
      });
    });

    forms.push({
      id: ($form.attr('id') || '').trim(),
      name: ($form.attr('name') || '').trim(),
      action: ($form.attr('action') || '').trim(),
      method: ($form.attr('method') || 'get').toLowerCase(),
      fields
    });
  });

  return forms;
}

function isTransientObservationError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const patterns = [
    'execution context was destroyed',
    'most likely because of a navigation',
    'frame was detached',
    'navigation',
    'target closed',
    'cannot find context with specified id'
  ];
  return patterns.some((pattern) => message.includes(pattern));
}

async function observePage(page, { screenshotDir, step, retries = 3, retryBaseWaitMs = 350 }) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const screenshotPath = path.join(
      screenshotDir,
      `step-${String(step).padStart(2, '0')}-try-${String(attempt).padStart(2, '0')}-${timestampForFilename()}.png`
    );

    try {
      console.log(
        `[Observer][Paso ${step}] Capturando screenshot de observación (intento ${attempt}/${retries}): ${screenshotPath}`
      );
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

      const [url, title, content] = await Promise.all([
        page.url(),
        page.title().catch(() => ''),
        page.content()
      ]);

      const $ = cheerio.load(content || '<html><body></body></html>');

      const state = {
        url,
        title,
        visibleText: getMainVisibleText($),
        forms: getFormSummaries($),
        buttons: collectElements($, 'button, input[type="submit"], input[type="button"]', 40),
        links: collectElements($, 'a', 40),
        fields: collectElements($, 'input, select, textarea', 70),
        screenshotPath
      };

      console.log(
        `[Observer][Paso ${step}] Estado capturado correctamente: url=${url}, botones=${state.buttons.length}, links=${state.links.length}, campos=${state.fields.length}`
      );

      return state;
    } catch (error) {
      lastError = error;
      const retryable = isTransientObservationError(error);
      console.warn(
        `[Observer][Paso ${step}] Fallo de observación en intento ${attempt}/${retries}: ${error.message}`
      );
      if (!retryable || attempt >= retries) {
        break;
      }

      const waitMs = retryBaseWaitMs * attempt;
      console.warn(
        `[Observe retry ${attempt}/${retries}] Estado de página en transición, reintentando en ${waitMs}ms...`
      );
      await sleep(waitMs);
    }
  }

  throw lastError || new Error('No fue posible observar la página');
}

module.exports = {
  observePage
};
