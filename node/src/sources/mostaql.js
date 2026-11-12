import * as cheerio from 'cheerio';
import { Source, SourceError, requestJson } from './base.js';

export const PROJECTS_URL = 'https://mostaql.com/projects?category=development&sort=latest';
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ORIGIN = 'https://mostaql.com';

function getText($, element) {
  const chunks = [];
  const visit = (node) => {
    if (node.type === 'text') {
      const value = String(node.data || '').trim();
      if (value) chunks.push(value);
    } else {
      for (const child of node.children || []) visit(child);
    }
  };
  for (const node of $(element).toArray()) visit(node);
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

export function parseDetails(html) {
  const $ = cheerio.load(html);
  const detailsPanel = $('#projectDetailsTab .text-wrapper-div').first();
  const description = detailsPanel.length
    ? detailsPanel.find('p').toArray().map((paragraph) => getText($, paragraph)).filter(Boolean).join('\n\n')
    : '';
  let budget = '';
  for (const row of $('.meta-row').toArray()) {
    const label = $(row).find('.meta-label').first();
    if (label.length && getText($, label) === 'الميزانية') {
      const value = $(row).find('.meta-value[data-type="project-budget_range"]').first();
      if (value.length) budget = getText($, value);
      break;
    }
  }
  return [description, budget];
}

export function parseProjectTitle(html) {
  const $ = cheerio.load(html);
  return String($('h1[data-page-title]').first().attr('data-page-title') || '').trim();
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

function parseLocalIso(value) {
  // Python's datetime.now() is naive; subtracting an aware timestamp raises TypeError.
  if (/(?:Z|[+-]\d\d(?::?\d\d)?)$/i.test(value)) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/);
  if (!match) return null;
  const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = '0'] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(`0.${fraction}`) * 1000));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseStats(html, now = () => new Date()) {
  const $ = cheerio.load(html);
  const bidsPanel = $('#project-bids').first();
  if (!bidsPanel.length) return {};
  const stats = { bid_count: bidsPanel.find('.bid[data-bid-item]').length };
  for (const row of $('.meta-row').toArray()) {
    const label = $(row).find('.meta-label').first();
    if (label.length && getText($, label) === 'تاريخ النشر') {
      const published = $(row).find('time[datetime]').first();
      if (published.length) {
        const submitted = parseLocalIso(published.attr('datetime') || '');
        if (submitted) {
          const localNow = now();
          const wallClockNow = Date.UTC(localNow.getFullYear(), localNow.getMonth(), localNow.getDate(), localNow.getHours(), localNow.getMinutes(), localNow.getSeconds(), localNow.getMilliseconds());
          const age = (wallClockNow - submitted.getTime()) / 3_600_000;
          stats.age_hours = Math.max(0, roundOnePython(age));
        }
      }
      break;
    }
  }
  return stats;
}

export function parseProjects(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  const seen = new Map();
  for (const link of $('a[href*="/project/"]').toArray()) {
    const href = ($(link).attr('href') || '').trim();
    const title = getText($, link).split(/\s+/).filter(Boolean).join(' ');
    if (!href) continue;
    let fullUrl;
    try { fullUrl = new URL(href, ORIGIN); } catch { continue; }
    if ([...fullUrl.searchParams.keys()].some((key) => key.toLowerCase() === 'template')) continue;
    const projectPath = fullUrl.pathname.match(/^\/project\/(\d+)(?:-[^/]+)?\/?$/);
    if (!projectPath) continue;
    const externalId = projectPath[1];
    const goodTitle = usefulProjectTitle(title) ? title : '';
    const candidate = {
      source: 'mostaql',
      external_id: externalId,
      title: goodTitle,
      description: '',
      url: fullUrl.toString(),
      budget: '',
    };
    if (!seen.has(externalId)) {
      seen.set(externalId, jobs.length);
      jobs.push(candidate);
    } else {
      const index = seen.get(externalId);
      if (!jobs[index].title && goodTitle) jobs[index] = candidate;
    }
  }
  return jobs;
}

function usefulProjectTitle(title) {
  const normalized = String(title || '').trim().toLowerCase();
  if (!normalized || normalized === 'مشروع مماثل') return false;
  const tokens = normalized.replace(/[.,،:؛!?()[\]{}]+/g, ' ').split(/\s+/).filter(Boolean);
  const relativeWords = new Set([
    'منذ', 'قبل', 'ago', 'since', 'just', 'now', 'yesterday', 'today',
    'ثانية', 'ثواني', 'ثوانٍ', 'دقيقة', 'دقائق', 'دقيقه', 'دقايق',
    'ساعة', 'ساعات', 'ساعه', 'يوم', 'أيام', 'ايام', 'يومان', 'يومين',
    'أسبوع', 'اسبوع', 'أسابيع', 'اسابيع', 'شهر', 'أشهر', 'اشهر', 'شهور',
    'سنة', 'سنوات', 'سنه', 'لحظة', 'لحظات', 'قليل', 'الآن', 'الان',
    'second', 'seconds', 'sec', 'secs', 'minute', 'minutes', 'min', 'mins',
    'hour', 'hours', 'hr', 'hrs', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years',
  ]);
  const number = /^[0-9٠-٩۰-۹]+(?:[.,][0-9٠-٩۰-۹]+)?$/;
  return !tokens.length || !tokens.every((token) => relativeWords.has(token) || number.test(token));
}

function toSourceError(error, source, fallbackKind = 'parse') {
  return error instanceof SourceError ? error
    : new SourceError({ source, kind: fallbackKind, status: null, message: error?.message || 'Could not parse Mostaql response' });
}

export class MostaqlSource extends Source {
  constructor({ fetchImpl = globalThis.fetch, sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), randomFn = Math.random, timeoutMs = 30_000, retries = 1, now = () => new Date() } = {}) {
    super('mostaql');
    this.fetchImpl = fetchImpl;
    this.sleepFn = sleepFn;
    this.randomFn = randomFn;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.now = now;
    this.url = PROJECTS_URL;
  }

  async requestPage(url) {
    await this.sleepFn(1000 + this.randomFn() * 2000);
    return requestJson(url, {
      source: this.name,
      headers: { 'User-Agent': USER_AGENT },
      timeoutMs: this.timeoutMs,
      retries: this.retries,
      fetchImpl: this.fetchImpl,
      parseResponse: (response) => response.text(),
    });
  }

  async fetchJobs() {
    try {
      const { data: html } = await this.requestPage(this.url);
      const jobs = parseProjects(html);
      if (!jobs.length) {
        return { jobs: [], errors: [new SourceError({ source: this.name, kind: 'parse', status: 200, message: 'No project links found in Mostaql listing page' })] };
      }
      return { jobs, errors: [] };
    } catch (error) {
      return { jobs: [], errors: [toSourceError(error, this.name)] };
    }
  }

  async fetchDetails(job) {
    const { data: html } = await this.requestPage(job.url);
    const [description, budget] = parseDetails(html);
    if (!job.title) job.title = parseProjectTitle(html);
    job.description = description;
    job.budget = budget;
    return job;
  }

  async fetchStats(job) {
    const { data: html } = await this.requestPage(job.url);
    try { return parseStats(html, this.now); }
    catch (error) { throw toSourceError(error, this.name); }
  }
}

export async function fetchJobs(options) { return new MostaqlSource(options).fetchJobs(); }
export async function fetchDetails(job, options) { return new MostaqlSource(options).fetchDetails(job); }
export async function fetchStats(job, options) { return new MostaqlSource(options).fetchStats(job); }
