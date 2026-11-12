import { connect } from '../db.js';
import { applyNotificationsMigration, handleNotificationRequest } from '../notifications.js';

export class HttpError extends Error {
  constructor(status, code, message, details = {}) { super(message); this.status = status; this.code = code; this.details = details; }
}

function sendJson(response, status, payload) {
  if (response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
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
  applyNotificationsMigration(connect());
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
    ['PATCH', '/notifications/settings', 'patchSettings'],
    ['GET', '/notifications/settings', 'getSettings'],
  ]) {
    router.add(method, route, ({ body, ...context }) => handleNotificationRequest(action, { body, ...context }));
  }
  return router;
}

export { sendJson };
