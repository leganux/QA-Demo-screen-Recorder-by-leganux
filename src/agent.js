const path = require('path');
const OpenAI = require('openai');
const config = require('./config');
const { observePage } = require('./observer');
const { ACTIONS, executeAction, setupDialogHandler, handleTransientUi } = require('./actions');
const { actionSignature, extractJsonObject, truncate, timestampForFilename } = require('./utils');

const ALLOWED_ACTIONS = new Set(Object.values(ACTIONS));

function actionRequiresSelector(actionName) {
  return [ACTIONS.CLICK, ACTIONS.TYPE, ACTIONS.SELECT, ACTIONS.CHECK, ACTIONS.UNCHECK, ACTIONS.UPLOAD].includes(
    actionName
  );
}

function actionRequiresValue(actionName) {
  return [ACTIONS.SELECT, ACTIONS.UPLOAD].includes(actionName);
}

function createOpenAIClient() {
  if (!config.openAIApiKey) {
    throw new Error('Falta OPENAI_API_KEY en variables de entorno');
  }

  const options = {
    apiKey: config.openAIApiKey
  };

  if (config.openAIBaseUrl) {
    options.baseURL = config.openAIBaseUrl;
  }

  return new OpenAI(options);
}

function normalizeAction(rawAction) {
  const mapped = {
    thought: String(rawAction?.thought || '').trim(),
    action: String(rawAction?.action || '').toLowerCase().trim(),
    selector: String(rawAction?.selector || '').trim(),
    value: rawAction?.value == null ? '' : String(rawAction.value),
    reason: String(rawAction?.reason || '').trim()
  };

  const aliases = {
    write: ACTIONS.TYPE,
    fill: ACTIONS.TYPE,
    input: ACTIONS.TYPE,
    navigate: ACTIONS.GOTO,
    done: ACTIONS.FINISH,
    complete: ACTIONS.FINISH,
    error: ACTIONS.FAIL
  };

  if (aliases[mapped.action]) {
    mapped.action = aliases[mapped.action];
  }

  if (!ALLOWED_ACTIONS.has(mapped.action)) {
    throw new Error(`Acción no permitida por el agente: ${mapped.action}`);
  }

  return mapped;
}

function buildStateForAI({ objective, step, state, lastError, actionHistory }) {
  return {
    objective,
    step,
    maxSteps: config.maxSteps,
    page: {
      url: state.url,
      title: state.title,
      visibleText: truncate(state.visibleText, config.aiStateTextLimit),
      forms: state.forms.slice(0, 8),
      buttons: state.buttons.slice(0, 30),
      links: state.links.slice(0, 30),
      fields: state.fields.slice(0, 40),
      screenshotPath: state.screenshotPath
    },
    lastError: lastError || '',
    recentActions: actionHistory.slice(-5)
  };
}

async function askAIForNextAction(client, payload) {
  const systemInstruction = [
    'Eres un agente de automatización de navegador.',
    'Debes elegir SOLO la siguiente acción para avanzar el objetivo.',
    'Responde únicamente JSON válido, sin markdown ni texto extra.',
    'Formato exacto:',
    '{"thought":"...","action":"click|type|select|check|uncheck|scroll|wait|goto|finish|fail|upload","selector":"...","value":"...","reason":"..."}',
    'Si no puedes avanzar, usa action="fail" y explica en reason.',
    'Si el objetivo ya se cumplió, usa action="finish".'
  ].join(' ');
  console.log('Consultando a la IA para la siguiente acción...', payload);

  for (let attempt = 1; attempt <= config.aiMaxRetries + 1; attempt += 1) {
    try {
      const completion = await client.chat.completions.create({
        model: config.aiModel,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: JSON.stringify(payload) }
        ]
      });

      const raw = completion.choices?.[0]?.message?.content || '';
      const parsed = extractJsonObject(raw);

      if (!parsed) {
        throw new Error('No se pudo parsear JSON de la IA');
      }

      return normalizeAction(parsed);
    } catch (error) {
      if (attempt > config.aiMaxRetries) {
        throw error;
      }
    }
  }

  throw new Error('La IA no devolvió una respuesta válida');
}

async function takeErrorScreenshot(page, screenshotDir, step) {
  const errorShotPath = path.join(
    screenshotDir,
    `step-${String(step).padStart(2, '0')}-error-${timestampForFilename()}.png`
  );
  await page.screenshot({ path: errorShotPath, fullPage: true }).catch(() => { });
  return errorShotPath;
}

