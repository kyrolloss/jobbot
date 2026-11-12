import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DB_PATH, CURRENCY_TO_USD, CURRENCY_SYMBOL_TO_CODE, KEYWORDS,
  SCORING_TITLE_KEYWORD_WEIGHT, SCORING_DESCRIPTION_KEYWORD_WEIGHT,
  SCORING_TITLE_KEYWORD_CAP, SCORING_DESCRIPTION_KEYWORD_CAP,
  SCORING_BUDGET_MAX_POINTS, SCORING_BUDGET_NEUTRAL_POINTS, SCORING_BUDGET_SATURATION_USD,
  SCORING_COMPETITION_MAX_POINTS, SCORING_COMPETITION_NEUTRAL_POINTS,
  SCORING_LOW_COMPETITION_REDUCTION_FRACTION, SCORING_MEDIUM_COMPETITION_START_FRACTION,
  SCORING_FRESHNESS_MAX_POINTS, SCORING_FRESHNESS_NEUTRAL_POINTS, SCORING_FRESHNESS_WINDOW_HOURS,
  COMPETITION_LOW_MAX_BIDS, COMPETITION_HIGH_MIN_BIDS,
} from '../src/config.js';
import { scoreJob } from '../src/score.js';
import { extractTags } from '../src/tech.js';

const GENERIC_LINE = '📋 الأرقام مش متاحة، افتح الرابط وشوف العروض والميزانية';
function splitLine(line) {
  if (line === GENERIC_LINE) return { kind: 'generic' };
  const sections = line.split(' | ');
  if (sections.length !== 5 || !/^كلمات عنوان \d+\/وصف \d+$/.test(sections[0])) return null;
  return { kind: 'metrics', sections };
}

function parseAverage(section, stats) {
  if (section === 'متوسط غير متاح') return true;
  const value = section.slice('متوسط '.length);
  const match = value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|nan|inf|-inf|\?)(?: (.*))?$/i);
  if (!match) return false;
  stats.bid_avg = match[1] === '?' ? '?' : Number(match[1]);
  if (match[2]) stats.currency = match[2];
  return true;
}

function buildStats(row, parsed) {
  if (parsed.kind === 'generic') return { stats: {}, error: null };
  const [, , budgetText, bidsText, averageText, ageText] = ['', ...parsed.sections];
  const stats = { __parityMarker: true };
  if (bidsText === 'عروض غير متاح') {
    // No scan-time bid count was available in the persisted score line.
  } else if (bidsText.startsWith('عروض ')) {
    const count = bidsText.slice('عروض '.length);
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(count)) return { error: 'score line has an unparseable bid count' };
    stats.bid_count = Number(count);
  } else return { error: 'score line has an unparseable bid count' };

  if (!parseAverage(averageText, stats)) return { error: 'score line has an unparseable bid average' };
  if (ageText === 'العمر غير متاح') {
    // A nonnumeric sentinel reproduces Python's unavailable age while keeping stats nonempty.
    stats.age_hours = '__parity_unavailable__';
  } else {
    const age = ageText.match(/^عمر ([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)س$/i);
    if (!age) return { error: 'score line has an unparseable age' };
    stats.age_hours = Number(age[1]);
  }

  const amount = budgetText.match(/^ميزانية≈(.+) USD$/);
  if (amount) {
    const usd = Number(amount[1]);
    if (!Number.isFinite(usd)) return { error: 'score line has an unparseable budget' };
    const natural = scoreJob(row, stats);
    const naturalBudget = natural.line.split(' | ')[1];
    if (naturalBudget !== budgetText) {
      let currency = stats.currency;
      if (!currency) {
        if (stats.bid_avg != null) return { error: 'budget currency is not recoverable from score line' };
        currency = 'USD';
        stats.currency = currency;
      }
      const rate = CURRENCY_TO_USD[currency.toUpperCase()];
      if (!rate) return { error: 'budget currency is not recoverable from score line' };
      const amountInCurrency = usd / rate;
      stats.budget_min = amountInCurrency;
      stats.budget_max = amountInCurrency;
    }
  } else if (budgetText !== 'ميزانية غير معروفة') {
    return { error: 'score line has an unrecognized budget value' };
  }
  if (budgetText === 'ميزانية غير معروفة' && !row.budget) {
    // Keep the marker so scoreJob emits the informative, unavailable-metrics line.
  }
  if (parsed.sections[1] === 'ميزانية غير معروفة' && row.budget) {
    const naturalBudget = scoreJob(row, stats).line.split(' | ')[1];
    if (naturalBudget !== 'ميزانية غير معروفة') return { error: 'stored budget conflicts with score line' };
  }
  return { stats, error: null };
}

