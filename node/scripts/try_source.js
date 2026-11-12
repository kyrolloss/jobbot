import { FREELANCER_QUERIES } from '../src/config.js';
import { FreelancerSource } from '../src/sources/freelancer.js';
import { MostaqlSource } from '../src/sources/mostaql.js';
import { KhamsatSource } from '../src/sources/khamsat.js';

const [sourceName, queryArg] = process.argv.slice(2);
if (sourceName === 'mostaql') {
  const { jobs, errors } = await new MostaqlSource().fetchJobs();
  console.log(`Jobs: ${jobs.length}`);
  for (const job of jobs.slice(0, 3)) console.log(JSON.stringify({ title: job.title, budget: job.budget, url: job.url }));
  console.log(`Errors: ${JSON.stringify(errors.map(({ source, kind, status, message }) => ({ source, kind, status, message })))}`);
} else if (sourceName === 'khamsat') {
  const { jobs, errors } = await new KhamsatSource().fetchJobs();
  console.log(`Jobs: ${jobs.length}`);
  for (const job of jobs.slice(0, 3)) console.log(JSON.stringify({ title: job.title, url: job.url, external_id: job.external_id }));
  console.log(`Errors: ${JSON.stringify(errors.map(({ source, kind, status, message }) => ({ source, kind, status, message })))}`);
} else if (sourceName === 'freelancer') {
  const query = queryArg || FREELANCER_QUERIES[0];
  const source = new FreelancerSource({ queries: [query] });
  const { jobs, errors } = await source.fetchJobs();
  console.log(`Jobs: ${jobs.length}`);
  for (const job of jobs.slice(0, 3)) {
    const display = { title: job.title, budget: job.budget, url: job.url };
    if (job.bid_count != null) display.bid_count = job.bid_count;
    console.log(JSON.stringify(display));
  }
  console.log(`Errors: ${JSON.stringify(errors)}`);
} else {
  console.error('Usage: node scripts/try_source.js freelancer [query] | mostaql | khamsat');
  process.exitCode = 1;
}
