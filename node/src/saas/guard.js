import { HttpError } from '../api/router.js';
import { createCredits } from './credits.js';
import { createUsage } from './usage.js';

function diagnostic(error) {
  const stack = String(error?.stack || '').split('\n').slice(0, 4).join(' | ');
  return `${error?.name || 'Error'}: ${error?.message || 'Unknown error'}${stack ? ` | ${stack}` : ''}`;
}

export function createGuard({ db, config = {}, logger = console, now = () => new Date() }) {
  const credits = createCredits(db, now), usage = createUsage(db, config, now), windows = new Map();
  function logEvent(principal, feature, jobId, usageData, status, points, latency) {
    const u = usageData || {};
    usage.recordUsage({ userId: principal.userId, kind: feature, jobId, model: u.model || null, inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, points, status, latencyMs: latency });
  }
  async function execute({ principal, feature, jobId = null, idempotencyKey = `${principal.userId}:${feature}:${jobId}:${now().getTime()}` }, fn) {
    const started = now().getTime();
    const blocked = (status, code, message, details = {}) => {
      logEvent(principal, feature, jobId, null, 'blocked', 0, now().getTime() - started);
      throw new HttpError(status, code, message, details);
    };
    const ownerOrOff = !config.SAAS_ENABLED || principal.role === 'owner';
    let cost = Number((config.FEATURE_COSTS || { estimate:1,evaluate:1,proposal:2,prototype:8 })[feature] || 0);
    let reserved = false;
    let reservationKey = idempotencyKey;
    if (!ownerOrOff) {
      credits.grantMonthlyPoints(principal.userId, principal.planId, now());
      const plan = db.prepare('SELECT features,daily_points_cap FROM plans WHERE id=?').get(principal.planId);
      const features = plan ? JSON.parse(plan.features) : {};
      if (!features[feature]) blocked(403, 'PLAN_REQUIRED', 'Your plan does not include this feature');
      const win = windows.get(principal.userId) || [];
      const cutoff = now().getTime() - 60_000, recent = win.filter((t) => t > cutoff);
      if (recent.length >= (config.AI_RATE_LIMIT_PER_MINUTE || 5)) blocked(429, 'RATE_LIMITED', 'AI request rate limit reached', { retry_after_seconds: Math.max(1, Math.ceil((recent[0] + 60_000 - now().getTime()) / 1000)) });
      windows.set(principal.userId, recent);
      if (plan.daily_points_cap != null) {
        const day = now().toISOString().slice(0,10);
        const spent = db.prepare("SELECT COALESCE(SUM(points),0) AS spent FROM usage_events WHERE user_id=? AND status='ok' AND substr(created_at,1,10)=?").get(principal.userId, day).spent;
        if (spent + cost > plan.daily_points_cap) blocked(429, 'DAILY_LIMIT_REACHED', 'Daily points limit reached');
      }
      const balance = credits.getBalance(principal.userId);
      if (balance < cost) blocked(402, 'INSUFFICIENT_CREDITS', 'Not enough points', { balance, cost });
      const reservation = credits.reserve(principal.userId, cost, idempotencyKey);
      if (reservation.insufficient) blocked(402, 'INSUFFICIENT_CREDITS', 'Not enough points', { balance: reservation.balance, cost });
      reserved = reservation.reserved;
      reservationKey = reservation.key || idempotencyKey;
      recent.push(now().getTime()); windows.set(principal.userId, recent);
    }
    try {
      const output = await fn();
      logEvent(principal, feature, jobId, output?.usage, 'ok', ownerOrOff || !reserved ? 0 : cost, now().getTime() - started);
      return output?.result;
    } catch (error) {
      if (reserved) credits.refund(reservationKey);
      logEvent(principal, feature, jobId, error?.usage, 'failed', 0, now().getTime() - started);
      logger?.warn?.('SaaS generation failed', diagnostic(error));
      throw error;
    }
  }
  return { execute, credits, usage };
}
