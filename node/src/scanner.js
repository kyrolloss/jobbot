import { API_KEY, GEMINI_API_KEY, SCORING_STATS_MAX_PER_SCAN, SCORING_STATS_MIN_INTERVAL_SECONDS } from './config.js';
import { extractTags } from './tech.js';
import { matchesJob } from './filters.js';
import { scoreJob } from './score.js';
import { backfillPostedAt, backfillTags, parseJobTags, postedAtFromStats } from './db.js';
import { serializeDbTimestamp } from './events.js';
import * as defaultLogger from './logger.js';
import { SourceError } from './sources/base.js';
import { FreelancerSource } from './sources/freelancer.js';
import { MostaqlSource } from './sources/mostaql.js';
import { KhamsatSource } from './sources/khamsat.js';
import * as defaultConfig from './config.js';
import { fanOutJob } from './user_jobs.js';
import { parseStoredProfile, profileSearchTerms } from './profile.js';

let lockHeld = false;
let activeStartedAt = null;
let lastScan = null;
let tagBackfillStarted = false;
let postedAtBackfillStarted = false;

export class ScanAlreadyRunningError extends Error {
  constructor() { super('A scan is already running'); this.name = 'ScanAlreadyRunningError'; }
}

export function tryAcquireScanLock() {
  if (lockHeld) return null;
  lockHeld = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockHeld = false;
  };
}

export function isScanRunning() { return lockHeld; }
export function getScanState() { return { running: lockHeld, started_at: activeStartedAt, last_scan: lastScan }; }

