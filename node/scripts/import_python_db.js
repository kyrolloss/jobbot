import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from '../src/config.js';
import { closeDb, openDb } from '../src/db.js';
import { migrateLegacyUserJobs } from '../src/saas/schema.js';

export function importPythonDb(sourcePath, targetPath = DB_PATH) {
  const source = new DatabaseSync(path.resolve(sourcePath), { readOnly: true });
  let target;
  try {
    target = openDb(targetPath);
    const statusCounts = (rows) => {
      const counts = Object.fromEntries(rows.map((r) => [r.status, r.count]));
      return Object.fromEntries(['new','sent','approved','applied','rejected','skipped'].map((status) => [status, counts[status] || 0]));
    };
    const beforeCounts = statusCounts(target.prepare('SELECT status,COUNT(*) AS count FROM jobs GROUP BY status').all());
    const sourceColumns = new Set(source.prepare('PRAGMA table_info(jobs)').all().map((r) => r.name));
    const targetColumns = new Set(target.prepare('PRAGMA table_info(jobs)').all().map((r) => r.name));
    const columns = [...sourceColumns].filter((column) => targetColumns.has(column));
    const rows = source.prepare(`SELECT rowid AS __rowid, ${columns.map((c) => `"${c}"`).join(',')} FROM jobs ORDER BY rowid`).all();
    const statement = target.prepare(`INSERT OR IGNORE INTO jobs (rowid,${columns.map((c) => `"${c}"`).join(',')}) VALUES (${['?'.repeat(1), ...columns.map(() => '?')].join(',')})`);
    target.exec('BEGIN');
    let copied = 0;
    try {
      for (const row of rows) copied += statement.run(row.__rowid, ...columns.map((column) => row[column])).changes;
      target.exec('COMMIT');
    } catch (error) {
      try { target.exec('ROLLBACK'); } catch { /* Keep the original transaction error. */ }
      throw error;
    }
    migrateLegacyUserJobs(target, 1);
    const afterCounts = statusCounts(target.prepare('SELECT status,COUNT(*) AS count FROM jobs GROUP BY status').all());
    console.log(`Copied ${copied} rows.`);
    console.log(`Status counts before: ${JSON.stringify(beforeCounts)}`);
    console.log(`Status counts after: ${JSON.stringify(afterCounts)}`);
    return { copied, before: beforeCounts, after: afterCounts };
  } finally {
    try {
      if (target) closeDb(target);
    } finally {
      closeDb(source);
    }
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const sourcePath = process.argv[2] || path.resolve(path.dirname(scriptPath), '../../jobs.db');
  importPythonDb(sourcePath);
}
