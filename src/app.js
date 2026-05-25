const readline = require('readline');
const config = require('./config');
const { parseCliArgs } = require('./utils');
const { startBrowserSession, closeBrowserSession } = require('./browser');
const { prepareDirectories, finalizeVideo } = require('./recorder');
const { runAgent } = require('./agent');

function printUsage() {
  console.log('Uso:');
  console.log('node src/app.js --url="https://mi-sistema.com" --prompt="Registra una persona demo"');
  console.log('npm run start -- --url="https://mi-sistema.com" --prompt="Crea un evento demo"');
  console.log('Si no envías --url o --prompt, el programa te los pedirá en consola.');
  console.log('Opcional: --clear-cache=true para borrar sesión/caché guardada antes de iniciar');
  console.log('Opcional: --human-cursor=true|false para mostrar/ocultar movimiento de cursor humano');
  console.log('Opcional: --browser-error-log=true|false para activar/desactivar log de errores navegador');
}

function validateCli({ url, prompt }) {
  if (!url || !String(url).trim()) {
    printUsage();
    throw new Error('La URL es requerida');
  }

  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    throw new Error(`URL inválida: ${url}`);
  }

  if (!prompt || !String(prompt).trim()) {
    printUsage();
    throw new Error('El prompt es requerido');
  }
}

function askQuestion(rl, text) {
  return new Promise((resolve) => {
    rl.question(text, (answer) => resolve(String(answer || '').trim()));
  });
}

async function askMissingInputs({ url, prompt }) {
  let finalUrl = String(url || '').trim();
  let finalPrompt = String(prompt || '').trim();

  if (finalUrl && finalPrompt) {
    return { url: finalUrl, prompt: finalPrompt };
  }

  if (!process.stdin.isTTY) {
    printUsage();
    throw new Error('Faltan --url o --prompt y no hay terminal interactiva para preguntarlos');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    while (!finalUrl) {
      const value = await askQuestion(rl, 'Ingresa la URL inicial: ');
      if (!value) {
        console.log('La URL no puede estar vacía.');
        continue;
      }

      try {
        // eslint-disable-next-line no-new
        new URL(value);
        finalUrl = value;
      } catch {
        console.log(`URL inválida: ${value}`);
      }
    }

    while (!finalPrompt) {
      const value = await askQuestion(rl, 'Ingresa el prompt de la tarea: ');
      if (!value) {
        console.log('El prompt no puede estar vacío.');
        continue;
      }
      finalPrompt = value;
    }
  } finally {
    rl.close();
  }

  return { url: finalUrl, prompt: finalPrompt };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  let url = args.url;
  let prompt = args.prompt;
  const clearCache =
    args['clear-cache'] === true ||
    String(args['clear-cache'] || '').toLowerCase() === 'true' ||
    args.clearCache === true ||
    String(args.clearCache || '').toLowerCase() === 'true';
  const humanCursor =
    args['human-cursor'] == null && args.humanCursor == null
      ? config.enableHumanCursor
      : args['human-cursor'] === true ||
          String(args['human-cursor'] || '').toLowerCase() === 'true' ||
          args.humanCursor === true ||
          String(args.humanCursor || '').toLowerCase() === 'true';
  const browserErrorLog =
    args['browser-error-log'] == null && args.browserErrorLog == null
      ? config.enableBrowserErrorLog
      : args['browser-error-log'] === true ||
          String(args['browser-error-log'] || '').toLowerCase() === 'true' ||
          args.browserErrorLog === true ||
          String(args.browserErrorLog || '').toLowerCase() === 'true';

  const askedInputs = await askMissingInputs({ url, prompt });
  url = askedInputs.url;
  prompt = askedInputs.prompt;

  validateCli({ url, prompt });

  await prepareDirectories(config.outputDir, config.screenshotDir, config.sessionDir, config.logsDir);

  let session;
  let pageVideo;
  let rawVideoPath = '';

  try {
    session = await startBrowserSession({
      url,
      viewport: config.viewport,
      outputDir: config.outputDir,
      sessionDir: config.sessionDir,
      clearCache,
      logsDir: config.logsDir,
      enableBrowserErrorLog: browserErrorLog
    });

    const { page } = session;
    pageVideo = page.video();

    console.log('Grabando video...');
    const result = await runAgent({
      page,
      prompt,
      screenshotDir: config.screenshotDir,
      maxSteps: config.maxSteps,
      enableHumanCursor: humanCursor
    });

    if (result.ok) {
      console.log('Tarea completada.');
    } else {
      console.log(`Tarea finalizada con advertencias: ${result.reason}`);
    }
  } catch (error) {
    console.error(`Error general: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (session) {
      await closeBrowserSession(session);
    }

    if (pageVideo) {
      rawVideoPath = await pageVideo.path().catch(() => '');
    }

    try {
      const finalVideoPath = await finalizeVideo(rawVideoPath, config.outputDir, 'tutorial');
      if (finalVideoPath) {
        console.log(`Video generado en: ${finalVideoPath}`);
      }
    } catch (error) {
      console.error(`No fue posible mover el video final: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

main();
