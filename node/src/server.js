import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as defaultConfig from './config.js';
import * as defaultLogger from './logger.js';
import { createRouter, HttpError, sendJson } from './api/router.js';
import { registerRoutes } from './api/routes.js';
import { parseJobTags, setStatus } from './db.js';
import { createDefaultSources, getScanState, runScan, tryAcquireScanLock } from './scanner.js';
import { createScheduler } from './scheduler.js';
import { settingsStore as defaultSettingsStore } from './settings.js';
import { createEventBus } from './events.js';
import { serializeDbTimestamp } from './events.js';
import { createRadar } from './radar.js';
import { resolvePrincipal } from './saas/principal.js';
import { createGuard } from './saas/guard.js';
import { createGeminiClient } from './gemini.js';

const version = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')).version;
const ALLOWED_HEADERS = new Set(['x-api-key', 'content-type', 'last-event-id']);
const ACTION_STATUSES = Object.freeze({ reject: 'rejected', applied: 'applied', approve: 'approved' });

function parseRecord(value) {
  try { const parsed = value ? JSON.parse(value) : null; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; }
  catch { return null; }
}

function jobResponse(row) {
  return {
    id: row.id, source: row.source, external_id: row.external_id, title: row.title, url: row.url,
    budget: row.budget || '', score: row.score ?? null, score_line: row.score_line || '', status: row.status,
    tags: parseJobTags(row.tags), currency: row.currency ?? null, bid_count: row.bid_count ?? null, bid_avg: row.bid_avg ?? null,
    posted_at: serializeDbTimestamp(row.posted_at ?? null),
    applied_at: row.applied_at && String(row.applied_at).trim() ? serializeDbTimestamp(row.applied_at) : null,
    created_at: serializeDbTimestamp(row.created_at),
    has_proposal: Boolean(row.proposal && String(row.proposal).trim()),
    has_estimate: Boolean(row.estimate && String(row.estimate).trim()), prototype_url: row.prototype_url ?? null,
    description: row.description, proposal: row.proposal ?? null,
    evaluation: parseRecord(row.evaluation), estimate: parseRecord(row.estimate),
    stats: { bid_count: row.bid_count ?? null, bid_avg: row.bid_avg ?? null, currency: row.currency ?? null, posted_at: serializeDbTimestamp(row.posted_at ?? null) },
  };
}

function loadJob(db, rowid, userId = 1) {
  const row = db.prepare(`SELECT j.rowid AS id,j.source,j.external_id,j.title,j.description,j.url,j.budget,j.created_at,j.message_id,j.bid_count,j.bid_avg,j.tags,j.currency,j.posted_at,uj.status,uj.proposal,uj.evaluation,uj.score,uj.score_line,uj.applied_at,uj.estimate,uj.prototype_url FROM jobs j JOIN user_jobs uj ON uj.job_id=j.rowid WHERE j.rowid=? AND uj.user_id=?`).get(rowid,userId);
  return row ? { ...row } : null;
}

function transitionJob(db, action, rawId, userId = 1) {
  let id;
  try { id = decodeURIComponent(rawId); }
  catch { throw new HttpError(400, 'INVALID_PARAMETER', 'Invalid id: must be a positive integer'); }
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw new HttpError(400, 'INVALID_PARAMETER', 'Invalid id: must be a positive integer');
  }
  const rowid = Number(id);
  const row = loadJob(db, rowid, userId);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Job not found');
  const allowedCurrentStatus = action === 'applied' ? 'approved' : 'sent';
  if (row.status !== allowedCurrentStatus) {
    const verb = { reject: 'reject', applied: 'mark job as applied', approve: 'approve' }[action];
    throw new HttpError(409, 'STATUS_CONFLICT', `Cannot ${verb} while its current status is "${row.status}"`);
  }
  const targetStatus = ACTION_STATUSES[action];
  if (!targetStatus) throw new HttpError(400, 'INVALID_ACTION', 'Unknown job action');
  setStatus({ source: row.source, external_id: row.external_id }, targetStatus, db, userId);
  const updated = loadJob(db, rowid, userId);
  if (!updated) throw new HttpError(404, 'NOT_FOUND', 'Job not found');
  return jobResponse(updated);
}

