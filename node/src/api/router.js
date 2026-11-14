import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../db.js';
import { applyNotificationsMigration, handleNotificationRequest } from '../notifications.js';
import { buildPrototype } from '../prototype.js';
import { getPricesReport, getTimingReport, getWeeklyReport } from '../reports.js';

const prototypeMigrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations/20261112_add_prototype_html.sql');
const prototypeMigrated = new WeakSet();

export class HttpError extends Error {
  constructor(status, code, message, details = {}) { super(message); this.status = status; this.code = code; this.details = details; }
}

function sendJson(response, status, payload) {
  if (response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}

function sendHtml(response, status, html) {
  if (response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' });
  response.end(html);
}

function applyPrototypeMigration(db) {
  if (prototypeMigrated.has(db)) return;
  const columns = new Set(db.prepare('PRAGMA table_info(user_jobs)').all().map((column) => column.name));
  if (!columns.has('prototype_html')) db.exec(fs.readFileSync(prototypeMigrationPath, 'utf8'));
  prototypeMigrated.add(db);
}

function positiveJobId(rawId) {
  if (!/^[1-9]\d*$/.test(String(rawId))) return null;
  const value = Number(rawId);
  return Number.isSafeInteger(value) ? value : null;
}

function estimateFields(value) {
  try {
    const parsed = value ? JSON.parse(value) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

async function readJson(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the allowed size');
    chunks.push(chunk);
  }
  if (!size) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'INVALID_JSON', 'Request body must contain valid JSON'); }
}

function compile(pattern) {
  const keys = [];
  const source = pattern.split('/').map((part) => {
    if (part.startsWith(':')) { keys.push(part.slice(1)); return '([^/]+)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { regex: new RegExp(`^${source}/?$`), keys };
}

export function createRouter({ maxBodyBytes = 1024 * 1024 } = {}) {
  const routes = [];
  const startupDb = connect();
  applyNotificationsMigration(startupDb);
  applyPrototypeMigration(startupDb);
  const router = {
    add(method, pattern, handler) { routes.push({ method: method.toUpperCase(), ...compile(pattern), handler }); return this; },
    async handle(request, response, context = {}) {
      let url;
      try { url = new URL(request.url, 'http://localhost'); }
      catch { return sendJson(response, 400, { error: { code: 'BAD_URL', message: 'Request URL is invalid' } }); }
      const pathMatches = routes.map((route) => ({ route, match: url.pathname.match(route.regex) })).filter(({ match }) => match);
      if (!pathMatches.length) return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
      const selected = pathMatches.find(({ route }) => route.method === request.method);
      if (!selected) return sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
      try {
        let body = null;
        if (!['GET', 'HEAD'].includes(request.method)) body = await readJson(request, maxBodyBytes);
        let params;
        try { params = Object.fromEntries(selected.route.keys.map((key, index) => [key, decodeURIComponent(selected.match[index + 1])])); }
        catch { throw new HttpError(400, 'INVALID_PATH', 'Path parameter encoding is invalid'); }
        const result = await selected.route.handler({ request, response, params, query: url.searchParams, body, ...context });
        if (result !== undefined && !response.writableEnded) sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof HttpError) return sendJson(response, error.status, { error: { code: error.code, message: error.message, ...error.details } });
        const diagnostic = `${error?.name || 'Error'}: ${error?.message || 'Unknown error'}${error?.stack ? ` | ${String(error.stack).split('\n').slice(0, 4).join(' | ')}` : ''}`;
        context.logger?.error?.('API handler failed', diagnostic);
        if (Number.isInteger(error?.status) && typeof error?.code === 'string') return sendJson(response, error.status, { error: { code: error.code, message: error.message || 'Request failed', ...(error.details || {}) } });
        return sendJson(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
      }
    },
  };
  for (const [method, route, action] of [
    ['POST', '/notifications/register', 'register'],
    ['POST', '/notifications/unregister', 'unregister'],
    ['POST', '/notifications/test', 'test'],
    ['PATCH', '/notifications/settings', 'patchSettings'],
    ['GET', '/notifications/settings', 'getSettings'],
  ]) {
    router.add(method, route, ({ body, ...context }) => handleNotificationRequest(action, { body, ...context }));
  }
  router.add('POST', '/jobs/:id/prototype', async ({ params, body, db, principal, guard, response }) => {
    const jobId = positiveJobId(params.id);
    if (jobId === null) { sendJson(response, 400, { error: 'invalid_job_id' }); return; }
    const userId = principal.userId;
    const row = db.prepare(`SELECT j.rowid AS id,j.source,j.title,j.description,j.posted_at,j.currency,j.created_at,
        uj.proposal AS proposal_text,uj.estimate,uj.prototype_html
      FROM jobs j JOIN user_jobs uj ON uj.job_id=j.rowid
      WHERE j.rowid=? AND uj.user_id=?`).get(jobId, userId);
    if (!row) { sendJson(response, 404, { error: 'not_found' }); return; }
    const estimate = estimateFields(row.estimate);
    const job = { ...row, estimated_price: estimate.estimated_price, estimated_days: estimate.estimated_days, estimated_tasks: estimate.tasks };
    try {
      const html = await guard.execute({ principal, feature: 'prototype', jobId }, async () => {
        if (!row.proposal_text || !row.proposal_text.trim()) {
          throw new HttpError(400, 'NO_PROPOSAL', 'لا يوجد عرض مكتوب لهذه الوظيفة');
        }
        const generated = buildPrototype(job, row.proposal_text, body || {});
        db.prepare('UPDATE user_jobs SET prototype_html=?,updated_at=? WHERE user_id=? AND job_id=?')
          .run(generated, new Date().toISOString(), userId, jobId);
        return { result: generated };
      });
      sendHtml(response, 200, html);
    } catch (failure) {
      if (failure?.code === 'PLAN_REQUIRED') sendJson(response, 403, { error: 'feature_unavailable', feature: 'prototype' });
      else if (failure?.code === 'NO_PROPOSAL') sendJson(response, 400, { error: 'no_proposal', message: 'لا يوجد عرض مكتوب لهذه الوظيفة' });
      else throw failure;
    }
  });
  router.add('GET', '/jobs/:id/prototype', ({ params, db, principal, response }) => {
    const jobId = positiveJobId(params.id);
    if (jobId === null) { sendJson(response, 400, { error: 'invalid_job_id' }); return; }
    const prototype = db.prepare('SELECT prototype_html FROM user_jobs WHERE user_id=? AND job_id=?').get(principal.userId, jobId)?.prototype_html;
    if (!prototype) { sendJson(response, 404, { error: 'no_prototype' }); return; }
    sendHtml(response, 200, prototype);
  });
  router.add('GET', '/reports/prices', ({ db, principal }) => ({ data: getPricesReport(principal.userId, db) }));
  router.add('GET', '/reports/timing', ({ db, principal }) => ({ data: getTimingReport(principal.userId, db) }));
  router.add('GET', '/reports/weekly', ({ db, principal }) => ({ data: getWeeklyReport(principal.userId, db) }));
  return router;
}

export { sendJson };