export function compareScoreRow(row) {
  if (!row || typeof row !== 'object') return { state: 'not-comparable', reason: 'invalid row' };
  if (row.score == null) return { state: 'not-applicable', reason: null };
  if (typeof row.score_line !== 'string' || !row.score_line) return { state: 'not-comparable', reason: 'missing score_line' };
  try {
    const parsed = splitLine(row.score_line);
    if (!parsed) return { state: 'not-comparable', reason: 'unrecognized score_line format' };
    const built = buildStats(row, parsed);
    if (built.error) return { state: 'not-comparable', reason: built.error };
    const result = scoreJob({ title: row.title, description: row.description, budget: row.budget || '' }, built.stats);
    const scoreMatches = Math.abs(Number(row.score) - result.score) <= 0.05;
    const lineMatches = result.line === row.score_line;
    return {
      state: scoreMatches && lineMatches ? 'match' : 'mismatch',
      stored: { score: row.score, line: row.score_line },
      js: { score: result.score, line: result.line },
    };
  } catch {
    return { state: 'not-comparable', reason: 'score recomputation failed' };
  }
}

function lineKeywordMatch(text, keyword) {
  const short = new Set(['ai', 'api', 'node']);
  const folded = String(text ?? '').toLowerCase();
  const word = String.raw`[\p{L}\p{N}_]`;
  if (short.has(keyword.toLowerCase())) return new RegExp(`(?<!${word})${keyword}(?!${word})`, 'iu').test(folded);
  return folded.includes(keyword.toLowerCase());
}

function budgetForExplanation(job, stats) {
  let amount = null, currency = null;
  if (stats.budget_min != null && stats.budget_max != null) {
    amount = (Number(stats.budget_min) + Number(stats.budget_max)) / 2;
    currency = stats.currency ? String(stats.currency).toUpperCase() : null;
  } else {
    const budget = job.budget || '';
    const values = budget.match(/[0-9]+(?:[,.][0-9]+)*/g) || [];
    if (values.length) {
      const numbers = values.slice(0, 2).map((value) => Number(value.replaceAll(',', '')));
      amount = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
      for (const code of Object.keys(CURRENCY_TO_USD)) {
        if (new RegExp(`(?<![\\p{L}\\p{N}_])${code}(?![\\p{L}\\p{N}_])`, 'iu').test(budget)) { currency = code; break; }
      }
      if (!currency) {
        for (const [symbol, code] of Object.entries(CURRENCY_SYMBOL_TO_CODE)) {
          if (budget.includes(symbol)) { currency = code; break; }
        }
      }
    }
  }
  const usd = amount != null && Object.hasOwn(CURRENCY_TO_USD, currency) ? amount * CURRENCY_TO_USD[currency] : null;
  const points = usd == null
    ? SCORING_BUDGET_NEUTRAL_POINTS
    : SCORING_BUDGET_MAX_POINTS * Math.min(1, Math.max(0, usd / Math.max(1, SCORING_BUDGET_SATURATION_USD)));
  return { amount, currency, usdAmount: usd, points };
}

function competitionForExplanation(stats) {
  if (stats.bid_count == null) return SCORING_COMPETITION_NEUTRAL_POINTS;
  const count = Math.max(0, Number(stats.bid_count));
  const low = Number(COMPETITION_LOW_MAX_BIDS), high = Number(COMPETITION_HIGH_MIN_BIDS);
  if (count <= low) return SCORING_COMPETITION_MAX_POINTS * (1 - SCORING_LOW_COMPETITION_REDUCTION_FRACTION * count / Math.max(1, low));
  if (count < high) return SCORING_COMPETITION_MAX_POINTS * SCORING_MEDIUM_COMPETITION_START_FRACTION * (high - count) / Math.max(1, high - low);
  return 0;
}

