import { FREELANCER_QUERIES } from '../config.js';
import { Source, SourceError, requestJson } from './base.js';

export const API_URL = 'https://www.freelancer.com/api/projects/0.1/projects/active/';
export const PROJECT_URL_BASE = 'https://www.freelancer.com/projects/';
export const USER_AGENT = 'Jobbot/1.0 (automated public job listing monitor; owner-operated)';

function formatAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError('Budget amount is not numeric');
  if (Number.isInteger(number)) return String(number);
  const absolute = Math.abs(number);
  let formatted;
  if (absolute !== 0 && (absolute < 1e-4 || absolute >= 1e6)) {
    const [mantissa, exponentText] = number.toExponential(5).split('e');
    const exponent = Number(exponentText);
    formatted = `${mantissa.replace(/(?:\.0+|(?<=\.[0-9]*?)0+)$/, '').replace(/\.$/, '')}e${exponent >= 0 ? '+' : '-'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  } else {
    const exponent = Math.floor(Math.log10(absolute || 1));
    formatted = number.toFixed(Math.max(0, 5 - exponent)).replace(/(?:\.0+|(?<=\.[0-9]*?)0+)$/, '').replace(/\.$/, '');
  }
  return formatted;
}

export function parseProjects(data) {
  const projects = data?.result && typeof data.result === 'object' && !Array.isArray(data.result)
    ? data.result.projects || [] : [];
  const jobs = [];
  const seenIds = new Set();
  for (const project of projects) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) continue;
    const projectId = project.id;
    const title = project.title;
    const seoUrl = project.seo_url;
    if (projectId == null || !title || !seoUrl || seenIds.has(String(projectId))) continue;
    seenIds.add(String(projectId));
    const budgetData = project.budget || {};
    const currencyData = project.currency || {};
    const minimum = budgetData.minimum;
    const maximum = budgetData.maximum;
    const currencyCode = String(currencyData.code ?? '').trim();
    let budget = '';
    if (minimum != null && maximum != null && currencyCode) {
      budget = `${formatAmount(minimum)}-${formatAmount(maximum)} ${currencyCode}`;
      if (project.type === 'hourly') budget += '/hr';
    }
    jobs.push({
      source: 'freelancer',
      external_id: String(projectId),
      title: String(title).trim(),
      description: String(project.description || '').trim(),
      url: PROJECT_URL_BASE + String(seoUrl).replace(/^\/+/, ''),
      budget,
    });
  }
  return jobs;
}

export function parseStats(data, projectId = null) {
  const projects = data?.result && typeof data.result === 'object' && !Array.isArray(data.result)
    ? data.result.projects || [] : [];
  const project = projects.find((item) => item && typeof item === 'object'
    && (projectId == null || String(item.id) === String(projectId)));
  if (!project || typeof project !== 'object' || Array.isArray(project)) return {};
  const bidStats = project.bid_stats || {};
  const budget = project.budget || {};
  const currency = project.currency || {};
  const stats = {
    bid_count: bidStats.bid_count,
    bid_avg: bidStats.bid_avg,
    budget_min: budget.minimum,
    budget_max: budget.maximum,
    currency: currency.code,
    hourly: project.type === 'hourly',
  };
  if (project.time_submitted != null) stats.time_submitted = project.time_submitted;
  return Object.fromEntries(Object.entries(stats).filter(([, value]) => value != null));
}

function roundOnePython(value) {
  const scaled = value * 10;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  if (Math.abs(fraction - 0.5) < Number.EPSILON * Math.max(1, Math.abs(scaled))) {
    return (lower % 2 === 0 ? lower : lower + 1) / 10;
  }
  return Math.round(scaled) / 10;
}

export class FreelancerSource extends Source {
  constructor({ fetchImpl = globalThis.fetch, sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), queries = FREELANCER_QUERIES, timeoutMs = 30_000, retries = 1, now = () => Date.now() } = {}) {
    super('freelancer');
    this.fetchImpl = fetchImpl;
    this.sleepFn = sleepFn;
    this.queries = [...queries];
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.now = now;
  }

  async fetchJobs() {
    const jobs = [];
    const errors = [];
    const seen = new Set();
    for (let index = 0; index < this.queries.length; index++) {
      const query = this.queries[index];
      if (index) await this.sleepFn(1500);
      try {
        const { data } = await requestJson(API_URL, {
          source: this.name,
          fetchImpl: this.fetchImpl,
          timeoutMs: this.timeoutMs,
          retries: this.retries,
          headers: { 'User-Agent': USER_AGENT },
          params: {
            query,
            limit: 20,
            full_description: true,
            job_details: true,
            sort_field: 'time_submitted',
            reverse_sort: true,
          },
        });
        let parsed;
        try { parsed = parseProjects(data); } catch (error) {
          throw new SourceError({ source: this.name, kind: 'parse', status: 200, message: error?.message || 'Could not parse projects' });
        }
        for (const job of parsed) {
          if (!seen.has(job.external_id)) { seen.add(job.external_id); jobs.push(job); }
        }
      } catch (error) {
        const structured = error instanceof SourceError ? error
          : new SourceError({ source: this.name, kind: 'parse', status: null, message: error?.message || 'Could not parse projects' });
        errors.push({ query, source: structured.source, kind: structured.kind, status: structured.status, message: structured.message });
      }
    }
    return { jobs, errors };
  }

  fetchDetails(job) { return job; }

  async fetchStats(job) {
    const { data } = await requestJson(API_URL, {
      source: this.name,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      retries: this.retries,
      headers: { 'User-Agent': USER_AGENT },
      params: {
        'project_ids[]': job.external_id,
        limit: 1,
        full_description: true,
        job_details: true,
      },
    });
    let stats;
    try { stats = parseStats(data, job.external_id); } catch (error) {
      throw new SourceError({ source: this.name, kind: 'parse', status: 200, message: error?.message || 'Could not parse project stats' });
    }
    if (stats.time_submitted != null) {
      const submitted = Number(stats.time_submitted);
      if (!Number.isFinite(submitted)) throw new SourceError({ source: this.name, kind: 'parse', status: 200, message: 'Invalid time_submitted value' });
      const ageHours = (this.now() / 1000 - submitted) / 3600;
      stats.age_hours = Math.max(0, roundOnePython(ageHours));
    }
    return stats;
  }
}

export async function fetchJobs(options) { return new FreelancerSource(options).fetchJobs(); }
export function fetchDetails(job) { return job; }
export async function fetchStats(job, options) { return new FreelancerSource(options).fetchStats(job); }
