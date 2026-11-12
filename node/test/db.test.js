import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createJob } from '../src/models.js';
import * as db from '../src/db.js';
import { importPythonDb } from '../scripts/import_python_db.js';

function tempDb(t, name = 'node.db') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-db-'));
  const connections = [];
  t.after(() => {
    for (const connection of connections) db.closeDb(connection);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return {
    path: path.join(dir, name),
    track(connection) { connections.push(connection); return connection; },
  };
}
const job = createJob({ source:'freelancer', externalId:'abc-1', title:'Job', description:'Desc', url:'https://example.test', budget:'100' });

test('creates complete schema, ignores duplicates, updates status and applied timestamp once', (t) => {
  const filename = tempDb(t); const conn = filename.track(db.openDb(filename.path));
  const columns = new Set(conn.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  for (const name of ['tags','currency','posted_at','applied_at','bid_count','bid_avg','prototype_url','estimate','radar_alerted_at','message_id','score','score_line','proposal','evaluation']) assert.ok(columns.has(name), name);
  db.save(job, 'new', ['python']); db.save({ ...job, title:'Duplicate' });
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1);
  assert.equal(db.isNew(job), false);
  db.setStatus(job, 'applied');
  const appliedAt = conn.prepare('SELECT applied_at FROM jobs').get().applied_at;
  assert.ok(appliedAt);
  db.setStatus(job, 'sent'); db.setStatus(job, 'applied');
  assert.equal(conn.prepare('SELECT applied_at FROM jobs').get().applied_at, appliedAt);
});

test('stats do not overwrite stored values with empty values; score/proposal/evaluation persist', (t) => {
  const filename = tempDb(t); const conn = filename.track(db.openDb(filename.path)); db.save(job);
  assert.equal(db.saveStats(job, { bid_count:4, bid_avg:88, currency:'USD' }), true);
  assert.equal(db.saveStats(job, { bid_count:null, bid_avg:'', currency:'  ' }), false);
  const rowid = db.getJobRowid(job);
  db.saveScore(job, 8.1, 'strong match');
  assert.deepEqual(db.getJobScore(job), [8.1, 'strong match']);
  assert.equal(db.saveProposal(rowid, 'Proposal'), true);
  db.saveEvaluation(rowid, { verdict:'good' }, { bid_count:null, bid_avg:null, currency:'', time_submitted:1 });
  const row = conn.prepare('SELECT proposal,evaluation,bid_count,bid_avg,currency FROM jobs').get();
  assert.equal(row.proposal, 'Proposal'); assert.deepEqual(JSON.parse(row.evaluation), { verdict:'good' });
  assert.equal(row.bid_count, 4); assert.equal(row.bid_avg, 88); assert.equal(row.currency, 'USD');
});

test('migrates an old-style jobs table by adding missing columns', (t) => {
  const filename = tempDb(t); const old = filename.track(new DatabaseSync(filename.path));
  old.exec(`CREATE TABLE jobs (source TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, url TEXT NOT NULL, budget TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source,external_id))`);
  const conn = filename.track(db.openDb(filename.path)); const columns = new Set(conn.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  for (const col of ['proposal','message_id','evaluation','bid_count','bid_avg','score','score_line','tags','currency','posted_at','applied_at','estimate','prototype_url','radar_alerted_at']) assert.ok(columns.has(col), col);
});

test('imports Python rows read-only, preserving rowids, and is safe to repeat', (t) => {
  const sourceFile = tempDb(t, 'python.db'); const targetFile = tempDb(t, 'node.db');
  const source = sourceFile.track(new DatabaseSync(sourceFile.path));
  source.exec(`CREATE TABLE jobs (source TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, url TEXT NOT NULL, budget TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'sent', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, proposal TEXT, PRIMARY KEY(source,external_id))`);
  source.prepare('INSERT INTO jobs (rowid,source,external_id,title,description,url,budget,status,proposal) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(47,'mostaql','py-47','From Python','Description','https://example.test/47','500','sent','Saved');
  const first = importPythonDb(sourceFile.path, targetFile.path); const second = importPythonDb(sourceFile.path, targetFile.path);
  assert.equal(first.copied, 1); assert.equal(second.copied, 0);
  const target = targetFile.track(db.openDb(targetFile.path));
  assert.equal(target.prepare('SELECT rowid FROM jobs').get().rowid, 47);
  assert.equal(target.prepare('SELECT proposal FROM jobs').get().proposal, 'Saved');
});
