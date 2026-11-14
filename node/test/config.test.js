import test from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../src/config.js';

test('ported defaults match Python config for key settings', () => {
  const expected = {
    REPORT_PORT: 8765, PROTOTYPE_MAX_KB: 200, PROTOTYPE_DIR: 'prototypes', PROTOTYPE_GEMINI_ATTEMPTS: 2,
    KHAMSAT_TIMEOUT_SECONDS: 30, KHAMSAT_REQUEST_GAP_SECONDS: 2.0,
    COMPETITION_LOW_MAX_BIDS: 10, COMPETITION_HIGH_MIN_BIDS: 41,
    SCORING_TITLE_KEYWORD_WEIGHT: 1.0, SCORING_DESCRIPTION_KEYWORD_WEIGHT: 0.5,
    SCORING_BUDGET_SATURATION_USD: 1000.0, INTERVAL_MINUTES: 60,
    RADAR_ENABLED: false, RADAR_INTERVAL_SECONDS: 120, RADAR_MAX_BIDS: 3,
    HIGH_SCORE_THRESHOLD: 6, ESTIMATE_BUFFER: 1.25,
  };
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(config[key], value, key);
  assert.deepEqual(config.PRICE_GROUPS.A, new Set(['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'NZD', 'SAR', 'AED']));
  assert.deepEqual(config.PRICE_GROUPS.B, new Set(['EGP', 'INR']));
});

test('validateConfig reports API key only; Gemini is optional at startup', (t) => {
  const names = ['API_KEY', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'REPORT_API_KEY'];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => { for (const name of names) original[name] === undefined ? delete process.env[name] : process.env[name] = original[name]; });
  for (const name of names) delete process.env[name];
  process.env.TELEGRAM_BOT_TOKEN = 'legacy-telegram-token';
  process.env.TELEGRAM_CHAT_ID = 'legacy-chat-id';
  process.env.REPORT_API_KEY = 'legacy-report-key';
  assert.deepEqual(config.validateConfig(), ['API_KEY']);
});

test('validateConfig reports API_KEY when missing or shorter than 24 characters', (t) => {
  const names = ['API_KEY', 'GEMINI_API_KEY', 'GEMINI_MODEL'];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => { for (const name of names) original[name] === undefined ? delete process.env[name] : process.env[name] = original[name]; });
  process.env.GEMINI_API_KEY = 'gemini-key';
  process.env.GEMINI_MODEL = 'model-name';
  delete process.env.API_KEY;
  assert.deepEqual(config.validateConfig(), ['API_KEY']);
  process.env.API_KEY = 'too-short';
  assert.deepEqual(config.validateConfig(), ['API_KEY']);
  process.env.API_KEY = 'a-valid-api-key-that-is-longer-than-24';
  assert.deepEqual(config.validateConfig(), []);
});
