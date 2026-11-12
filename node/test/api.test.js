import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, closeDb } from '../src/db.js';
import { createServer } from '../src/server.js';

const API_KEY = 'api-test-secret-key-that-is-at-least-24-chars';

test('HTTP API auth, CORS, read endpoints, filters, errors and safe logging', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-api-'));
  const db = openDb(path.join(dir, 'api.db'));
  const logOutput = [];
  const logger = { info: (...args) => logOutput.push(args.join(' ')), warn: (...args) => logOutput.push(args.join(' ')), error: (...args) => logOutput.push(args.join(' ')) };
  const config = { API_HOST: '127.0.0.1', API_PORT: 0, API_KEY, CORS_ORIGINS: ['https://mobile.example'], API_MAX_BODY_BYTES: 64 };
  const api = createServer({ db, config, logger });
  let base;
  try {
    db.exec(`INSERT INTO jobs (rowid,source,external_id,title,description,url,budget,status,created_at,proposal,evaluation,bid_count,bid_avg,score,score_line,tags,currency,posted_at,estimate,prototype_url) VALUES
      (11,'freelancer','fl-11','Flutter 100%_Build','Search literal token %_','https://example.test/11','$500','new','2025-01-10 10:00:00','Proposal text','{"grade":"good"}',4,125,8,'great','["flutter","api"]','USD','2025-01-10T09:00:00Z','{"amount":500}','https://demo.example/11'),
      (12,'mostaql','mo-12','Python React backend','Build a service','https://example.test/12','$300','sent','2025-06-10 10:00:00',NULL,NULL,8,60,4,'average','["python"]','USD','2025-06-09T10:00:00Z',NULL,NULL),
      (13,'khamsat','kh-13','React starter','Web api project','https://example.test/13','','applied','2024-01-10 10:00:00',NULL,NULL,NULL,NULL,6,'good','["react"]',NULL,NULL,NULL,NULL),
      (14,'freelancer','fl-14','Flutter second','Mobile project','https://example.test/14','$900','rejected','2025-10-10 10:00:00',NULL,NULL,2,450,9,'top','["flutter"]','USD','2025-10-09T10:00:00Z',NULL,NULL)`);
    const address = await api.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${address.port}`;
    t.after(async () => {
      await api.close();
      closeDb(db);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const req = (route, options = {}) => fetch(`${base}${route}`, options);
    const authorized = (extra = {}) => ({ 'X-API-Key': API_KEY, ...extra });
    const json = async (response) => response.json();

    assert.equal((await req('/health')).status, 200);
    const health = await json(await req('/health'));
    assert.deepEqual(Object.keys(health).sort(), ['ok', 'time', 'version']);
    assert.equal(health.ok, true);
    assert.equal((await req('/jobs')).status, 401);
    assert.equal((await req('/jobs', { headers: { 'X-API-Key': 'wrong-api-key-secret-that-is-very-long' } })).status, 401);
    assert.equal((await req('/jobs', { headers: authorized() })).status, 200);

    const allowedCors = await req('/health', { headers: { Origin: 'https://mobile.example' } });
    assert.equal(allowedCors.headers.get('access-control-allow-origin'), 'https://mobile.example');
    assert.equal((await req('/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
    const preflight = await req('/jobs', { method: 'OPTIONS', headers: { Origin: 'https://mobile.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'X-API-Key, Content-Type, Last-Event-ID' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    assert.match(preflight.headers.get('access-control-allow-headers'), /X-API-Key/);

    const list = await json(await req('/jobs', { headers: authorized() }));
    assert.equal(list.total, 4);
    assert.equal(list.items.length, 4);
    assert.equal(list.items[0].id, 14);
    assert.ok(!Object.hasOwn(list.items[0], 'description'));
    assert.equal(list.items.find((job) => job.id === 11).has_proposal, true);
    assert.equal(list.items.find((job) => job.id === 11).has_estimate, true);
    assert.equal(list.items.find((job) => job.id === 11).applied_at, null);
    assert.equal(list.items.find((job) => job.id === 11).created_at, '2025-01-10T10:00:00Z');
    assert.equal(db.prepare('SELECT created_at FROM jobs WHERE rowid=11').get().created_at, '2025-01-10 10:00:00');

    const filterCases = [
      ['status=sent', [12]], ['source=khamsat', [13]], ['tag=flutter', [11, 14]],
      ['min_score=8', [11, 14]], ['search=PYTHON', [12]], ['search=%25_', [11]],
      ['since=2025-06-01', [12, 14]],
    ];
    for (const [query, ids] of filterCases) {
      const result = await json(await req(`/jobs?${query}`, { headers: authorized() }));
      assert.deepEqual(result.items.map((job) => job.id).sort((a, b) => a - b), ids.slice().sort((a, b) => a - b), query);
    }
    assert.deepEqual((await json(await req('/jobs?sort=score', { headers: authorized() }))).items.map((job) => job.id), [14, 11, 13, 12]);
    assert.deepEqual((await json(await req('/jobs?sort=posted', { headers: authorized() }))).items.map((job) => job.id), [14, 12, 11, 13]);
    const page = await json(await req('/jobs?limit=1&offset=1', { headers: authorized() }));
    assert.equal(page.total, 4); assert.equal(page.limit, 1); assert.equal(page.offset, 1); assert.equal(page.items.length, 1);
    const capped = await json(await req('/jobs?limit=999', { headers: authorized() }));
    assert.equal(capped.limit, 200);

    const fullResponse = await req('/jobs/11', { headers: authorized() });
    assert.equal(fullResponse.status, 200);
    const full = await json(fullResponse);
    assert.equal(full.description, 'Search literal token %_');
    assert.deepEqual(full.tags, list.items.find((job) => job.id === 11).tags);
    assert.equal(full.applied_at, null);
    assert.equal(full.created_at, '2025-01-10T10:00:00Z');
    assert.equal(full.proposal, 'Proposal text');
    assert.deepEqual(full.evaluation, { grade: 'good' });
    assert.deepEqual(full.estimate, { amount: 500 });
    assert.equal(full.stats.bid_count, 4);
    assert.equal((await req('/jobs/0', { headers: authorized() })).status, 400);
    assert.equal((await req('/jobs/nope', { headers: authorized() })).status, 400);
    assert.equal((await req('/jobs/999', { headers: authorized() })).status, 404);
    assert.equal((await req('/unknown', { headers: authorized() })).status, 404);
    assert.equal((await req('/health', { method: 'POST', headers: authorized() })).status, 405);

    for (const query of ['status=unknown', 'source=unknown', 'tag=unknown', 'min_score=x', 'since=yesterday', 'limit=0', 'offset=-1', 'sort=oldest']) {
      const response = await req(`/jobs?${query}`, { headers: authorized() });
      assert.equal(response.status, 400, query);
      const body = await json(response);
      assert.equal(body.error.code, 'INVALID_PARAMETER');
      assert.match(body.error.message, new RegExp(query.split('=')[0]));
    }
    const counts = await json(await req('/stats/counts', { headers: authorized() }));
    assert.deepEqual(counts.by_status, { new: 1, sent: 1, approved: 0, applied: 1, rejected: 1, skipped: 0 });
    assert.deepEqual(counts.by_source, { freelancer: 2, khamsat: 1, mostaql: 1 });
    assert.equal(counts.total, 4);
    assert.ok(!logOutput.join('\n').includes(API_KEY));
  } finally {
    await api.close();
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('API refuses missing and too-short keys with one clear log line each', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-api-key-'));
  const db = openDb(path.join(dir, 'api.db'));
  const logs = [];
  const logger = { error: (message) => logs.push(message) };
  const missing = createServer({ db, config: { API_HOST: '127.0.0.1', CORS_ORIGINS: [] }, logger });
  const short = createServer({ db, config: { API_KEY: 'short', API_HOST: '127.0.0.1', CORS_ORIGINS: [] }, logger });
  try {
    assert.equal(await missing.listen(0, '127.0.0.1'), false);
    assert.equal(await short.listen(0, '127.0.0.1'), false);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /API_KEY/);
    assert.match(logs[1], /API_KEY/);
  } finally { await missing.close(); await short.close(); closeDb(db); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
