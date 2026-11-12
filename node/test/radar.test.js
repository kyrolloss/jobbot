import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, closeDb } from '../src/db.js';
import { createEventBus } from '../src/events.js';
import { createRadar, qualifiesForRadar } from '../src/radar.js';
import { createServer } from '../src/server.js';
import { createSettingsStore } from '../src/settings.js';
import { tryAcquireScanLock } from '../src/scanner.js';
import { SourceError } from '../src/sources/base.js';
import { RADAR_INTERVAL_SECONDS, RADAR_MAX_BIDS, RADAR_MIN_SCORE, RADAR_MAX_AGE_MINUTES, RADAR_MAX_ALERTS_PER_HOUR, RADAR_QUERIES_PER_CYCLE, RADAR_ENABLED } from '../src/config.js';

const fixed = new Date('2026-04-05T12:00:00.000Z');
function fakeClock(initial = fixed) {
  let millis = initial.getTime();
  let mono = 0;
  return {
    now: () => new Date(millis),
    monotonic: () => mono,
    sleep: async (ms) => { mono += ms; millis += ms; },
    advance: (ms) => { millis += ms; mono += ms; },
  };
}
function temporary(t, name = 'radar') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobbot-${name}-`));
  const dbPath = path.join(dir, 'jobs.db');
  const db = openDb(dbPath);
  const settingsStore = createSettingsStore({ filePath: path.join(dir, 'settings.json'), logger: { warn() {} } });
  t.after(() => {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dir, dbPath, db, settingsStore };
}
function fakeTimers(start = fixed) {
  let nowMs = start.getTime();
  let id = 1;
  const timers = new Map();
  const setTimeoutFn = (callback, delay) => { const key = id++; timers.set(key, { callback, due: nowMs + delay }); return key; };
  const clearTimeoutFn = (key) => timers.delete(key);
  async function fireNext() {
    const entry = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
    if (!entry) return false;
    const [key, timer] = entry;
    timers.delete(key); // Fired callbacks are no longer pending timers.
    nowMs = timer.due;
    await timer.callback();
    return true;
  }
  return { timers, setTimeoutFn, clearTimeoutFn, fireNext, clock: { now: () => new Date(nowMs) } };
}
function setRadarEnabled(store, enabled = true) {
  store.write({ ...store.read(), radar_enabled: enabled });
}
function eligibleJob(id) {
  return { source: 'freelancer', external_id: id, title: 'Flutter mobile app python backend', description: 'Build a Flutter mobile app', url: `https://example.test/${id}`, budget: '$500' };
}
function eligibleStats(now = fixed) {
  return { bid_count: 3, bid_avg: 100, currency: 'USD', time_submitted: now.getTime() / 1000 - 10 * 60 };
}
function quietWindowAt(date) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', hour: '2-digit', hourCycle: 'h23' }).format(date));
  return `${hour}-${(hour + 1) % 24}`;
}

test('radar defaults and qualification boundaries match Python rules', () => {
  assert.equal(RADAR_ENABLED, false);
  assert.equal(RADAR_INTERVAL_SECONDS, 120);
  assert.equal(RADAR_MAX_BIDS, 3);
  assert.equal(RADAR_MIN_SCORE, 6);
  assert.equal(RADAR_MAX_AGE_MINUTES, 30);
  assert.equal(RADAR_MAX_ALERTS_PER_HOUR, 6);
  assert.equal(RADAR_QUERIES_PER_CYCLE, 2);

  const now = new Date('2026-04-05T12:00:00.000Z');
  const atThirty = { bid_count: 3, time_submitted: now.getTime() / 1000 - 30 * 60 };
  assert.equal(qualifiesForRadar({ stats: atThirty, score: 6, now, alertsLastHour: 5 }), true);
  assert.equal(qualifiesForRadar({ stats: { ...atThirty, bid_count: 4 }, score: 6, now }), false);
  assert.equal(qualifiesForRadar({ stats: atThirty, score: 5.9, now }), false);
  assert.equal(qualifiesForRadar({ stats: { ...atThirty, time_submitted: now.getTime() / 1000 - 31 * 60 }, score: 6, now }), false);
  assert.equal(qualifiesForRadar({ stats: atThirty, score: 6, now, alertsLastHour: 6 }), false);
  assert.equal(qualifiesForRadar({ stats: atThirty, score: 6, now, config: { RADAR_MAX_BIDS: 3, RADAR_MIN_SCORE: 6, RADAR_MAX_AGE_MINUTES: 30, RADAR_MAX_ALERTS_PER_HOUR: 6, RADAR_QUIET_HOURS: quietWindowAt(now) } }), false);
});

