const fs = require('fs');
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

function buildStateForAI({ objective, step, state, lastError, actionHistory, stepsLogPath }) {
  return {
    objective,
    objectiveReminder: objective,
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
    recentActions: actionHistory.slice(-8),
    completedSteps: actionHistory.slice(-20),
    completedStepsLogPath: stepsLogPath || ''
  };
}

async function loadScreenshotAsDataUrl(screenshotPath) {
  if (!screenshotPath) return '';

  try {
    const imageBuffer = await fs.promises.readFile(screenshotPath);
    return `data:image/png;base64,${imageBuffer.toString('base64')}`;
  } catch (error) {
    console.warn(`[Agent] No se pudo adjuntar screenshot para visión: ${error.message}`);
    return '';
  }
}

async function persistStepsLog({ logPath, objective, actionHistory, status = 'running', currentStep = 0, lastError = '' }) {
  const content = {
    objective,
    status,
    currentStep,
    updatedAt: new Date().toISOString(),
    lastError,
    steps: actionHistory
  };

  await fs.promises
    .writeFile(logPath, `${JSON.stringify(content, null, 2)}\n`, 'utf8')
    .catch((error) => {
      console.warn(`[Agent] No se pudo persistir log JSON de pasos: ${error.message}`);
    });
}

function buildUserPromptText(payload) {
  const pageSummary = {
    url: payload.page?.url || '',
    title: payload.page?.title || '',
    visibleText: payload.page?.visibleText || '',
    forms: payload.page?.forms || [],
    buttons: payload.page?.buttons || [],
    links: payload.page?.links || [],
    fields: payload.page?.fields || [],
    screenshotPath: payload.page?.screenshotPath || ''
  };

  return [
    `Objetivo general: ${payload.objective || ''}`,
    `Paso actual: ${payload.step}/${payload.maxSteps}`,
    `Último error: ${payload.lastError || 'ninguno'}`,
    `Ruta del log JSON de pasos: ${payload.completedStepsLogPath || 'n/a'}`,
    'Pasos ya ejecutados (JSON):',
    JSON.stringify(payload.completedSteps || [], null, 2),
    'Estado actual de la página (JSON):',
    JSON.stringify(pageSummary, null, 2),
    'Con base en el objetivo general, los pasos ya ejecutados y el estado actual, devuelve SOLO la siguiente acción en JSON estricto.'
  ].join('\n');
}

async function askAIForNextAction(client, payload, { screenshotDataUrl = '' } = {}) {
  const systemInstruction = [
    'Eres un agente de automatización de navegador.',
    'Debes elegir SOLO la siguiente acción para avanzar el objetivo general.',
    'Antes de responder, considera explícitamente los pasos ya ejecutados para no perder contexto.',
    'Si hay screenshot adjunta, úsala para inferir mejor qué botón/campo corresponde, no dependas solo de selector textual.',
    'Responde únicamente JSON válido, sin markdown ni texto extra.',
    'Formato exacto:',
    '{"thought":"...","action":"click|type|select|check|uncheck|scroll|wait|goto|finish|fail|upload","selector":"...","value":"...","reason":"..."}',
    'Si no puedes avanzar, usa action="fail" y explica en reason.',
    'Si el objetivo ya se cumplió, usa action="finish".'
  ].join(' ');
  console.log(
    `[Agent][Paso ${payload.step}] Consultando a la IA para siguiente acción (url=${payload.page?.url || 'n/a'})...`
  );

  const userPromptText = buildUserPromptText(payload);
  let includeImage = Boolean(screenshotDataUrl);

  for (let attempt = 1; attempt <= config.aiMaxRetries + 1; attempt += 1) {
    try {
      console.log(`[Agent][Paso ${payload.step}] Intento IA ${attempt}/${config.aiMaxRetries + 1}`);

      const userContent = [{ type: 'text', text: userPromptText }];
      if (includeImage) {
        userContent.push({
          type: 'image_url',
          image_url: { url: screenshotDataUrl }
        });
      }

      const completion = await client.chat.completions.create({
        model: config.aiModel,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userContent }
        ]
      });

      const raw = completion.choices?.[0]?.message?.content || '';
      const parsed = extractJsonObject(raw);

      if (!parsed) {
        throw new Error('No se pudo parsear JSON de la IA');
      }

      const normalized = normalizeAction(parsed);
      console.log(
        `[Agent][Paso ${payload.step}] IA respondió acción=${normalized.action}, selector=${normalized.selector || 'n/a'}, value=${normalized.value ? '[con valor]' : 'n/a'}`
      );
      return normalized;
    } catch (error) {
      const errorMessage = String(error?.message || error || 'Error desconocido');

      if (includeImage && /image|vision|multimodal|content/i.test(errorMessage)) {
        includeImage = false;
        console.warn(
          `[Agent][Paso ${payload.step}] La llamada multimodal falló, reintentando sin imagen: ${errorMessage}`
        );
        continue;
      }

      console.warn(`[Agent][Paso ${payload.step}] Falló intento IA ${attempt}: ${error.message}`);
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
  console.log(`[Agent][Paso ${step}] Screenshot de error generado: ${errorShotPath}`);
  return errorShotPath;
}

