import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb } from '../src/db.js';
import { API_KEY, DB_PATH, GEMINI_API_KEY } from '../src/config.js';
import { createDefaultSources, runScan } from '../src/scanner.js';

const dryRun = process.argv.includes('--dry-run');
let db;
function safe(value) {
  let text = String(value ?? '');
  for (const secret of [API_KEY, GEMINI_API_KEY]) if (secret) text = text.split(secret).join('[REDACTED]');
  return text;
}

try {
  db = dryRun ? new DatabaseSync(DB_PATH, { readOnly: true }) : openDb(DB_PATH);
  const topJobs = [];
  const summary = await runScan({
    db,
    sources: createDefaultSources(),
    trigger: 'manual',
    dryRun,
    onNewJob(job) { topJobs.push(job); },
  });
  console.log(dryRun ? 'Dry run: no database writes' : 'Scan complete');
  for (const [source, counts] of Object.entries(summary.per_source)) {
    console.log(`${source}: ${JSON.stringify({
      fetched: counts.fetched,
      new_candidates: counts.new_candidates,
      already_known: counts.fetched - counts.new_candidates,
      would_save: counts.would_save,
      would_skip_filtered: counts.would_skip_filtered,
      would_skip_details_failed: counts.would_skip_details_failed,
      filtered_out: counts.filtered_out,
      details_failed: counts.details_failed,
      details_unavailable: counts.details_unavailable,
      new_saved: counts.new_saved,
      stats_fetched: counts.stats_fetched,
    })}`);
    if (counts.errors.length) console.log(`${source} errors: ${JSON.stringify(counts.errors.map(({ source: sourceName, kind, status, message }) => ({ source: sourceName, kind, status, message: safe(message) })))}`);
  }
  console.log('Top 5 new scored jobs:');
  for (const job of topJobs.slice(0, 5)) console.log(JSON.stringify({ title: safe(job.title), score: job.score, score_line: safe(job.score_line) }));
} catch (error) {
  console.error(`Scan failed: ${safe(error?.message || 'unknown error')}`);
  process.exitCode = 1;
} finally {
  if (db) {
    if (dryRun) db.close();
    else closeDb(db);
  }
}