test('radar rotates Freelancer queries and shares the nonblocking scanner lock', async (t) => {
  const { db, settingsStore } = temporary(t, 'radar-rotation');
  setRadarEnabled(settingsStore);
  const queries = ['flutter', 'mobile app', 'python'];
  const seen = [];
  const source = { name: 'freelancer', queries: [...queries], async fetchJobs() { seen.push([...this.queries]); return { jobs: [], errors: [] }; } };
  const radar = createRadar({ db, source, settingsStore, clock: fakeClock(), logger: { debug() {}, error() {} } });
  assert.equal(await radar.runCycle(), true);
  assert.equal(await radar.runCycle(), true);
  assert.deepEqual(seen, [['flutter', 'mobile app'], ['python', 'flutter']]);
  assert.deepEqual(source.queries, queries);

  let busyFetches = 0;
  source.fetchJobs = async () => { busyFetches++; return { jobs: [], errors: [] }; };
  const debugLines = [];
  const busyRadar = createRadar({ db, source, settingsStore, clock: fakeClock(), logger: { debug: (line) => debugLines.push(line), error() {} } });
  const release = tryAcquireScanLock();
  try {
    assert.equal(await busyRadar.runCycle(), false);
    assert.equal(busyFetches, 0);
    assert.equal(debugLines.length, 1);
  } finally { release(); }
});

test('radar backs off on structured 429, 5xx, and network errors, honors retry-after, then resets', async (t) => {
  const { db, settingsStore } = temporary(t, 'radar-backoff');
  setRadarEnabled(settingsStore);
  const results = [
    { jobs: [], errors: [new SourceError({ source: 'freelancer', kind: 'rate_limit', status: 429, message: 'rate limited' })] },
    { jobs: [], errors: [new SourceError({ source: 'freelancer', kind: 'server', status: 503, message: 'server failure' })] },
    { jobs: [], errors: [{ kind: 'network', status: null, retryAfterSeconds: 700, message: 'temporary network issue' }] },
    { jobs: [], errors: [{ kind: 'network', status: null, message: 'network issue' }] },
    { jobs: [], errors: [] },
  ];
  const source = { name: 'freelancer', queries: ['one', 'two'], async fetchJobs() { return results.shift(); } };
  const radar = createRadar({ db, source, settingsStore, clock: fakeClock(), logger: { error() {} } });
  const observed = [];
  for (let i = 0; i < 5; i++) { await radar.runCycle(); observed.push(radar.status().backoff_seconds); }
  assert.deepEqual(observed, [240, 480, 700, 900, RADAR_INTERVAL_SECONDS]);
});

test('disabled radar stays idle; timers are removed on stop and stale callbacks cannot run', async (t) => {
  const { db, settingsStore } = temporary(t, 'radar-timers');
  const fake = fakeTimers();
  let fetches = 0;
  const source = { name: 'freelancer', queries: ['one'], async fetchJobs() { fetches++; return { jobs: [], errors: [] }; } };
  const radar = createRadar({ db, source, settingsStore, clock: fake.clock, setTimeoutFn: fake.setTimeoutFn, clearTimeoutFn: fake.clearTimeoutFn, logger: { error() {} } });
  radar.start();
  assert.equal(fake.timers.size, 0);
  assert.equal(await radar.runCycle(), false);
  assert.equal(fetches, 0);

  radar.enable();
  radar.start();
  assert.equal(fake.timers.size, 1);
  const stale = [...fake.timers.values()][0].callback;
  radar.stop();
  assert.equal(fake.timers.size, 0);
  await stale();
  assert.equal(fetches, 0);
});