export function createDefaultSources() {
  return [new MostaqlSource(), new FreelancerSource(), new KhamsatSource()];
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
function iso(value) { return asDate(value).toISOString(); }
function makeError(error, source, fallback = 'network') {
  if (error instanceof SourceError || (error && typeof error === 'object' && error.kind)) {
    return { source: error.source || source, kind: error.kind, status: error.status ?? null, message: String(error.message || 'Source request failed') };
  }
  return { source, kind: fallback, status: null, message: String(error?.message || 'Source request failed') };
}
function addError(entry, error, source, fallback) {
  entry.errors.push(makeError(error, source, fallback));
}
const EVENT_SECRET_PATTERNS = [
  /\b((?:"?(?:TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|GEMINI_API_KEY|REPORT_API_KEY|TOKEN|API_KEY|APIKEY|AUTHORIZATION|X-REPORT-KEY|X-API-KEY)"?)\s*[=:]\s*["']?)[^\s,;"'}]+/gi,
  /\b[0-9]{5,}:[A-Za-z0-9_-]+/g,
  /\b(?:sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+)/g,
];
export function safeEventData(value) {
  if (typeof value === 'string') {
    let safe = value;
    for (const secret of [API_KEY, GEMINI_API_KEY]) if (secret) safe = safe.split(secret).join('[REDACTED]');
    safe = safe.replace(EVENT_SECRET_PATTERNS[0], (_match, prefix) => `${prefix}[REDACTED]`);
    for (const pattern of EVENT_SECRET_PATTERNS.slice(1)) safe = safe.replace(pattern, '[REDACTED]');
    return safe;
  }
  if (Array.isArray(value)) return value.map(safeEventData);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, safeEventData(child)]));
  }
  return value;
}
function emitEvent(events, logger, type, data) {
  if (typeof events?.emit !== 'function') return false;
  try { events.emit(type, safeEventData(data)); return true; }
  catch { try { logger?.error?.('Scanner event emission failed'); } catch { /* Event reporting must not stop scanning. */ } return false; }
}
export function savedJobEventData(db, rowid, userId = 1) {
  const row = db.prepare(`SELECT j.rowid AS id,j.source,j.external_id,j.title,j.url,j.budget,uj.score,uj.score_line,j.tags,uj.status,j.created_at,j.posted_at
    FROM jobs j JOIN user_jobs uj ON uj.job_id=j.rowid WHERE j.rowid=? AND uj.user_id=?`).get(rowid,userId);
  if (!row || row.status !== 'sent') return null;
  return safeEventData({
    user_id: userId, id: Number(row.id), source: row.source, external_id: row.external_id, title: row.title,
    url: row.url, budget: row.budget || '', score: row.score ?? null, score_line: row.score_line || '',
    tags: parseJobTags(row.tags), status: row.status,
    created_at: serializeDbTimestamp(row.created_at), posted_at: serializeDbTimestamp(row.posted_at ?? null),
  });
}
export function emitSavedJobEvent({ db, rowid, events, logger = defaultLogger, userIds = null }) {
  if (rowid == null) return false;
  try {
    const recipients = userIds || db.prepare("SELECT user_id FROM user_jobs WHERE job_id=? AND status='sent'").all(rowid).map((r) => r.user_id);
    let emitted = false;
    for (const userId of recipients) {
      const data = savedJobEventData(db, rowid, userId);
      if (data) emitted = emitEvent(events, logger, 'new_job', data) || emitted;
    }
    return emitted;
  } catch {
    try { logger?.error?.('Could not prepare new-job event'); } catch { /* Event reporting must not stop scanning. */ }
    return false;
  }
}
function insertJob(db, job, status, tags, now) {
  const timestamp = iso(now);
  const createdAt = timestamp.slice(0, 19).replace('T', ' ');
  const result = db.prepare(`INSERT OR IGNORE INTO jobs
    (source,external_id,title,description,url,budget,status,tags,created_at,posted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(job.source, job.external_id, job.title || '', job.description || '', job.url || '', job.budget || '', status, JSON.stringify(tags || []), createdAt, timestamp);
  return { saved: result.changes > 0, rowid: result.changes ? Number(result.lastInsertRowid) : null };
}
function saveNonEmptyStats(db, job, stats) {
  const fields = [];
  const values = [];
  for (const field of ['bid_count', 'bid_avg', 'currency']) {
    const value = stats?.[field];
    if (value == null || (typeof value === 'string' && !value.trim())) continue;
    fields.push(`"${field}"=?`);
    values.push(typeof value === 'string' ? value.trim() : value);
  }
  if (fields.length) db.prepare(`UPDATE jobs SET ${fields.join(',')} WHERE source=? AND external_id=?`).run(...values, job.source, job.external_id);
}
function savePostedAt(db, job, stats) {
  const postedAt = postedAtFromStats(job.source, stats || {});
  if (!postedAt) return;
  db.prepare(`UPDATE jobs SET posted_at=? WHERE source=? AND external_id=?
    AND (posted_at IS NULL OR datetime(posted_at)=datetime(created_at))`).run(postedAt, job.source, job.external_id);
}

export async function processNewJob({ db, source, job: inputJob, statsFetchAllowed = true, clock = {}, dryRun = false, config = defaultConfig }) {
  const result = { job: inputJob, matched: false, saved: false, rowid: null, score: null, scoreLine: null, userIds: [], stats: {}, statsFetched: false, detailsFailed: false, detailsUnavailable: false, filteredOut: false, errors: [] };
  const wallNow = clock.now || (() => new Date());
  const detailsWereBlocked = source.name === 'khamsat' && Boolean(source.detailsBlocked);
  if ('lastDetailError' in source) source.lastDetailError = null;
  try {
    const detailed = await source.fetchDetails(inputJob);
    if (!detailed) throw new Error('Source returned no job details');
    result.job = detailed;
  } catch (error) {
    result.detailsFailed = true;
    addError(result, error, source.name, 'network');
    return result;
  }
  if (source.name === 'khamsat' && (detailsWereBlocked || source.lastDetailError)) {
    // Khamsat's Python source returns the list-level Job when details are
    // unavailable (including HTTP 202 and an open breaker); keep processing it.
    result.detailsUnavailable = true;
    source.lastDetailError = null;
  }

  const ownerProfile = parseStoredProfile(db.prepare('SELECT profile_md FROM user_profiles WHERE user_id=1').get()?.profile_md);
  const ownerTerms = profileSearchTerms(ownerProfile);
  const tags = extractTags(result.job);
  if (!matchesJob(result.job, ownerProfile ? ownerTerms : null)) {
    result.filteredOut = true;
    if (dryRun) return result;
    try {
      const inserted = insertJob(db, result.job, 'skipped', tags, wallNow());
      result.saved = inserted.saved;
      result.rowid = inserted.rowid;
      if (inserted.saved) result.userIds = fanOutJob({ db, rowid: inserted.rowid, job: result.job, status: 'skipped', config, now: wallNow });
    } catch (error) { addError(result, error, source.name, 'server'); }
    return result;
  }

  let inserted = { saved: true, rowid: null };
  if (!dryRun) {
    try { inserted = insertJob(db, result.job, 'sent', tags, wallNow()); }
    catch (error) { addError(result, error, source.name, 'server'); return result; }
    result.saved = inserted.saved;
    result.rowid = inserted.rowid;
    if (!inserted.saved) return result;
  }
  result.matched = true;

  if (statsFetchAllowed) {
    result.statsFetched = true;
    try { result.stats = await source.fetchStats(result.job) || {}; }
    catch (error) { addError(result, error, source.name, 'network'); result.stats = {}; }
    if (source.lastDetailError) {
      if (source.name === 'khamsat') {
        result.detailsUnavailable = true;
        source.lastDetailError = null;
      } else addError(result, source.lastDetailError, source.name, 'network');
    }
  }
  try {
    const scored = scoreJob(result.job, result.stats, ownerProfile ? ownerTerms.include : undefined);
    result.score = scored.score;
    result.scoreLine = scored.line;
    result.job.score = scored.score;
    result.job.score_line = scored.line;
    if (!dryRun) {
      saveNonEmptyStats(db, result.job, result.stats);
      savePostedAt(db, result.job, result.stats);
      db.prepare('UPDATE jobs SET score=?,score_line=? WHERE source=? AND external_id=?').run(scored.score, scored.line, result.job.source, result.job.external_id);
    }
  } catch (error) { addError(result, error, source.name, 'server'); }
  if (!dryRun && result.saved && result.rowid != null) result.userIds = fanOutJob({ db, rowid: result.rowid, job: result.job, stats: result.stats, status: 'sent', score: result.score, scoreLine: result.scoreLine, config, now: wallNow });
  return result;
}

function sourceStats(name) {
  return {
    fetched: 0, new_candidates: 0, filtered_out: 0, details_failed: 0, details_unavailable: 0,
    new_saved: 0, stats_fetched: 0, would_save: 0, would_skip_filtered: 0,
    would_skip_details_failed: 0, errors: [],
  };
}

export async function runScan({ db, sources = createDefaultSources(), trigger = 'manual', clock = {}, onNewJob = () => {}, lock, dryRun = false, events = null, logger = defaultLogger, config = defaultConfig } = {}) {
  if (!db) throw new TypeError('runScan requires a database connection');
  const release = lock || tryAcquireScanLock();
  if (!release) throw new ScanAlreadyRunningError();
  const selectedClock = {
    now: clock.now || (() => new Date()),
    monotonic: clock.monotonic || (() => performance.now()),
    sleep: clock.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
  const startMono = selectedClock.monotonic();
  activeStartedAt = iso(selectedClock.now());
  const startedAt = activeStartedAt;
  const perSource = Object.fromEntries(sources.map((source) => [source.name, sourceStats(source.name)]));
  const newJobs = [];
  let statsSlotsUsed = 0;
  let lastStatsRequestAt = null;
  try {
    if (!dryRun && !tagBackfillStarted) {
      tagBackfillStarted = true;
      try { backfillTags(undefined, db); } catch (error) { if (sources[0]) addError(perSource[sources[0].name], error, sources[0].name, 'server'); }
    }
    if (!dryRun && !postedAtBackfillStarted) {
      postedAtBackfillStarted = true;
      try { backfillPostedAt(db); } catch (error) { if (sources[0]) addError(perSource[sources[0].name], error, sources[0].name, 'server'); }
    }
    for (const source of sources) {
      const counts = perSource[source.name];
      let fetched;
      try {
        const response = await source.fetchJobs();
        fetched = Array.isArray(response) ? response : response?.jobs || [];
        for (const error of response?.errors || []) addError(counts, error, source.name, 'network');
      } catch (error) {
        addError(counts, error, source.name, 'network');
        continue;
      }
      counts.fetched = fetched.length;

      for (const job of fetched) {
        let alreadyKnown;
        try { alreadyKnown = Boolean(db.prepare('SELECT 1 FROM jobs WHERE source=? AND external_id=?').get(job.source, job.external_id)); }
        catch (error) { addError(counts, error, source.name, 'server'); continue; }
        if (alreadyKnown) continue;
        counts.new_candidates++;

        const statsFetchAllowed = statsSlotsUsed < SCORING_STATS_MAX_PER_SCAN;
        if (statsFetchAllowed) {
          if (lastStatsRequestAt != null) {
            const elapsedSeconds = selectedClock.monotonic() - lastStatsRequestAt;
            const remaining = SCORING_STATS_MIN_INTERVAL_SECONDS * 1000 - elapsedSeconds;
            if (remaining > 0) await selectedClock.sleep(remaining);
          }
          statsSlotsUsed++;
          lastStatsRequestAt = selectedClock.monotonic();
        }
        let processed;
        try { processed = await processNewJob({ db, source, job, statsFetchAllowed, clock: selectedClock, dryRun, config }); }
        catch (error) {
          addError(counts, error, source.name, 'server');
          counts.details_failed++;
          counts.would_skip_details_failed++;
          continue;
        }
        counts.filtered_out += Number(processed.filteredOut);
        counts.details_failed += Number(processed.detailsFailed);
        counts.details_unavailable += Number(processed.detailsUnavailable);
        counts.new_saved += Number(processed.saved);
        counts.stats_fetched += Number(processed.statsFetched);
        if (processed.detailsFailed) counts.would_skip_details_failed++;
        else if (processed.filteredOut) counts.would_skip_filtered++;
        else if (processed.matched) counts.would_save++;
        counts.errors.push(...processed.errors);
        if ((processed.matched && (processed.saved || dryRun) && processed.score != null)
          || (!dryRun && processed.saved && processed.userIds.length)) {
          const fanoutScore = processed.score ?? db.prepare("SELECT MAX(score) AS score FROM user_jobs WHERE job_id=? AND status='sent'").get(processed.rowid)?.score ?? 0;
          newJobs.push({ source: source.name, job: processed.job, rowid: processed.rowid, score: fanoutScore, userIds: processed.userIds, ownerMatched: processed.matched });
        }
      }
    }

    newJobs.sort((a, b) => b.score - a.score);
    for (const item of newJobs) {
      if (!dryRun) emitSavedJobEvent({ db, rowid: item.rowid, events, logger, userIds: item.userIds });
      if (item.ownerMatched) {
        try { await onNewJob(item.job, item.rowid); }
        catch (error) { addError(perSource[item.source], error, item.source, 'server'); }
      }
    }

    const finishedAt = iso(selectedClock.now());
    for (const source of sources) {
      const state = perSource[source.name];
      const firstError = state.errors[0];
      try {
        db.prepare(`INSERT INTO source_scan_state(source,enabled,last_scan_at,last_count,last_error_code,last_error_message)
          VALUES(?,1,?,?,?,?) ON CONFLICT(source) DO UPDATE SET enabled=1,last_scan_at=excluded.last_scan_at,
          last_count=excluded.last_count,last_error_code=excluded.last_error_code,last_error_message=excluded.last_error_message`)
          .run(source.name, finishedAt, state.fetched, firstError ? (firstError.status ? `HTTP_${firstError.status}` : String(firstError.kind || 'SOURCE_ERROR').toUpperCase()) : null, firstError ? String(firstError.message || 'Source request failed').slice(0, 240) : null);
      } catch { /* Status reporting must never stop a scan. */ }
    }
    const duration = Math.max(0, selectedClock.monotonic() - startMono);
    const totals = Object.values(perSource).reduce((sum, current) => ({
      fetched: sum.fetched + current.fetched,
      new_candidates: sum.new_candidates + current.new_candidates,
      filtered_out: sum.filtered_out + current.filtered_out,
      details_failed: sum.details_failed + current.details_failed,
      details_unavailable: sum.details_unavailable + current.details_unavailable,
      new_saved: sum.new_saved + current.new_saved,
      stats_fetched: sum.stats_fetched + current.stats_fetched,
      would_save: sum.would_save + current.would_save,
      would_skip_filtered: sum.would_skip_filtered + current.would_skip_filtered,
      would_skip_details_failed: sum.would_skip_details_failed + current.would_skip_details_failed,
      errors: sum.errors + current.errors.length,
    }), {
      fetched: 0, new_candidates: 0, filtered_out: 0, details_failed: 0, details_unavailable: 0,
      new_saved: 0, stats_fetched: 0, would_save: 0, would_skip_filtered: 0,
      would_skip_details_failed: 0, errors: 0,
    });
    lastScan = { started_at: startedAt, finished_at: finishedAt, duration_ms: duration, trigger, per_source: perSource, totals };
    emitEvent(events, logger, 'scan_finished', { ...lastScan, user_id: 1 });
    return lastScan;
  } finally {
    activeStartedAt = null;
    release();
  }
}
