import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from '../src/config.js';

const nodeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(nodeDir, '.env');
const REQUIRED_TABLES = ['device_tokens', 'notification_category_prefs', 'user_jobs', 'jobs'];
const REQUIRED_ENV_KEYS = ['FCM_SERVICE_ACCOUNT_JSON', 'GEMINI_API_KEY', 'API_KEY'];
const checks = [];

function addCheck(ok, passMessage, failMessage) {
  checks.push({ ok, message: ok ? passMessage : failMessage });
}

function pythonDbPath() {
  const configured = process.env.PYTHON_DB_PATH || '../jobs.db';
  return path.isAbsolute(configured) ? configured : path.resolve(nodeDir, configured);
}

function openReadOnly(dbPath) { return new DatabaseSync(dbPath, { readOnly: true }); }

async function checkApi() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  timeout.unref?.();
  try {
    const response = await fetch('http://127.0.0.1:8787/health', { signal: controller.signal });
    addCheck(response.status === 200, 'API reachable (HTTP 200)', `API health check returned HTTP ${response.status}`);
  } catch (error) {
    addCheck(false, '', `API is not reachable (${error?.name || 'request failed'})`);
  } finally { clearTimeout(timeout); }
}

function quoteIdentifier(value) { return `"${String(value).replaceAll('"', '""')}"`; }

function lastPersistedScan(db) {
  const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  const candidates = [];
  for (const table of tableNames) {
    const tableColumns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => row.name);
    const column = tableColumns.find((name) => ['last_run', 'last_scan'].includes(name));
    if (!column) continue;
    try {
      const row = db.prepare(`SELECT ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(table)} LIMIT 1`).get();
      if (row?.value != null) {
        const raw = String(row.value);
        const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
        const date = new Date(normalized);
        if (!Number.isNaN(date.getTime())) candidates.push(date);
      }
    } catch { /* Ignore unrelated tables and continue looking for scheduler state. */ }
  }
  return candidates.length ? new Date(Math.max(...candidates.map((date) => date.getTime()))) : null;
}

function checkLastScan(db) {
  if (!db) {
    addCheck(false, '', 'Last scan could not be checked because the Node database is unavailable');
    return;
  }
  let lastRun;
  try { lastRun = lastPersistedScan(db); }
  catch {
    addCheck(false, '', 'Could not inspect the Node database for the scheduler last_run timestamp');
    return;
  }
  if (!lastRun) {
    addCheck(false, '', 'No scheduler last_run timestamp is persisted in the Node database');
    return;
  }
  const ageMinutes = (Date.now() - lastRun.getTime()) / 60_000;
  addCheck(ageMinutes >= 0 && ageMinutes < 30,
    `Last scan was ${Math.floor(ageMinutes)} minutes ago`,
    ageMinutes < 0 ? 'Last scan timestamp is in the future' : `Last scan was ${Math.floor(ageMinutes)} minutes ago — expected < 30`);
}

function checkTables(db) {
  if (!db) {
    addCheck(false, '', 'Required database tables could not be checked');
    return;
  }
  try {
    const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const missing = REQUIRED_TABLES.filter((name) => !existing.has(name));
    addCheck(missing.length === 0,
      `Required database tables exist (${REQUIRED_TABLES.join(', ')})`,
      `Missing database tables: ${missing.join(', ')}`);
  } catch {
    addCheck(false, '', 'Could not verify required database tables');
  }
}

function checkJobCounts(nodeDb) {
  let pythonDb;
  try {
    if (!nodeDb) throw new Error('Node database unavailable');
    pythonDb = openReadOnly(pythonDbPath());
    const nodeCount = Number(nodeDb.prepare('SELECT COUNT(*) AS count FROM jobs').get().count);
    const pythonCount = Number(pythonDb.prepare('SELECT COUNT(*) AS count FROM jobs').get().count);
    const requiredCount = pythonCount * 0.8;
    addCheck(nodeCount >= requiredCount,
      `Node job count ${nodeCount} meets the 80% threshold of Python count ${pythonCount}`,
      `Node job count ${nodeCount} is below 80% of Python count ${pythonCount} (minimum ${Math.ceil(requiredCount)})`);
  } catch (error) {
    addCheck(false, '', `Could not compare Node and Python job counts (${error?.code || error?.name || 'error'})`);
  } finally { if (pythonDb) { try { pythonDb.close(); } catch {} } }
}

function checkEnv() {
  if (!fs.existsSync(envPath)) {
    addCheck(false, '', 'node/.env is missing');
    return;
  }
  try {
    const contents = fs.readFileSync(envPath, 'utf8');
    const missing = REQUIRED_ENV_KEYS.filter((key) => !new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'm').test(contents));
    addCheck(missing.length === 0,
      'node/.env contains all required key names',
      `node/.env is missing key names: ${missing.join(', ')}`);
  } catch {
    addCheck(false, '', 'Could not inspect required key names in node/.env');
  }
}

function checkBackup() {
  try {
    const found = fs.readdirSync(nodeDir).some((name) => /^jobs_node_backup_.*\.db$/i.test(name));
    addCheck(found, 'Node database backup exists', 'No jobs_node_backup_*.db file exists in node/');
  } catch {
    addCheck(false, '', 'Could not check for a Node database backup');
  }
}

async function main() {
  await checkApi();
  let nodeDb;
  try { nodeDb = openReadOnly(DB_PATH); } catch { /* Individual checks report that the Node DB is unavailable. */ }
  checkLastScan(nodeDb);
  checkJobCounts(nodeDb);
  checkTables(nodeDb);
  checkEnv();
  checkBackup();
  if (nodeDb) { try { nodeDb.close(); } catch {} }

  for (const check of checks) console.log(`[${check.ok ? 'PASS' : 'FAIL'}] ${check.message}`);
  const safe = checks.every((check) => check.ok);
  console.log(safe ? 'Cutover is SAFE' : 'Cutover is NOT SAFE — fix the above before stopping Python');
  process.exitCode = safe ? 0 : 1;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) void main();
