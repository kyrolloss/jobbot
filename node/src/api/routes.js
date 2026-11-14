import { TECH_TAGS } from '../config.js';
import { countBySource, listJobs } from '../db.js';
import { HttpError } from './router.js';
import { serializeDbTimestamp } from '../events.js';
import { createCredits } from '../saas/credits.js';
import { listPlans } from '../saas/plans.js';
import { createUsage } from '../saas/usage.js';
import crypto from 'node:crypto';
import { saveEvaluation, saveEstimate, saveProposal, saveStats, savePostedAt, setStatus } from '../db.js';
import { buildEvaluationPrompt, parseEvaluation } from '../ai/evaluate.js';
import { buildProposalPrompt } from '../ai/proposal.js';
import { buildEstimatePrompt, parseEstimate, computePricing } from '../ai/estimate.js';
import { getMarketMedians } from '../ai/prices.js';
import { normalizeProfile, parseStoredProfile, profilePromptText, profileSearchTerms } from '../profile.js';

const runningAi = new Set();

const STATUSES = ['new', 'sent', 'approved', 'applied', 'rejected', 'skipped'];
const SOURCES = ['freelancer', 'mostaql', 'khamsat'];

function bad(parameter, detail) { throw new HttpError(400, 'INVALID_PARAMETER', `Invalid ${parameter}${detail ? `: ${detail}` : ''}`); }
function parsedJson(value) {
  try { const result = value ? JSON.parse(value) : null; return result && typeof result === 'object' && !Array.isArray(result) ? result : null; }
  catch { return null; }
}
function parsedTags(value) {
  if (Array.isArray(value)) return value;
  try { const result = value ? JSON.parse(value) : []; return Array.isArray(result) ? result : []; }
  catch { return []; }
}
function compact(row) {
  const tags = parsedTags(row.tags);
  return {
    id: row.id, source: row.source, external_id: row.external_id, title: row.title, url: row.url,
    budget: row.budget || '', score: row.score ?? null, score_line: row.score_line || '', status: row.status,
    tags, currency: row.currency ?? null, bid_count: row.bid_count ?? null, bid_avg: row.bid_avg ?? null,
    posted_at: serializeDbTimestamp(row.posted_at ?? null),
    applied_at: row.applied_at && String(row.applied_at).trim() ? serializeDbTimestamp(row.applied_at) : null,
    created_at: serializeDbTimestamp(row.created_at),
    has_proposal: Boolean(row.proposal && String(row.proposal).trim()),
    has_estimate: Boolean(row.estimate && String(row.estimate).trim()), prototype_url: row.prototype_url ?? null,
  };
}

function queryFilters(query) {
  const filters = {};
  const status = query.get('status');
  if (status !== null) { if (!STATUSES.includes(status)) bad('status'); filters.status = status; }
  const source = query.get('source');
  if (source !== null) { if (!SOURCES.includes(source)) bad('source'); filters.source = source; }
  const tag = query.get('tag');
  if (tag !== null) { if (!Object.hasOwn(TECH_TAGS, tag)) bad('tag'); filters.tag = tag; }
  const minScore = query.get('min_score');
  if (minScore !== null) { if (!minScore.trim() || !Number.isFinite(Number(minScore))) bad('min_score'); filters.min_score = Number(minScore); }
  const search = query.get('search');
  if (search !== null) filters.search = search;
  const since = query.get('since');
  if (since !== null) {
    const iso = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))?$/;
    const date = new Date(since);
    const calendarDate = since.slice(0, 10);
    const validCalendarDate = !Number.isNaN(new Date(calendarDate).getTime()) && new Date(calendarDate).toISOString().slice(0, 10) === calendarDate;
    if (!iso.test(since) || Number.isNaN(date.getTime()) || !validCalendarDate) bad('since');
    filters.since = since;
  }
  for (const [name, fallback] of [['limit', 50], ['offset', 0]]) {
    const raw = query.get(name);
    let number = fallback;
    if (raw !== null) {
      if (!/^\d+$/.test(raw)) bad(name);
      number = Number(raw);
      if (!Number.isSafeInteger(number) || (name === 'limit' && number < 1)) bad(name);
    }
    filters[name] = name === 'limit' ? Math.min(number, 200) : number;
  }
  const sort = query.get('sort') || 'newest';
  if (!['score', 'newest', 'posted'].includes(sort)) bad('sort');
  filters.sort = sort;
  return filters;
}

