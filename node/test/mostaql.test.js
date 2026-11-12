import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SourceError } from '../src/sources/base.js';
import { MostaqlSource, PROJECTS_URL, USER_AGENT, parseDetails, parseProjects, parseStats } from '../src/sources/mostaql.js';

const anonymousHtml = fs.readFileSync(new URL('./fixtures/mostaql_job_sample.html', import.meta.url), 'utf8');
const loggedInHtml = fs.readFileSync(new URL('./fixtures/mostaql_job_logged_in.html', import.meta.url), 'utf8');
const junkListingHtml = fs.readFileSync(new URL('./fixtures/mostaql_listing_junk.html', import.meta.url), 'utf8');
const response = (status, body) => ({ status, async text() { return body; } });
const fixedNow = () => new Date(2026, 9, 30, 20, 20, 58);

test('Mostaql details match the saved Python sample output', () => {
  const [description, budget] = parseDetails(anonymousHtml);
  assert.equal(description, 'سلام عليكم،\n\nانا سويت تطبيق بالAi ، والتطبيق من Bolt.new ، التطبيق لسا موجود على بولت.\n\nابغى مبرمج محترف،\n\nيفحصه، يكتشف الاخطاء.\n\nيصحح الاخطاء.\n\nوايضا يزيد بعض الخدمات مثل يربطلي طرق الدفع ويربطها لحسابي البنكي التجاري، وايضا يربط التطبيق بخدمات التحقق من الID.\n\nونطلق التطبيق في الابستور مع بعض.\n\nوانا منفتحة لأي نصيحة منه.\n\nاتمنى محد يكلمني الا اللي فعلا فعلا مبرمج ومحترف بشغله وعندو خبرة.');
  assert.equal(budget, '$250.00 - $500.00');
});

test('Mostaql stats count sample bids and calculate naive local age like Python', () => {
  assert.deepEqual(parseStats(anonymousHtml, fixedNow), { bid_count:27, age_hours:24 });
  assert.deepEqual(parseStats(loggedInHtml, fixedNow), { bid_count:36, age_hours:24 });
  assert.deepEqual(parseStats('<html><body>no bid panel</body></html>', fixedNow), {});
});

test('listing extraction follows the Python URL selectors and deduplication', () => {
  const jobs = parseProjects(anonymousHtml);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].external_id, '1289128');
  assert.equal(jobs[0].title, '');
  assert.equal(jobs[0].url, 'https://mostaql.com/project/1289128-%D8%A7%D8%A8%D8%AD%D8%AB-%D8%B9%D9%86-%D9%85%D8%A8%D8%B1%D9%85%D8%AC-%D9%84%D9%81%D8%AD%D8%B5-%D9%88%D8%AA%D8%B9%D8%AF%D9%8A%D9%84-%D8%A7%D9%84%D8%A3%D8%AE%D8%B7%D8%A7%D8%A1-%D9%84%D8%AA%D8%B7%D8%A8%D9%8A%D9%82-%D8%AC%D9%88%D8%A7%D9%84?bid=10221613');
});

test('listing rejects create and nonnumeric paths and prefers a good duplicate title', () => {
  const jobs = parseProjects(junkListingHtml);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(({ external_id, title }) => ({ external_id, title })), [
    { external_id:'5566771', title:'بناء متجر إلكتروني' },
    { external_id:'1281369', title:'تطوير تطبيق إدارة المخزون' },
  ]);
  assert.ok(jobs.every((job) => /^\d+$/.test(job.external_id)));
  assert.ok(jobs.every((job) => !job.url.includes('/project/create')));
});

test('fetchJobs exposes structured 403, 429, server, network, and parse errors', async () => {
  for (const item of [
    { status:403, kind:'client' },
    { status:429, kind:'rate_limit' },
    { status:503, kind:'server' },
  ]) {
    let calls = 0;
    const source = new MostaqlSource({ fetchImpl:async () => { calls++; return response(item.status, ''); }, sleepFn:async () => {}, retries:0 });
    const result = await source.fetchJobs();
    assert.deepEqual(result.jobs, []);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0] instanceof SourceError);
    assert.equal(result.errors[0].source, 'mostaql');
    assert.equal(result.errors[0].kind, item.kind);
    assert.equal(result.errors[0].status, item.status);
    if (item.status === 403) assert.equal(calls, 1);
  }
  const network = await new MostaqlSource({ fetchImpl:async () => { throw new TypeError('offline'); }, sleepFn:async () => {}, retries:0 }).fetchJobs();
  assert.equal(network.errors[0].kind, 'network');
  assert.equal(network.errors[0].status, null);
  const changed = await new MostaqlSource({ fetchImpl:async () => response(200, '<html><main>changed layout</main></html>'), sleepFn:async () => {}, retries:0 }).fetchJobs();
  assert.equal(changed.errors[0].kind, 'parse');
  assert.equal(changed.errors[0].status, 200);
});

test('fetchJobs, fetchDetails, and fetchStats use injected fetch and the Python User-Agent', async () => {
  const calls = [];
  const source = new MostaqlSource({
    fetchImpl:async (url, options) => { calls.push({ url:String(url), options }); return response(200, anonymousHtml); },
    sleepFn:async () => {}, randomFn:() => 0, retries:0, now:fixedNow,
  });
  const listing = await source.fetchJobs();
  assert.equal(listing.jobs.length, 1);
  assert.deepEqual(listing.errors, []);
  assert.equal(calls[0].url, PROJECTS_URL);
  assert.equal(calls[0].options.headers['User-Agent'], USER_AGENT);

  const job = await source.fetchDetails({ ...listing.jobs[0] });
  assert.equal(job.title, 'ابحث عن مبرمج لفحص وتعديل الأخطاء لتطبيق جوال');
  assert.equal(job.budget, '$250.00 - $500.00');
  assert.equal(job.description, parseDetails(anonymousHtml)[0]);
  assert.deepEqual(await source.fetchStats(job), { bid_count:27, age_hours:24 });
  assert.equal(calls.length, 3);
});
