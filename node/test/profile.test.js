import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { normalizeProfile, profileSearchTerms } from '../src/profile.js';
import { matchesJob } from '../src/filters.js';
import { computePricing } from '../src/ai/estimate.js';

const apiKey = 'profile-api-test-key-with-at-least-24-chars';

test('profile contract accepts diverse freelancer work and enforces limits', () => {
  const profile = normalizeProfile({ field: 'translation', skills: ['Arabic-English translation'], services: ['Proofreading'], years_experience: 6, portfolio: [{ title: 'Sample translation' }] });
  const terms = profileSearchTerms(profile);
  assert.equal(matchesJob({ title: 'Arabic-English translation needed', description: 'Proofreading a report' }, terms), true);
  assert.equal(matchesJob({ title: 'Logo design', description: '' }, terms), false);
  assert.throws(() => normalizeProfile({ bio: 'x'.repeat(4001) }), /4000 characters/);
  assert.throws(() => normalizeProfile({ hourly_rate: 20 }), /currency/);
  assert.throws(() => normalizeProfile({ profile_text: 'text', field: 'translation' }), /cannot be combined/);
});

test('profile API stores and returns the authenticated user profile without a repo file', async (t) => {
  const db = openDb(':memory:');
  const api = createServer({ db, sources: [{ name: 'freelancer' }, { name: 'mostaql' }, { name: 'khamsat' }],
    config: { API_KEY: apiKey, API_HOST: '127.0.0.1', CORS_ORIGINS: [], SAAS_ENABLED: false },
    logger: { info() {}, warn() {}, error() {} } });
  const address = await api.listen(0, '127.0.0.1');
  t.after(async () => { await api.close(); closeDb(db); });
  const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };
  const base = `http://127.0.0.1:${address.port}`;
  let response = await fetch(`${base}/profile`, { headers });
  assert.deepEqual(await response.json(), { exists: false });
  response = await fetch(`${base}/profile`, { method: 'PUT', headers, body: JSON.stringify({ profile_text: 'Freelance translator specializing in Arabic and English.' }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).profile, { profile_text: 'Freelance translator specializing in Arabic and English.' });
  response = await fetch(`${base}/profile`, { method: 'PUT', headers, body: JSON.stringify({ bio: 'x'.repeat(4001) }) });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: { code: 'INVALID_PROFILE', message: 'bio must be at most 4000 characters' } });

  db.prepare("INSERT INTO source_scan_state(source,enabled,last_scan_at,last_count,last_error_code,last_error_message) VALUES('mostaql',1,'2026-01-02T03:04:05Z',0,'HTTP_403','HTTP 403')").run();
  response = await fetch(`${base}/sources/status`, { headers });
  const status = await response.json();
  assert.deepEqual(status.sources.map(({ source }) => source), ['freelancer', 'mostaql', 'khamsat']);
  assert.deepEqual(status.sources[1], { source: 'mostaql', enabled: true, last_scan_at: '2026-01-02T03:04:05Z', last_count: 0, last_error: { code: 'HTTP_403', message: 'HTTP 403' } });
});

test('estimate pricing does not invent an hourly price when profile rate is absent', () => {
  const pricing = computePricing({ total_hours: 4 }, { title: 'Translation work', description: '', budget: '' }, {}, {}, null);
  assert.equal(pricing.price_usd, null);
  assert.equal(pricing.floor_usd, null);
});
