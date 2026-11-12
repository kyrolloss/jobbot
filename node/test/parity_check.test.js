import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { analyzeRows, compareScoreRow, compareTagsRow, explainScoreRow } from '../scripts/parity_check.js';

test('parity comparison helpers report match, mismatch, and not comparable rows', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jobbot-parity-'));
  const filename = path.join(directory, 'parity.db');
  const database = new DatabaseSync(filename);
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  database.exec(`CREATE TABLE jobs (
    title TEXT, description TEXT, budget TEXT, score REAL, score_line TEXT, tags TEXT
  )`);
  const generic = '📋 الأرقام مش متاحة، افتح الرابط وشوف العروض والميزانية';
  const insert = database.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)');
  insert.run('Plain title', '', '', 2.5, generic, '[]');
  insert.run('Flutter API', 'Firebase', '', 2.5, generic, '["python"]');
  insert.run('Unrecoverable', '', '', 5, 'old score line', 'not-json');

  const rows = database.prepare('SELECT rowid, * FROM jobs ORDER BY rowid').all().map((row) => ({ ...row }));
  assert.equal(compareScoreRow(rows[0]).state, 'match');
  assert.equal(compareTagsRow(rows[0]).state, 'match');
  const explanation = explainScoreRow(rows[0]);
  assert.deepEqual(explanation.inputs.statsUsed, {});
  assert.equal(explanation.components.techSkillPoints, 0);
  assert.equal(explanation.js.score, 2.5);
  assert.equal(compareScoreRow(rows[1]).state, 'mismatch');
  assert.equal(compareTagsRow(rows[1]).state, 'mismatch');
  assert.equal(compareScoreRow(rows[2]).state, 'not-comparable');
  assert.equal(compareTagsRow(rows[2]).state, 'not-comparable');

  const report = analyzeRows(rows);
  assert.equal(report.totalRows, 3);
  assert.deepEqual([report.score.compared, report.score.matches, report.score.mismatches], [2, 1, 1]);
  assert.equal(Object.values(report.score.notComparable).reduce((sum, n) => sum + n, 0), 1);
  assert.deepEqual([report.tags.compared, report.tags.matches, report.tags.mismatches], [2, 1, 1]);
  assert.equal(Object.values(report.tags.notComparable).reduce((sum, n) => sum + n, 0), 1);
  assert.equal(compareScoreRow(null).state, 'not-comparable');
  assert.equal(compareTagsRow(null).state, 'not-comparable');
});
