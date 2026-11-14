import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { DB_PATH } from './config.js';
import { createJob } from './models.js';
import { extractTags } from './tech.js';
import { createSaasSchema } from './saas/schema.js';

let db;
const closedConnections = new WeakSet();
const definitions = {
  proposal: 'TEXT', message_id: 'INTEGER', evaluation: 'TEXT', bid_count: 'INTEGER', bid_avg: 'REAL',
  score: 'REAL', score_line: 'TEXT', tags: 'TEXT', currency: 'TEXT', posted_at: 'TEXT', applied_at: 'TEXT',
  estimate: 'TEXT', prototype_url: 'TEXT', radar_alerted_at: 'TEXT',
};

function active() {
  if (!db) openDb();
  return db;
}
export function connect() { return active(); }
function jobFields(job) { return [job.source, job.external_id, job.title, job.description, job.url, job.budget ?? '']; }
function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function transaction(database, callback) {
  database.exec('BEGIN');
  try {
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* Keep the original transaction error. */ }
    throw error;
  }
}

export function openDb(databasePath = DB_PATH) {
  if (db) closeDb(db);
  db = new DatabaseSync(databasePath);
  const connection = db;
  try {
    connection.exec(`CREATE TABLE IF NOT EXISTS jobs (
      source TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      url TEXT NOT NULL, budget TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, proposal TEXT, message_id INTEGER,
      evaluation TEXT, bid_count INTEGER, bid_avg REAL, score REAL, score_line TEXT, tags TEXT,
      currency TEXT, PRIMARY KEY (source, external_id)
    )`);
    let columns = new Set(connection.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name));
    for (const [column, definition] of Object.entries(definitions)) {
      if (!columns.has(column)) {
        try { connection.exec(`ALTER TABLE jobs ADD COLUMN "${column}" ${definition}`); } catch (error) {
          if (!/duplicate column/i.test(error.message)) throw error;
        }
        columns.add(column);
      }
    }
    createSaasSchema(connection);
    connection.exec(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS source_scan_state (
      source TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, last_scan_at TEXT,
      last_count INTEGER, last_error_code TEXT, last_error_message TEXT
    );`);
    return connection;
  } catch (error) {
    closeDb(connection);
    throw error;
  }
}

export function closeDb(connection) {
  if (!connection || closedConnections.has(connection)) return;
  connection.close();
  closedConnections.add(connection);
  if (db === connection) db = undefined;
}

export function isNew(job) { return !active().prepare('SELECT 1 FROM jobs WHERE source=? AND external_id=?').get(job.source, job.external_id); }
export function save(job, status = 'new', tags = []) {
  const createdAt = nowIso().slice(0, 19).replace('T', ' ');
  active().prepare(`INSERT OR IGNORE INTO jobs
    (source,external_id,title,description,url,budget,status,tags,created_at,posted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(...jobFields(job), status, JSON.stringify(tags || []), createdAt, nowIso());
}
export function ensureUserJob(userId, jobId, { status = 'sent', score = null, scoreLine = null } = {}, connection = active(), timestamp = nowIso()) {
  return connection.prepare('INSERT OR IGNORE INTO user_jobs(user_id,job_id,status,score,score_line,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(userId,jobId,status,score,scoreLine,timestamp,timestamp).changes > 0;
}
export function listActiveUsers(connection = active()) { return connection.prepare("SELECT id AS user_id FROM users WHERE status='active' ORDER BY id").all().map((row) => row.user_id); }
export function getJobsByStatus(status, userId = 1) {
  return active().prepare('SELECT j.source,j.external_id,j.title,j.description,j.url,j.budget FROM jobs j JOIN user_jobs uj ON uj.job_id=j.rowid WHERE uj.user_id=? AND uj.status=? ORDER BY j.created_at,j.rowid')
    .all(userId,status).map((r) => createJob({ source:r.source, externalId:r.external_id, title:r.title, description:r.description, url:r.url, budget:r.budget }));
}
export function setStatus(job, status, connection = active(), userId = 1) {
  const stamp = nowIso(), rowid = connection.prepare('SELECT rowid FROM jobs WHERE source=? AND external_id=?').get(job.source,job.external_id)?.rowid;
  if (rowid == null) return;
  connection.prepare("UPDATE user_jobs SET status=?,applied_at=CASE WHEN ?='applied' AND (applied_at IS NULL OR TRIM(applied_at)='') THEN ? ELSE applied_at END,updated_at=? WHERE user_id=? AND job_id=?")
    .run(status,status,stamp,stamp,userId,rowid);
  if (userId === 1) connection.prepare("UPDATE jobs SET status=?,applied_at=CASE WHEN ?='applied' AND (applied_at IS NULL OR TRIM(applied_at)='') THEN ? ELSE applied_at END WHERE rowid=?").run(status,status,stamp,rowid);
}
export function postedAtFromStats(source, stats = {}) {
  try {
    let d;
    if (source === 'freelancer' && stats.time_submitted != null) {
      const seconds = Number(stats.time_submitted);
      if (!Number.isFinite(seconds) || seconds <= 0) return null;
      d = new Date(seconds * 1000);
    } else if (source === 'mostaql' && stats.age_hours != null) {
      const age = Number(stats.age_hours);
      if (!Number.isFinite(age) || age < 0) return null;
      d = new Date(Date.now() - age * 3600000);
    } else return null;
    return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  } catch { return null; }
}
export function savePostedAt(job, stats) {
  const postedAt = postedAtFromStats(job.source, stats || {});
  if (!postedAt) return false;
  return active().prepare(`UPDATE jobs SET posted_at=? WHERE source=? AND external_id=? AND (posted_at IS NULL OR datetime(posted_at)=datetime(created_at))`)
    .run(postedAt, job.source, job.external_id).changes > 0;
}
export function saveStats(job, stats) {
  const values = {};
  for (const field of ['bid_count','bid_avg','currency']) {
    let value = stats?.[field];
    if (value == null || (typeof value === 'string' && !value.trim())) continue;
    values[field] = typeof value === 'string' ? value.trim() : value;
  }
  const fields = Object.keys(values);
  if (!fields.length) return false;
  return active().prepare(`UPDATE jobs SET ${fields.map((f) => `"${f}"=?`).join(',')} WHERE source=? AND external_id=?`)
    .run(...fields.map((f) => values[f]), job.source, job.external_id).changes > 0;
}
export function getJobStatus(source, externalId, userId = 1) { return active().prepare('SELECT uj.status FROM jobs j JOIN user_jobs uj ON uj.job_id=j.rowid WHERE j.source=? AND j.external_id=? AND uj.user_id=?').get(source,externalId,userId)?.status ?? null; }
export function getJobByRowid(rowid) {
  const r = active().prepare('SELECT source,external_id,title,description,url,budget FROM jobs WHERE rowid=?').get(rowid);
  return r ? createJob({ source:r.source, externalId:r.external_id, title:r.title, description:r.description, url:r.url, budget:r.budget }) : null;
}
export function getJob(source, externalId) {
  const r = active().prepare('SELECT source,external_id,title,description,url,budget FROM jobs WHERE source=? AND external_id=?').get(source, externalId);
  return r ? createJob({ source:r.source, externalId:r.external_id, title:r.title, description:r.description, url:r.url, budget:r.budget }) : null;
}
export function getJobRowid(job) { return active().prepare('SELECT rowid FROM jobs WHERE source=? AND external_id=?').get(job.source, job.external_id)?.rowid ?? null; }
export function saveScore(job, score, scoreLine, userId = 1) {
  const db=active(), rowid=db.prepare('SELECT rowid FROM jobs WHERE source=? AND external_id=?').get(job.source,job.external_id)?.rowid;
  if(rowid==null)return;
  db.prepare('UPDATE user_jobs SET score=?,score_line=?,updated_at=? WHERE user_id=? AND job_id=?').run(score,scoreLine,nowIso(),userId,rowid);
  if(userId===1)db.prepare('UPDATE jobs SET score=?,score_line=? WHERE rowid=?').run(score,scoreLine,rowid);
}
export function getJobScore(job, userId = 1) {
  const r = active().prepare('SELECT uj.score,uj.score_line FROM jobs j JOIN user_jobs uj ON uj.job_id=j.rowid WHERE j.source=? AND j.external_id=? AND uj.user_id=?').get(job.source,job.external_id,userId);
  return r && r.score != null ? [r.score, r.score_line || ''] : null;
}
export function markRadarAlert(job, timestamp = nowIso(), connection = active()) {
  return connection.prepare('UPDATE jobs SET radar_alerted_at=? WHERE source=? AND external_id=? AND radar_alerted_at IS NULL').run(timestamp, job.source, job.external_id).changes > 0;
}
export function countRadarAlertsSince(since, connection = active()) { return connection.prepare('SELECT COUNT(*) AS count FROM jobs WHERE radar_alerted_at>=?').get(since).count; }
export function getProposal(rowid,userId=1) { return active().prepare('SELECT proposal FROM user_jobs WHERE job_id=? AND user_id=?').get(rowid,userId)?.proposal ?? null; }
export function getSentJobsWithoutProposal(limit = 5,userId=1) {
  return active().prepare(`SELECT j.rowid,j.source,j.external_id,j.title,j.description,j.url,j.budget FROM jobs j JOIN user_jobs uj ON uj.job_id=j.rowid WHERE uj.user_id=? AND uj.status='sent' AND (uj.proposal IS NULL OR TRIM(uj.proposal)='') ORDER BY j.created_at,j.rowid LIMIT ?`)
    .all(userId,Math.max(0,Math.min(limit,5))).map((r)=>[r.rowid,createJob({source:r.source,externalId:r.external_id,title:r.title,description:r.description,url:r.url,budget:r.budget})]);
}
export function getMessageId(rowid) { return active().prepare('SELECT message_id FROM jobs WHERE rowid=?').get(rowid)?.message_id ?? null; }
export function setMessageId(rowid, messageId) { active().prepare('UPDATE jobs SET message_id=? WHERE rowid=?').run(messageId, rowid); }
export function saveProposal(rowid,text,overwrite=false,userId=1) {
  const db=active(),sql=overwrite?'UPDATE user_jobs SET proposal=?,updated_at=? WHERE job_id=? AND user_id=?':'UPDATE user_jobs SET proposal=?,updated_at=? WHERE job_id=? AND user_id=? AND proposal IS NULL';
  const changed=db.prepare(sql).run(text,nowIso(),rowid,userId).changes>0;
  if(changed&&userId===1)db.prepare('UPDATE jobs SET proposal=? WHERE rowid=?').run(text,rowid);
  return changed;
}
export function savePrototypeUrl(rowid,url,userId=1){const db=active(),changed=db.prepare('UPDATE user_jobs SET prototype_url=?,updated_at=? WHERE job_id=? AND user_id=?').run(url,nowIso(),rowid,userId).changes>0;if(changed&&userId===1)db.prepare('UPDATE jobs SET prototype_url=? WHERE rowid=?').run(url,rowid);return changed;}
export function getPrototypeUrl(rowid,userId=1){return active().prepare('SELECT prototype_url FROM user_jobs WHERE job_id=? AND user_id=?').get(rowid,userId)?.prototype_url||null;}
export function saveEstimate(rowid,estimateDict,userId=1){const value=JSON.stringify(estimateDict),db=active();db.prepare('UPDATE user_jobs SET estimate=?,updated_at=? WHERE job_id=? AND user_id=?').run(value,nowIso(),rowid,userId);if(userId===1)db.prepare('UPDATE jobs SET estimate=? WHERE rowid=?').run(value,rowid);}
export function getEstimate(rowid,userId=1) {
  const value = active().prepare('SELECT estimate FROM user_jobs WHERE job_id=? AND user_id=?').get(rowid,userId)?.estimate;
  try { const parsed = value ? JSON.parse(value) : null; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}
export function saveEvaluation(rowid, evaluation, stats = {}, userId = 1) {
  const source = active().prepare('SELECT source FROM jobs WHERE rowid=?').get(rowid)?.source;
  const postedAt = source ? postedAtFromStats(source, stats || {}) : null;
  const db=active(), value=JSON.stringify(evaluation);
  db.prepare('UPDATE user_jobs SET evaluation=?,updated_at=? WHERE user_id=? AND job_id=?').run(value,nowIso(),userId,rowid);
  if(userId===1)db.prepare('UPDATE jobs SET evaluation=? WHERE rowid=?').run(value,rowid);
  db.prepare(`UPDATE jobs SET bid_count=COALESCE(?,bid_count),bid_avg=COALESCE(?,bid_avg),
    currency=COALESCE(NULLIF(TRIM(?),''),currency),posted_at=CASE WHEN ? IS NOT NULL AND (posted_at IS NULL OR datetime(posted_at)=datetime(created_at)) THEN ? ELSE posted_at END WHERE rowid=?`)
    .run(stats.bid_count ?? null, stats.bid_avg ?? null, stats.currency ?? '', postedAt, postedAt, rowid);
}
export function backfillTags(extractor = extractTags, connection = active()) {
  const conn = connection;
  const rows = conn.prepare("SELECT rowid,title,description FROM jobs WHERE tags IS NULL OR TRIM(tags)='' OR tags='[]'").all();
  const update = conn.prepare('UPDATE jobs SET tags=? WHERE rowid=?');
  transaction(conn, () => { for (const r of rows) update.run(JSON.stringify(extractor({ title:r.title, description:r.description })), r.rowid); });
  return rows.length;
}
export function countByStatus(userId = 1) {
  const counts = Object.fromEntries(active().prepare('SELECT status,COUNT(*) AS count FROM user_jobs WHERE user_id=? GROUP BY status').all(userId).map((r) => [r.status, r.count]));
  return Object.fromEntries(['new','sent','approved','applied','rejected','skipped'].map((s) => [s, counts[s] || 0]));
}

function parseJson(value, fallback = null) {
  try { return value == null || value === '' ? fallback : JSON.parse(value); } catch { return fallback; }
}
export function parseJobTags(value) {
  if (Array.isArray(value)) return value;
  const tags = parseJson(value, []);
  return Array.isArray(tags) ? tags : [];
}
function compactJob(row) {
  return {
    id: row.id, source: row.source, external_id: row.external_id, title: row.title, url: row.url,
    budget: row.budget || '', score: row.score ?? null, score_line: row.score_line || '', status: row.status,
    tags: parseJobTags(row.tags), currency: row.currency ?? null, bid_count: row.bid_count ?? null,
    bid_avg: row.bid_avg ?? null, posted_at: row.posted_at ?? null,
    applied_at: row.applied_at && String(row.applied_at).trim() ? row.applied_at : null, created_at: row.created_at,
    has_proposal: Boolean(row.proposal && String(row.proposal).trim()),
    has_estimate: Boolean(row.estimate && String(row.estimate).trim()), prototype_url: row.prototype_url ?? null,
  };
}

// Read-only API listing. All variable values are bound; sort expressions come
// exclusively from this fixed map after route validation.
export function listJobs(filters = {}, connection = active(), userId = 1) {
  const clauses = [];
  const values = [];
  if (filters.status) { clauses.push('uj.status = ?'); values.push(filters.status); }
  if (filters.source) { clauses.push('j.source = ?'); values.push(filters.source); }
  if (filters.tag) {
    const escaped = String(filters.tag).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
    clauses.push("j.tags LIKE ? ESCAPE '\\'"); values.push(`%"${escaped}"%`);
  }
  if (filters.min_score != null) { clauses.push('uj.score >= ?'); values.push(filters.min_score); }
  if (filters.search) {
    const escaped = String(filters.search).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
    const pattern = `%${escaped}%`;
    clauses.push("(j.title LIKE ? ESCAPE '\\' COLLATE NOCASE OR j.description LIKE ? ESCAPE '\\' COLLATE NOCASE)");
    values.push(pattern, pattern);
  }
  if (filters.since) { clauses.push('datetime(j.created_at) >= datetime(?)'); values.push(filters.since); }
  clauses.unshift('uj.user_id = ?'); values.unshift(userId);
  const where = ` WHERE ${clauses.join(' AND ')}`;
  const sorts = { newest: 'j.created_at DESC, j.rowid DESC', posted: 'j.posted_at DESC, j.created_at DESC, j.rowid DESC', score: 'uj.score DESC, j.created_at DESC, j.rowid DESC' };
  const from = ' FROM jobs j JOIN user_jobs uj ON uj.job_id=j.rowid';
  const total = connection.prepare(`SELECT COUNT(*) AS total${from}${where}`).get(...values).total;
  const rows = connection.prepare(`SELECT j.rowid AS id,j.source,j.external_id,j.title,j.url,j.budget,uj.score,uj.score_line,uj.status,j.tags,j.currency,j.bid_count,j.bid_avg,j.posted_at,uj.applied_at,j.created_at,uj.proposal,uj.estimate,uj.prototype_url${from}${where} ORDER BY ${sorts[filters.sort || 'newest']} LIMIT ? OFFSET ?`)
    .all(...values, filters.limit ?? 50, filters.offset ?? 0).map((row) => compactJob({ ...row }));
  return { items: rows, total };
}

export function countBySource(connection = active(), userId = 1) {
  const rows = connection.prepare('SELECT j.source,COUNT(*) AS count FROM jobs j JOIN user_jobs uj ON uj.job_id=j.rowid WHERE uj.user_id=? GROUP BY j.source').all(userId);
  return Object.fromEntries(rows.map((row) => [row.source, row.count]));
}
function readOnlyRows(dbPath, fields, where, params) {
  if (!fs.existsSync(dbPath)) return [];
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = reader.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    if (!tables.includes('jobs')) return [];
    const columns = new Set(reader.prepare('PRAGMA table_info(jobs)').all().map((r) => r.name));
    const select = fields.map((f) => columns.has(f) ? `"${f}"` : `NULL AS "${f}"`).join(',');
    return reader.prepare(`SELECT ${select} FROM jobs WHERE ${where}`).all(...params).map((row) => ({ ...row }));
  } finally { reader.close(); }
}
export function getPriceRows(days, dbPath = DB_PATH) {
  const n = Math.max(1, Math.min(Number(days) | 0, 365));
  return readOnlyRows(dbPath, ['created_at','tags','budget','currency','bid_avg','bid_count'], "created_at >= datetime('now', ?)", [`-${n} days`]);
}
export function getTimingRows(days, dbPath = DB_PATH) {
  const n = Math.max(1, Math.min(Number(days) | 0, 365));
  if (!fs.existsSync(dbPath)) return [];
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (!reader.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get()) return [];
    const columns = new Set(reader.prepare('PRAGMA table_info(jobs)').all().map((r) => r.name));
    const fields = ['created_at','posted_at','applied_at','score','status'];
    const select = fields.map((f) => columns.has(f) ? `"${f}"` : `NULL AS "${f}"`).join(',');
    const posted = columns.has('posted_at') ? 'COALESCE("posted_at","created_at")' : '"created_at"';
    return reader.prepare(`SELECT ${select} FROM jobs WHERE datetime(${posted}) >= datetime(?) AND (status IS NULL OR status!='skipped')`).all(`-${n} days`).map((row) => ({ ...row }));
  } finally { reader.close(); }
}
export function backfillPostedAt(connection = active()) {
  const conn = connection;
  const rows = conn.prepare("SELECT rowid,created_at FROM jobs WHERE posted_at IS NULL OR TRIM(posted_at)=''").all();
  const update = conn.prepare("UPDATE jobs SET posted_at=? WHERE rowid=? AND (posted_at IS NULL OR TRIM(posted_at)='')");
  let count = 0;
  transaction(conn, () => {
    for (const r of rows) {
      if (!r.created_at) continue;
      const date = new Date(`${String(r.created_at).replace(' ', 'T')}${String(r.created_at).includes('Z') || /[+-]\d\d:\d\d$/.test(r.created_at) ? '' : 'Z'}`);
      if (Number.isNaN(date.getTime())) continue;
      count += update.run(date.toISOString().replace(/\.\d{3}Z$/, 'Z'), r.rowid).changes;
    }
  });
  return count;
}
