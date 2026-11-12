import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requestJson, SourceError } from '../src/sources/base.js';
import { FreelancerSource, parseProjects, parseStats, USER_AGENT } from '../src/sources/freelancer.js';

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/freelancer_sample.json', import.meta.url), 'utf8'));
const response = (status, data, jsonError = null) => ({
  status,
  async json() { if (jsonError) throw jsonError; return data; },
});

test('Freelancer project parsing matches saved sample values', () => {
  const jobs = parseProjects(sample);
  assert.equal(jobs.length, 5);
  assert.deepEqual(jobs.slice(0, 3).map(({ external_id, title, url, budget }) => ({ external_id, title, url, budget })), [
    { external_id:'40796482', title:'Flutter App Update and Deployment', url:'https://www.freelancer.com/projects/app-development/Flutter-App-Update-Deployment', budget:'250-750 EUR' },
    { external_id:'40796476', title:'Secure Cross-Platform Equestrian Marketplace App (Android & iOS) – NDA Required', url:'https://www.freelancer.com/projects/flutter/Secure-Cross-Platform-Equestrian', budget:'3000-5000 USD' },
    { external_id:'40796385', title:'Android Classroom Control Software', url:'https://www.freelancer.com/projects/webrtc/Android-Classroom-Control-Software', budget:'30-250 USD' },
  ]);
  assert.equal(jobs[0].description, sample.result.projects[0].description.trim());
  assert.equal(jobs[0].source, 'freelancer');
  assert.equal(jobs[0].external_id, '40796482');
});

test('Freelancer stats preserve bid, budget, currency, hourly, and submitted fields', () => {
  assert.deepEqual(parseStats(sample, '40796482'), {
    bid_count: 228,
    bid_avg: 405.6077192982456,
    budget_min: 250,
    budget_max: 750,
    currency: 'EUR',
    hourly: false,
    time_submitted: 1793474037,
  });
  assert.deepEqual(parseStats({ result: { projects: [] } }, 'missing'), {});
});

test('stats request adds age_hours and uses Python endpoint parameters and User-Agent', async () => {
  let captured;
  const submitted = 1000;
  const source = new FreelancerSource({
    queries: [],
    fetchImpl: async (url, options) => {
      captured = { url: new URL(url), options };
      return response(200, { result: { projects: [{ id: 7, time_submitted: submitted, bid_stats: { bid_count: 2, bid_avg: 3 }, budget: { minimum: 4, maximum: 5 }, currency: { code: 'USD' }, type: 'fixed' }] } });
    },
    now: () => (submitted + 2.25 * 3600) * 1000,
    retries: 0,
  });
  const stats = await source.fetchStats({ external_id: '7' });
  assert.deepEqual(stats, { bid_count: 2, bid_avg: 3, budget_min: 4, budget_max: 5, currency: 'USD', hourly: false, time_submitted: 1000, age_hours: 2.2 });
  assert.equal(captured.url.searchParams.get('project_ids[]'), '7');
  assert.equal(captured.url.searchParams.get('limit'), '1');
  assert.equal(captured.url.searchParams.get('full_description'), 'true');
  assert.equal(captured.options.headers['User-Agent'], USER_AGENT);
});

test('HTTP failures, timeout, and invalid JSON become structured SourceErrors', async () => {
  const cases = [
    { response: response(429, {}), kind:'rate_limit', status:429 },
    { response: response(500, {}), kind:'server', status:500 },
    { response: response(404, {}), kind:'client', status:404 },
    { response: response(200, null, new SyntaxError('invalid JSON')), kind:'parse', status:200 },
  ];
  for (const item of cases) {
    await assert.rejects(
      requestJson('https://example.test/api', { source:'freelancer', retries:0, fetchImpl:async () => item.response }),
      (error) => error instanceof SourceError && error.source === 'freelancer' && error.kind === item.kind && error.status === item.status,
    );
  }
  await assert.rejects(
    requestJson('https://example.test/timeout', { source:'freelancer', timeoutMs:5, retries:0, fetchImpl:() => new Promise(() => {}) }),
    (error) => error instanceof SourceError && error.kind === 'network' && error.status === null,
  );
  await assert.rejects(
    requestJson('https://example.test/network', { source:'freelancer', retries:0, fetchImpl:async () => { throw new TypeError('offline'); } }),
    (error) => error instanceof SourceError && error.kind === 'network',
  );
});

test('transient server failure is retried once, then returns the successful response', async () => {
  let calls = 0;
  const result = await requestJson('https://example.test/retry', {
    source:'freelancer',
    fetchImpl:async () => ++calls === 1 ? response(503, {}) : response(200, { ok:true }),
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.data, { ok:true });
});

test('a failed search query does not discard successful query results', async () => {
  const calls = [];
  const source = new FreelancerSource({
    queries: ['broken', 'flutter'], sleepFn:async () => {}, retries:0,
    fetchImpl:async (url) => {
      const query = new URL(url).searchParams.get('query');
      calls.push(query);
      return query === 'broken' ? response(429, {}) : response(200, sample);
    },
  });
  const result = await source.fetchJobs();
  assert.deepEqual(calls, ['broken', 'flutter']);
  assert.equal(result.jobs.length, 5);
  assert.equal(result.jobs[0].external_id, '40796482');
  assert.deepEqual(result.errors, [{ query:'broken', source:'freelancer', kind:'rate_limit', status:429, message:'HTTP 429' }]);
});

test('search options match the Python query list, limit, sort, and response flags', async () => {
  const captured = [];
  const source = new FreelancerSource({ queries:['flutter'], sleepFn:async () => {}, retries:0, fetchImpl:async (url, options) => {
    captured.push({ url:new URL(url), options });
    return response(200, sample);
  } });
  const { jobs } = await source.fetchJobs();
  assert.equal(jobs.length, 5);
  const query = captured[0].url.searchParams;
  assert.equal(query.get('query'), 'flutter');
  assert.equal(query.get('limit'), '20');
  assert.equal(query.get('full_description'), 'true');
  assert.equal(query.get('job_details'), 'true');
  assert.equal(query.get('sort_field'), 'time_submitted');
  assert.equal(query.get('reverse_sort'), 'true');
  assert.equal(captured[0].options.headers['User-Agent'], USER_AGENT);
});
