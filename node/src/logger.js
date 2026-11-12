import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let logDirectory = path.join(ROOT, 'logs');
let maxBytes = 1024 * 1024;
let keepFiles = 3;
const SECRET_PATTERNS = [
  /\b((?:"?(?:TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|GEMINI_API_KEY|REPORT_API_KEY|TOKEN|API_KEY|APIKEY|AUTHORIZATION|X-REPORT-KEY|X-API-KEY)"?)\s*[=:]\s*["']?)[^\s,;"'}]+/gi,
  /\b[0-9]{5,}:[A-Za-z0-9_-]+/g,
  /\b(?:sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+)/g,
];

function mask(value) {
  let output = typeof value === 'string' ? value : JSON.stringify(value);
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (...matches) => {
      const prefix = matches.length > 2 ? matches[1] : '';
      return prefix ? `${prefix}[REDACTED]` : '[REDACTED]';
    });
  }
  return output;
}

function rotate() {
  const current = path.join(logDirectory, 'bot.log');
  if (!fs.existsSync(current) || fs.statSync(current).size < maxBytes) return;
  for (let index = keepFiles - 1; index >= 1; index--) {
    const from = `${current}.${index}`;
    const to = `${current}.${index + 1}`;
    if (fs.existsSync(from)) {
      if (index + 1 > keepFiles) fs.rmSync(from, { force: true });
      else fs.renameSync(from, to);
    }
  }
  if (keepFiles > 0) fs.renameSync(current, `${current}.1`);
  else fs.rmSync(current, { force: true });
}

function write(level, args) {
  fs.mkdirSync(logDirectory, { recursive: true });
  const message = args.map(mask).join(' ');
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}\n`;
  const stream = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  stream(line.trimEnd());
  rotate();
  fs.appendFileSync(path.join(logDirectory, 'bot.log'), line, 'utf8');
}

export const info = (...args) => write('info', args);
export const warn = (...args) => write('warn', args);
export const error = (...args) => write('error', args);

// Test hook for exercising rotation with a small threshold and isolated directory.
export function configureLoggerForTests({ directory, maxFileBytes = maxBytes, retainedFiles = keepFiles }) {
  logDirectory = directory;
  maxBytes = maxFileBytes;
  keepFiles = retainedFiles;
}