export function explainScoreRow(row) {
  if (!row || typeof row !== 'object') return { error: 'invalid row' };
  try {
    const parsed = splitLine(row.score_line);
    if (!parsed) return { rowid: row.rowid, title: row.title, error: 'missing or unrecognized score_line' };
    const built = buildStats(row, parsed);
    if (built.error) return { rowid: row.rowid, title: row.title, error: built.error };
    const job = { title: row.title || '', description: row.description || '', budget: row.budget || '' };
    const stats = built.stats;
    const titleMatches = KEYWORDS.reduce((sum, keyword) => sum + Number(lineKeywordMatch(job.title, keyword)), 0);
    const descriptionMatches = KEYWORDS.reduce((sum, keyword) => sum + Number(lineKeywordMatch(job.description, keyword)), 0);
    const titleRaw = titleMatches * SCORING_TITLE_KEYWORD_WEIGHT;
    const descriptionRaw = descriptionMatches * SCORING_DESCRIPTION_KEYWORD_WEIGHT;
    const keywordTitle = Math.min(SCORING_TITLE_KEYWORD_CAP, titleRaw);
    const keywordDescription = Math.min(SCORING_DESCRIPTION_KEYWORD_CAP, descriptionRaw);
    const budget = budgetForExplanation(job, stats);
    const competition = competitionForExplanation(stats);
    const age = stats.age_hours == null || Number.isNaN(Number(stats.age_hours)) ? null : Math.max(0, Number(stats.age_hours));
    const freshness = age == null
      ? SCORING_FRESHNESS_NEUTRAL_POINTS
      : SCORING_FRESHNESS_MAX_POINTS * Math.max(0, 1 - age / Math.max(1, SCORING_FRESHNESS_WINDOW_HOURS));
    const unrounded = keywordTitle + keywordDescription + budget.points + competition + freshness;
    const clamped = Math.min(10, Math.max(0, unrounded));
    const result = scoreJob(job, stats);
    return {
      rowid: row.rowid,
      title: String(row.title ?? '').slice(0, 60),
      inputs: {
        titleLength: [...job.title].length,
        descriptionLength: [...job.description].length,
        budget: job.budget,
        bid_count: stats.bid_count ?? null,
        bid_avg: stats.bid_avg ?? null,
        currency: stats.currency ?? null,
        age_hours_input: stats.age_hours ?? null,
        age_hours: age,
        statsUsed: stats,
      },
      components: {
        titleKeywordMatches: titleMatches,
        descriptionKeywordMatches: descriptionMatches,
        titleKeywordRawPoints: titleRaw,
        titleKeywordCap: SCORING_TITLE_KEYWORD_CAP,
        titleKeywordPoints: keywordTitle,
        descriptionKeywordRawPoints: descriptionRaw,
        descriptionKeywordCap: SCORING_DESCRIPTION_KEYWORD_CAP,
        descriptionKeywordPoints: keywordDescription,
        keywordPoints: keywordTitle + keywordDescription,
        techSkillPoints: 0,
        competitionPoints: competition,
        budget,
        freshnessPoints: freshness,
        unroundedTotal: unrounded,
        clampedTotal: clamped,
        rounding: { digits: 1, finalScore: result.score, roundingDelta: result.score - clamped },
      },
      stored: { score: row.score, line: row.score_line },
      js: result,
    };
  } catch {
    return { rowid: row.rowid, title: row.title, error: 'score explanation failed' };
  }
}

export function explainParityRow(dbPath, rowid) {
  let database;
  try {
    database = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
    const row = database.prepare('SELECT rowid, title, description, budget, score, score_line, tags FROM jobs WHERE rowid=?').get(Number(rowid));
    if (!row) return { error: `rowid ${rowid} not found` };
    return explainScoreRow({ ...row });
  } catch (error) {
    return { error: `database read failed (${error.code || error.name || 'error'})` };
  } finally {
    if (database) {
      try { database.close(); } catch { /* CLI still exits successfully if cleanup reports an error. */ }
    }
  }
}

