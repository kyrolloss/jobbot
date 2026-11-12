import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from '../src/server.js';
import { openDb, closeDb } from '../src/db.js';
import { applyNotificationsMigration, getJobCategory, sendPushNotification } from '../src/notifications.js';
import { createRadar } from '../src/radar.js';
import { createEventBus } from '../src/events.js';

const apiKey = 'notifications-test-api-key-at-least-24-chars';
const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
let accountNumber = 0;

function database(t) {
  const db = openDb(':memory:');
  applyNotificationsMigration(db);
  t.after(() => closeDb(db));
  return db;
}

function account(label = `test-${++accountNumber}`) {
  return { project_id: 'offline-project', client_email: `${label}@example.test`, private_key: keyPair.privateKey, token_uri: 'https://oauth2.googleapis.com/token' };
}

function enabledEnv(serviceAccount = account()) {
  return { NOTIFICATIONS_ENABLED: 'true', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount) };
}

function seedToken(db, userId, token, { notificationsEnabled = 1, soundEnabled = 0 } = {}) {
  db.prepare('INSERT INTO device_tokens(user_id,token,notifications_enabled,sound_enabled) VALUES(?,?,?,?)').run(userId, token, notificationsEnabled, soundEnabled);
}

function fakeFetch({ fcmStatus = 200 } = {}) {
  const messages = [], requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://oauth2.googleapis.com/token') {
      return { ok: true, status: 200, json: async () => ({ access_token: 'offline-access-token', expires_in: 3600 }) };
    }
    messages.push(JSON.parse(options.body).message);
    return { ok: fcmStatus >= 200 && fcmStatus < 300, status: fcmStatus };
  };
  return { fetch, messages, requests };
}