async function runAgent({
  page,
  prompt,
  screenshotDir,
  maxSteps = config.maxSteps,
  enableHumanCursor = config.enableHumanCursor
}) {
  const client = createOpenAIClient();
  await setupDialogHandler(page);

  const repeatedActionCounter = new Map();
  const actionHistory = [];
  let lastError = '';

  for (let step = 1; step <= maxSteps; step += 1) {
    console.log(`Paso ${step}: observando pantalla...`);
    await handleTransientUi(page);

    let state;
    try {
      state = await observePage(page, {
        screenshotDir,
        step,
        retries: config.observeRetries,
        retryBaseWaitMs: config.retryBaseWaitMs
      });
    } catch (error) {
      const screenshotPath = await takeErrorScreenshot(page, screenshotDir, step);
      lastError = `Error observando página (contenido en cambio): ${error.message}. Screenshot: ${screenshotPath}`;
      console.error(lastError);
      continue;
    }

    const payload = buildStateForAI({
      objective: prompt,
      step,
      state,
      lastError,
      actionHistory
    });

    let nextAction;
    try {
      nextAction = await askAIForNextAction(client, payload);
    } catch (error) {
      const screenshotPath = await takeErrorScreenshot(page, screenshotDir, step);
      lastError = `Error obteniendo acción de IA: ${error.message}. Screenshot: ${screenshotPath}`;
      console.error(lastError);
      continue;
    }

    if (!nextAction || !nextAction.action) {
      const screenshotPath = await takeErrorScreenshot(page, screenshotDir, step);
      lastError = `La IA devolvió una acción vacía o inválida. Screenshot: ${screenshotPath}`;
      console.error(lastError);
      continue;
    }
    const actionLabel = nextAction.selector
      ? ` en "${nextAction.selector}"`
      : nextAction.value
        ? ` con valor "${nextAction.value}"`
        : '';

    console.log(`Paso ${step}: acción ${nextAction.action}${actionLabel}`);

    const signature = actionSignature(nextAction);
    const repeatedCount = (repeatedActionCounter.get(signature) || 0) + 1;
    repeatedActionCounter.set(signature, repeatedCount);

    if (repeatedCount > config.maxRepeatedAction) {
      return {
        ok: false,
        reason: `La IA repitió demasiadas veces la misma acción: ${signature}`,
        steps: step,
        lastState: state
      };
    }

    actionHistory.push({
      step,
      url: state.url,
      action: nextAction.action,
      selector: nextAction.selector,
      value: truncate(nextAction.value, 120),
      thought: truncate(nextAction.thought, 160),
      reason: truncate(nextAction.reason, 220)
    });

    if (nextAction.action === ACTIONS.FINISH) {
      return {
        ok: true,
        reason: nextAction.reason || 'La IA reportó objetivo cumplido.',
        steps: step,
        lastState: state
      };
    }

    if (nextAction.action === ACTIONS.FAIL) {
      return {
        ok: false,
        reason: nextAction.reason || 'La IA indicó que no puede continuar.',
        steps: step,
        lastState: state
      };
    }

    if (actionRequiresSelector(nextAction.action) && !nextAction.selector) {
      const screenshotPath = await takeErrorScreenshot(page, screenshotDir, step);
      lastError = `Acción ${nextAction.action} sin selector. Se omite para continuar. Screenshot: ${screenshotPath}`;
      console.warn(lastError);
      continue;
    }

    if (actionRequiresValue(nextAction.action) && !String(nextAction.value || '').trim()) {
      const screenshotPath = await takeErrorScreenshot(page, screenshotDir, step);
      lastError = `Acción ${nextAction.action} sin value. Se omite para continuar. Screenshot: ${screenshotPath}`;
      console.warn(lastError);
      continue;
    }

    try {
      await executeAction(page, nextAction, {
        defaultWaitMs: config.defaultWaitMs,
        enableHumanCursor,
        maxRetries: config.actionMaxRetries,
        retryBaseWaitMs: config.retryBaseWaitMs
      });

      lastError = '';
    } catch (error) {
      const screenshotPath = await takeErrorScreenshot(page, screenshotDir, step);
      lastError = `Error ejecutando ${nextAction.action} (${nextAction.selector}): ${error.message}. Screenshot: ${screenshotPath}`;
      console.error(lastError);
      await handleTransientUi(page);
    }
  }

  return {
    ok: false,
    reason: `Se alcanzó el máximo de pasos (${maxSteps}).`,
    steps: maxSteps,
    lastState: null
  };
}

module.exports = {
  runAgent
};
