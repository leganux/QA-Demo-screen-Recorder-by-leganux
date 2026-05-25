const fs = require('fs');
const path = require('path');
const { ensureDir, timestampForFilename } = require('./utils');

async function prepareDirectories(outputDir, screenshotDir, sessionDir, logsDir) {
  await ensureDir(outputDir);
  await ensureDir(screenshotDir);
  if (sessionDir) {
    await ensureDir(sessionDir);
  }
  if (logsDir) {
    await ensureDir(logsDir);
  }
}

async function finalizeVideo(rawVideoPath, outputDir, prefix = 'tutorial') {
  if (!rawVideoPath) return '';

  await ensureDir(outputDir);
  const finalName = `${prefix}-${timestampForFilename()}.webm`;
  const finalPath = path.join(outputDir, finalName);

  try {
    await fs.promises.rename(rawVideoPath, finalPath);
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      await fs.promises.copyFile(rawVideoPath, finalPath);
      await fs.promises.unlink(rawVideoPath);
    } else {
      throw error;
    }
  }

  return finalPath;
}

module.exports = {
  prepareDirectories,
  finalizeVideo
};
