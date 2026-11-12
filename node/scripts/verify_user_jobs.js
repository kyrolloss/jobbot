import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyUserJobs(databasePath) {
  if (!databasePath) throw new TypeError('usage: node scripts/verify_user_jobs.js <database-path>');
  const db = new DatabaseSync(path.resolve(databasePath), { readOnly: true });
  try {
    const fixedStatuses = ['new','sent','approved','applied','rejected','skipped'];
    const countRows = (sql) => Object.fromEntries(db.prepare(sql).all(...(sql.includes('?') ? [1] : [])).map((r) => [r.status,r.count]));
    const legacyCounts = countRows('SELECT status,COUNT(*) AS count FROM jobs GROUP BY status');
    const userCounts = countRows('SELECT status,COUNT(*) AS count FROM user_jobs WHERE user_id=? GROUP BY status');
    const missing = db.prepare('SELECT COUNT(*) AS count FROM jobs j LEFT JOIN user_jobs u ON u.job_id=j.rowid AND u.user_id=1 WHERE u.job_id IS NULL').get().count;
    const mismatches = db.prepare(`SELECT j.rowid,j.status AS jobs_status,u.status AS user_status,j.score AS jobs_score,u.score AS user_score,
      j.proposal AS jobs_proposal,u.proposal AS user_proposal,j.applied_at AS jobs_applied_at,u.applied_at AS user_applied_at
      FROM jobs j LEFT JOIN user_jobs u ON u.job_id=j.rowid AND u.user_id=1
      WHERE u.job_id IS NULL OR j.status IS NOT u.status OR j.score IS NOT u.score OR j.proposal IS NOT u.proposal OR datetime(j.applied_at) IS NOT datetime(u.applied_at) ORDER BY j.rowid`).all().map((r) => ({ ...r }));
    const counts = Object.fromEntries(fixedStatuses.map((status) => [status,{ jobs:legacyCounts[status]||0,user_jobs:userCounts[status]||0 } ]));
    const countMismatch = Object.values(counts).some((v) => v.jobs !== v.user_jobs);
    const report = { user_id:1, status_counts:counts, jobs_without_user_job:missing, mismatches, ok:!countMismatch && missing===0 && mismatches.length===0 };
    console.log(JSON.stringify(report,null,2));
    return report;
  } finally { db.close(); }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try { process.exitCode = verifyUserJobs(process.argv[2]).ok ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode=1; }
}
