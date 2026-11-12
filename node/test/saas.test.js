import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSaasSchema } from '../src/saas/schema.js';
import { resolvePrincipal } from '../src/saas/principal.js';
import { createGuard } from '../src/saas/guard.js';
import { createUsage } from '../src/saas/usage.js';
import { createServer } from '../src/server.js';
import { HttpError } from '../src/api/router.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-saas-'));
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  let time = new Date('2026-01-15T12:00:00Z');
  const now = () => new Date(time);
  createSaasSchema(db); createSaasSchema(db);
  return { db, dir, now, advance: (ms) => { time = new Date(time.getTime() + ms); } };
}

test('SaaS schema is idempotent and seeds owner and plans', (t) => {
  const x = setup(); t.after(() => { x.db.close(); fs.rmSync(x.dir, { recursive: true, force: true }); });
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  assert.deepEqual(x.db.prepare('SELECT id FROM plans ORDER BY id').all().map((r) => r.id), ['free','owner','power','pro']);
});

test('API key principal resolves only for the matching secret', async () => {
  const deps = { config: { API_KEY: 'api-test-secret-key-that-is-at-least-24-chars' } };
  assert.deepEqual(await resolvePrincipal({ headers: { 'x-api-key': deps.config.API_KEY } }, deps), { userId: 1, role: 'owner', planId: 'owner' });
  assert.equal(await resolvePrincipal({ headers: { 'x-api-key': 'incorrect-long-api-key-string-here' } }, deps), null);
});