export function registerRoutes(router, { radar = null, config = {}, gemini = null, sources = [] } = {}) {
  router.add('GET', '/health', ({ version }) => ({ ok: true, version, time: new Date().toISOString() }));
  router.add('GET', '/sources/status', ({ db }) => {
    const rows = new Map(db.prepare('SELECT source,enabled,last_scan_at,last_count,last_error_code,last_error_message FROM source_scan_state').all().map((row) => [row.source, row]));
    return { sources: sources.map((source) => {
      const row = rows.get(source.name);
      return { source: source.name, enabled: Boolean(row ? row.enabled : true), last_scan_at: row?.last_scan_at ?? null, last_count: row?.last_count ?? null,
        last_error: row?.last_error_code ? { code: row.last_error_code, message: row.last_error_message || 'Source request failed' } : null };
    }) };
  });
  router.add('GET', '/profile', ({ db, principal }) => {
    const row = db.prepare('SELECT profile_md,updated_at FROM user_profiles WHERE user_id=?').get(principal.userId);
    if (!row?.profile_md) return { exists: false };
    return { exists: true, profile: parseStoredProfile(row.profile_md), updated_at: row.updated_at };
  });
  router.add('PUT', '/profile', ({ db, principal, body }) => {
    const profile = normalizeProfile(body);
    const terms = profileSearchTerms(profile);
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT INTO user_profiles(user_id,profile_md,keywords,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET profile_md=excluded.profile_md,keywords=excluded.keywords,updated_at=excluded.updated_at`)
      .run(principal.userId, JSON.stringify(profile), JSON.stringify(terms.include), timestamp);
    return { exists: true, profile, updated_at: timestamp };
  });
  router.add('GET', '/plans', ({ db }) => listPlans(db));
  router.add('GET', '/me', ({ db, principal }) => {
    const user = db.prepare('SELECT id,email,name,role,status,created_at FROM users WHERE id=?').get(principal.userId);
    const planRow = db.prepare('SELECT id,name,monthly_points,daily_points_cap,features FROM plans WHERE id=?').get(principal.planId || 'owner');
    const plan = planRow ? { ...planRow, features: JSON.parse(planRow.features) } : null;
    const credits = createCredits(db), usage = createUsage(db, config);
    const month = new Date(); month.setUTCDate(1); month.setUTCHours(0,0,0,0);
    const summary = usage.getUsageSummary(principal.userId, month);
    return { user, plan, balance: credits.getBalance(principal.userId), saas_enabled: Boolean(config.SAAS_ENABLED), usage_this_month: { by_kind: summary, total_cost_usd: summary.reduce((sum, row) => sum + row.cost_usd, 0), calls: summary.reduce((sum, row) => sum + row.calls, 0) } };
  });
  router.add('GET', '/usage/summary', ({ db, principal, query }) => {
    const raw = query.get('days') || '30';
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 365) bad('days', 'must be an integer from 1 to 365');
    const since = new Date(Date.now() - Number(raw) * 86400000);
    return { days: Number(raw), by_kind: createUsage(db, config).getUsageSummary(principal.userId, since) };
  });
  router.add('GET', '/jobs', ({ query, db, principal }) => {
    const filters = queryFilters(query);
    const { items: rows, total } = listJobs(filters, db, principal.userId);
    const items = rows.map((row) => ({
      ...row,
      created_at: serializeDbTimestamp(row.created_at),
      posted_at: serializeDbTimestamp(row.posted_at ?? null),
      applied_at: row.applied_at && String(row.applied_at).trim() ? serializeDbTimestamp(row.applied_at) : null,
    }));
    return { items, total, limit: filters.limit, offset: filters.offset };
  });
  router.add('GET', '/jobs/:id', ({ params, db, principal }) => {
    if (!/^[1-9]\d*$/.test(params.id) || !Number.isSafeInteger(Number(params.id))) bad('id', 'must be a positive integer');
    const row = db.prepare(`SELECT j.rowid AS id,j.source,j.external_id,j.title,j.description,j.url,j.budget,uj.status,j.created_at,uj.proposal,uj.evaluation,j.bid_count,j.bid_avg,uj.score,uj.score_line,j.tags,j.currency,j.posted_at,uj.applied_at,uj.estimate,uj.prototype_url
      FROM jobs j JOIN user_jobs uj ON uj.job_id=j.rowid WHERE j.rowid=? AND uj.user_id=?`).get(Number(params.id),principal.userId);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Job not found');
    return {
      ...compact({ ...row }), description: row.description, proposal: row.proposal ?? null,
      evaluation: parsedJson(row.evaluation), estimate: parsedJson(row.estimate),
      stats: { bid_count: row.bid_count ?? null, bid_avg: row.bid_avg ?? null, currency: row.currency ?? null, posted_at: serializeDbTimestamp(row.posted_at ?? null) },
    };
  });
  router.add('GET', '/stats/counts', ({ db, principal }) => {
    const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    for (const row of db.prepare('SELECT status,COUNT(*) AS count FROM user_jobs WHERE user_id=? GROUP BY status').all(principal.userId)) byStatus[row.status] = row.count;
    const bySource = countBySource(db,principal.userId);
    return { by_status: byStatus, by_source: bySource, total: Object.values(byStatus).reduce((sum, count) => sum + count, 0) };
  });
  for (const kind of ['evaluate','proposal','estimate']) router.add('POST', `/jobs/:id/${kind}`, async ({ request, params, body, db, principal, guard }) => {
    if (!/^[1-9]\d*$/.test(params.id) || !Number.isSafeInteger(Number(params.id))) bad('id','must be a positive integer');
    const id=Number(params.id), uid=principal.userId;
    const row=()=>db.prepare(`SELECT j.rowid AS id,j.source,j.external_id,j.title,j.description,j.url,j.budget,j.tags,j.currency,j.bid_count,j.bid_avg,j.posted_at,j.created_at,uj.status,uj.score,uj.score_line,uj.proposal,uj.evaluation,uj.estimate,uj.prototype_url,uj.applied_at FROM jobs j JOIN user_jobs uj ON uj.job_id=j.rowid WHERE j.rowid=? AND uj.user_id=?`).get(id,uid);
    let job=row(); if(!job)throw new HttpError(404,'NOT_FOUND','Job not found');
    const decode=(v)=>{try{return v?JSON.parse(v):null;}catch{return null;}};
    const cachedValue=kind==='evaluate'?decode(job.evaluation):kind==='proposal'?job.proposal:decode(job.estimate);
    if(cachedValue && body?.regenerate!==true) { const stored=parseStoredProfile(db.prepare('SELECT profile_md FROM user_profiles WHERE user_id=?').get(uid)?.profile_md); return {job_id:id,kind,cached:true,result:kind==='estimate'?{...cachedValue,pricing:computePricing(cachedValue,job,{currency:job.currency},getMarketMedians(db),stored)}:cachedValue,usage:null,job:jobResponseForAi(job)}; }
    if(!gemini)throw new HttpError(503,'GEMINI_NOT_CONFIGURED','Gemini is not configured');
    const lock=`${uid}:${id}:${kind}`; if(runningAi.has(lock))throw new HttpError(409,'ALREADY_RUNNING','This generation is already running');
    runningAi.add(lock);
    try {
      const storedProfile=parseStoredProfile(db.prepare('SELECT profile_md FROM user_profiles WHERE user_id=?').get(uid)?.profile_md);
      const profile=profilePromptText(storedProfile);
      if(kind==='proposal' && !profile)throw new HttpError(422,'PROFILE_REQUIRED','A profile is required to write a proposal');
      const evaluation=decode(job.evaluation);
      if(kind==='proposal' && !evaluation && body?.skip_evaluation!==true)throw new HttpError(409,'EVALUATION_REQUIRED','Evaluate the job before writing a proposal');
      if(kind==='proposal' && evaluation?.verdict==='skip' && body?.skip_evaluation!==true)throw new HttpError(409,'EVALUATION_SKIP',evaluation.reasons?.[0]||'Evaluation recommends skipping this job');
      let stats={};
      if(kind==='evaluate') { const source=sources.find(x=>x.name===job.source); if(source?.fetchStats){try{stats=await source.fetchStats(job)||{};saveStats(job,stats);savePostedAt(job,stats);}catch{stats={};}} }
      let prompt=kind==='evaluate'?buildEvaluationPrompt(job,stats,profile||''):kind==='proposal'?buildProposalPrompt(job,profile):buildEstimatePrompt(job);
      const supplied=request.headers['idempotency-key']; const key=typeof supplied==='string'&&supplied.trim()?supplied.trim():`${kind}:${uid}:${id}:${crypto.randomUUID()}`;
      const result=await guard.execute({principal,feature:kind,jobId:id,idempotencyKey:key},async()=>{
        const generated=await gemini.generate({prompt,json:kind!=='proposal'});
        const parsed=kind==='evaluate'?parseEvaluation(generated.text):kind==='estimate'?parseEstimate(generated.text):generated.text.trim();
        if(!parsed || (typeof parsed==='string'&&!parsed.trim()))throw new HttpError(502,'GEMINI_BAD_RESPONSE','Gemini returned an unusable result');
        if(kind==='evaluate')saveEvaluation(id,parsed,stats,uid);
        else if(kind==='proposal'){saveProposal(id,parsed,true,uid); if(job.status==='sent')setStatus({source:job.source,external_id:job.external_id},'approved',db,uid);}
        else saveEstimate(id,parsed,uid);
        return {result:{value:parsed,meta:generated.usage},usage:generated.usage};
      });
      job=row(); const points=principal.role==='owner'||!config.SAAS_ENABLED?0:Number(config.FEATURE_COSTS?.[kind]||0);
      const endpointResult=kind==='estimate'?{...result.value,pricing:computePricing(result.value,job,{currency:job.currency},getMarketMedians(db),storedProfile)}:result.value;
      return {job_id:id,kind,cached:false,result:endpointResult,usage:{points,model:result.meta.model,input_tokens:result.meta.inputTokens,output_tokens:result.meta.outputTokens,cost_usd:(config.GEMINI_PRICE_PER_MTOK_INPUT||config.GEMINI_PRICE_PER_MTOK_OUTPUT)?((result.meta.inputTokens*(config.GEMINI_PRICE_PER_MTOK_INPUT||0)+result.meta.outputTokens*(config.GEMINI_PRICE_PER_MTOK_OUTPUT||0))/1e6):null},job:jobResponseForAi(job)};
    } finally {runningAi.delete(lock);}
  });
  if (radar) {
    router.add('GET', '/radar/status', () => radar.status());
    router.add('POST', '/radar/on', () => radar.enable());
    router.add('POST', '/radar/off', () => radar.disable());
  }
  return router;
}

function jobResponseForAi(r){return {id:r.id,source:r.source,external_id:r.external_id,title:r.title,url:r.url,budget:r.budget||'',score:r.score??null,score_line:r.score_line||'',status:r.status,tags:parsedTags(r.tags),currency:r.currency??null,bid_count:r.bid_count??null,bid_avg:r.bid_avg??null,posted_at:serializeDbTimestamp(r.posted_at??null),applied_at:r.applied_at?serializeDbTimestamp(r.applied_at):null,created_at:serializeDbTimestamp(r.created_at),has_proposal:Boolean(r.proposal),has_estimate:Boolean(r.estimate),prototype_url:r.prototype_url??null,description:r.description,proposal:r.proposal??null,evaluation:parsedJson(r.evaluation),estimate:parsedJson(r.estimate),stats:{bid_count:r.bid_count??null,bid_avg:r.bid_avg??null,currency:r.currency??null,posted_at:serializeDbTimestamp(r.posted_at??null)}};}