export function printExplanation(explanation) {
  console.log(JSON.stringify(explanation, null, 2));
}

export function compareTagsRow(row) {
  if (!row || typeof row !== 'object') return { state: 'not-comparable', reason: 'invalid row' };
  if (row.tags == null || row.tags === '') return { state: 'not-applicable', reason: null };
  try {
    const stored = typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags;
    if (!Array.isArray(stored) || stored.some((tag) => typeof tag !== 'string')) {
      return { state: 'not-comparable', reason: 'invalid stored tags' };
    }
    const js = extractTags({ title: row.title, description: row.description });
    const left = [...new Set(stored)].sort();
    const right = [...new Set(js)].sort();
    return {
      state: JSON.stringify(left) === JSON.stringify(right) ? 'match' : 'mismatch',
      stored: left,
      js: right,
    };
  } catch {
    return { state: 'not-comparable', reason: 'invalid stored tags' };
  }
}

function emptyGroup() {
  return { rowsWithStoredValue: 0, compared: 0, matches: 0, mismatches: 0, notComparable: {}, mismatchRows: [] };
}
function addResult(group, row, result, kind) {
  if (result.state === 'not-applicable') return;
  group.rowsWithStoredValue++;
  if (result.state === 'not-comparable') {
    group.notComparable[result.reason] = (group.notComparable[result.reason] || 0) + 1;
    return;
  }
  group.compared++;
  if (result.state === 'match') group.matches++;
  else {
    group.mismatches++;
    group.mismatchRows.push({ kind, rowid: row.rowid, title: String(row.title ?? '').slice(0, 60), stored: result.stored, js: result.js });
  }
}

export function analyzeRows(rows) {
  const report = { totalRows: rows.length, score: emptyGroup(), tags: emptyGroup() };
  for (const row of rows) {
    addResult(report.score, row, compareScoreRow(row), 'score');
    addResult(report.tags, row, compareTagsRow(row), 'tags');
  }
  return report;
}

function printGroup(label, group) {
  console.log(`${label}: rows with stored value ${group.rowsWithStoredValue}, compared ${group.compared}, matches ${group.matches}, mismatches ${group.mismatches}, not comparable ${Object.values(group.notComparable).reduce((a, b) => a + b, 0)}`);
  for (const [reason, count] of Object.entries(group.notComparable)) console.log(`  not comparable — ${reason}: ${count}`);
}

export function printReport(report) {
  console.log(`Total rows: ${report.totalRows}`);
  printGroup('Score', report.score);
  printGroup('Tags', report.tags);
  const mismatches = [...report.score.mismatchRows, ...report.tags.mismatchRows].slice(0, 10);
  console.log(`First ${mismatches.length} mismatches:`);
  for (const item of mismatches) {
    console.log(`${item.kind} rowid=${item.rowid} title=${JSON.stringify(item.title)} stored=${JSON.stringify(item.stored)} js=${JSON.stringify(item.js)}`);
  }
}

export function runParityCheck(dbPath = DB_PATH) {
  let database;
  try {
    database = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
    const rows = database.prepare('SELECT rowid, title, description, budget, score, score_line, tags FROM jobs ORDER BY rowid').all().map((row) => ({ ...row }));
    const report = analyzeRows(rows);
    printReport(report);
    return report;
  } catch (error) {
    console.error(`Parity check could not read the database (${error.code || error.name || 'error'}).`);
    return null;
  } finally {
    if (database) {
      try { database.close(); } catch (error) {
        console.error(`Parity check could not close the database (${error.code || error.name || 'error'}).`);
      }
    }
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  if (process.argv[2] === '--explain') {
    if (!process.argv[3]) console.log(JSON.stringify({ error: 'usage: node scripts/parity_check.js --explain <rowid> [dbPath]' }));
    else printExplanation(explainParityRow(process.argv[4] || DB_PATH, process.argv[3]));
  } else runParityCheck(process.argv[2] || DB_PATH);
  process.exitCode = 0;
}
