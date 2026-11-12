export function createUsage(db, config = {}, now = () => new Date()) {
  function recordUsage({ userId, kind, jobId = null, model = null, inputTokens = 0, outputTokens = 0, points = 0, status = 'ok', latencyMs = 0 }) {
    const inputPrice = Number(config.GEMINI_PRICE_PER_MTOK_INPUT || 0), outputPrice = Number(config.GEMINI_PRICE_PER_MTOK_OUTPUT || 0);
    const calculatedCost = inputPrice || outputPrice ? (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000 : null;
    const cost = Number.isFinite(calculatedCost) ? calculatedCost : null;
    db.prepare('INSERT INTO usage_events(user_id,kind,job_id,model,input_tokens,output_tokens,cost_usd,points,status,latency_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(userId, kind, jobId == null ? null : String(jobId), model, inputTokens, outputTokens, cost === null ? 0 : cost, points, status, latencyMs, now().toISOString());
    return { costUsd: cost };
  }
  function getUsageSummary(userId, sinceDate) {
    return db.prepare(`SELECT kind,COUNT(*) AS calls,SUM(status='ok') AS ok,SUM(status='failed') AS failed,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(cost_usd) AS cost_usd,SUM(points) AS points FROM usage_events WHERE user_id=? AND created_at>=? GROUP BY kind ORDER BY kind`).all(userId, sinceDate.toISOString()).map((r) => ({ ...r, ok: Number(r.ok), failed: Number(r.failed) }));
  }
  return { recordUsage, getUsageSummary };
}
