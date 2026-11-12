function isoNow(now = () => new Date()) { return now().toISOString(); }
export function createCredits(db, now = () => new Date()) {
  const balance = (userId) => db.prepare('SELECT COALESCE(SUM(delta),0) AS balance FROM credit_ledger WHERE user_id=?').get(userId).balance;
  function addCredits(userId, points, reason, key, refType = null, refId = null) {
    if (!Number.isInteger(points) || points < 0) throw new TypeError('points must be a nonnegative integer');
    const result = db.prepare('INSERT OR IGNORE INTO credit_ledger(user_id,delta,reason,ref_type,ref_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)').run(userId, points, reason, refType, refId, key, isoNow(now));
    return { added: result.changes > 0, balance: balance(userId) };
  }
  function reserve(userId, points, key) {
    db.exec('BEGIN IMMEDIATE');
    try {
      let reserveKey = key;
      if (db.prepare('SELECT 1 FROM credit_ledger WHERE idempotency_key=?').get(reserveKey)) {
        const refunded = db.prepare("SELECT 1 FROM credit_ledger WHERE idempotency_key=?").get(`refund:${reserveKey}`);
        if (!refunded) { db.exec('COMMIT'); return { reserved: false, balance: balance(userId), key: reserveKey }; }
        let attempt = 1;
        while (db.prepare('SELECT 1 FROM credit_ledger WHERE idempotency_key=?').get(`${key}:retry:${attempt}`)) attempt++;
        reserveKey = `${key}:retry:${attempt}`;
      }
      const current = balance(userId);
      if (current < points) { db.exec('COMMIT'); return { reserved: false, insufficient: true, balance: current }; }
      db.prepare("INSERT INTO credit_ledger(user_id,delta,reason,idempotency_key,created_at) VALUES(?,?,'reserve',?,?)").run(userId, -points, reserveKey, isoNow(now));
      db.exec('COMMIT'); return { reserved: true, balance: current - points, key: reserveKey };
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  function refund(key) {
    const reserveRow = db.prepare("SELECT user_id,delta FROM credit_ledger WHERE idempotency_key=? AND reason='reserve'").get(key);
    if (!reserveRow) return false;
    return db.prepare("INSERT OR IGNORE INTO credit_ledger(user_id,delta,reason,ref_type,ref_id,idempotency_key,created_at) VALUES(?,?,'refund','credit_ledger',?,?,?)")
      .run(reserveRow.user_id, -reserveRow.delta, String(reserveRow.user_id), `refund:${key}`, isoNow(now)).changes > 0;
  }
  function grantMonthlyPoints(userId, planId, nowDate = now()) {
    const month = nowDate.toISOString().slice(0,7);
    const plan = db.prepare('SELECT monthly_points FROM plans WHERE id=?').get(planId);
    if (!plan || plan.monthly_points < 0) return false;
    return addCredits(userId, plan.monthly_points, 'monthly_grant', `grant:${userId}:${month}`, 'plan', planId).added;
  }
  return { getBalance: balance, addCredits, reserve, refund, grantMonthlyPoints };
}