function detailJob(db, rawId, userId = 1) {
  let id;
  try { id = decodeURIComponent(rawId); }
  catch { throw new HttpError(400, 'INVALID_PARAMETER', 'Invalid id: must be a positive integer'); }
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw new HttpError(400, 'INVALID_PARAMETER', 'Invalid id: must be a positive integer');
  }
  const row = loadJob(db, Number(id), userId);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Job not found');
  return jobResponse(row);
}

function readLimitedJson(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    request.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        settled = true;
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Settings body exceeds 10 KB'));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', (error) => { if (!settled) { settled = true; reject(error); } });
    request.once('end', () => {
      if (settled || tooLarge) return;
      settled = true;
      if (!size) { reject(new HttpError(400, 'INVALID_PARAMETER', 'Settings body must be valid JSON')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'INVALID_PARAMETER', 'Settings body must be valid JSON')); }
    });
  });
}

function originList(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return list.map((origin) => String(origin).trim()).filter((origin) => origin && origin !== '*');
}
function unauthorized(headerValue, expected) {
  if (!expected || expected.length < 24 || typeof headerValue !== 'string') return true;
  const supplied = Buffer.from(headerValue, 'utf8');
  const secret = Buffer.from(expected, 'utf8');
  return supplied.length !== secret.length || !crypto.timingSafeEqual(supplied, secret);
}

