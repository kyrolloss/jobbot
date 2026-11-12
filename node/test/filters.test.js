import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { containsKeyword, matchesJob } from '../src/filters.js';

const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/parity_cases.json', import.meta.url), 'utf8')).filters;

test('broad keyword filter matches parity fixtures', () => {
  for (const item of cases) assert.equal(matchesJob(item), item.expected, JSON.stringify(item));
});

test('short terms use whole-word matching while normal terms stay substring based', () => {
  assert.equal(containsKeyword('email', 'ai'), false);
  assert.equal(containsKeyword('rapid', 'api'), false);
  assert.equal(containsKeyword('Node.js', 'node'), true);
  assert.equal(containsKeyword('مطلوب API بالعربية', 'api'), true);
  assert.equal(matchesJob({ title: '', description: 'Flutter '.repeat(10000) }), true);
});
