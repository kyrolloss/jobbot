import * as defaultConfig from './config.js';
import * as defaultLogger from './logger.js';
import { FREELANCER_QUERIES } from './config.js';
import { countRadarAlertsSince, markRadarAlert } from './db.js';
import { emitSavedJobEvent, processNewJob, safeEventData, savedJobEventData, tryAcquireScanLock } from './scanner.js';
import { SourceError } from './sources/base.js';
import { defaultSettings, settingsStore as defaultSettingsStore } from './settings.js';
import fs from 'node:fs';
import { buildProposalPrompt } from './ai/proposal.js';
import { saveProposal, setStatus } from './db.js';
import { getJobCategory, sendPushNotification } from './notifications.js';

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
function iso(value) { return asDate(value).toISOString(); }
function interval(config) {
  const value = Number(config.RADAR_INTERVAL_SECONDS);
  return Math.max(60, Number.isFinite(value) ? Math.trunc(value) : 120);
}
function alertCutoff(now) { return new Date(asDate(now).getTime() - 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

function backoffIssue(error) {
  if (!error || typeof error !== 'object') return false;
  const status = Number(error.status);
  const kind = error.kind || (status === 429 ? 'rate_limit' : status >= 500 && status <= 599 ? 'server' : null);
  return kind === 'rate_limit' || kind === 'server' || kind === 'network';
}

function retryAfterSeconds(error, now) {
  if (!error || typeof error !== 'object') return 0;
  for (const key of ['retryAfterSeconds', 'retry_after_seconds', 'retry_after', 'retryAfter']) {
    const value = error[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string' && value.trim()) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
      const date = Date.parse(value);
      if (Number.isFinite(date)) return Math.max(0, (date - asDate(now).getTime()) / 1000);
    }
  }
  const header = error.headers?.['retry-after'] ?? error.headers?.get?.('retry-after');
  if (header != null) return retryAfterSeconds({ retryAfter: String(header) }, now);
  return 0;
}

function hasQuietHour(value, now) {
  const text = String(value || '').trim();
  if (!text) return false;
  try {
    const [startText, endText] = text.split('-', 2);
    if (endText === undefined) return false;
    const start = Number(startText), end = Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > 23 || end < 0 || end > 23) return false;
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', hour: '2-digit', hourCycle: 'h23' }).format(asDate(now)));
    return start < end ? start <= hour && hour < end : hour >= start || hour < end;
  } catch { return false; }
}

function ageMinutes(stats, now) {
  const submitted = Number(stats?.time_submitted);
  if (!Number.isFinite(submitted) || submitted <= 0) return null;
  return Math.max(0, (asDate(now).getTime() / 1000 - submitted) / 60);
}

export function qualifiesForRadar({ stats = {}, score, now = new Date(), alertsLastHour = 0, config = defaultConfig } = {}) {
  const rawBids = Number(stats.bid_count);
  if (stats.bid_count == null || !Number.isFinite(rawBids)) return false;
  const bids = Math.trunc(rawBids); // Python int() truncates toward zero.
  const age = ageMinutes(stats, now);
  return bids <= Number(config.RADAR_MAX_BIDS)
    && age !== null && age <= Number(config.RADAR_MAX_AGE_MINUTES)
    && Number.isFinite(Number(score)) && Number(score) >= Number(config.RADAR_MIN_SCORE)
    && !hasQuietHour(config.RADAR_QUIET_HOURS, now)
    && alertsLastHour < Number(config.RADAR_MAX_ALERTS_PER_HOUR);
}

function emptyResult() { return { fetched: 0, new: 0, saved: 0, alerts: 0 }; }

export function createRadar({
  db,
  source,
  events = null,
  settingsStore = defaultSettingsStore,
  config = defaultConfig,
  logger = defaultLogger,
  clock = {},
  random = Math.random,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  guard = null,
  gemini = null,
} = {}) {
  if (!db) throw new TypeError('createRadar requires an open database connection');
  if (!source || source.name !== 'freelancer') throw new TypeError('createRadar requires the Freelancer source');

  const normalInterval = interval(config);
  const backoffCap = 900;
  let enabled = Boolean(config.RADAR_ENABLED);
  let settingsLoaded = false;
  let started = false;
  let runningCycle = false;
  let queryIndex = 0;
  let timer = null;
  let timerGeneration = 0;
  let nextCycleAt = null;
  let lastCycleAt = null;
  let lastCycleResult = null;
  let backoffSeconds = normalInterval;

  function now() { return asDate(clock.now ? clock.now() : new Date()); }
  function loadSettings() {
    if (settingsLoaded) return;
    const stored = settingsStore?.read?.() || defaultSettings();
    enabled = typeof stored.radar_enabled === 'boolean' ? stored.radar_enabled : Boolean(config.RADAR_ENABLED);
    settingsLoaded = true;
  }
  function clearTimer() {
    timerGeneration++;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    nextCycleAt = null;
  }
  function scheduleNext() {
    clearTimer();
    if (!started || !enabled) return;
    const delaySeconds = Math.max(normalInterval, backoffSeconds);
    const due = now().getTime() + delaySeconds * 1000;
    nextCycleAt = new Date(due).toISOString();
    const generation = timerGeneration;
    timer = setTimeoutFn(() => {
      if (generation !== timerGeneration) return;
      timer = null;
      nextCycleAt = null;
      void runCycle().finally(() => scheduleNext());
    }, delaySeconds * 1000);
    timer?.unref?.();
  }
  function debugBusy() {
    const line = '[radar] cycle skipped because scanner lock is busy';
    if (typeof logger.debug === 'function') logger.debug(line);
    else console.debug(line);
  }
  function status() {
    loadSettings();
    let alertsLastHour = 0;
    try { alertsLastHour = countRadarAlertsSince(alertCutoff(now()), db); }
    catch { try { logger.error('Could not count recent radar alerts'); } catch { /* Status remains available. */ } }
    return {
      enabled,
      running_cycle: runningCycle,
      interval_seconds: normalInterval,
      last_cycle_at: lastCycleAt,
      last_cycle_result: lastCycleResult ? { ...lastCycleResult } : null,
      alerts_last_hour: alertsLastHour,
      max_alerts_per_hour: Number(config.RADAR_MAX_ALERTS_PER_HOUR),
      next_cycle_at: nextCycleAt,
      backoff_seconds: backoffSeconds,
    };
  }
  function saveEnabled(value) {
    const current = settingsStore?.read?.() || defaultSettings();
    const saved = settingsStore.write({ ...current, radar_enabled: value });
    enabled = saved.radar_enabled;
    settingsLoaded = true;
    return enabled;
  }
  function selectQueries() {
    const all = Array.isArray(source.queries) ? source.queries : [...FREELANCER_QUERIES];
    if (!all.length) return [];
    const requested = Number(config.RADAR_QUERIES_PER_CYCLE);
    const count = Math.min(all.length, Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : 2));
    const selected = Array.from({ length: count }, (_, offset) => all[(queryIndex + offset) % all.length]);
    queryIndex = (queryIndex + count) % all.length;
    return selected;
  }
  function updateBackoff(issues, nowValue) {
    const failed = issues.filter(backoffIssue);
    if (!failed.length) {
      backoffSeconds = normalInterval;
      return;
    }
    const retry = Math.max(0, ...failed.map((error) => retryAfterSeconds(error, nowValue)));
    // Retry-After is an explicit server delay and takes precedence over the
    // locally calculated exponential delay for this cycle.
    backoffSeconds = Math.min(backoffCap, retry > 0 ? Math.max(normalInterval, retry) : Math.max(normalInterval, backoffSeconds * 2));
  }

  const pendingProposals = new Set();
  async function autoProposal(jobId) {
    if(!config.RADAR_AUTO_PROPOSAL || !guard || !gemini)return;
    try {
      const row=db.prepare(`SELECT j.rowid AS id,j.source,j.external_id,j.title,j.description,j.budget,uj.status FROM jobs j JOIN user_jobs uj ON uj.job_id=j.rowid WHERE j.rowid=? AND uj.user_id=1`).get(jobId);
      if(!row)return;
      let profile=db.prepare('SELECT profile_md FROM user_profiles WHERE user_id=1').get()?.profile_md?.trim();
      if(!profile){try{profile=fs.readFileSync(config.PROFILE_PATH,'utf8').trim();}catch{}}
      if(!profile)throw new Error('Profile unavailable');
      const output=await guard.execute({principal:{userId:1,role:'owner',planId:'owner'},feature:'proposal',jobId},async()=>{
        const generated=await gemini.generate({prompt:buildProposalPrompt(row,profile)});
        if(!generated.text.trim())throw new Error('Empty proposal');
        return {result:generated.text.trim(),usage:generated.usage};
      });
      saveProposal(jobId,output,true,1);
      if(row.status==='sent')setStatus(row,'approved',db,1);
      events?.emit?.('proposal_ready',{user_id:1,job_id:jobId});
    }catch{try{logger.warn('Radar auto-proposal failed');}catch{}}
  }
  async function runCycle() {
    loadSettings();
    if (!enabled || runningCycle) return false;
    const release = tryAcquireScanLock();
    if (!release) {
      debugBusy();
      lastCycleAt = iso(now());
      lastCycleResult = emptyResult();
      return false;
    }
    runningCycle = true;
    const cycleNow = now();
    const counts = emptyResult();
    const issues = [];
    try {
      const queries = selectQueries();
      const originalQueries = source.queries;
      let response;
      try {
        source.queries = queries;
        response = await source.fetchJobs();
      } finally { source.queries = originalQueries; }
      const jobs = Array.isArray(response) ? response : response?.jobs || [];
      const sourceErrors = response?.errors || [];
      issues.push(...sourceErrors);
      counts.fetched = jobs.length;
      const seen = new Set();
      for (const job of jobs) {
        const identity = `${job.source}\u0000${job.external_id}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        let alreadyKnown;
        try { alreadyKnown = Boolean(db.prepare('SELECT 1 FROM jobs WHERE source=? AND external_id=?').get(job.source, job.external_id)); }
        catch { try { logger.error('Radar duplicate check failed'); } catch { /* Continue with the remaining jobs. */ } continue; }
        if (alreadyKnown) continue;
        counts.new++;
        try {
          const processed = await processNewJob({ db, source, job, statsFetchAllowed: true, clock, config });
          issues.push(...processed.errors);
          if (processed.saved) counts.saved++;
          if (processed.matched && processed.saved) {
            emitSavedJobEvent({ db, rowid: processed.rowid, events, logger });
            const sentUsers = db.prepare("SELECT user_id FROM user_jobs WHERE job_id=? AND status='sent' ORDER BY user_id").all(processed.rowid).map((row) => row.user_id);
            const stats = processed.stats || {};
            const age = ageMinutes(stats, cycleNow);
            let alertsLastHour = 0;
            try { alertsLastHour = countRadarAlertsSince(alertCutoff(cycleNow), db); }
            catch { try { logger.error('Could not count recent radar alerts'); } catch { /* Alert checks fail closed. */ } }
            if (sentUsers.length && qualifiesForRadar({ stats, score: processed.score, now: cycleNow, alertsLastHour, config })) {
              const ageAtAlert = ageMinutes(stats, cycleNow);
              try {
                if (events?.emit) {
                  for (const userId of sentUsers) {
                    const saved = savedJobEventData(db, processed.rowid, userId);
                    if (saved) events.emit('radar_alert', safeEventData({ ...saved, bid_count: stats.bid_count ?? null, bid_avg: stats.bid_avg ?? null, age_minutes: ageAtAlert }));
                  }
                  if(sentUsers.includes(1)&&config.RADAR_AUTO_PROPOSAL!==false)pendingProposals.add(processed.rowid);
                  const timestamp = cycleNow.toISOString().replace(/\.\d{3}Z$/, 'Z');
                  if (markRadarAlert({ source: job.source, external_id: job.external_id }, timestamp, db)) {
                    counts.alerts++;
                    for (const userId of sentUsers) {
                      const saved = savedJobEventData(db, processed.rowid, userId);
                      if (!saved) continue;
                      const notificationJob = { id: saved.id, title: saved.title, score: saved.score, category: getJobCategory(saved) };
                      try { await sendPushNotification(userId, notificationJob, { db, logger }); }
                      catch (failure) { try { logger.error(Number.isInteger(failure?.status) ? failure.status : 'FCM HTTP status unavailable'); } catch { /* Push failures do not stop radar. */ } }
                    }
                  }
                }
              } catch { try { logger.error('Radar alert emission failed'); } catch { /* Event failures do not stop the cycle. */ } }
            }
          }
        } catch (error) {
          if (error && typeof error === 'object' && error.kind) issues.push(error);
          try { logger.error('Radar job processing failed'); } catch { /* Keep processing candidates. */ }
        }
      }
      updateBackoff(issues, cycleNow);
      lastCycleAt = iso(now());
      lastCycleResult = counts;
      return true;
    } catch (error) {
      if (error instanceof SourceError || (error && typeof error === 'object' && error.kind)) issues.push(error);
      updateBackoff(issues.length ? issues : [{ kind: 'network' }], cycleNow);
      lastCycleAt = iso(now());
      lastCycleResult = counts;
      try { logger.error('Radar cycle failed'); } catch { /* A cycle failure must not stop the process. */ }
      return false;
    } finally {
      runningCycle = false;
      release();
      for(const jobId of pendingProposals)queueMicrotask(()=>{void autoProposal(jobId);});
      pendingProposals.clear();
    }
  }

  return {
    start() {
      loadSettings();
      started = true;
      scheduleNext();
      return status();
    },
    stop() {
      clearTimer();
      started = false;
      return { enabled, running_cycle: runningCycle, next_cycle_at: null };
    },
    enable() {
      loadSettings();
      saveEnabled(true);
      started = true;
      scheduleNext();
      return status();
    },
    disable() {
      loadSettings();
      saveEnabled(false);
      scheduleNext();
      return status();
    },
    status,
    runCycle,
    getQueryIndex() { return queryIndex; },
  };
}
