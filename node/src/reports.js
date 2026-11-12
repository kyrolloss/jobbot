import { connect } from './db.js';

function readRows(userId, db) {
  return db.prepare(`SELECT j.rowid AS job_id,j.title,j.source,j.currency,j.created_at,
      uj.estimate,uj.score,uj.status,uj.created_at AS user_created_at
    FROM user_jobs uj JOIN jobs j ON j.rowid=uj.job_id
    WHERE uj.user_id=?`).all(userId);
}

function parseEstimate(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function nonNullEstimateValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

export function getPricesReport(userId, db = connect()) {
  return readRows(userId, db).flatMap((row) => {
    const estimate = parseEstimate(row.estimate);
    const estimatedPrice = nonNullEstimateValue(estimate?.estimated_price);
    if (estimatedPrice === null) return [];
    return [{
      job_id: Number(row.job_id), title: row.title, source: row.source,
      estimated_price: estimatedPrice, currency: estimate?.currency ?? row.currency ?? null,
      score: row.score ?? null, created_at: row.user_created_at ?? row.created_at,
    }];
  }).sort((a, b) => Number(b.estimated_price) - Number(a.estimated_price));
}

export function getTimingReport(userId, db = connect()) {
  return readRows(userId, db).flatMap((row) => {
    const estimate = parseEstimate(row.estimate);
    const estimatedDays = nonNullEstimateValue(estimate?.estimated_days);
    if (estimatedDays === null) return [];
    return [{
      job_id: Number(row.job_id), title: row.title, estimated_days: estimatedDays,
      score: row.score ?? null, status: row.status, created_at: row.user_created_at ?? row.created_at,
    }];
  }).sort((a, b) => Number(a.estimated_days) - Number(b.estimated_days));
}

function parseUtcDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoWeekStart(date) {
  const day = date.getUTCDay() || 7;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 1));
}

function dateOnly(date) { return date.toISOString().slice(0, 10); }

export function getWeeklyReport(userId, db = connect(), now = new Date()) {
  const currentWeek = isoWeekStart(now);
  const firstWeek = new Date(currentWeek.getTime() - 7 * 7 * 24 * 60 * 60 * 1000);
  const grouped = new Map();
  for (const row of readRows(userId, db)) {
    const created = parseUtcDate(row.user_created_at ?? row.created_at);
    if (!created) continue;
    const weekStart = isoWeekStart(created);
    if (weekStart < firstWeek || weekStart > currentWeek) continue;
    const key = dateOnly(weekStart);
    if (!grouped.has(key)) grouped.set(key, { week_start: key, total_jobs: 0, applied: 0, rejected: 0, approved: 0, score_total: 0, score_count: 0 });
    const item = grouped.get(key);
    item.total_jobs++;
    if (row.status === 'applied') item.applied++;
    if (row.status === 'rejected') item.rejected++;
    if (row.status === 'approved') item.approved++;
    const score = Number(row.score);
    if (row.score !== null && row.score !== undefined && Number.isFinite(score)) {
      item.score_total += score;
      item.score_count++;
    }
  }
  return [...grouped.values()].map((item) => ({
    week_start: item.week_start, total_jobs: item.total_jobs,
    applied: item.applied, rejected: item.rejected, approved: item.approved,
    avg_score: item.score_count ? Math.round((item.score_total / item.score_count) * 100) / 100 : null,
  })).sort((a, b) => b.week_start.localeCompare(a.week_start));
}
