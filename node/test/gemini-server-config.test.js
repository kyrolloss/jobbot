import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('run_api-style server creates a configured Gemini client from environment values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-server-config-'));
  const dbPath = path.join(dir, 'test.db');
  const script = `
    import { openDb, closeDb } from './src/db.js';
    import { createServer } from './src/server.js';
    const db = openDb(process.env.NODE_DB_PATH);
    db.prepare("INSERT INTO jobs(rowid,source,external_id,title,description,url,budget,status,created_at) VALUES(1744,'freelancer','env-test','Flutter app','Build an app','https://example.test','','sent','2026-01-01 00:00:00')").run();
    let calls = 0;
    const api = createServer({ db, sources: [{ name: 'freelancer' }], fetch: async (url, options) => {
      calls++;
      if (!url.includes(encodeURIComponent(process.env.GEMINI_MODEL))) throw new Error('Gemini model was not used');
      if (options.headers['x-goog-api-key'] !== process.env.GEMINI_API_KEY) throw new Error('Gemini key was not used');
      const payload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ tasks: [{ name: 'Build app', hours: 2 }], total_hours: 2, risks: [], questions_for_client: [] }) }] } }], usageMetadata: {} };
      return { ok: true, status: 200, json: async () => payload };
    } });
    try {
      const address = await api.listen(0, '127.0.0.1');
      const response = await fetch('http://127.0.0.1:' + address.port + '/jobs/1744/estimate', { method: 'POST', headers: { 'X-API-Key': process.env.API_KEY } });
      if (response.status !== 200 || calls !== 1) throw new Error('Server Gemini path did not complete');
      await api.close();
      closeDb(db);
      process.stdout.write('configured');
    } catch (error) {
      await api.close();
      closeDb(db);
      throw error;
    }
  `;
  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_DB_PATH: dbPath,
        API_KEY: 'gemini-server-test-api-key-0123456789',
        GEMINI_API_KEY: 'offline-gemini-test-key',
        GEMINI_MODEL: 'offline-model',
        GEMINI_MIN_GAP_MS: '1',
        SAAS_ENABLED: 'false',
      },
    });
    assert.equal(output, 'configured');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