async function apiFor(t, db, { planId = 'free', userId = 2 } = {}) {
  const api = createServer({
    db,
    sources: [{ name: 'freelancer' }],
    config: { API_KEY: apiKey, API_HOST: '127.0.0.1', CORS_ORIGINS: [], SAAS_ENABLED: true },
    authProviders: [(request) => request.headers['x-api-key'] === apiKey ? { userId, role: 'user', planId } : null],
    logger: { info() {}, warn() {}, error() {} },
  });
  const address = await api.listen(0, '127.0.0.1');
  t.after(async () => { await api.close(); });
  const base = `http://127.0.0.1:${address.port}`;
  const request = (route, method = 'GET', body) => fetch(`${base}${route}`, {
    method,
    headers: { 'X-API-Key': apiKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { request };
}

test('getJobCategory maps known categories and defaults to other', () => {
  assert.equal(getJobCategory({ tags: ['flutter'] }), 'mobile_app');
  assert.equal(getJobCategory({ tags: ['frontend'] }), 'website');
  assert.equal(getJobCategory({ tags: ['gemini'] }), 'ai');
  assert.equal(getJobCategory({ tags: ['django'] }), 'backend');
  assert.equal(getJobCategory({ tags: ['data-entry'] }), 'other');
  assert.equal(getJobCategory({ tags: ['website', 'flutter'] }), 'mobile_app');
});

test('sendPushNotification skips FCM when notifications are disabled', async (t) => {
  const db = database(t), debug = [], calls = fakeFetch();
  seedToken(db, 1, 'offline-token');
  await sendPushNotification(1, { id: 1, title: 'Job', tags: ['node'] }, {
    db, fetch: calls.fetch, env: { NOTIFICATIONS_ENABLED: 'false', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(account()) }, logger: { debug: (line) => debug.push(line) },
  });
  assert.equal(calls.requests.length, 0);
  assert.deepEqual(debug, ['FCM sending disabled']);
});

test('sendPushNotification builds a high tier FCM v1 payload for eligible sound tokens', async (t) => {
  const db = database(t), calls = fakeFetch();
  seedToken(db, 1, 'high-token', { soundEnabled: 1 });
  await sendPushNotification(1, { id: 44, title: 'Flutter delivery app', score: 8.6, tags: ['flutter'] }, { db, fetch: calls.fetch, env: enabledEnv(account()), logger: { error() {} } });
  assert.equal(calls.messages.length, 1);
  assert.deepEqual(calls.messages[0], {
    token: 'high-token',
    notification: { title: '🔥 وظيفة ممتازة!', body: 'Flutter delivery app — اتقدم بسرعة' },
    android: { priority: 'high', notification: { channel_id: 'high_priority_jobs', sound: 'alarm', notification_priority: 'PRIORITY_MAX', visibility: 'PUBLIC' } },
    apns: { headers: { 'apns-priority': '10', 'apns-push-type': 'alert' }, payload: { aps: { sound: 'alarm.caf', 'interruption-level': 'time-sensitive' } } },
    data: { job_id: '44', category: 'mobile_app', tier: 'high' },
  });
  assert.equal(calls.requests[1].url, 'https://fcm.googleapis.com/v1/projects/offline-project/messages:send');
  assert.equal(calls.requests[1].options.headers.authorization, 'Bearer offline-access-token');
});

test('sendPushNotification builds a normal tier payload below the high threshold', async (t) => {
  const db = database(t), calls = fakeFetch();
  seedToken(db, 1, 'normal-token', { soundEnabled: 1 });
  await sendPushNotification(1, { id: 45, title: 'Website redesign', score: 8.4, tags: ['website'] }, { db, fetch: calls.fetch, env: enabledEnv(account()), logger: { error() {} } });
  assert.equal(calls.messages[0].notification.title, 'وظيفة جديدة');
  assert.equal(calls.messages[0].notification.body, 'Website redesign');
  assert.deepEqual(calls.messages[0].android, { priority: 'normal', notification: { channel_id: 'normal_jobs', sound: 'default' } });
  assert.deepEqual(calls.messages[0].apns, { headers: { 'apns-priority': '5' }, payload: { aps: { sound: 'default' } } });
  assert.deepEqual(calls.messages[0].data, { job_id: '45', category: 'website', tier: 'normal' });
});

test('high tier is downgraded for tokens without the paid sound setting', async (t) => {
  const db = database(t), calls = fakeFetch();
  seedToken(db, 1, 'quiet-token', { soundEnabled: 0 });
  await sendPushNotification(1, { id: 46, title: 'AI helper', score: 95, tags: ['ai'] }, { db, fetch: calls.fetch, env: enabledEnv(account()), logger: { error() {} } });
  assert.equal(calls.messages[0].data.tier, 'normal');
  assert.equal(calls.messages[0].android.priority, 'normal');
});

test('disabled notification category skips sending entirely', async (t) => {
  const db = database(t), calls = fakeFetch();
  seedToken(db, 1, 'category-token');
  db.prepare('INSERT INTO notification_category_prefs(user_id,category,enabled) VALUES(1,\'backend\',0)').run();
  await sendPushNotification(1, { id: 47, title: 'Node API', score: 80, tags: ['node'] }, { db, fetch: calls.fetch, env: enabledEnv(account()), logger: { error() {} } });
  assert.equal(calls.requests.length, 0);
});

test('FCM 404 deletes the invalid device token', async (t) => {
  const db = database(t), calls = fakeFetch({ fcmStatus: 404 });
  seedToken(db, 1, 'stale-token');
  await sendPushNotification(1, { id: 48, title: 'Backend work', score: 50, tags: ['backend'] }, { db, fetch: calls.fetch, env: enabledEnv(account()), logger: { error() {} } });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM device_tokens WHERE token=?').get('stale-token').count, 0);
});

test('POST register disables paid sound for a free plan user', async (t) => {
  const db = database(t), api = await apiFor(t, db);
  const response = await api.request('/notifications/register', 'POST', { token: 'free-user-token', sound_enabled: true });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, sound_enabled: false, sound_notifications_unavailable: true });
  assert.equal(db.prepare('SELECT sound_enabled FROM device_tokens WHERE token=?').get('free-user-token').sound_enabled, 0);
});

test('PATCH settings persists notification categories', async (t) => {
  const db = database(t), api = await apiFor(t, db);
  seedToken(db, 2, 'settings-token');
  const response = await api.request('/notifications/settings', 'PATCH', { categories: { mobile_app: false, backend: false } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, applied: { categories: { mobile_app: false, backend: false } } });
  assert.equal(db.prepare('SELECT enabled FROM notification_category_prefs WHERE user_id=2 AND category=\'mobile_app\'').get().enabled, 0);
  assert.equal(db.prepare('SELECT enabled FROM notification_category_prefs WHERE user_id=2 AND category=\'backend\'').get().enabled, 0);
});

test('GET settings merges category defaults with saved preferences', async (t) => {
  const db = database(t), api = await apiFor(t, db);
  const plans = Object.fromEntries(db.prepare('SELECT id,features FROM plans').all().map((row) => [row.id, JSON.parse(row.features)]));
  assert.equal(Object.hasOwn(plans.free, 'sound_notifications'), false);
  assert.equal(plans.pro.sound_notifications, true);
  assert.equal(plans.power.sound_notifications, true);
  db.prepare('INSERT INTO notification_category_prefs(user_id,category,enabled) VALUES(2,\'mobile_app\',0)').run();
  const response = await api.request('/notifications/settings');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    notifications_enabled: false,
    sound_enabled: false,
    sound_notifications_available: false,
    categories: { mobile_app: false, website: true, ai: true, backend: true },
  });
});

