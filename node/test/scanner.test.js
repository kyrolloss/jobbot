import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, closeDb } from '../src/db.js';
import { runScan, tryAcquireScanLock, isScanRunning, ScanAlreadyRunningError, getScanState } from '../src/scanner.js';
import { createSettingsStore } from '../src/settings.js';
import { createServer } from '../src/server.js';

const fixedTime = new Date('2026-02-03T04:05:06.000Z');
const testClock = () => {
  let monotonic = 0;
  return { now: () => new Date(fixedTime), monotonic: () => monotonic, sleep: async (ms) => { monotonic += ms; } };
};
const makeJob = (source, externalId, title, extra = {}) => ({ source, external_id: externalId, title, description: 'Flutter mobile application', url: `https://example.test/${externalId}`, budget: '$500', ...extra });

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-scanner-'));
  const db = openDb(path.join(dir, 'scan.db'));
  return { dir, db };
}

test('scan filters, deduplicates, caps stats at 40, saves sent jobs and calls hooks by score', async () => {
  const { dir, db } = makeTempDb();
  try {
    db.prepare(`INSERT INTO jobs (source,external_id,title,description,url,budget,status,tags) VALUES (?,?,?,?,?,?,?,?)`)
      .run('freelancer', 'known-id', 'Known', '', 'https://example.test/known', '', 'sent', '[]');
    const jobs = Array.from({ length: 45 }, (_, index) => makeJob('freelancer', `fl-${index + 1}`, `Flutter app task ${index + 1}`, { budget: `$${(index + 1) * 25}` }));
    jobs.push(makeJob('freelancer', 'logo-job', 'Logo designer', { description: 'Logo design only' }));
    jobs.push(makeJob('freelancer', 'details-fail', 'Flutter details fail', { failDetails: true }));
    jobs.push(makeJob('freelancer', 'known-id', 'Flutter duplicate'));
    let statsCalls = 0;
    const source = {
      name: 'freelancer',
      async fetchJobs() { return { jobs, errors: [] }; },
      async fetchDetails(job) { if (job.failDetails) throw new Error('details unavailable'); return job; },
      async fetchStats(job) { statsCalls++; return { bid_count: 1, bid_avg: 100, currency: 'USD' }; },
    };
    const failing = { name: 'mostaql', async fetchJobs() { throw new Error('source offline'); } };
    const finalSource = {
      name: 'khamsat', async fetchJobs() { return { jobs: [makeJob('khamsat', 'kh-1', 'Flutter community app')], errors: [] }; },
      async fetchDetails(job) { return job; }, async fetchStats() { statsCalls++; return {}; },
    };
    const hookScores = [];
    const summary = await runScan({ db, sources: [source, failing, finalSource], clock: testClock(), onNewJob: (job, rowid) => hookScores.push({ score: job.score, rowid }) });

    assert.equal(statsCalls, 40);
    assert.equal(summary.trigger, 'manual');
    assert.equal(summary.per_source.freelancer.fetched, 48);
    assert.equal(summary.per_source.freelancer.filtered_out, 1);
    assert.equal(summary.per_source.freelancer.details_failed, 1);
    assert.equal(summary.per_source.freelancer.new_saved, 46);
    assert.equal(summary.per_source.freelancer.stats_fetched, 40);
    assert.equal(summary.per_source.mostaql.errors[0].kind, 'network');
    assert.equal(summary.per_source.khamsat.new_saved, 1);
    assert.equal(hookScores.length, 46);
    assert.ok(hookScores.every((entry, index) => index === 0 || hookScores[index - 1].score >= entry.score));
    assert.ok(hookScores.every((entry) => Number.isInteger(entry.rowid)));
    assert.equal(db.prepare("SELECT status FROM jobs WHERE source='freelancer' AND external_id='fl-1'").get().status, 'sent');
    assert.equal(db.prepare("SELECT status FROM jobs WHERE source='freelancer' AND external_id='logo-job'").get().status, 'skipped');
    assert.equal(db.prepare("SELECT 1 FROM jobs WHERE source='freelancer' AND external_id='details-fail'").get(), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE source='freelancer' AND external_id='known-id'").get().count, 1);
    const scored = db.prepare("SELECT score,score_line FROM jobs WHERE source='freelancer' AND external_id='fl-1'").get();
    assert.equal(typeof scored.score, 'number');
    assert.ok(scored.score_line);
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('scan lock refuses a second concurrent scan without releasing the first lock', async () => {
  const { dir, db } = makeTempDb();
  const release = tryAcquireScanLock();
  try {
    assert.equal(typeof release, 'function');
    await assert.rejects(runScan({ db, sources: [], lock: null }), ScanAlreadyRunningError);
    assert.equal(isScanRunning(), true);
  } finally {
    release(); closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Khamsat empty details and an open breaker preserve list jobs for normal saving', async () => {
  const { dir, db } = makeTempDb();
  let detailCalls = 0;
  const khamsat = {
    name: 'khamsat', detailsBlocked: false, lastDetailError: null,
    async fetchJobs() {
      return { jobs: [
        makeJob('khamsat', 'kh-202', 'Flutter request 202', { description: 'List-level Flutter description' }),
        makeJob('khamsat', 'kh-breaker', 'Flutter request after breaker', { description: 'Second list-level Flutter description' }),
      ], errors: [] };
    },
    async fetchDetails(job) {
      detailCalls++;
      if (this.detailsBlocked) return job;
      this.detailsBlocked = true;
      this.lastDetailError = { kind: 'parse', status: 202, message: 'Empty Khamsat detail response' };
      return job;
    },
    async fetchStats() { return {}; },
  };
  try {
    const summary = await runScan({ db, sources: [khamsat], clock: testClock() });
    const counts = summary.per_source.khamsat;
    assert.equal(detailCalls, 2);
    assert.equal(counts.new_candidates, 2);
    assert.equal(counts.details_failed, 0);
    assert.equal(counts.details_unavailable, 2);
    assert.equal(counts.would_save, 2);
    assert.equal(counts.would_skip_filtered, 0);
    assert.equal(counts.would_skip_details_failed, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE source='khamsat'").get().count, 2);
    assert.equal(db.prepare("SELECT description FROM jobs WHERE external_id='kh-202'").get().description, 'List-level Flutter description');
    assert.equal(db.prepare("SELECT status FROM jobs WHERE external_id='kh-breaker'").get().status, 'sent');
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('dry-run projections account for every new candidate without writing rows', async () => {
  const { dir, db } = makeTempDb();
  const source = {
    name: 'freelancer',
    async fetchJobs() { return { jobs: [
      makeJob('freelancer', 'dry-match', 'Flutter mobile app'),
      makeJob('freelancer', 'dry-filter', 'Logo design', { description: 'Logo only' }),
      makeJob('freelancer', 'dry-details-fail', 'Flutter details unavailable', { failDetails: true }),
    ], errors: [] }; },
    async fetchDetails(job) { if (job.failDetails) throw new Error('details unavailable'); return job; },
    async fetchStats() { return {}; },
  };
  try {
    const summary = await runScan({ db, sources: [source], clock: testClock(), dryRun: true });
    const counts = summary.per_source.freelancer;
    assert.equal(counts.would_save, 1);
    assert.equal(counts.would_skip_filtered, 1);
    assert.equal(counts.would_skip_details_failed, 1);
    assert.equal(counts.would_save + counts.would_skip_filtered + counts.would_skip_details_failed, counts.new_candidates);
    assert.equal(counts.new_saved, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 0);
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('scan API starts in background, reports busy scans, validates settings and allows POST preflight', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-scan-api-'));
  const db = openDb(path.join(dir, 'api.db'));
  const settingsStore = createSettingsStore({ filePath: path.join(dir, 'settings.json'), logger: { warn() {} } });
  let savedSettings = settingsStore.read();
  let releaseFetch;
  const waitFetch = new Promise((resolve) => { releaseFetch = resolve; });
  const source = {
    name: 'freelancer',
    async fetchJobs() { await waitFetch; return { jobs: [], errors: [] }; },
  };
  const scheduler = {
    status() { const scan = getScanState(); return { ...scan, enabled: savedSettings.scan_enabled, interval_minutes: savedSettings.interval_minutes, next_run_at: savedSettings.scan_enabled ? '2026-02-03T05:05:06.000Z' : null }; },
    updateSettings(settings) { savedSettings = settings; return this.status(); },
    stop() {},
  };
  const key = 'scanner-api-key-that-has-more-than-24-characters';
  const api = createServer({ db, sources: [source], clock: testClock(), settingsStore, scheduler,
    config: { API_KEY: key, API_HOST: '127.0.0.1', CORS_ORIGINS: ['https://app.example'] },
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    const address = await api.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;
    const auth = { 'X-API-Key': key };
    const req = (route, options = {}) => fetch(`${base}${route}`, options);
    db.prepare(`INSERT INTO jobs (rowid,source,external_id,title,description,url,budget,status,tags,applied_at)
      VALUES (77,'freelancer','tagged','Flutter app','Desc','https://example.test/77','','approved','["flutter","node"]',NULL)`).run();
    const taggedList = await (await req('/jobs?status=approved', { headers: auth })).json();
    const taggedDetail = await (await req('/jobs/77', { headers: auth })).json();
    assert.deepEqual(taggedDetail.tags, taggedList.items[0].tags);
    assert.deepEqual(taggedDetail.tags, ['flutter', 'node']);
    assert.equal(taggedList.items[0].applied_at, null);
    assert.equal(taggedDetail.applied_at, null);
    const applyResponse = await req('/jobs/77/applied', { method: 'POST', headers: auth });
    const appliedPayload = await applyResponse.json();
    assert.equal(applyResponse.status, 200);
    assert.deepEqual(appliedPayload.tags, ['flutter', 'node']);
    assert.ok(appliedPayload.applied_at);
    const recordedAppliedAt = appliedPayload.applied_at;
    const refusedRepeat = await req('/jobs/77/applied', { method: 'POST', headers: auth });
    assert.equal(refusedRepeat.status, 409);
    assert.equal(db.prepare('SELECT applied_at FROM jobs WHERE rowid=77').get().applied_at, recordedAppliedAt);

    const start = await req('/scan/run', { method: 'POST', headers: auth, body: 'ignored non-json' });
    assert.equal(start.status, 202);
    const started = await start.json();
    assert.equal(started.started, true);
    assert.ok(started.started_at);
    const statusWhileRunning = await (await req('/scan/status', { headers: auth })).json();
    assert.equal(statusWhileRunning.running, true);
    assert.ok(Object.hasOwn(statusWhileRunning, 'last_scan'));
    const busy = await req('/scan/run', { method: 'POST', headers: auth });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).error.code, 'SCAN_RUNNING');
    assert.equal((await req('/scan/status')).status, 401);

    const settingResponse = await req('/scan/settings', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, interval_minutes: 15 }) });
    assert.equal(settingResponse.status, 200);
    const settingPayload = await settingResponse.json();
    assert.equal(settingPayload.enabled, true);
    assert.equal(settingPayload.interval_minutes, 15);
    assert.equal((await req('/scan/settings', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{bad json' })).status, 400);
    assert.equal((await req('/scan/settings', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ interval_minutes: 4 }) })).status, 400);
    assert.equal((await req('/scan/settings', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: 'x'.repeat(10 * 1024 + 1) })).status, 413);
    const preflight = await req('/scan/settings', { method: 'OPTIONS', headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-API-Key, Content-Type' } });
    assert.equal(preflight.status, 204);

    releaseFetch();
    for (let attempt = 0; attempt < 30 && isScanRunning(); attempt++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(isScanRunning(), false);
    const completed = await (await req('/scan/status', { headers: auth })).json();
    assert.equal(completed.running, false);
    assert.equal(completed.last_scan.trigger, 'manual');
  } finally {
    releaseFetch();
    for (let attempt = 0; attempt < 30 && isScanRunning(); attempt++) await new Promise((resolve) => setImmediate(resolve));
    await api.close();
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
