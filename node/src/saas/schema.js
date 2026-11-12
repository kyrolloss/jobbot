import { planSeeds } from './plans.js';
import { PLAN_SEEDS } from '../config.js';
export function createSaasSchema(db, config = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','user')), status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,name TEXT NOT NULL,monthly_points INTEGER NOT NULL,daily_points_cap INTEGER,features TEXT NOT NULL,price_egp REAL NOT NULL DEFAULT 0,price_usd REAL NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS subscriptions(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),plan_id TEXT NOT NULL REFERENCES plans(id),status TEXT NOT NULL,provider TEXT,provider_ref TEXT,current_period_start TEXT,current_period_end TEXT,cancel_at_period_end INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS credit_ledger(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),delta INTEGER NOT NULL,reason TEXT NOT NULL,ref_type TEXT,ref_id TEXT,idempotency_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS usage_events(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,job_id TEXT,model TEXT,input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,cost_usd REAL NOT NULL DEFAULT 0,points INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL CHECK(status IN ('ok','failed','blocked')),latency_ms INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS webhook_events(id INTEGER PRIMARY KEY,provider TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT NOT NULL,received_at TEXT NOT NULL,processed_at TEXT,UNIQUE(provider,event_id));
  CREATE TABLE IF NOT EXISTS user_profiles(user_id INTEGER PRIMARY KEY REFERENCES users(id),profile_md TEXT,keywords TEXT NOT NULL DEFAULT '[]',min_budget REAL,countries TEXT NOT NULL DEFAULT '[]',portfolio TEXT NOT NULL DEFAULT '[]',updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS user_jobs(user_id INTEGER NOT NULL,job_id INTEGER NOT NULL,status TEXT NOT NULL,score REAL,score_line TEXT,proposal TEXT,evaluation TEXT,estimate TEXT,prototype_url TEXT,applied_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,job_id));
  CREATE INDEX IF NOT EXISTS idx_subscriptions_user_created ON subscriptions(user_id,created_at);
  CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_created ON credit_ledger(user_id,created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON usage_events(user_id,created_at);
  CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_received ON webhook_events(provider,received_at);
  CREATE INDEX IF NOT EXISTS idx_user_jobs_user_status ON user_jobs(user_id,status);
  CREATE INDEX IF NOT EXISTS idx_user_jobs_user_created ON user_jobs(user_id,created_at);
  CREATE INDEX IF NOT EXISTS idx_user_jobs_job ON user_jobs(job_id);`);
  const now = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO users(id,email,name,role,status,created_at) VALUES(1,NULL,'owner','owner','active',?)").run(now);
  const insert = db.prepare('INSERT OR IGNORE INTO plans(id,name,monthly_points,daily_points_cap,features,price_egp,price_usd) VALUES(?,?,?,?,?,?,?)');
  for (const p of planSeeds({ PLAN_SEEDS, ...config })) insert.run(p.id,p.name,p.monthly_points,p.daily_points_cap,JSON.stringify(p.features),p.price_egp,p.price_usd);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get()) {
    migrateLegacyUserJobs(db, 1);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_jobs_owner_user_job AFTER INSERT ON jobs BEGIN
      INSERT OR IGNORE INTO user_jobs(user_id,job_id,status,score,score_line,proposal,evaluation,estimate,prototype_url,applied_at,created_at,updated_at)
      VALUES(1,NEW.rowid,NEW.status,NEW.score,NEW.score_line,NEW.proposal,NEW.evaluation,NEW.estimate,NEW.prototype_url,NEW.applied_at,
        COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at),strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_jobs_owner_user_job_update AFTER UPDATE OF status,score,score_line,proposal,evaluation,estimate,prototype_url,applied_at ON jobs BEGIN
      UPDATE user_jobs SET status=NEW.status,score=NEW.score,score_line=NEW.score_line,proposal=NEW.proposal,evaluation=NEW.evaluation,
        estimate=NEW.estimate,prototype_url=NEW.prototype_url,
        applied_at=CASE WHEN NEW.applied_at IS NULL OR TRIM(NEW.applied_at)='' THEN NULL ELSE COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',NEW.applied_at),NEW.applied_at) END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=1 AND job_id=NEW.rowid;
    END;`);
  }
}

function utcIso(value) {
  if (!value) return new Date().toISOString();
  const raw = String(value);
  const date = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function migrateLegacyUserJobs(db, userId = 1) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get()) return 0;
  const columns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((r) => r.name));
  const fields = ['status','score','score_line','proposal','evaluation','estimate','prototype_url','applied_at','created_at'];
  const select = fields.map((field) => columns.has(field) ? `"${field}"` : `NULL AS "${field}"`).join(',');
  const rows = db.prepare(`SELECT rowid AS job_id,${select} FROM jobs ORDER BY rowid`).all();
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(`INSERT OR IGNORE INTO user_jobs(user_id,job_id,status,score,score_line,proposal,evaluation,estimate,prototype_url,applied_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const row of rows) {
      const createdAt = utcIso(row.created_at);
      insert.run(userId,row.job_id,row.status || 'new',row.score,row.score_line,row.proposal,row.evaluation,row.estimate,row.prototype_url,row.applied_at ? utcIso(row.applied_at) : null,createdAt,createdAt);
    }
    db.exec('COMMIT');
    return rows.length;
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}
