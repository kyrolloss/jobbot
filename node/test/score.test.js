import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scoreJob } from '../src/score.js';

const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/parity_cases.json', import.meta.url), 'utf8')).score;

test('score and Arabic score-line output match parity fixtures', () => {
  for (const item of cases) assert.deepEqual(scoreJob(item.job, item.stats), item.expected, JSON.stringify(item));
});

test('empty title and very long description keep keyword scoring capped', () => {
  const empty = scoreJob({ title: '', description: '', budget: '' }, {});
  assert.equal(empty.score, 2.5);
  const long = scoreJob({ title: '', description: 'Flutter '.repeat(10000), budget: '' });
  assert.equal(long.score, 3);
  assert.equal(long.line, '📋 الأرقام مش متاحة، افتح الرابط وشوف العروض والميزانية');
});
