import { openDb, closeDb } from '../src/db.js';
import { API_HOST, API_PORT, DB_PATH, EVENTS_BUFFER_SIZE } from '../src/config.js';
import * as logger from '../src/logger.js';
import { createServer } from '../src/server.js';
import { createDefaultSources, runScan } from '../src/scanner.js';
import { createScheduler } from '../src/scheduler.js';
import { createSettingsStore } from '../src/settings.js';
import { createEventBus } from '../src/events.js';
import { createRadar } from '../src/radar.js';

const db = openDb(DB_PATH);
const settingsStore = createSettingsStore({ logger });
const sources = createDefaultSources();
const events = createEventBus({ bufferSize: EVENTS_BUFFER_SIZE });
const radar = createRadar({ db, source: sources.find((source) => source.name === 'freelancer'), events, settingsStore, logger });
const scheduler = createScheduler({ db, sources, settingsStore, logger, scan: (options) => runScan({ ...options, events, logger }) });
const api = createServer({ db, sources, settingsStore, scheduler, events, radar });
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  scheduler.stop();
  try { await api.close(); } finally { closeDb(db); }
}

try {
  const settings = settingsStore.read();
  if (settings.scan_enabled) scheduler.start();
  radar.start();
  const address = await api.listen(API_PORT, API_HOST);
  if (!address) {
    scheduler.stop();
    radar.stop();
    closeDb(db);
    process.exitCode = 1;
  } else {
    const displayHost = address.address.includes(':') && address.address !== '::' ? `[${address.address}]` : address.address;
    console.log(`http://${displayHost}:${address.port} ready`);
    process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
    process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
  }
} catch (failure) {
  logger.error(`API server failed to listen: ${failure?.code || 'unknown error'}`);
  await stop();
  process.exitCode = 1;
}
