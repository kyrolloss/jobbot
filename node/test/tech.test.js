import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractTags } from '../src/tech.js';

const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/parity_cases.json', import.meta.url), 'utf8')).tech;

test('tech tag extraction matches parity fixtures', () => {
  for (const item of cases) {
    assert.deepEqual(extractTags({ title: item.title, description: item.description }), item.expected, JSON.stringify(item));
  }
});

test('empty title, tag-free text, and very long descriptions are handled', () => {
  assert.deepEqual(extractTags({ title: '', description: 'ordinary writing only' }), []);
  assert.deepEqual(extractTags({ title: '', description: 'بايثون و Flutter' }), ['flutter', 'python']);
  assert.deepEqual(extractTags({ title: '', description: 'Flutter '.repeat(10000) }), ['flutter']);
});