async function runAgent({
  page,
  prompt,
  screenshotDir,
  maxSteps = config.maxSteps,
  enableHumanCursor = config.enableHumanCursor
}) {
  console.log(
    `[Agent] Iniciando ejecución -> maxSteps=${maxSteps}, humanCursor=${enableHumanCursor}, screenshotDir=${screenshotDir}`
  );
  const client = createOpenAIClient();
  await setupDialogHandler(page);
  console.log('[Agent] Handler de diálogos activo.');

  const repeatedActionCounter = new Map();
  const actionHistory = [];
  let lastError = '';
  const stepsLogPath = path.join(config.logsDir, `agent-steps-${timestampForFilename()}.json`);

  console.log(`[Agent] Log JSON de pasos: ${stepsLogPath}`);
  await persistStepsLog({
    logPath: stepsLogPath,
    objective: prompt,
    actionHistory,
    status: 'running',
    currentStep: 0,
    lastError
  });

  for (let step = 1; step <= maxSteps; step += 1) {
    console.log(`[Agent][Paso ${step}] Observando pantalla...`);
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
      console.error(`[Agent][Paso ${step}] ${lastError}`);

      actionHistory.push({
        step,
        timestamp: new Date().toISOString(),
        status: 'observe_error',
        error: truncate(error.message, 300),
        screenshotPath
      });
      await persistStepsLog({
        logPath: stepsLogPath,
        objective: prompt,
        actionHistory,
        status: 'running',
        currentStep: step,
        lastError
      });
      continue;
    }

    console.log(
      `[Agent][Paso ${step}] Estado observado -> url=${state.url}, screenshot=${state.screenshotPath}, botones=${state.buttons.length}, links=${state.links.length}, campos=${state.fields.length}`
    );

    const payload = buildStateForAI({
      objective: prompt,
      step,
      state,
      lastError,
      actionHistory,
      stepsLogPath
    });

    const screenshotDataUrl = await loadScreenshotAsDataUrl(state.screenshotPath);
    if (screenshotDataUrl) {
      console.log(`[Agent][Paso ${step}] Screenshot adjuntada a la petición multimodal del LLM.`);
    }

    let nextAction;
    try {
      nextAction = await askAIForNextAction(client, payload, { screenshotDataUrl });
    } catch (error) {
      const screenshotPath = await takeErrorScreenshot(page, screenshotDir, step);
      lastError = `Error obteniendo acción de IA: ${error.message}. Screenshot: ${screenshotPath}`;
      console.error(`[Agent][Paso ${step}] ${lastError}`);

      actionHistory.push({
        step,
        timestamp: new Date().toISOString(),
        status: 'ai_error',
        url: state.url,
        screenshotPath,
        error: truncate(error.message, 300)
      });
      await persistStepsLog({
        logPath: stepsLogPath,
        objective: prompt,
        actionHistory,
        status: 'running',
        currentStep: step,
        lastError
      });
      continue;
    }

    if (!nextAction || !nextAction.action) {
      const screenshotPath = await takeErrorScreenshot(page, screenshotDir, step);
      lastError = `La IA devolvió una acción vacía o inválida. Screenshot: ${screenshotPath}`;
      console.error(`[Agent][Paso ${step}] ${lastError}`);

      actionHistory.push({
        step,
        timestamp: new Date().toISOString(),
        status: 'invalid_action',
        url: state.url,
        screenshotPath
      });
      await persistStepsLog({
        logPath: stepsLogPath,
        objective: prompt,
        actionHistory,
        status: 'running',
        currentStep: step,
        lastError
      });
      continue;
    }
    const actionLabel = nextAction.selector
      ? ` en "${nextAction.selector}"`
      : nextAction.value
        ? ` con valor "${nextAction.value}"`
        : '';

    console.log(`[Agent][Paso ${step}] Acción ${nextAction.action}${actionLabel}`);

    const signature = actionSignature(nextAction);
    const repeatedCount = (repeatedActionCounter.get(signature) || 0) + 1;
    repeatedActionCounter.set(signature, repeatedCount);

    if (repeatedCount > config.maxRepeatedAction) {
      console.warn(
        `[Agent][Paso ${step}] Acción repetida detectada ${repeatedCount} veces para firma: ${signature}`
      );

      actionHistory.push({
        step,
        timestamp: new Date().toISOString(),
        status: 'blocked_repeated_action',
        url: state.url,
        action: nextAction.action,
        selector: nextAction.selector,
        value: truncate(nextAction.value, 120),
        reason: 'Acción repetida por encima del umbral'
      });
      await persistStepsLog({
        logPath: stepsLogPath,
        objective: prompt,
        actionHistory,
        status: 'failed',
        currentStep: step,
        lastError
      });

      return {
        ok: false,
        reason: `La IA repitió demasiadas veces la misma acción: ${signature}`,
        steps: step,
        lastState: state,
        stepsLogPath
      };
    }

    if (nextAction.action === ACTIONS.FINISH) {
      console.log(`[Agent][Paso ${step}] IA indicó finish. Motivo: ${nextAction.reason || 'sin detalle'}`);

      actionHistory.push({
        step,
        timestamp: new Date().toISOString(),
        status: 'finish',
        url: state.url,
        action: nextAction.action,
        selector: nextAction.selector,
        value: truncate(nextAction.value, 120),
        thought: truncate(nextAction.thought, 160),
        reason: truncate(nextAction.reason, 220),
        screenshotPath: state.screenshotPath
      });
      await persistStepsLog({
        logPath: stepsLogPath,
        objective: prompt,
        actionHistory,
        status: 'completed',
        currentStep: step,
        lastError
      });

      return {
        ok: true,
        reason: nextAction.reason || 'La IA reportó objetivo cumplido.',
        steps: step,
        lastState: state,
        stepsLogPath
      };
    }

    if (nextAction.action === ACTIONS.FAIL) {
      console.warn(`[Agent][Paso ${step}] IA indicó fail. Motivo: ${nextAction.reason || 'sin detalle'}`);

      actionHistory.push({
        step,
        timestamp: new Date().toISOString(),
        status: 'fail',
        url: state.url,
        action: nextAction.action,
        selector: nextAction.selector,
        value: truncate(nextAction.value, 120),
        thought: truncate(nextAction.thought, 160),
        reason: truncate(nextAction.reason, 220),
        screenshotPath: state.screenshotPath
      });
      await persistStepsLog({
        logPath: stepsLogPath,
        objective: prompt,
        actionHistory,
        status: 'failed',
        currentStep: step,
        lastError
      });

      return {
        ok: false,
        reason: nextAction.reason || 'La IA indicó que no puede continuar.',
        steps: step,
        lastState: state,
        stepsLogPath
      };
    }

    if (actionRequiresSelector(nextAction.action) && !nextAction.selector) {
      const screenshotPath = await takeErrorScreenshot(page, screenshotDir, step);
      lastError = `Acción ${nextAction.action} sin selector. Se omite para continuar. Screenshot: ${screenshotPath}`;
      console.warn(`[Agent][Paso ${step}] ${lastError}`);

      actionHistory.push({
        step,
        timestamp: new Date().toISOString(),
        status: 'skipped_missing_selector',
        url: state.url,
        action: nextAction.action,
        reason: truncate(nextAction.reason, 220),
        screenshotPath
      });
      await persistStepsLog({
        logPath: stepsLogPath,
        objective: prompt,
        actionHistory,
        status: 'running',
        currentStep: step,
        lastError
      });
      continue;
    }

    if (actionRequiresValue(nextAction.action) && !String(nextAction.value || '').trim()) {
      const screenshotPath = await takeErrorScreenshot(page, screenshotDir, step);
      lastError = `Acción ${nextAction.action} sin value. Se omite para continuar. Screenshot: ${screenshotPath}`;
      console.warn(`[Agent][Paso ${step}] ${lastError}`);

      actionHistory.push({
        step,
        timestamp: new Date().toISOString(),
        status: 'skipped_missing_value',
        url: state.url,
        action: nextAction.action,
        selector: nextAction.selector,
        reason: truncate(nextAction.reason, 220),
        screenshotPath
      });
      await persistStepsLog({
        logPath: stepsLogPath,
        objective: prompt,
        actionHistory,
        status: 'running',
        currentStep: step,
        lastError
      });
      continue;
    }

    try {
      console.log(`[Agent][Paso ${step}] Ejecutando acción ${nextAction.action}...`);
      await executeAction(page, nextAction, {
        defaultWaitMs: config.defaultWaitMs,
        enableHumanCursor,
        maxRetries: config.actionMaxRetries,
        retryBaseWaitMs: config.retryBaseWaitMs
      });

      console.log(`[Agent][Paso ${step}] Acción ${nextAction.action} ejecutada correctamente.`);
      actionHistory.push({
        step,
        timestamp: new Date().toISOString(),
        status: 'executed',
        url: state.url,
        action: nextAction.action,
        selector: nextAction.selector,
        value: truncate(nextAction.value, 120),
        thought: truncate(nextAction.thought, 160),
        reason: truncate(nextAction.reason, 220),
        screenshotPath: state.screenshotPath
      });
      lastError = '';
      await persistStepsLog({
        logPath: stepsLogPath,
        objective: prompt,
        actionHistory,
        status: 'running',
        currentStep: step,
        lastError
      });
    } catch (error) {
      const screenshotPath = await takeErrorScreenshot(page, screenshotDir, step);
      lastError = `Error ejecutando ${nextAction.action} (${nextAction.selector}): ${error.message}. Screenshot: ${screenshotPath}`;
      console.error(`[Agent][Paso ${step}] ${lastError}`);

      actionHistory.push({
        step,
        timestamp: new Date().toISOString(),
        status: 'execution_error',
        url: state.url,
        action: nextAction.action,
        selector: nextAction.selector,
        value: truncate(nextAction.value, 120),
        reason: truncate(nextAction.reason, 220),
        error: truncate(error.message, 300),
        screenshotPath
      });
      await persistStepsLog({
        logPath: stepsLogPath,
        objective: prompt,
        actionHistory,
        status: 'running',
        currentStep: step,
        lastError
      });
      await handleTransientUi(page);
    }
  }

  console.warn(`[Agent] Se alcanzó el máximo de pasos (${maxSteps}) sin completar objetivo.`);

  await persistStepsLog({
    logPath: stepsLogPath,
    objective: prompt,
    actionHistory,
    status: 'max_steps',
    currentStep: maxSteps,
    lastError
  });

  return {
    ok: false,
    reason: `Se alcanzó el máximo de pasos (${maxSteps}).`,
    steps: maxSteps,
    lastState: null,
    stepsLogPath
  };
}

module.exports = {
  runAgent
};