test('credits are idempotent, reservations cannot overdraw concurrently, and monthly grants are UTC keyed', async (t) => {
  const x = setup(); t.after(() => { x.db.close(); fs.rmSync(x.dir, { recursive: true, force: true }); });
  const guard = createGuard({ db: x.db, config: { SAAS_ENABLED: true, FEATURE_COSTS: { evaluate: 1 }, AI_RATE_LIMIT_PER_MINUTE: 10 }, now: x.now });
  x.db.prepare("INSERT INTO users(id,name,role,status,created_at) VALUES(2,'test','user','active',?)").run(x.now().toISOString());
  x.db.prepare("INSERT INTO users(id,name,role,status,created_at) VALUES(3,'test2','user','active',?)").run(x.now().toISOString());
  x.db.prepare("UPDATE plans SET monthly_points=0 WHERE id IN ('free','pro')").run();
  guard.credits.addCredits(2, 1, 'test', 'seed');
  const principal = { userId: 2, role: 'user', planId: 'free' };
  const run = () => guard.execute({ principal, feature: 'evaluate', idempotencyKey: `key-${Math.random()}` }, async () => new Promise((resolve) => setTimeout(() => resolve({ result: true, usage: { inputTokens: 1, outputTokens: 1 } }), 10)));
  const results = await Promise.allSettled([run(), run()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(guard.credits.getBalance(2), 0);
  assert.equal(guard.credits.grantMonthlyPoints(3, 'free', x.now()), true);
  assert.equal(guard.credits.grantMonthlyPoints(3, 'free', x.now()), false);
  x.advance(31 * 86400000);
  assert.equal(guard.credits.grantMonthlyPoints(3, 'free', x.now()), true);
});

test('owner bypass usage cost and failed user generation refund', async (t) => {
  const x = setup(); t.after(() => { x.db.close(); fs.rmSync(x.dir, { recursive: true, force: true }); });
  const guard = createGuard({ db: x.db, config: { SAAS_ENABLED: true, GEMINI_PRICE_PER_MTOK_INPUT: 2 }, now: x.now });
  x.db.prepare("INSERT INTO users(id,name,role,status,created_at) VALUES(2,'test','user','active',?)").run(x.now().toISOString());
  x.db.prepare("UPDATE plans SET monthly_points=0 WHERE id='pro'").run();
  await guard.execute({ principal: { userId:1,role:'owner',planId:'owner' }, feature:'evaluate' }, async () => ({ result: 'ok', usage: { inputTokens: 500000 } }));
  assert.equal(x.db.prepare('SELECT cost_usd FROM usage_events').get().cost_usd, 1);
  guard.credits.addCredits(2, 5, 'test', 'seed2');
  await assert.rejects(guard.execute({ principal: { userId:2,role:'user',planId:'pro' }, feature:'evaluate', idempotencyKey:'failed-key' }, async () => { throw Object.assign(new Error('failed'), { usage: { inputTokens: 10 } }); }));
  assert.equal(guard.credits.getBalance(2), 5);
});

test('guard reports plan, credit, daily, and rate limits and never charges one key twice', async (t) => {
  const x = setup(); t.after(() => { x.db.close(); fs.rmSync(x.dir, { recursive: true, force: true }); });
  x.db.prepare("INSERT INTO users(id,name,role,status,created_at) VALUES(2,'test','user','active',?)").run(x.now().toISOString());
  x.db.prepare("INSERT INTO users(id,name,role,status,created_at) VALUES(3,'test2','user','active',?)").run(x.now().toISOString());
  x.db.prepare("UPDATE plans SET monthly_points=0,daily_points_cap=1 WHERE id='free'").run();
  const guard = createGuard({ db: x.db, config: { SAAS_ENABLED: true, FEATURE_COSTS: { evaluate:1, proposal:2 }, AI_RATE_LIMIT_PER_MINUTE:10 }, now:x.now, logger:{ warn(){} } });
  const principal = { userId:2, role:'user', planId:'free' };
  await assert.rejects(guard.execute({ principal, feature:'evaluate', idempotencyKey:'no-credit' }, async () => ({})), (e) => e instanceof HttpError && e.status === 402 && e.code === 'INSUFFICIENT_CREDITS' && e.details.balance === 0);
  guard.credits.addCredits(2, 2, 'test', 'grant-test');
  await assert.rejects(guard.execute({ principal, feature:'proposal', idempotencyKey:'no-plan' }, async () => ({})), (e) => e.status === 403 && e.code === 'PLAN_REQUIRED');
  await guard.execute({ principal, feature:'evaluate', idempotencyKey:'once' }, async () => ({ result:1 }));
  x.db.prepare('UPDATE plans SET daily_points_cap=NULL WHERE id=\'free\'').run();
  await guard.execute({ principal, feature:'evaluate', idempotencyKey:'once' }, async () => ({ result:2 }));
  assert.equal(guard.credits.getBalance(2), 1);
  x.db.prepare("UPDATE plans SET daily_points_cap=1 WHERE id='free'").run();
  const capped = createGuard({ db:x.db, config:{ SAAS_ENABLED:true, FEATURE_COSTS:{ evaluate:1 }, AI_RATE_LIMIT_PER_MINUTE:10 }, now:x.now, logger:{ warn(){} } });
  capped.credits.addCredits(3, 5, 'test', 'grant-daily');
  const free3 = { ...principal, userId:3 };
  await capped.execute({ principal:free3, feature:'evaluate', idempotencyKey:'daily-one' }, async () => ({}));
  await assert.rejects(capped.execute({ principal:free3, feature:'evaluate', idempotencyKey:'daily-two' }, async () => ({})), (e) => e.status === 429 && e.code === 'DAILY_LIMIT_REACHED');
  x.db.prepare("UPDATE plans SET daily_points_cap=NULL WHERE id='pro'").run();
  const limited = createGuard({ db:x.db, config:{ SAAS_ENABLED:true, FEATURE_COSTS:{ evaluate:1 }, AI_RATE_LIMIT_PER_MINUTE:1 }, now:x.now, logger:{ warn(){} } });
  limited.credits.addCredits(3, 5, 'test', 'grant-rate');
  const p3 = { userId:3, role:'user', planId:'pro' };
  x.db.prepare("UPDATE plans SET monthly_points=0,daily_points_cap=NULL WHERE id='pro'").run();
  await limited.execute({ principal:p3, feature:'evaluate', idempotencyKey:'rate-one' }, async () => ({}));
  await assert.rejects(limited.execute({ principal:p3, feature:'evaluate', idempotencyKey:'rate-two' }, async () => ({})), (e) => e.status === 429 && e.code === 'RATE_LIMITED' && e.details.retry_after_seconds >= 1);
});

test('usage summary groups calls and token cost by kind', (t) => {
  const x = setup(); t.after(() => { x.db.close(); fs.rmSync(x.dir, { recursive: true, force: true }); });
  const usage = createUsage(x.db, { GEMINI_PRICE_PER_MTOK_OUTPUT: 4 }, x.now);
  usage.recordUsage({ userId:1, kind:'proposal', outputTokens:250000, status:'ok' });
  assert.deepEqual(usage.getUsageSummary(1, new Date('2026-01-01T00:00:00Z')).map((r) => [r.kind,r.calls,r.cost_usd]), [['proposal',1,1]]);
});

test('account, usage, and plan endpoints require auth and return read-only data', async (t) => {
  const x = setup();
  const key = 'saas-http-test-api-key-at-least-24-chars';
  const api = createServer({ db: x.db, config: { API_KEY: key, API_HOST: '127.0.0.1', API_PORT: 0, CORS_ORIGINS: [] } });
  const address = await api.listen(0, '127.0.0.1');
  t.after(async () => { await api.close(); x.db.close(); fs.rmSync(x.dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}`;
  for (const route of ['/me','/usage/summary','/plans']) assert.equal((await fetch(base + route)).status, 401);
  const headers = { 'X-API-Key': key };
  const me = await (await fetch(base + '/me', { headers })).json();
  assert.equal(me.user.id, 1); assert.equal(me.plan.id, 'owner');
  assert.equal((await fetch(base + '/usage/summary?days=366', { headers })).status, 400);
  assert.equal((await fetch(base + '/usage/summary', { headers })).status, 200);
  const plans = await (await fetch(base + '/plans', { headers })).json();
  assert.deepEqual(plans.map((p) => p.id), ['owner','free','pro','power']);
});
