import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureLoggerForTests, info } from '../src/logger.js';

test('logger masks token and rotates files at configured size', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-logger-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  configureLoggerForTests({ directory, maxFileBytes: 120, retainedFiles: 3 });
  const originalLog = console.log;
  console.log = () => {};
  t.after(() => { console.log = originalLog; });
  info('token=123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk');
  info('x'.repeat(140));
  info('y'.repeat(140));
  const active = fs.readFileSync(path.join(directory, 'bot.log'), 'utf8');
  const rotated = fs.readFileSync(path.join(directory, 'bot.log.1'), 'utf8');
  assert.match(active, /y{140}/);
  assert.doesNotMatch(rotated, /123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk/);
  assert.match(rotated, /\[REDACTED\]/);
});