test('radar dispatches FCM after recording a confirmed radar alert', async (t) => {
  const db = database(t), accountData = account();
  seedToken(db, 1, 'radar-alert-token');
  const previousFetch = globalThis.fetch;
  const previousEnabled = process.env.NOTIFICATIONS_ENABLED;
  const previousAccount = process.env.FCM_SERVICE_ACCOUNT_JSON;
  process.env.NOTIFICATIONS_ENABLED = 'true';
  process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify(accountData);
  const calls = fakeFetch();
  globalThis.fetch = calls.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousEnabled === undefined) delete process.env.NOTIFICATIONS_ENABLED; else process.env.NOTIFICATIONS_ENABLED = previousEnabled;
    if (previousAccount === undefined) delete process.env.FCM_SERVICE_ACCOUNT_JSON; else process.env.FCM_SERVICE_ACCOUNT_JSON = previousAccount;
  });

  const now = new Date('2026-04-05T12:00:00.000Z');
  const settingsStore = { read: () => ({ radar_enabled: true }), write: (value) => value };
  const source = {
    name: 'freelancer', queries: ['flutter'],
    async fetchJobs() { return { jobs: [{ source: 'freelancer', external_id: 'radar-fcm', title: 'Flutter mobile app python backend', description: 'Build a Flutter mobile app', url: 'https://example.test/radar-fcm', budget: '$500' }], errors: [] }; },
    async fetchDetails(job) { return job; },
    async fetchStats() { return { bid_count: 3, bid_avg: 100, currency: 'USD', time_submitted: now.getTime() / 1000 - 10 * 60 }; },
  };
  const radar = createRadar({ db, source, events: createEventBus(), settingsStore, clock: { now: () => now }, config: {
    RADAR_ENABLED: true, RADAR_INTERVAL_SECONDS: 120, RADAR_MIN_INTERVAL_SECONDS: 60,
    RADAR_MAX_BACKOFF_SECONDS: 900, RADAR_QUERIES_PER_CYCLE: 1, RADAR_MAX_BIDS: 3,
    RADAR_MIN_SCORE: 6, RADAR_MAX_AGE_MINUTES: 30, RADAR_MAX_ALERTS_PER_HOUR: 6,
    RADAR_QUIET_HOURS: '', RADAR_AUTO_PROPOSAL: false,
  }, logger: { error() {}, debug() {} } });

  assert.equal(await radar.runCycle(), true);
  assert.equal(radar.status().last_cycle_result.alerts, 1, JSON.stringify({ status: radar.status(), jobs: db.prepare('SELECT rowid,title,tags,score,status,radar_alerted_at FROM jobs').all(), logs: [] }));
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.messages[0].data.category, 'mobile_app');
  assert.equal(calls.messages[0].data.tier, 'normal');
});
