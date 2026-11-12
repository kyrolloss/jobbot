import { TECH_TAGS } from './config.js';

const SHORT_KEYWORDS = new Set([
  'api', 'apis', 'ai', 'php', 'ios', 'llm', 'dart', 'n8n', 'ui', 'ux', 'gpt',
  'node', 'react', 'flask', 'django', 'firebase', 'supabase', 'python', 'fastapi',
  'gemini', 'openai', 'zapier', 'android',
]);
const WORD = String.raw`[\p{L}\p{N}_]`;

function matchesTagText(text, keyword) {
  const normalized = keyword.toLowerCase().trim();
  if (!normalized) return false;
  if (!SHORT_KEYWORDS.has(normalized)) return text.includes(normalized);
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!${WORD})${escaped}(?!${WORD})`, 'iu').test(text);
}

export function extractTags(job) {
  try {
    const text = `${job.title || ''}\n${job.description || ''}`.toLowerCase();
    return Object.entries(TECH_TAGS)
      .filter(([, keywords]) => keywords.some((keyword) => matchesTagText(text, keyword)))
      .map(([tag]) => tag)
      .sort();
  } catch {
    return [];
  }
}

