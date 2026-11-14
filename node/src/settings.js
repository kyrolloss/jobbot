import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from './config.js';
import * as defaultLogger from './logger.js';
import { connect } from './db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SETTINGS_PATH = path.join(ROOT, 'settings.json');

export function defaultSettings() {
  return { scan_enabled: false, interval_minutes: config.INTERVAL_MINUTES };
}

function validSettings(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.scan_enabled === 'boolean'
    && Number.isInteger(value.interval_minutes)
    && value.interval_minutes >= config.SCAN_MIN_INTERVAL_MINUTES
    && value.interval_minutes <= config.SCAN_MAX_INTERVAL_MINUTES
    && (!Object.hasOwn(value, 'radar_enabled') || typeof value.radar_enabled === 'boolean'));
}

function normalizeSettings(value) {
  const normalized = { scan_enabled: value.scan_enabled, interval_minutes: value.interval_minutes };
  if (Object.hasOwn(value, 'radar_enabled')) normalized.radar_enabled = value.radar_enabled;
  return normalized;
}

export function createSettingsStore({ filePath = SETTINGS_PATH, logger = defaultLogger, fsImpl = fs } = {}) {
  function atomicWrite(settings) {
    const directory = path.dirname(filePath);
    fsImpl.mkdirSync(directory, { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      fsImpl.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      fsImpl.renameSync(temporary, filePath);
    } catch (error) {
      try { fsImpl.rmSync(temporary, { force: true }); } catch { /* Preserve the write error. */ }
      throw error;
    }
  }

  function read() {
    if (!fsImpl.existsSync(filePath)) {
      const defaults = defaultSettings();
      atomicWrite(defaults);
      return defaults;
    }
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      if (!validSettings(parsed)) throw new Error('settings schema invalid');
      return normalizeSettings(parsed);
    } catch {
      logger.warn('Invalid settings.json; using default scan settings');
      const defaults = defaultSettings();
      atomicWrite(defaults);
      return defaults;
    }
  }

  function write(value) {
    if (!validSettings(value)) throw new TypeError('Invalid scan settings');
    const normalized = normalizeSettings(value);
    atomicWrite(normalized);
    return normalized;
  }

  function update(patch) { return write({ ...read(), ...patch }); }
  return { read, write, update, filePath };
}

export function createDatabaseSettingsStore({ dbProvider = connect } = {}) {
  function read() {
    const db = dbProvider();
    db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const row = db.prepare("SELECT value FROM app_settings WHERE key='scan_settings'").get();
    if (!row) return write(defaultSettings());
    try {
      const parsed = JSON.parse(row.value);
      if (!validSettings(parsed)) throw new Error('invalid');
      return normalizeSettings(parsed);
    } catch {
      return write(defaultSettings());
    }
  }
  function write(value) {
    if (!validSettings(value)) throw new TypeError('Invalid scan settings');
    const normalized = normalizeSettings(value);
    dbProvider().prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('scan_settings',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .run(JSON.stringify(normalized), new Date().toISOString());
    return normalized;
  }
  return { read, write, update(patch) { return write({ ...read(), ...patch }); } };
}

export const settingsStore = createDatabaseSettingsStore();
