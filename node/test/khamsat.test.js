import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDetails, parseList, parseStats, KhamsatSource } from '../src/sources/khamsat.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const listHtml = fs.readFileSync(path.join(here, 'fixtures', 'khamsat_list.html'), 'utf8');
const detailsHtml = fs.readFileSync(path.join(here, 'fixtures', 'khamsat_job.html'), 'utf8');
const noWait = async () => {};
const response = (status, body = '') => ({ status, text: async () => body });

test('Khamsat list and details parse match the saved Python samples', () => {
  const jobs = parseList(listHtml);
  assert.equal(jobs.length, 25);
  assert.deepEqual(jobs[0], {
    source: 'khamsat',
    external_id: '799930',
    title: 'مطلوب مطور لإنشاء صفحة هبوط (متجر مصغر للأحذية) مخ',
    description: '',
    url: 'https://khamsat.com/community/requests/799930-%D9%85%D8%B7%D9%84%D9%88%D8%A8-%D9%85%D8%B7%D9%88%D8%B1-%D9%84%D8%A5%D9%86%D8%B4%D8%A7%D8%A1-%D8%B5%D9%81%D8%AD%D8%A9-%D9%87%D8%A8%D9%88%D8%B7-%D9%85%D8%AA%D8%AC%D8%B1-%D9%85%D8%B5%D8%BA%D8%B1-%D9%84%D9%84%D8%A3%D8%AD%D8%B0%D9%8A%D8%A9-%D9%85%D8%AE',
    budget: '',
  });
  const details = parseDetails(detailsHtml, () => new Date('2026-01-01T00:00:00Z'));
  assert.ok(details.description.length > 0);
  assert.equal(details.budget, '');
  assert.equal(details.bid_count, 105);
  assert.deepEqual(parseStats('<html></html>'), {});
});

test('202 empty detail body returns the job, records empty details, and opens breaker', async () => {
  let calls = 0;
  const source = new KhamsatSource({ fetchImpl: async () => { calls++; return response(202, ''); }, sleepFn: noWait });
  const job = parseList(listHtml)[0];
  const result = await source.fetchDetails(job);
  assert.equal(result, job);
  assert.equal(calls, 1);
  assert.equal(source.detailsBlocked, true);
  assert.equal(source.lastDetailError.status, 202);
  assert.equal(source.lastDetailError.kind, 'parse');
  assert.deepEqual(source.lastDetails, { description: '', budget: '' });
  assert.deepEqual(await source.fetchStats(job), {});
  assert.equal(calls, 1);
});

for (const [status, kind] of [[403, 'client'], [429, 'rate_limit'], [503, 'server']]) {
  test(`Khamsat listing reports HTTP ${status} as ${kind}`, async () => {
    const source = new KhamsatSource({ fetchImpl: async () => response(status), sleepFn: noWait });
    const result = await source.fetchJobs();
    assert.equal(result.jobs.length, 0);
    assert.equal(result.errors[0].status, status);
    assert.equal(result.errors[0].kind, kind);
  });
}

test('Khamsat network errors are returned as structured errors', async () => {
  const source = new KhamsatSource({ fetchImpl: async () => { throw new Error('offline'); }, sleepFn: noWait });
  const { jobs, errors } = await source.fetchJobs();
  assert.equal(jobs.length, 0);
  assert.equal(errors[0].kind, 'network');
});

test('changed listing structure reports a parse error without crashing', async () => {
  const source = new KhamsatSource({ fetchImpl: async () => response(200, '<html><body><a>Different structure</a></body></html>'), sleepFn: noWait });
  const { jobs, errors } = await source.fetchJobs();
  assert.deepEqual(jobs, []);
  assert.equal(errors[0].kind, 'parse');
});

test('one detail HTTP failure trips the breaker and prevents further requests', async () => {
  let calls = 0;
  const source = new KhamsatSource({ fetchImpl: async () => { calls++; return response(403); }, sleepFn: noWait });
  const jobs = parseList(listHtml);
  await source.fetchDetails(jobs[0]);
  assert.equal(source.detailsBlocked, true);
  assert.equal(source.lastDetailError.status, 403);
  await source.fetchDetails(jobs[1]);
  assert.equal(calls, 1);
});