export function createServer({ db, config = defaultConfig, logger = defaultLogger, sources = createDefaultSources(), clock = {}, settingsStore = defaultSettingsStore, scheduler = null, onNewJob = () => {}, events = null, radar = null, authProviders = null, geminiClient = null, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!db) throw new TypeError('createServer requires an open database connection');
  const saasConfig = { ...defaultConfig, ...config };
  const eventBus = events || createEventBus({ bufferSize: config.EVENTS_BUFFER_SIZE || 500 });
  const eventStreams = new Set();
  const guard = createGuard({ db, config: saasConfig, logger, now: clock.now || (() => new Date()) });
  const gemini = geminiClient || createGeminiClient({ config: saasConfig, fetch: fetchImpl, now: () => clock.now ? clock.now().getTime() : Date.now(), sleep: clock.sleep, logger });
  const radarController = radar || createRadar({ db, source: sources.find((source) => source.name === 'freelancer'), events: eventBus, settingsStore, config: saasConfig, logger, clock, guard, gemini });
  const router = registerRoutes(createRouter({ maxBodyBytes: config.API_MAX_BODY_BYTES || 1024 * 1024 }), { radar: radarController, config: saasConfig, gemini, sources });
  for (const action of ['reject', 'applied', 'approve']) {
    router.add('POST', `/jobs/:id/${action}`, ({ params, principal }) => transitionJob(db, action, params.id, principal.userId));
  }
  const scanWithEvents = (options) => runScan({ ...options, config: saasConfig, events: eventBus, logger });
  const scanScheduler = scheduler || createScheduler({ db, sources, clock, settingsStore, logger, onNewJob, scan: scanWithEvents });
  const allowedOrigins = originList(config.CORS_ORIGINS);

  function beginEventStream(request, response) {
    const principalUserId = request.principal.userId;
    const visibleToPrincipal = (event) => principalUserId === 1 || event.data?.user_id === principalUserId;
    let lastId = null;
    const lastEventId = request.headers['last-event-id'];
    if (lastEventId !== undefined) {
      if (typeof lastEventId !== 'string' || !/^\d+$/.test(lastEventId) || !Number.isSafeInteger(Number(lastEventId))) {
        sendJson(response, 400, { error: { code: 'INVALID_PARAMETER', message: 'Invalid Last-Event-ID' } });
        return;
      }
      lastId = Number(lastEventId);
    }
    const maxClients = config.EVENTS_MAX_CLIENTS || 20;
    if (eventStreams.size >= maxClients) {
      sendJson(response, 503, { error: { code: 'EVENTS_CLIENT_LIMIT', message: 'Too many event stream clients' } });
      return;
    }

    let closed = false;
    let keepAliveTimer = null;
    let unsubscribe = () => {};
    const stream = {
      close({ end = false, destroy = false } = {}) {
        if (closed) return;
        closed = true;
        if (keepAliveTimer !== null) clearInterval(keepAliveTimer);
        unsubscribe();
        eventStreams.delete(stream);
        response.off('close', onResponseClose);
        response.off('error', onResponseClose);
        request.off('aborted', onResponseClose);
        if (destroy && !response.destroyed) response.destroy();
        else if (end && !response.writableEnded) response.end();
      },
    };
    const onResponseClose = () => stream.close();
    eventStreams.add(stream);
    response.once('close', onResponseClose);
    response.once('error', onResponseClose);
    request.once('aborted', onResponseClose);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();

    const maxBufferedBytes = config.EVENTS_MAX_BUFFER_BYTES || 1_048_576;
    const write = (text) => {
      if (closed) return false;
      try { response.write(text); }
      catch { stream.close({ destroy: true }); return false; }
      const buffered = Math.max(response.writableLength || 0, response.socket?.writableLength || 0);
      if (buffered > maxBufferedBytes) { stream.close({ destroy: true }); return false; }
      return true;
    };
    const writeEvent = (event) => write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    unsubscribe = eventBus.subscribe((event) => { if (visibleToPrincipal(event)) writeEvent(event); });
    if (!closed) write(': connected\n\n');

    if (!closed && lastId !== null) {
      const missed = eventBus.getSince(lastId);
      if (missed?.reset) {
        writeEvent({ id: eventBus.latestId(), type: 'reset', data: { user_id: principalUserId, reason: 'buffer_overflow', action: 'refetch_jobs' } });
      } else {
        for (const event of missed) if (visibleToPrincipal(event) && !writeEvent(event)) break;
      }
    }

    if (!closed) {
      const keepAliveMs = (config.EVENTS_KEEPALIVE_SECONDS || 25) * 1000;
      keepAliveTimer = setInterval(() => { write(': keep-alive\n\n'); }, keepAliveMs);
      keepAliveTimer.unref?.();
    }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Vary', 'Origin');
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
      sendJson(response, 403, { error: { code: 'CORS_ORIGIN_DENIED', message: 'Origin is not allowed' } });
      return;
    }
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
    if (request.method === 'OPTIONS') {
      const requestedMethod = request.headers['access-control-request-method'];
      const requestedHeaders = String(request.headers['access-control-request-headers'] || '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
      if (requestedMethod && !['GET', 'POST', 'OPTIONS'].includes(requestedMethod.toUpperCase())) {
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Preflight method is not allowed' } });
        return;
      }
      if (requestedHeaders.some((name) => !ALLOWED_HEADERS.has(name))) {
        sendJson(response, 403, { error: { code: 'CORS_HEADERS_DENIED', message: 'Requested headers are not allowed' } });
        return;
      }
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'X-API-Key, Content-Type, Last-Event-ID',
        'Access-Control-Max-Age': '600',
      });
      response.end();
      return;
    }
    let requestPath;
    try { requestPath = new URL(request.url, 'http://localhost').pathname; }
    catch { sendJson(response, 400, { error: { code: 'BAD_URL', message: 'Request URL is invalid' } }); return; }
    const isHealth = request.method === 'GET' && requestPath === '/health';
    if (!isHealth) {
      const principal = await resolvePrincipal(request, { config: saasConfig, providers: authProviders || undefined });
      if (!principal) { sendJson(response, 401, { error: { code: 'UNAUTHORIZED', message: 'A valid X-API-Key header is required' } }); return; }
      request.principal = principal;
    }
    if (request.method === 'GET' && requestPath === '/events') {
      beginEventStream(request, response);
      return;
    }
    request.setTimeout(config.API_REQUEST_TIMEOUT_MS || 30_000, () => {
      if (!response.writableEnded) sendJson(response, 408, { error: { code: 'REQUEST_TIMEOUT', message: 'Request timed out' } });
      request.destroy();
    });
    if (request.method === 'GET' && requestPath === '/scan/status') {
      sendJson(response, 200, scanScheduler.status());
      return;
    }
    if (request.method === 'POST' && requestPath === '/scan/run') {
      request.resume();
      const lock = tryAcquireScanLock();
      if (!lock) {
        sendJson(response, 409, { error: { code: 'SCAN_RUNNING', message: 'A scan is already running' } });
        return;
      }
      const scanPromise = runScan({ db, sources, trigger: 'manual', clock, onNewJob, lock, events: eventBus, logger, config: saasConfig });
      const startedAt = getScanState().started_at;
      void scanPromise.catch(() => logger.error('Manual scan failed'));
      sendJson(response, 202, { started: true, started_at: startedAt });
      return;
    }
    if (request.method === 'POST' && requestPath === '/scan/settings') {
      try {
        const body = await readLimitedJson(request, 10 * 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'INVALID_PARAMETER', 'Settings body must be a JSON object');
        if (Object.hasOwn(body, 'enabled') && typeof body.enabled !== 'boolean') throw new HttpError(400, 'INVALID_PARAMETER', 'Invalid enabled: must be a boolean');
        if (Object.hasOwn(body, 'interval_minutes') && (!Number.isInteger(body.interval_minutes)
          || body.interval_minutes < defaultConfig.SCAN_MIN_INTERVAL_MINUTES
          || body.interval_minutes > defaultConfig.SCAN_MAX_INTERVAL_MINUTES)) {
          throw new HttpError(400, 'INVALID_PARAMETER', `Invalid interval_minutes: must be an integer from ${defaultConfig.SCAN_MIN_INTERVAL_MINUTES} to ${defaultConfig.SCAN_MAX_INTERVAL_MINUTES}`);
        }
        const current = settingsStore.read();
        const saved = settingsStore.write({
          ...current,
          scan_enabled: Object.hasOwn(body, 'enabled') ? body.enabled : current.scan_enabled,
          interval_minutes: Object.hasOwn(body, 'interval_minutes') ? body.interval_minutes : current.interval_minutes,
        });
        sendJson(response, 200, scanScheduler.updateSettings(saved));
      } catch (failure) {
        if (failure instanceof HttpError) sendJson(response, failure.status, { error: { code: failure.code, message: failure.message } });
        else {
          logger.error('Scan settings update failed');
          sendJson(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
        }
      }
      return;
    }
    const detailMatch = requestPath.match(/^\/jobs\/([^/]+)\/?$/);
    if (request.method === 'GET' && detailMatch) {
      try { sendJson(response, 200, detailJob(db, detailMatch[1], request.principal.userId)); }
      catch (failure) {
        if (failure instanceof HttpError) sendJson(response, failure.status, { error: { code: failure.code, message: failure.message } });
        else {
          logger.error('API detail lookup failed');
          sendJson(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
        }
      }
      return;
    }
    const actionMatch = requestPath.match(/^\/jobs\/([^/]+)\/(reject|applied|approve)\/?$/);
    if (request.method === 'POST' && actionMatch) {
      // The action contract ignores its optional body, so drain it without JSON parsing.
      request.resume();
      try { sendJson(response, 200, transitionJob(db, actionMatch[2], actionMatch[1], request.principal.userId)); }
      catch (failure) {
        if (failure instanceof HttpError) sendJson(response, failure.status, { error: { code: failure.code, message: failure.message } });
        else {
          logger.error('API action failed');
          sendJson(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
        }
      }
      return;
    }
    await router.handle(request, response, { db, config: saasConfig, logger, version, principal: request.principal, guard });
  });
  server.requestTimeout = config.API_REQUEST_TIMEOUT_MS || 30_000;
  server.headersTimeout = Math.max(server.requestTimeout + 1000, 35_000);

  let listening = false;
  return {
    listen(port = config.API_PORT, host = config.API_HOST) {
      if (!config.API_KEY || config.API_KEY.length < 24) {
        logger.error('API server cannot start: API_KEY must be configured and at least 24 characters');
        return Promise.resolve(false);
      }
      return new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { listening = true; server.off('error', onError); resolve(server.address()); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    close() {
      scanScheduler.stop();
      radarController.stop();
      for (const stream of [...eventStreams]) stream.close({ end: true });
      if (!listening) return Promise.resolve();
      return new Promise((resolve, reject) => server.close((error) => {
        listening = false;
        if (error) reject(error); else resolve();
      }));
    },
  };
}

