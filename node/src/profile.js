const LIMITS = Object.freeze({
  display_name: 120, headline: 200, field: 120, bio: 4000, preferred_proposal_language: 80,
  tone_notes: 1000, extra_instructions: 2000,
});
const LISTS = Object.freeze({ skills: [30, 100], services: [30, 240], excluded_work: [30, 240], languages: [15, 80] });
const PORTFOLIO_MAX = 20;
const PROFILE_TEXT_MAX = 8000;

function invalid(message, code = 'INVALID_PROFILE') {
  const error = new Error(message);
  error.status = 422;
  error.code = code;
  return error;
}

export function normalizeProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Body must be a JSON object', 'INVALID_PARAMETER');
  if (Object.hasOwn(input, 'profile_text')) {
    if (Object.keys(input).length !== 1) throw invalid('profile_text cannot be combined with structured profile fields', 'INVALID_PARAMETER');
    if (typeof input.profile_text !== 'string' || !input.profile_text.trim()) throw invalid('profile_text must be a non-empty string');
    if (input.profile_text.length > PROFILE_TEXT_MAX) throw invalid(`profile_text must be at most ${PROFILE_TEXT_MAX} characters`);
    return { profile_text: input.profile_text.trim() };
  }
  const allowed = new Set([...Object.keys(LIMITS), ...Object.keys(LISTS), 'years_experience', 'hourly_rate', 'currency', 'portfolio']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw invalid(`Unknown profile field: ${key}`, 'INVALID_PARAMETER');
  const profile = {};
  for (const [key, max] of Object.entries(LIMITS)) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string') throw invalid(`${key} must be a string`, 'INVALID_PARAMETER');
    if (input[key].length > max) throw invalid(`${key} must be at most ${max} characters`);
    profile[key] = input[key].trim();
  }
  for (const [key, [count, max]] of Object.entries(LISTS)) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key]) || input[key].length > count || input[key].some((v) => typeof v !== 'string' || !v.trim() || v.length > max)) {
      throw invalid(`${key} must be a list of at most ${count} strings, each at most ${max} characters`, 'INVALID_PARAMETER');
    }
    profile[key] = input[key].map((v) => v.trim());
  }
  if (input.years_experience !== undefined) {
    if (!Number.isInteger(input.years_experience) || input.years_experience < 0 || input.years_experience > 70) throw invalid('years_experience must be an integer from 0 to 70', 'INVALID_PARAMETER');
    profile.years_experience = input.years_experience;
  }
  if (input.hourly_rate !== undefined) {
    if (typeof input.hourly_rate !== 'number' || !Number.isFinite(input.hourly_rate) || input.hourly_rate <= 0 || input.hourly_rate > 1_000_000) throw invalid('hourly_rate must be a positive number no greater than 1000000', 'INVALID_PARAMETER');
    profile.hourly_rate = input.hourly_rate;
    if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) throw invalid('currency must be a 3-letter uppercase code when hourly_rate is set', 'INVALID_PARAMETER');
    profile.currency = input.currency;
  } else if (input.currency !== undefined) throw invalid('currency requires hourly_rate', 'INVALID_PARAMETER');
  if (input.portfolio !== undefined) {
    if (!Array.isArray(input.portfolio) || input.portfolio.length > PORTFOLIO_MAX) throw invalid(`portfolio must be a list of at most ${PORTFOLIO_MAX} items`, 'INVALID_PARAMETER');
    profile.portfolio = input.portfolio.map((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['title', 'url', 'description'].includes(key))) throw invalid(`portfolio[${i}] must contain title, optional url, and optional description`, 'INVALID_PARAMETER');
      if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 160) throw invalid(`portfolio[${i}].title must be 1 to 160 characters`, 'INVALID_PARAMETER');
      if (item.url !== undefined) { let url; try { url = new URL(item.url); } catch { throw invalid(`portfolio[${i}].url must be an http(s) URL`, 'INVALID_PARAMETER'); } if (!['http:', 'https:'].includes(url.protocol) || item.url.length > 500) throw invalid(`portfolio[${i}].url must be an http(s) URL up to 500 characters`, 'INVALID_PARAMETER'); }
      if (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 500)) throw invalid(`portfolio[${i}].description must be at most 500 characters`, 'INVALID_PARAMETER');
      return { title: item.title.trim(), ...(item.url ? { url: item.url } : {}), ...(item.description ? { description: item.description.trim() } : {}) };
    });
  }
  if (!Object.keys(profile).length) throw invalid('Provide profile_text or at least one profile field');
  return profile;
}

export function parseStoredProfile(value) {
  if (!value) return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : { profile_text: value }; }
  catch { return { profile_text: value }; }
}

export function profilePromptText(profile) {
  if (!profile) return '';
  if (profile.profile_text) return profile.profile_text;
  return Object.entries(profile).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => `${key}: ${Array.isArray(value) ? value.map((item) => typeof item === 'object' ? JSON.stringify(item) : item).join(', ') : value}`).join('\n');
}

export function profileSearchTerms(profile) {
  if (!profile) return { include: [], exclude: [] };
  const terms = [...(profile.skills || []), ...(profile.services || []), profile.field, profile.headline].filter((v) => typeof v === 'string' && v.trim());
  if (profile.profile_text) {
    const clauses = profile.profile_text.split(/[\n,;؛.!?؟]+/).map((v) => v.trim()).filter(Boolean);
    terms.push(...clauses);
    if (clauses.length === 1) {
      const words = clauses[0].split(/\s+/).filter((word) => word.length > 2);
      for (let i = 0; i + 1 < words.length && i < 99; i++) terms.push(`${words[i]} ${words[i + 1]}`);
    }
  }
  return { include: [...new Set(terms.map((v) => v.trim()).filter(Boolean))], exclude: (profile.excluded_work || []).filter((v) => typeof v === 'string' && v.trim()) };
}
