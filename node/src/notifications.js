import './config.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './db.js';

const migrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations/20261112_add_device_notifications.sql');
const migrated = new WeakSet();
const cachedTokens = new Map();
const DEFAULT_CATEGORIES = Object.freeze({ mobile_app: true, website: true, ai: true, backend: true });
const HIGH_SCORE_THRESHOLD = 8.5;

export function applyNotificationsMigration(db = connect()) {
  if (migrated.has(db)) return;
  db.exec(fs.readFileSync(migrationPath, 'utf8'));
  migrated.add(db);
}

function tagsOf(job) {
  if (Array.isArray(job?.tags)) return job.tags.map((tag) => String(tag).toLowerCase());
  if (typeof job?.tags === 'string') {
    try {
      const parsed = JSON.parse(job.tags);
      if (Array.isArray(parsed)) return parsed.map((tag) => String(tag).toLowerCase());
    } catch { return job.tags.toLowerCase().split(/[\s,;]+/).filter(Boolean); }
  }
  return [];
}

export function getJobCategory(job = {}) {
  const tags = tagsOf(job);
  const includesAny = (values) => tags.some((tag) => values.some((value) => tag.includes(value)));
  if (includesAny(['mobile', 'flutter', 'android', 'ios'])) return 'mobile_app';
  if (includesAny(['website', 'frontend', 'wordpress'])) return 'website';
  if (includesAny(['ai', 'ml', 'llm', 'gemini', 'openai'])) return 'ai';
  if (includesAny(['backend', 'api', 'node', 'python', 'django'])) return 'backend';
  return 'other';
}

function error(status, code, message) {
  const failure = new Error(message);
  failure.status = status;
  failure.code = code;
  return failure;
}

function hasSoundFeature(db, planId) {
  if (!planId) return false;
  const row = db.prepare('SELECT features FROM plans WHERE id=?').get(planId);
  try { return JSON.parse(row?.features || '{}').sound_notifications === true; }
  catch { return false; }
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') throw error(400, 'INVALID_PARAMETER', `${name} must be a boolean`);
}

function parseAccount(env) {
  try {
    const account = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON || '');
    if (typeof account.project_id !== 'string' || typeof account.client_email !== 'string' || typeof account.private_key !== 'string') return null;
    return account;
  } catch { return null; }
}

function base64url(value) { return Buffer.from(value).toString('base64url'); }

