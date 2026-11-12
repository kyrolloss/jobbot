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
      try { await scan({ db, sources, trigger: 'scheduled', clock, onNewJob, lock: release }); }
      catch { logger.error('Scheduled scan failed'); }
      finally {
        release();
        reschedule();
      }
    }, delay);
  }

  function reschedule() {
    clearScheduled();
    scheduleNext();
  }
  function loadSettings() {
    if (!settingsLoaded) {
      currentSettings = settingsStore?.read?.() || currentSettings;
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
        last_scan: getScanState().last_scan,
      };
    },
  };
}

