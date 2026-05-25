const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toBool(value, fallback) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).toLowerCase().trim();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

const config = {
  openAIApiKey: process.env.OPENAI_API_KEY || '',
  openAIBaseUrl: process.env.OPENAI_BASE_URL || '',
  aiModel: process.env.AI_MODEL || 'gpt-4o-mini',
  maxSteps: toInt(process.env.MAX_STEPS, 30),
  outputDir: path.resolve(process.cwd(), process.env.OUTPUT_DIR || './videos'),
  screenshotDir: path.resolve(process.cwd(), process.env.SCREENSHOT_DIR || './screenshots'),
  sessionDir: path.resolve(process.cwd(), process.env.SESSION_DIR || './.session-data'),
  logsDir: path.resolve(process.cwd(), process.env.LOG_DIR || './logs'),
  viewport: {
    width: toInt(process.env.VIEWPORT_WIDTH, 1366),
    height: toInt(process.env.VIEWPORT_HEIGHT, 768)
  },
  maxRepeatedAction: 3,
  aiMaxRetries: 2,
  aiStateTextLimit: toInt(process.env.AI_STATE_TEXT_LIMIT, 3000),
  defaultWaitMs: 1500,
  enableHumanCursor: toBool(process.env.ENABLE_HUMAN_CURSOR, true),
  actionMaxRetries: toInt(process.env.ACTION_MAX_RETRIES, 3),
  observeRetries: toInt(process.env.OBSERVE_RETRIES, 3),
  retryBaseWaitMs: toInt(process.env.RETRY_BASE_WAIT_MS, 350),
  enableBrowserErrorLog: toBool(process.env.ENABLE_BROWSER_ERROR_LOG, true)
};

module.exports = config;
