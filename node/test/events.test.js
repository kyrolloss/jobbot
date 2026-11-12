import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEventBus } from '../src/events.js';
import { createServer } from '../src/server.js';
import { openDb, closeDb } from '../src/db.js';
import { runScan } from '../src/scanner.js';

const testClock = () => {
  let elapsed = 0;
  return { now: () => new Date('2026-03-04T05:06:07.000Z'), monotonic: () => elapsed, sleep: async (ms) => { elapsed += ms; } };
};

function temporaryDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-events-'));
  return { dir, db: openDb(path.join(dir, 'events.db')) };
}

async function waitUntil(predicate, attempts = 30) {
  for (let i = 0; i < attempts && !predicate(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(predicate(), true, 'condition should become true');
}

async function readUntil(reader, marker, initial = '') {
  let text = initial;
  const decoder = new TextDecoder();
  while (!text.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before ${marker}`);
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

async function readToDone(reader) {
  while (true) {
    const { done } = await reader.read();
    if (done) return;
  }
}

test('event bus retains ordered ids, replays since an id, resets on overflow, and unsubscribes', () => {
  const errors = [];
  const bus = createEventBus({ bufferSize: 3, now: () => new Date('2026-01-02T03:04:05.000Z'), onListenerError: (error) => errors.push(error.message) });
  const seen = [];
  const unsubscribe = bus.subscribe((event) => seen.push(event));
  const first = bus.emit('one', { value: 1 });
  bus.emit('two', { value: 2 });
  bus.emit('three', { value: 3 });
  const fourth = bus.emit('four', { value: 4 });
  assert.equal(first.id, 1);
  assert.equal(fourth.id, 4);
  assert.equal(fourth.timestamp, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(bus.getSince(1).map((event) => event.id), [2, 3, 4]);
  assert.deepEqual(bus.getSince(0), { reset: true });
  assert.deepEqual(bus.getSince(4), []);
  assert.deepEqual(seen.map((event) => event.id), [1, 2, 3, 4]);
  unsubscribe();
  unsubscribe();
  bus.emit('five', { value: 5 });
  assert.equal(bus.listenerCount(), 0);
  assert.equal(seen.length, 4);

  const surviving = [];
  bus.subscribe(() => { throw new Error('listener failure'); });
  bus.subscribe((event) => surviving.push(event.type));
  bus.emit('six', {});
  assert.deepEqual(surviving, ['six']);
  assert.deepEqual(errors, ['listener failure']);
});

test('GET /events authenticates, replays, streams exact SSE, sends keepalives, limits clients, and cleans up', async () => {
  const { dir, db } = temporaryDb();
  const events = createEventBus({ bufferSize: 3 });
  events.emit('sample', { n: 1 });
  events.emit('sample', { n: 2 });
  events.emit('sample', { n: 3 });
  events.emit('sample', { n: 4 });
  const key = 'events-test-api-key-with-more-than-24-chars';
  const api = createServer({ db, events, config: {
    API_KEY: key, API_HOST: '127.0.0.1', CORS_ORIGINS: [], API_REQUEST_TIMEOUT_MS: 40,
    EVENTS_MAX_CLIENTS: 1, EVENTS_KEEPALIVE_SECONDS: 0.015, EVENTS_MAX_BUFFER_BYTES: 4096,
  }, logger: { info() {}, warn() {}, error() {} } });
  let activeReader = null;
  try {
    const address = await api.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/events`)).status, 401);

    const resetResponse = await fetch(`${base}/events`, { headers: { 'X-API-Key': key, 'Last-Event-ID': '0' } });
    assert.equal(resetResponse.status, 200);
    const resetReader = resetResponse.body.getReader();
    let resetText = await readUntil(resetReader, 'event: reset');
    resetText = await readUntil(resetReader, 'data: {"user_id":1,"reason":"buffer_overflow","action":"refetch_jobs"}\n\n', resetText);
    assert.match(resetText, /id: 4\nevent: reset\ndata: \{"user_id":1,"reason":"buffer_overflow","action":"refetch_jobs"\}\n\n/);
    await resetReader.cancel();
    await waitUntil(() => events.listenerCount() === 0);

    const response = await fetch(`${base}/events`, { headers: { 'X-API-Key': key, 'Last-Event-ID': '2' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    activeReader = response.body.getReader();
    let text = await readUntil(activeReader, ': connected\n\n');
    text = await readUntil(activeReader, 'id: 4\nevent: sample\ndata: {"n":4}\n\n', text);
    assert.match(text, /id: 3\nevent: sample\ndata: \{"n":3\}\n\n/);

    const refused = await fetch(`${base}/events`, { headers: { 'X-API-Key': key } });
    assert.equal(refused.status, 503);
    assert.equal((await refused.json()).error.code, 'EVENTS_CLIENT_LIMIT');

    events.emit('sample', { message: 'hello' });
    text = await readUntil(activeReader, 'event: sample\ndata: {"message":"hello"}\n\n', text);
    assert.match(text, /id: 5\nevent: sample\ndata: \{"message":"hello"\}\n\n/);
    text = await readUntil(activeReader, ': keep-alive\n\n', text);
    assert.match(text, /: keep-alive\n\n/);

    await activeReader.cancel();
    activeReader = null;
    await waitUntil(() => events.listenerCount() === 0);

    const finalResponse = await fetch(`${base}/events`, { headers: { 'X-API-Key': key } });
    activeReader = finalResponse.body.getReader();
    await readUntil(activeReader, ': connected\n\n');
    await api.close();
    await readToDone(activeReader);
    activeReader = null;
    assert.equal(events.listenerCount(), 0);
  } finally {
    if (activeReader) await activeReader.cancel().catch(() => {});
    await api.close();
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('scanner emits sent-job and scan-finished events; throwing listeners or emitters do not break scans', async () => {
  const { dir, db } = temporaryDb();
  const events = createEventBus();
  const observed = [];
  events.subscribe((event) => observed.push(event));
  events.subscribe(() => { throw new Error('subscriber failed'); });
  const source = {
    name: 'freelancer',
    async fetchJobs() { return { jobs: [
      { source: 'freelancer', external_id: 'sent-job', title: 'Flutter mobile app', description: 'Build a Flutter app', url: 'https://example.test/1', budget: '$500' },
      { source: 'freelancer', external_id: 'skip-job', title: 'Logo design', description: 'Logo only', url: 'https://example.test/2', budget: '' },
    ], errors: [] }; },
    async fetchDetails(job) { return job; },
    async fetchStats() { return {}; },
  };
  try {
    const summary = await runScan({ db, sources: [source], clock: testClock(), events, logger: { error() {} } });
    assert.deepEqual(observed.map((event) => event.type), ['new_job', 'scan_finished']);
    const newJob = observed[0].data;
    assert.deepEqual(Object.keys(newJob), ['user_id', 'id', 'source', 'external_id', 'title', 'url', 'budget', 'score', 'score_line', 'tags', 'status', 'created_at', 'posted_at']);
    assert.equal(newJob.user_id, 1);
    assert.equal(newJob.status, 'sent');
    assert.equal(newJob.external_id, 'sent-job');
    assert.equal(newJob.created_at, '2026-03-04T05:06:07Z');
    assert.equal(newJob.description, undefined);
    assert.deepEqual(observed[1].data, { ...summary, user_id: 1 });
    assert.equal(summary.per_source.freelancer.filtered_out, 1);

    const logLines = [];
    const throwingEvents = { emit() { throw new Error('event dispatch failure'); } };
    const secondSummary = await runScan({ db, sources: [{
      name: 'freelancer',
      async fetchJobs() { return { jobs: [{ source: 'freelancer', external_id: 'second', title: 'Flutter app', description: '', url: 'https://example.test/3', budget: '' }], errors: [] }; },
      async fetchDetails(job) { return job; }, async fetchStats() { return {}; },
    }], clock: testClock(), events: throwingEvents, logger: { error: (line) => logLines.push(line) } });
    assert.equal(secondSummary.per_source.freelancer.new_saved, 1);
    assert.ok(logLines.length >= 2);
    assert.ok(logLines.every((line) => line === 'Scanner event emission failed'));
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
