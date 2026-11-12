import { ensureUserJob, listActiveUsers } from './db.js';
import { KEYWORDS, SOURCE_POLICY, SAAS_ENABLED } from './config.js';
import { containsKeyword, matchesJob } from './filters.js';
import { scoreJob } from './score.js';

function userMatches(job, keywords) {
  if (!keywords?.length) return matchesJob(job);
  const text = `${job.title || ''}\n${job.description || ''}`;
  return keywords.some((word) => typeof word === 'string' && containsKeyword(text, word));
}

export function fanOutJob({ db, rowid, job, stats = {}, status = 'sent', score = null, scoreLine = null, config = {}, now = () => new Date() }) {
  if (rowid == null) return [];
  const current = now();
  const stamp = (current instanceof Date ? current : new Date(current)).toISOString();
  ensureUserJob(1, rowid, { status, score, scoreLine }, db, stamp);
  db.prepare('UPDATE user_jobs SET status=?,score=?,score_line=?,updated_at=? WHERE user_id=1 AND job_id=?').run(status, score, scoreLine, stamp, rowid);
  // Legacy owner state is mirrored by owner-facing writers; scanner insertion already preserves its status.
  const enabled = config.SAAS_ENABLED ?? SAAS_ENABLED;
  const policy = config.SOURCE_POLICY ?? SOURCE_POLICY;
  const recipients = [];
  if (status === 'sent') recipients.push(1);
  if (!enabled || !policy?.[job.source]?.saas) return recipients;
  const users = listActiveUsers(db).filter((userId) => userId !== 1);
  const profileQuery = db.prepare('SELECT keywords FROM user_profiles WHERE user_id=?');
  for (const userId of users) {
    let keywords = [];
    const value = profileQuery.get(userId)?.keywords;
    try { const parsed = value ? JSON.parse(value) : []; if (Array.isArray(parsed)) keywords = parsed.filter((v) => typeof v === 'string' && v.trim()); } catch { /* Malformed profile uses global filters. */ }
    if (!userMatches(job, keywords)) continue;
    const scored = scoreJob(job, stats);
    ensureUserJob(userId, rowid, { status: 'sent', score: scored.score, scoreLine: scored.line }, db, stamp);
    if (db.prepare('SELECT status FROM user_jobs WHERE user_id=? AND job_id=?').get(userId,rowid)?.status === 'sent') recipients.push(userId);
  }
  return recipients;
}

export function defaultUserKeywords() { return KEYWORDS.slice(); }
