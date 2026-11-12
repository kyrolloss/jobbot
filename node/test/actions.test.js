import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, closeDb } from '../src/db.js';
import { createServer } from '../src/server.js';

const API_KEY = 'actions-test-secret-key-long-enough-24-plus';

test('job action endpoints apply Python status guards, transitions, and API response shape', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-actions-'));
  const db = openDb(path.join(dir, 'actions.db'));
  const api = createServer({
    db,
    config: { API_KEY, API_HOST: '127.0.0.1', CORS_ORIGINS: ['https://app.example'] },
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    db.exec(`INSERT INTO jobs (rowid,source,external_id,title,description,url,budget,status,created_at,proposal,evaluation,bid_count,bid_avg,score,score_line,tags,currency,posted_at,estimate,prototype_url) VALUES
      (101,'freelancer','reject-me','Reject job','Desc','https://example.test/101','100','sent','2025-01-01 00:00:00',NULL,NULL,1,10,5,'score','["flutter"]','USD',NULL,NULL,NULL),
      (102,'mostaql','approve-me','Approve job','Desc','https://example.test/102','200','sent','2025-01-02 00:00:00','Saved proposal','{"verdict":"apply"}',2,20,6,'score','["python"]','USD',NULL,'{"hours":4}',NULL),
      (103,'khamsat','apply-me','Apply job','Desc','https://example.test/103','','approved','2025-01-03 00:00:00',NULL,NULL,NULL,NULL,7,'score','[]',NULL,NULL,NULL,NULL),
      (104,'freelancer','still-new','New job','Desc','https://example.test/104','','new','2025-01-04 00:00:00',NULL,NULL,NULL,NULL,1,'score','[]',NULL,NULL,NULL,NULL)`);
    const address = await api.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { 'X-API-Key': API_KEY };
    const call = (route, options = {}) => fetch(`${base}${route}`, options);
    const readJson = async (response) => response.json();

    const actions = [
      ['/jobs/101/reject', 'rejected', ['flutter']],
      ['/jobs/102/approve', 'approved', ['python']],
      ['/jobs/103/applied', 'applied', []],
    ];
    const beforeApply = await readJson(await call('/jobs/103', { headers }));
    assert.equal(beforeApply.applied_at, null);
    for (const [route, expectedStatus, expectedTags] of actions) {
      const before = await readJson(await call(route.replace(/\/(reject|approve|applied)$/, ''), { headers }));
      const response = await call(route, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ignored: true }) });
      assert.equal(response.status, 200, route);
      const updated = await readJson(response);
      assert.equal(updated.status, expectedStatus);
      assert.deepEqual(updated.tags, expectedTags, `${route} tags`);
      if (expectedStatus === 'applied') assert.ok(updated.applied_at);
      assert.equal(db.prepare('SELECT status FROM jobs WHERE rowid=?').get(updated.id).status, expectedStatus);
      assert.deepEqual(Object.keys(updated).sort(), Object.keys(before).sort());
      const repeated = await call(route, { method: 'POST', headers });
      assert.equal(repeated.status, 409);
      assert.match((await readJson(repeated)).error.message, new RegExp(expectedStatus));
    }

    const appliedAt = db.prepare('SELECT applied_at FROM jobs WHERE rowid=103').get().applied_at;
    assert.ok(appliedAt);
    const appliedDetail = await readJson(await call('/jobs/103', { headers }));
    const appliedList = await readJson(await call('/jobs?source=khamsat', { headers }));
    assert.equal(appliedDetail.applied_at, appliedAt);
    assert.equal(appliedList.items[0].applied_at, appliedAt);
    assert.deepEqual(appliedDetail.tags, appliedList.items[0].tags);
    const repeatedApply = await call('/jobs/103/applied', { method: 'POST', headers });
    assert.equal(repeatedApply.status, 409);
    assert.equal((await readJson(repeatedApply)).error.message, 'Cannot mark job as applied while its current status is "applied"');
    assert.equal(db.prepare('SELECT applied_at FROM jobs WHERE rowid=103').get().applied_at, appliedAt);
    const invalidStatuses = db.prepare("SELECT rowid,status FROM jobs WHERE status NOT IN ('new','sent','approved','applied','rejected','skipped')").all();
    assert.deepEqual(invalidStatuses, []);

    for (const route of ['/jobs/104/reject', '/jobs/101/approve', '/jobs/101/applied']) {
      const response = await call(route, { method: 'POST', headers });
      assert.equal(response.status, 409, route);
      assert.match((await readJson(response)).error.message, /current status/);
    }
    assert.equal((await call('/jobs/999/reject', { method: 'POST', headers })).status, 404);
    assert.equal((await call('/jobs/0/reject', { method: 'POST', headers })).status, 400);
    assert.equal((await call('/jobs/nope/approve', { method: 'POST', headers })).status, 400);
    assert.equal((await call('/jobs/101/reject', { method: 'POST' })).status, 401);
    assert.equal((await call('/jobs/101/reject', { method: 'POST', headers: { 'X-API-Key': 'wrong-key-that-is-longer-than-twenty-four' } })).status, 401);
    assert.equal((await call('/jobs/101/reject', { method: 'POST', headers, body: 'not-json' })).status, 409, 'action body is ignored');

    const preflight = await call('/jobs/102/approve', { method: 'OPTIONS', headers: {
      Origin: 'https://app.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'X-API-Key, Content-Type',
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.example');
    assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Content-Type/);
  } finally {
    await api.close();
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
