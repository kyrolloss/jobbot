import { INTERVAL_MINUTES, SCAN_MIN_INTERVAL_MINUTES, SCAN_MAX_INTERVAL_MINUTES } from './config.js';
import * as defaultLogger from './logger.js';
import { runScan, tryAcquireScanLock, getScanState } from './scanner.js';
import { settingsStore as defaultSettingsStore, defaultSettings } from './settings.js';

function dateFrom(clock) {
  const value = clock.now ? clock.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function createScheduler({
  db,
  sources,
  onNewJob,
  logger = defaultLogger,
  settingsStore = defaultSettingsStore,
  scan = runScan,
  clock = {},
  random = Math.random,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  let currentSettings = defaultSettings();
  let settingsLoaded = false;
  let timer = null;
  let nextRunAt = null;
  let started = false;
  let timerGeneration = 0;
  let lastScan = null;

  function clearScheduled() {
    timerGeneration++;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    nextRunAt = null;
  }

  function scheduleNext() {
    if (!started || !currentSettings.scan_enabled) return;
    const randomValue = Number(random());
    const jitter = Math.max(0, Math.min(1, Number.isFinite(randomValue) ? randomValue : 0)) * 5 * 60_000;
    const delay = currentSettings.interval_minutes * 60_000 + jitter;
    const due = dateFrom(clock).getTime() + delay;
    nextRunAt = new Date(due).toISOString();
    const generation = timerGeneration;
    timer = setTimeoutFn(async () => {
      if (generation !== timerGeneration) return;
      timer = null;
      nextRunAt = null;
      const release = tryAcquireScanLock();
      if (!release) {
        logger.warn('Scheduled scan skipped because another scan is running');
        reschedule();
        return;
      }
      try {
        lastScan = await scan({ db, sources, trigger: 'scheduled', clock, onNewJob, lock: release });
        if (db && lastScan) {
          db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
          db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('last_scan',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
            .run(JSON.stringify(lastScan), dateFrom(clock).toISOString());
        }
      }
      catch { logger.error('Scheduled scan failed'); }
      finally {
        release();
        reschedule();
      }
    }, delay);
    timer?.unref?.();
  }

  function reschedule() {
    clearScheduled();
    scheduleNext();
  }
  function loadSettings() {
    if (!settingsLoaded) {
      currentSettings = settingsStore?.read?.() || currentSettings;
      if (db) {
        try { const row = db.prepare("SELECT value FROM app_settings WHERE key='last_scan'").get(); if (row) lastScan = JSON.parse(row.value); } catch { /* An absent or old status row is harmless. */ }
      }
      settingsLoaded = true;
    }
  }

  return {
    start() {
      clearScheduled();
      started = true;
      loadSettings();
      scheduleNext();
      return this.status();
    },
    stop() {
      clearScheduled();
      started = false;
      return this.status();
    },
    updateSettings(settings) {
      if (!settings || typeof settings.scan_enabled !== 'boolean'
        || !Number.isInteger(settings.interval_minutes)
        || settings.interval_minutes < SCAN_MIN_INTERVAL_MINUTES
        || settings.interval_minutes > SCAN_MAX_INTERVAL_MINUTES) {
        throw new TypeError('Invalid scan settings');
      }
      clearScheduled();
      currentSettings = { scan_enabled: settings.scan_enabled, interval_minutes: settings.interval_minutes };
      settingsLoaded = true;
      if (currentSettings.scan_enabled) started = true;
      scheduleNext();
      return this.status();
    },
    status() {
      loadSettings();
      return {
        running: getScanState().running,
        started_at: getScanState().started_at,
        enabled: currentSettings.scan_enabled,
        interval_minutes: currentSettings.interval_minutes || INTERVAL_MINUTES,
        next_run_at: currentSettings.scan_enabled ? nextRunAt : null,
        last_scan: getScanState().last_scan || lastScan,
      };
    },
  };
}