test('radar saves sent jobs, emits new_job and radar_alert, and persists hourly alert caps across DB reopen', async (t) => {
  const { dir, dbPath, db, settingsStore } = temporary(t, 'radar-alerts');
  setRadarEnabled(settingsStore);
  const clock = fakeClock();
  const events = createEventBus();
  const observed = [];
  events.subscribe((event) => observed.push(event));
  const source = {
    name: 'freelancer', queries: ['flutter'],
    async fetchJobs() { return { jobs: [eligibleJob('first-alert')], errors: [] }; },
    async fetchDetails(job) { return job; },
    async fetchStats() { return eligibleStats(clock.now()); },
  };
  const radar = createRadar({ db, source, events, settingsStore, clock, config: {
    RADAR_ENABLED: false, RADAR_INTERVAL_SECONDS: 120, RADAR_MIN_INTERVAL_SECONDS: 60,
    RADAR_MAX_BACKOFF_SECONDS: 900, RADAR_QUERIES_PER_CYCLE: 1, RADAR_MAX_BIDS: 3,
    RADAR_MIN_SCORE: 6, RADAR_MAX_AGE_MINUTES: 30, RADAR_MAX_ALERTS_PER_HOUR: 1, RADAR_QUIET_HOURS: '',
  }, logger: { error() {} } });
  let activeDb = db;
  try {
    assert.equal(await radar.runCycle(), true);
    assert.deepEqual(observed.map((event) => event.type), ['new_job', 'radar_alert']);
    assert.equal(observed[0].data.status, 'sent');
    assert.equal(observed[0].data.created_at, '2026-04-05T12:00:00Z');
    assert.equal(observed[1].data.bid_count, 3);
    assert.equal(observed[1].data.age_minutes, 10);
    assert.equal(observed[1].data.description, undefined);
    assert.equal(db.prepare('SELECT created_at FROM jobs WHERE external_id=?').get('first-alert').created_at, '2026-04-05 12:00:00');
    assert.equal(radar.status().last_cycle_result.alerts, 1);
    closeDb(db);

    const reopened = openDb(dbPath);
    activeDb = reopened;
    const sourceAfterRestart = {
      name: 'freelancer', queries: ['flutter'],
      async fetchJobs() { return { jobs: [eligibleJob('second-alert')], errors: [] }; },
      async fetchDetails(job) { return job; },
      async fetchStats() { return eligibleStats(clock.now()); },
    };
    const restartedEvents = createEventBus();
    const restartedRadar = createRadar({ db: reopened, source: sourceAfterRestart, events: restartedEvents, settingsStore, clock, config: {
      RADAR_ENABLED: false, RADAR_INTERVAL_SECONDS: 120, RADAR_MIN_INTERVAL_SECONDS: 60,
      RADAR_MAX_BACKOFF_SECONDS: 900, RADAR_QUERIES_PER_CYCLE: 1, RADAR_MAX_BIDS: 3,
      RADAR_MIN_SCORE: 6, RADAR_MAX_AGE_MINUTES: 30, RADAR_MAX_ALERTS_PER_HOUR: 1, RADAR_QUIET_HOURS: '',
    }, logger: { error() {} } });
    await restartedRadar.runCycle();
    assert.equal(restartedRadar.status().alerts_last_hour, 1);
    assert.equal(restartedEvents.getSince(0).some((event) => event.type === 'radar_alert'), false);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM jobs WHERE status=\'sent\'').get().n, 2);
  } finally {
    closeDb(activeDb);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('radar on/off API persists its flag, preserves scanner settings, and serializes SQL timestamps', async (t) => {
  const { dir, db, settingsStore } = temporary(t, 'radar-api');
  const key = 'radar-api-test-secret-key-with-at-least-24-chars';
  const events = createEventBus();
  const source = {
    name: 'freelancer', queries: ['flutter'],
    async fetchJobs() { return { jobs: [eligibleJob('api-timestamp')], errors: [] }; },
    async fetchDetails(job) { return job; }, async fetchStats() { return {}; },
  };
  const radar = createRadar({ db, source, events, settingsStore, clock: fakeClock(), logger: { error() {} } });
  const api = createServer({ db, sources: [source], events, radar, settingsStore, config: { API_KEY: key, API_HOST: '127.0.0.1', CORS_ORIGINS: [], EVENTS_MAX_CLIENTS: 5 }, logger: { info() {}, warn() {}, error() {} } });
  try {
    const address = await api.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { 'X-API-Key': key };
    const getJson = async (route) => (await fetch(`${base}${route}`, { headers })).json();
    assert.deepEqual(await getJson('/radar/status'), {
      enabled: false, running_cycle: false, interval_seconds: 120, last_cycle_at: null,
      last_cycle_result: null, alerts_last_hour: 0, max_alerts_per_hour: 6, next_cycle_at: null, backoff_seconds: 120,
    });
    assert.equal((await fetch(`${base}/radar/on`, { method: 'POST', headers })).status, 200);
    assert.equal(settingsStore.read().radar_enabled, true);
    assert.equal(settingsStore.read().scan_enabled, false);
    assert.equal((await fetch(`${base}/scan/settings`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, interval_minutes: 20 }) })).status, 200);
    assert.equal(settingsStore.read().radar_enabled, true);

    await radar.runCycle();
    const list = await getJson('/jobs');
    const item = list.items.find((job) => job.external_id === 'api-timestamp');
    assert.equal(item.created_at, '2026-04-05T12:00:00Z');
    assert.equal(db.prepare('SELECT created_at FROM jobs WHERE external_id=?').get('api-timestamp').created_at, '2026-04-05 12:00:00');
    db.prepare('UPDATE jobs SET posted_at=?,applied_at=? WHERE external_id=?').run('2026-04-05 11:59:00', '2026-04-05 12:10:00', 'api-timestamp');
    const detail = await getJson(`/jobs/${item.id}`);
    assert.equal(detail.created_at, '2026-04-05T12:00:00Z');
    assert.equal(detail.posted_at, '2026-04-05T11:59:00Z');
    assert.equal(detail.applied_at, '2026-04-05T12:10:00Z');
    assert.equal(detail.stats.posted_at, '2026-04-05T11:59:00Z');

    assert.equal((await fetch(`${base}/radar/off`, { method: 'POST', headers })).status, 200);
    assert.equal(settingsStore.read().radar_enabled, false);
    assert.equal(settingsStore.read().scan_enabled, true);
    assert.equal((await fetch(`${base}/radar/status`, { method: 'POST', headers })).status, 405);
    assert.equal((await fetch(`${base}/radar/missing`, { headers })).status, 404);
  } finally {
    await api.close();
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('radar cycle continues when its event emitter throws', async (t) => {
  const { dir, db, settingsStore } = temporary(t, 'radar-throwing-events');
  setRadarEnabled(settingsStore);
  const source = {
    name: 'freelancer', queries: ['flutter'],
    async fetchJobs() { return { jobs: [eligibleJob('throwing-event')], errors: [] }; },
    async fetchDetails(job) { return job; }, async fetchStats() { return eligibleStats(fixed); },
  };
  const errors = [];
  const radar = createRadar({ db, source, events: { emit() { throw new Error('dispatch error'); } }, settingsStore, clock: fakeClock(), logger: { error: (line) => errors.push(line) } });
  try {
    assert.equal(await radar.runCycle(), true);
    assert.equal(radar.status().last_cycle_result.saved, 1);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE external_id=?').get('throwing-event').status, 'sent');
    assert.ok(errors.some((line) => line === 'Scanner event emission failed'));
    assert.ok(errors.some((line) => line === 'Radar alert emission failed'));
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
