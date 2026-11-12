import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { closeDb, openDb } from '../src/db.js';
import { getPricesReport, getTimingReport, getWeeklyReport } from '../src/reports.js';

const apiKey = 'reports-test-api-key-at-least-24-chars';

function database(t) {
  const db = openDb(':memory:');
  t.after(() => closeDb(db));
  return db;
}

function seed(db, { userId = 1, title = 'Job', estimate = null, status = 'sent', score = null, createdAt = new Date().toISOString() } = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs(source,external_id,title,description,url,budget,created_at)
    VALUES('freelancer',?,?, '', '', '',?)`).run(`${title}-${Math.random()}`, title, createdAt);
  const jobId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  if (userId !== 1 && !db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) {
    db.prepare("INSERT INTO users(id,email,name,role,status,created_at) VALUES(?,NULL,'Reports user','user','active',?)").run(userId, now);
  }
  db.prepare(`INSERT INTO user_jobs(user_id,job_id,status,score,estimate,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(user_id,job_id) DO UPDATE SET status=excluded.status,score=excluded.score,
      estimate=excluded.estimate,created_at=excluded.created_at,updated_at=excluded.updated_at`)
    .run(userId, jobId, status, score, estimate, createdAt, now);
  return jobId;
}

async function apiFor(t, db) {
  const api = createServer({
    db,
    sources: [{ name: 'freelancer' }],
    config: { API_KEY: apiKey, API_HOST: '127.0.0.1', CORS_ORIGINS: [], SAAS_ENABLED: true },
    authProviders: [(request) => request.headers['x-api-key'] === apiKey ? { userId: 1, role: 'owner', planId: 'owner' } : null],
    logger: { info() {}, warn() {}, error() {} },
  });
  const address = await api.listen(0, '127.0.0.1');
  t.after(async () => { await api.close(); });
  const base = `http://127.0.0.1:${address.port}`;
  return { request: (route) => fetch(`${base}${route}`, { headers: { 'X-API-Key': apiKey } }) };
}

test('getPricesReport includes only stored non-null estimated prices', (t) => {
  const db = database(t);
  seed(db, { title: 'Priced', estimate: JSON.stringify({ estimated_price: 120 }), score: 8 });
  seed(db, { title: 'Unpriced', estimate: JSON.stringify({ estimated_price: null }) });
  assert.deepEqual(getPricesReport(1, db).map((row) => row.title), ['Priced']);
});

test('getPricesReport sorts by estimated price descending', (t) => {
  const db = database(t);
  seed(db, { title: 'Low', estimate: JSON.stringify({ estimated_price: 25 }) });
  seed(db, { title: 'High', estimate: JSON.stringify({ estimated_price: 200 }) });
  assert.deepEqual(getPricesReport(1, db).map((row) => row.estimated_price), [200, 25]);
});

test('getTimingReport includes only stored non-null estimated days', (t) => {
  const db = database(t);
  seed(db, { title: 'Timed', estimate: JSON.stringify({ estimated_days: 4 }) });
  seed(db, { title: 'Untimed', estimate: JSON.stringify({ estimated_days: null }) });
  assert.deepEqual(getTimingReport(1, db).map((row) => row.title), ['Timed']);
});

test('getTimingReport sorts by estimated days ascending', (t) => {
  const db = database(t);
  seed(db, { title: 'Long', estimate: JSON.stringify({ estimated_days: 12 }) });
  seed(db, { title: 'Short', estimate: JSON.stringify({ estimated_days: 2 }) });
  assert.deepEqual(getTimingReport(1, db).map((row) => row.estimated_days), [2, 12]);
});

test('getWeeklyReport returns no more than eight ISO weeks', (t) => {
  const db = database(t), now = new Date('2026-11-12T12:00:00.000Z');
  for (let week = 0; week < 10; week++) {
    const date = new Date(now.getTime() - week * 7 * 24 * 60 * 60 * 1000).toISOString();
    seed(db, { title: `Week ${week}`, createdAt: date });
  }
  const report = getWeeklyReport(1, db, now);
  assert.equal(report.length, 8);
  assert.equal(report[0].week_start, '2026-11-09');
});

test('getWeeklyReport counts applied, rejected, approved, and average score by week', (t) => {
  const db = database(t), now = new Date('2026-11-12T12:00:00.000Z'), date = '2026-11-10T10:00:00.000Z';
  seed(db, { title: 'Applied', status: 'applied', score: 8, createdAt: date });
  seed(db, { title: 'Rejected', status: 'rejected', score: 6, createdAt: date });
  seed(db, { title: 'Approved', status: 'approved', score: 10, createdAt: date });
  const [week] = getWeeklyReport(1, db, now);
  assert.deepEqual(week, { week_start: '2026-11-09', total_jobs: 3, applied: 1, rejected: 1, approved: 1, avg_score: 8 });
});

for (const route of ['/reports/prices', '/reports/timing', '/reports/weekly']) {
  test(`GET ${route} returns a data array`, async (t) => {
    const api = await apiFor(t, database(t));
    const response = await api.request(route);
    assert.equal(response.status, 200);
    assert.ok(Array.isArray((await response.json()).data));
  });
}
