import * as cheerio from 'cheerio';
import { KHAMSAT_BASE_URL, KHAMSAT_REQUESTS_URL, KHAMSAT_REQUEST_GAP_SECONDS, KHAMSAT_TIMEOUT_SECONDS, KHAMSAT_USER_AGENT } from '../config.js';
import { Source, SourceError, requestJson } from './base.js';

const REQUEST_ID = /^\/community\/requests\/(\d+)(?:-|\/|$)/;

function text($, element) {
  return $(element).text().replace(/\s+/g, ' ').trim();
}

function textWithNewlines($, element) {
  const pieces = [];
  const visit = (node) => {
    if (node.type === 'text') {
      const value = String(node.data || '').trim();
      if (value) pieces.push(value);
    } else {
      for (const child of node.children || []) visit(child);
    }
  };
  for (const node of $(element).toArray()) visit(node);
  return pieces.join('\n');
}

export function parseList(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  const seen = new Set();
  for (const row of $('tr.forum_post').toArray()) {
    const link = $(row).find('td.details-td h3.details-head a[href]').first();
    if (!link.length) continue;
    const href = String(link.attr('href') || '').trim();
    let path;
    try { path = new URL(href, KHAMSAT_BASE_URL).pathname; } catch { continue; }
    const match = path.match(REQUEST_ID);
    const title = text($, link);
    if (!match || !title || seen.has(match[1])) continue;
    seen.add(match[1]);
    jobs.push({ source: 'khamsat', external_id: match[1], title, description: '', url: new URL(href, KHAMSAT_BASE_URL).toString(), budget: '' });
  }
  return jobs;
}

export function parseStats(html, now = () => new Date()) {
  const $ = cheerio.load(html);
  const stats = {};
  for (const heading of $('div.card h3').toArray()) {
    const match = text($, heading).match(/التعليقات\s*\(([\d,]+)\)/);
    if (match) { stats.bid_count = Number(match[1].replaceAll(',', '')); break; }
  }
  const published = $('#community_sidebar #sidebar span[title]').first().attr('title');
  const dateMatch = String(published || '').match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/);
  if (dateMatch) {
    const [, day, month, year, hour, minute, second] = dateMatch;
    const submitted = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
    if (!Number.isNaN(submitted)) stats.age_hours = Math.max(0, Math.round(((now().getTime() - submitted) / 3_600_000) * 10) / 10);
  }
  return stats;
}

export function parseDetails(html, now = () => new Date()) {
  const $ = cheerio.load(html);
  const article = $('.js-page article.replace_urls').first();
  const description = article.length ? textWithNewlines($, article) : '';
  return { description, budget: '', ...parseStats(html, now) };
}

function errorFor(error, source, fallback = 'parse') {
  return error instanceof SourceError ? error : new SourceError({ source, kind: fallback, status: null, message: error?.message || 'Khamsat request failed' });
}

export class KhamsatSource extends Source {
  constructor({ fetchImpl = globalThis.fetch, sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = KHAMSAT_TIMEOUT_SECONDS * 1000, now = () => new Date() } = {}) {
    super('khamsat');
    this.fetchImpl = fetchImpl;
    this.sleepFn = sleepFn;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.detailsBlocked = false;
    this.lastDetailError = null;
    this.lastDetails = {};
    this.lastRequestAt = 0;
  }

  async request(url, { accept202 = false } = {}) {
    const elapsed = Date.now() - this.lastRequestAt;
    if (this.lastRequestAt) await this.sleepFn(Math.max(0, KHAMSAT_REQUEST_GAP_SECONDS * 1000 - elapsed));
    this.lastRequestAt = Date.now();
    return requestJson(url, { source: this.name, headers: { 'User-Agent': KHAMSAT_USER_AGENT }, timeoutMs: this.timeoutMs, retries: 0, fetchImpl: this.fetchImpl, parseResponse: (response) => response.text(), acceptStatuses: accept202 ? [202] : [] });
  }

  async fetchJobs() {
    this.detailsBlocked = false;
    this.lastDetailError = null;
    this.lastDetails = {};
    try {
      const { data: html } = await this.request(KHAMSAT_REQUESTS_URL);
      if (!html.trim()) return { jobs: [], errors: [new SourceError({ source: this.name, kind: 'parse', status: 200, message: 'Empty Khamsat listing response' })] };
      const jobs = parseList(html);
      return jobs.length ? { jobs, errors: [] } : { jobs: [], errors: [new SourceError({ source: this.name, kind: 'parse', status: 200, message: 'No Khamsat requests found in listing' })] };
    } catch (error) { return { jobs: [], errors: [errorFor(error, this.name)] }; }
  }

  async fetchDetails(job) {
    if (this.detailsBlocked) return job;
    let path;
    try { path = new URL(job.url).pathname; } catch { this.lastDetailError = new SourceError({ source: this.name, kind: 'client', status: null, message: 'Invalid Khamsat request URL' }); return job; }
    if (!REQUEST_ID.test(path)) { this.lastDetailError = new SourceError({ source: this.name, kind: 'client', status: null, message: 'Invalid Khamsat request URL' }); return job; }
    try {
      const { data: html } = await this.request(job.url, { accept202: true });
      if (!html.trim()) { this.detailsBlocked = true; this.lastDetails = { description: '', budget: '' }; this.lastDetailError = new SourceError({ source: this.name, kind: 'parse', status: 202, message: 'Empty Khamsat detail response; details disabled for this scan' }); return job; }
      const details = parseDetails(html, this.now);
      if (details.description) job.description = details.description;
      if (details.budget) job.budget = details.budget;
      this.lastDetails = details;
      return job;
    } catch (error) {
      this.lastDetailError = errorFor(error, this.name, 'network');
      // Python opens the breaker for HTTP failures and empty bodies, but not
      // for transport exceptions caught by its outer handler.
      if (error instanceof SourceError && error.status !== null) this.detailsBlocked = true;
      return job;
    }
  }

  async fetchStats(job) {
    if (this.detailsBlocked) return {};
    try {
      const { data: html } = await this.request(job.url, { accept202: true });
      if (!html.trim()) { this.detailsBlocked = true; this.lastDetailError = new SourceError({ source: this.name, kind: 'parse', status: 202, message: 'Empty Khamsat detail response; details disabled for this scan' }); return {}; }
      return parseStats(html, this.now);
    } catch (error) {
      this.lastDetailError = errorFor(error, this.name, 'network');
      if (error instanceof SourceError && error.status !== null) this.detailsBlocked = true;
      return {};
    }
  }
}

export async function fetchJobs(options) { return new KhamsatSource(options).fetchJobs(); }
export async function fetchDetails(job, options) { return new KhamsatSource(options).fetchDetails(job); }
export async function fetchStats(job, options) { return new KhamsatSource(options).fetchStats(job); }
