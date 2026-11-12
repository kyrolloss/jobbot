import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsStore } from '../src/settings.js';
import { createScheduler } from '../src/scheduler.js';
import { tryAcquireScanLock } from '../src/scanner.js';
import { INTERVAL_MINUTES } from '../src/config.js';

function temporarySettings(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { dir, store: createSettingsStore({ filePath: path.join(dir, 'settings.json'), logger: { warn() {} } }) };
}

function fakeTimerHarness(start = '2026-01-01T00:00:00.000Z') {
  let now = new Date(start).getTime();
  let nextId = 1;
  const timers = new Map();
  const setTimeoutFn = (callback, delay) => {
    const id = nextId++;
    timers.set(id, { callback, due: now + delay });
    return id;
  };
  const clearTimeoutFn = (id) => timers.delete(id);
  async function fireNext() {
    const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
    if (!next) return false;
    const [id, timer] = next;
    timers.delete(id); // A real timer is no longer pending once its callback fires.
    now = timer.due;
    await timer.callback();
    return true;
  }
  async function advanceBy(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > target) break;
      await fireNext();
    }
    now = target;
  }
  return { timers, clock: { now: () => new Date(now) }, setTimeoutFn, clearTimeoutFn, fireNext, advanceBy };
}

test('settings persist atomically, create defaults, and recover corrupt files with one warning', (t) => {
  const { dir, store } = temporarySettings(t);
  assert.deepEqual(store.read(), { scan_enabled: false, interval_minutes: INTERVAL_MINUTES });
  assert.equal(fs.existsSync(store.filePath), true);
  assert.deepEqual(store.write({ scan_enabled: true, interval_minutes: 25 }), { scan_enabled: true, interval_minutes: 25 });
  assert.deepEqual(JSON.parse(fs.readFileSync(store.filePath, 'utf8')), { scan_enabled: true, interval_minutes: 25 });
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);

  const logs = [];
  fs.writeFileSync(store.filePath, '{truncated', 'utf8');
  const recoveredStore = createSettingsStore({ filePath: store.filePath, logger: { warn: (line) => logs.push(line) } });
  assert.deepEqual(recoveredStore.read(), { scan_enabled: false, interval_minutes: INTERVAL_MINUTES });
  assert.deepEqual(recoveredStore.read(), { scan_enabled: false, interval_minutes: INTERVAL_MINUTES });
  assert.equal(logs.length, 1);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
});

test('scheduler stays idle when disabled; enabled schedule adds 0-5 minute jitter and reschedules updates', async (t) => {
  const { store } = temporarySettings(t);
  const fake = fakeTimerHarness();
  const { timers } = fake;
  const cleared = [];
  const delays = [];
  let scanArgs;
  const scheduler = createScheduler({
    settingsStore: store,
    clock: fake.clock,
    random: () => 0.4,
    setTimeoutFn(callback, delay) { delays.push(delay); return fake.setTimeoutFn(callback, delay); },
    clearTimeoutFn(id) { cleared.push(id); fake.clearTimeoutFn(id); },
    async scan(args) { scanArgs = args; },
    logger: { warn() {}, error() {} },
  });
  scheduler.start();
  assert.equal(timers.size, 0);
  assert.equal(scheduler.status().next_run_at, null);

  const enabled = store.write({ scan_enabled: true, interval_minutes: 5 });
  scheduler.updateSettings(enabled);
  assert.equal(delays.at(-1), 5 * 60_000 + 0.4 * 5 * 60_000);
  assert.equal(scheduler.status().next_run_at, '2026-01-01T00:07:00.000Z');
  const firstId = [...timers.keys()][0];
  const changed = store.write({ scan_enabled: true, interval_minutes: 10 });
  scheduler.updateSettings(changed);
  assert.ok(cleared.includes(firstId));
  assert.equal(delays.at(-1), 10 * 60_000 + 0.4 * 5 * 60_000);

  await fake.fireNext();
  assert.equal(scanArgs.trigger, 'scheduled');
  assert.equal(typeof scanArgs.lock, 'function');
  scheduler.stop();
  assert.equal(timers.size, 0);
  assert.equal(scheduler.status().next_run_at, null);
});

test('scheduler skips a due cycle once when the shared scan lock is busy', async (t) => {
  const { store } = temporarySettings(t);
  store.write({ scan_enabled: true, interval_minutes: 5 });
  const fake = fakeTimerHarness();
  const { timers } = fake;
  const warnings = [];
  const scheduler = createScheduler({
    settingsStore: store,
    clock: fake.clock, random: () => 0,
    setTimeoutFn: fake.setTimeoutFn,
    clearTimeoutFn: fake.clearTimeoutFn,
    logger: { warn: (line) => warnings.push(line), error() {} },
  });
  scheduler.start();
  const release = tryAcquireScanLock();
  try {
    await fake.fireNext();
    assert.equal(warnings.length, 1);
    assert.equal(timers.size, 1, 'a later cycle is scheduled');
  } finally { release(); scheduler.stop(); }
});

test('rapid settings changes keep at most one timer and disabled or stopped schedulers never scan', async (t) => {
  const { store } = temporarySettings(t);
  const fake = fakeTimerHarness();
  let scans = 0;
  const scheduler = createScheduler({
    settingsStore: store, clock: fake.clock, random: () => 0,
    setTimeoutFn: fake.setTimeoutFn, clearTimeoutFn: fake.clearTimeoutFn,
    async scan() { scans++; }, logger: { warn() {}, error() {} },
  });
  scheduler.start();
  for (const value of [
    { scan_enabled: true, interval_minutes: 5 },
    { scan_enabled: true, interval_minutes: 6 },
    { scan_enabled: true, interval_minutes: 7 },
    { scan_enabled: false, interval_minutes: 7 },
  ]) {
    scheduler.updateSettings(value);
    assert.ok(fake.timers.size <= 1);
  }
  assert.equal(fake.timers.size, 0);
  await fake.advanceBy(365 * 24 * 60 * 60 * 1000);
  assert.equal(scans, 0);

  scheduler.updateSettings({ scan_enabled: true, interval_minutes: 5 });
  assert.equal(fake.timers.size, 1);
  scheduler.stop();
  assert.equal(fake.timers.size, 0);
  await fake.advanceBy(365 * 24 * 60 * 60 * 1000);
  assert.equal(scans, 0);
});

test('a scan finishing after settings change leaves one timer chain', async (t) => {
  const { store } = temporarySettings(t);
  store.write({ scan_enabled: true, interval_minutes: 5 });
  const fake = fakeTimerHarness();
  let finishScan;
  let scanCount = 0;
  const scanWait = new Promise((resolve) => { finishScan = resolve; });
  const scheduler = createScheduler({
    settingsStore: store, clock: fake.clock, random: () => 0,
    setTimeoutFn: fake.setTimeoutFn, clearTimeoutFn: fake.clearTimeoutFn,
    async scan() { scanCount++; await scanWait; }, logger: { warn() {}, error() {} },
  });
  scheduler.start();
  const runningCallback = fake.fireNext();
  assert.equal(scanCount, 1);
  scheduler.updateSettings({ scan_enabled: true, interval_minutes: 10 });
  assert.equal(fake.timers.size, 1);
  scheduler.updateSettings({ scan_enabled: true, interval_minutes: 15 });
  assert.equal(fake.timers.size, 1);
  finishScan();
  await runningCallback;
  assert.equal(fake.timers.size, 1);
  scheduler.stop();
  assert.equal(fake.timers.size, 0);
});
