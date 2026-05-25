const fs = require('fs');
const path = require('path');
const { ensureDir, timestampForFilename } = require('./utils');

async function prepareDirectories(outputDir, screenshotDir, sessionDir, logsDir) {
  console.log(`[Recorder] Asegurando directorio de video: ${outputDir}`);
  await ensureDir(outputDir);
  console.log(`[Recorder] Asegurando directorio de screenshots: ${screenshotDir}`);
  await ensureDir(screenshotDir);
  if (sessionDir) {
    console.log(`[Recorder] Asegurando directorio de sesión: ${sessionDir}`);
    await ensureDir(sessionDir);
  }
  if (logsDir) {
    console.log(`[Recorder] Asegurando directorio de logs: ${logsDir}`);
    await ensureDir(logsDir);
  }
}

async function finalizeVideo(rawVideoPath, outputDir, prefix = 'tutorial') {
  if (!rawVideoPath) {
    console.warn('[Recorder] No hay ruta de video temporal para finalizar.');
    return '';
  }

  console.log(`[Recorder] Preparando video final desde temporal: ${rawVideoPath}`);
  await ensureDir(outputDir);
  const finalName = `${prefix}-${timestampForFilename()}.webm`;
  const finalPath = path.join(outputDir, finalName);
  console.log(`[Recorder] Ruta objetivo de video final: ${finalPath}`);

  try {
    await fs.promises.rename(rawVideoPath, finalPath);
    console.log('[Recorder] Video movido con rename().');
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      console.warn('[Recorder] rename() no disponible entre volúmenes, usando copy+unlink...');
      await fs.promises.copyFile(rawVideoPath, finalPath);
      await fs.promises.unlink(rawVideoPath);
      console.log('[Recorder] Video copiado y archivo temporal eliminado.');
    } else {
      throw error;
    }
  }

  console.log(`[Recorder] Video final listo: ${finalPath}`);

  return finalPath;
}

module.exports = {
  prepareDirectories,
  finalizeVideo
};
