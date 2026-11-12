import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { closeDb, openDb } from '../src/db.js';
import { buildPrototype, sanitizeContent } from '../src/prototype.js';

const apiKey = 'prototype-test-api-key-at-least-24-chars';

function seedJob(db, { userId = 1, proposal = null, estimate = null } = {}) {
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO jobs(source,external_id,title,description,url,budget,created_at,currency,posted_at)
    VALUES('freelancer','prototype-test','Sample job','Build a useful application','https://example.test/job','100 USD',?,'USD',?)`);
  insert.run(now, now);
  const jobId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  if (userId !== 1) db.prepare("INSERT INTO users(id,email,name,role,status,created_at) VALUES(?,NULL,'Test user','user','active',?)").run(userId, now);
  db.prepare(`INSERT INTO user_jobs(user_id,job_id,status,score,proposal,estimate,created_at,updated_at)
    VALUES(?,?,'sent',8.5,?,?,?,?)
    ON CONFLICT(user_id,job_id) DO UPDATE SET status=excluded.status,score=excluded.score,
      proposal=excluded.proposal,estimate=excluded.estimate,created_at=excluded.created_at,updated_at=excluded.updated_at`)
    .run(userId, jobId, proposal, estimate, now, now);
  return jobId;
}

async function apiFor(t, db, { userId = 1, role = 'owner', planId = 'owner' } = {}) {
  const api = createServer({
    db,
    sources: [{ name: 'freelancer' }],
    config: { API_KEY: apiKey, API_HOST: '127.0.0.1', CORS_ORIGINS: [], SAAS_ENABLED: true },
    authProviders: [(request) => request.headers['x-api-key'] === apiKey ? { userId, role, planId } : null],
    logger: { info() {}, warn() {}, error() {} },
  });
  const address = await api.listen(0, '127.0.0.1');
  t.after(async () => { await api.close(); });
  const base = `http://127.0.0.1:${address.port}`;
  return {
    request: (route, method = 'GET', body) => fetch(`${base}${route}`, {
      method,
      headers: { 'X-API-Key': apiKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  };
}

function database(t) {
  const db = openDb(':memory:');
  t.after(() => closeDb(db));
  return db;
}

test('buildPrototype returns complete HTML containing the job title', () => {
  const html = buildPrototype({ title: 'A sample title', source: 'freelancer', posted_at: '2026-11-12', description: 'Description' }, 'Proposal');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /A sample title/);
});

test('modern theme uses the dark background color', () => {
  assert.match(buildPrototype({}, '', { theme: 'modern' }), /#1a1a2e/);
});

test('minimal theme uses a monospace font', () => {
  assert.match(buildPrototype({}, '', { theme: 'minimal' }), /monospace/);
});

test('sanitizeContent strips HTML tags', () => {
  assert.equal(sanitizeContent('<b>Hello</b>'), 'Hello');
});

test('sanitizeContent trims whitespace', () => {
  assert.equal(sanitizeContent('  Hello  '), 'Hello');
});

test('price section displays the estimated price when requested', () => {
  assert.match(buildPrototype({ estimated_price: 120, currency: 'USD' }, '', { include_price: true }), /120 USD/);
});

test('price section is omitted when include_price is false', () => {
  const html = buildPrototype({ estimated_price: 120, currency: 'USD' }, '', { include_price: false });
  assert.doesNotMatch(html, /التسعير/);
});

test('prototype sanitizes job and proposal content before embedding it in HTML', () => {
  const html = buildPrototype({ title: '<script>alert(1)</script>', description: '<img src=x onerror=alert(1)>' }, '<b>proposal</b>');
  assert.doesNotMatch(html, /<script>|<img|<b>/i);
  assert.match(html, /alert\(1\)/);
});

test('POST prototype returns 400 when the authenticated user has no proposal', async (t) => {
  const db = database(t), id = seedJob(db), api = await apiFor(t, db);
  const response = await api.request(`/jobs/${id}/prototype`, 'POST', {});
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'no_proposal', message: 'لا يوجد عرض مكتوب لهذه الوظيفة' });
});

test('POST prototype returns 403 when the user plan lacks the feature', async (t) => {
  const db = database(t), id = seedJob(db, { userId: 2, proposal: 'A proposal' });
  const api = await apiFor(t, db, { userId: 2, role: 'user', planId: 'free' });
  const response = await api.request(`/jobs/${id}/prototype`, 'POST', {});
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'feature_unavailable', feature: 'prototype' });
});

test('GET prototype returns 404 before a prototype is generated', async (t) => {
  const db = database(t), id = seedJob(db), api = await apiFor(t, db);
  const response = await api.request(`/jobs/${id}/prototype`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'no_prototype' });
});

test('POST prototype saves generated HTML and serves it as text/html', async (t) => {
  const db = database(t), id = seedJob(db, { proposal: 'A proposal', estimate: JSON.stringify({ estimated_price: 120, estimated_days: 3 }) });
  const api = await apiFor(t, db);
  const created = await api.request(`/jobs/${id}/prototype`, 'POST', { include_price: true, include_timing: true });
  assert.equal(created.status, 200);
  assert.match(created.headers.get('content-type'), /text\/html/);
  const html = await created.text();
  assert.match(html, /120 USD/);
  assert.equal(db.prepare('SELECT prototype_html FROM user_jobs WHERE user_id=1 AND job_id=?').get(id).prototype_html, html);
  const fetched = await api.request(`/jobs/${id}/prototype`);
  assert.equal(fetched.status, 200);
  assert.match(fetched.headers.get('content-type'), /text\/html/);
  assert.equal(await fetched.text(), html);
});