async function accessToken(account, fetchImpl, now) {
  const cached = cachedTokens.get(account.client_email);
  if (cached && cached.expiresAt > now() + 60_000) return { token: cached.token };
  const issuedAt = Math.floor(now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: account.token_uri || 'https://oauth2.googleapis.com/token',
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url');
  const assertion = `${unsigned}.${signature}`;
  const response = await fetchImpl(account.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  if (!response?.ok) return { status: Number.isInteger(response?.status) ? response.status : null };
  let payload;
  try { payload = await response.json(); } catch { return { status: Number.isInteger(response.status) ? response.status : null }; }
  if (typeof payload?.access_token !== 'string' || !payload.access_token) return { status: Number.isInteger(response.status) ? response.status : null };
  const lifetime = Number(payload.expires_in);
  cachedTokens.set(account.client_email, { token: payload.access_token, expiresAt: now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600) * 1000 });
  return { token: payload.access_token };
}

function logHttpStatus(logger, status) {
  if (Number.isInteger(status)) logger?.error?.(status);
  else logger?.error?.('FCM HTTP status unavailable');
}

function logDisabled(logger) {
  if (typeof logger?.debug === 'function') logger.debug('FCM sending disabled');
  else console.debug('FCM sending disabled');
}

function toFcmMessage(token, job, category, tier) {
  const high = tier === 'high';
  return {
    message: {
      token,
      notification: {
        title: high ? '🔥 وظيفة ممتازة!' : 'وظيفة جديدة',
        body: high ? `${String(job.title || '')} — اتقدم بسرعة` : String(job.title || ''),
      },
      android: {
        priority: high ? 'high' : 'normal',
        notification: high
          ? { channel_id: 'high_priority_jobs', sound: 'alarm', notification_priority: 'PRIORITY_MAX', visibility: 'PUBLIC' }
          : { channel_id: 'normal_jobs', sound: 'default' },
      },
      apns: high
        ? { headers: { 'apns-priority': '10', 'apns-push-type': 'alert' }, payload: { aps: { sound: 'alarm.caf', 'interruption-level': 'time-sensitive' } } }
        : { headers: { 'apns-priority': '5' }, payload: { aps: { sound: 'default' } } },
      data: { job_id: String(job.id ?? ''), category, tier },
    },
  };
}

export async function sendPushNotification(userId, job, {
  db = connect(), fetch: fetchImpl = globalThis.fetch, env = process.env, logger = console, now = () => Date.now(),
} = {}) {
  try {
    applyNotificationsMigration(db);
    const tokens = db.prepare('SELECT id,token,sound_enabled FROM device_tokens WHERE user_id=? AND notifications_enabled=1').all(userId);
    if (!tokens.length) return;
    if (env.NOTIFICATIONS_ENABLED !== 'true') { logDisabled(logger); return; }

    const category = typeof job?.category === 'string' && job.category ? job.category : getJobCategory(job);
    const preference = db.prepare('SELECT enabled FROM notification_category_prefs WHERE user_id=? AND category=?').get(userId, category);
    if (preference && preference.enabled === 0) return;

    const defaultTier = Number(job?.score) >= HIGH_SCORE_THRESHOLD ? 'high' : 'normal';
    const candidates = tokens.map((row) => ({ row, tier: defaultTier === 'high' && row.sound_enabled !== 1 ? 'normal' : defaultTier }));
    if (!candidates.length) return;
    const account = parseAccount(env);
    if (!account) { logger?.debug?.('FCM service account unavailable'); return; }
    const auth = await accessToken(account, fetchImpl, now);
    if (!auth.token) { logHttpStatus(logger, auth.status); return; }

    const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`;
    for (const { row, tier } of candidates) {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(toFcmMessage(row.token, job || {}, category, tier)),
        });
        if (response?.status === 404 || response?.status === 410) {
          db.prepare('DELETE FROM device_tokens WHERE id=? AND user_id=?').run(row.id, userId);
        } else if (!response?.ok) logHttpStatus(logger, Number.isInteger(response?.status) ? response.status : null);
      } catch { logHttpStatus(logger, null); }
    }
  } catch (failure) {
    logHttpStatus(logger, Number.isInteger(failure?.status) ? failure.status : null);
  }
}

export function handleNotificationRequest(action, { body, db = connect(), principal, logger = console } = {}) {
  applyNotificationsMigration(db);
  if (!principal || !Number.isSafeInteger(principal.userId)) throw error(401, 'UNAUTHORIZED', 'A valid API key is required');
  const userId = principal.userId;

  if (action === 'register') {
    if (!body || typeof body.token !== 'string' || !body.token.trim()) throw error(400, 'INVALID_PARAMETER', 'token must be a non-empty string');
    if (body.notifications_enabled !== undefined) requireBoolean(body.notifications_enabled, 'notifications_enabled');
    if (body.sound_enabled !== undefined) requireBoolean(body.sound_enabled, 'sound_enabled');
    const soundUnavailable = body.sound_enabled === true && !hasSoundFeature(db, principal.planId);
    const soundEnabled = body.sound_enabled === undefined ? 0 : Number(body.sound_enabled && !soundUnavailable);
    const notificationsEnabled = body.notifications_enabled === undefined ? 1 : Number(body.notifications_enabled);
    db.prepare(`INSERT INTO device_tokens(user_id,token,notifications_enabled,sound_enabled)
      VALUES(?,?,?,?) ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id,
      notifications_enabled=excluded.notifications_enabled,sound_enabled=excluded.sound_enabled,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run(userId, body.token.trim(), notificationsEnabled, soundEnabled);
    return { ok: true, sound_enabled: Boolean(soundEnabled), ...(soundUnavailable ? { sound_notifications_unavailable: true } : {}) };
  }

  if (action === 'unregister') {
    if (!body || typeof body.token !== 'string' || !body.token.trim()) throw error(400, 'INVALID_PARAMETER', 'token must be a non-empty string');
    db.prepare('DELETE FROM device_tokens WHERE token=? AND user_id=?').run(body.token.trim(), userId);
    return { ok: true };
  }

  if (action === 'patchSettings') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'INVALID_PARAMETER', 'Request body must be an object');
    const applied = {};
    for (const field of ['notifications_enabled', 'sound_enabled']) {
      if (body[field] === undefined) continue;
      requireBoolean(body[field], field);
      if (field === 'sound_enabled' && body[field] && !hasSoundFeature(db, principal.planId)) {
        db.prepare('UPDATE device_tokens SET sound_enabled=0,updated_at=strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\') WHERE user_id=?').run(userId);
        applied.sound_enabled = false;
        applied.sound_notifications_unavailable = true;
      } else {
        db.prepare(`UPDATE device_tokens SET ${field}=?,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE user_id=?`).run(Number(body[field]), userId);
        applied[field] = body[field];
      }
    }
    if (body.categories !== undefined) {
      if (!body.categories || typeof body.categories !== 'object' || Array.isArray(body.categories)
        || Object.entries(body.categories).some(([key, value]) => !key.trim() || typeof value !== 'boolean')) {
        throw error(400, 'INVALID_PARAMETER', 'categories must map category names to booleans');
      }
      const upsert = db.prepare('INSERT INTO notification_category_prefs(user_id,category,enabled) VALUES(?,?,?) ON CONFLICT(user_id,category) DO UPDATE SET enabled=excluded.enabled');
      for (const [category, enabled] of Object.entries(body.categories)) upsert.run(userId, category.trim(), Number(enabled));
      applied.categories = body.categories;
    }
    const soundUnavailable = applied.sound_notifications_unavailable;
    delete applied.sound_notifications_unavailable;
    return { ok: true, applied, ...(soundUnavailable ? { sound_notifications_unavailable: true } : {}) };
  }

  if (action === 'getSettings') {
    const row = db.prepare('SELECT notifications_enabled,sound_enabled FROM device_tokens WHERE user_id=? ORDER BY updated_at DESC,id DESC LIMIT 1').get(userId);
    const categories = { ...DEFAULT_CATEGORIES };
    for (const pref of db.prepare('SELECT category,enabled FROM notification_category_prefs WHERE user_id=?').all(userId)) categories[pref.category] = pref.enabled === 1;
    return {
      notifications_enabled: row ? row.notifications_enabled === 1 : false,
      sound_enabled: row ? row.sound_enabled === 1 : false,
      sound_notifications_available: hasSoundFeature(db, principal.planId),
      categories,
    };
  }
  return null;
}
