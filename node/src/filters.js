import { KEYWORDS, NEGATIVE_KEYWORDS } from './config.js';

const SHORT_WORD_KEYWORDS = new Set(['ai', 'api', 'node']);
const WORD = String.raw`[\p{L}\p{N}_]`;

export function containsKeyword(text, keyword) {
  const folded = String(text ?? '').toLowerCase();
  const normalized = String(keyword).toLowerCase();
  if (SHORT_WORD_KEYWORDS.has(normalized)) {
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<!${WORD})${escaped}(?!${WORD})`, 'iu').test(folded);
  }
  return folded.includes(normalized);
}

export function matchesJob(job) {
  const text = `${job.title ?? 'None'}\n${job.description ?? 'None'}`.toLowerCase();
  return KEYWORDS.some((keyword) => containsKeyword(text, keyword))
    && !NEGATIVE_KEYWORDS.some((keyword) => containsKeyword(text, keyword));
}

