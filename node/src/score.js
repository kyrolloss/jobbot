import {
  CURRENCY_TO_USD, CURRENCY_SYMBOL_TO_CODE,
  SCORING_BUDGET_MAX_POINTS, SCORING_BUDGET_NEUTRAL_POINTS, SCORING_BUDGET_SATURATION_USD,
  SCORING_COMPETITION_MAX_POINTS, SCORING_COMPETITION_NEUTRAL_POINTS,
  SCORING_DESCRIPTION_KEYWORD_CAP, SCORING_DESCRIPTION_KEYWORD_WEIGHT,
  SCORING_FRESHNESS_MAX_POINTS, SCORING_FRESHNESS_NEUTRAL_POINTS, SCORING_FRESHNESS_WINDOW_HOURS,
  SCORING_LABEL_FIRE_MIN, SCORING_LABEL_THUMBS_MIN,
  SCORING_LOW_COMPETITION_REDUCTION_FRACTION, SCORING_MEDIUM_COMPETITION_START_FRACTION,
  SCORING_TITLE_KEYWORD_CAP, SCORING_TITLE_KEYWORD_WEIGHT,
  COMPETITION_HIGH_MIN_BIDS, COMPETITION_LOW_MAX_BIDS, KEYWORDS,
} from './config.js';

const SHORT_WORD_KEYWORDS = new Set(['ai', 'api', 'node']);
const WORD = String.raw`[\p{L}\p{N}_]`;
const PYTHON_FLOAT = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)$/i;

function pythonFloat(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return Number(value);
  if (typeof value !== 'string' || !PYTHON_FLOAT.test(value.trim())) return NaN;
  return Number(value);
}
function isPythonFloat(value) {
  return typeof value === 'number' || typeof value === 'boolean'
    || (typeof value === 'string' && PYTHON_FLOAT.test(value.trim()));
}

function matches(text, keyword) {
  const folded = String(text ?? '').toLowerCase();
  const normalized = keyword.toLowerCase();
  if (SHORT_WORD_KEYWORDS.has(normalized)) return new RegExp(`(?<!${WORD})${normalized}(?!${WORD})`, 'iu').test(folded);
  return folded.includes(normalized);
}

function formatGeneral(value) {
  const number = pythonFloat(value);
  if (Number.isNaN(number)) return 'nan';
  if (number === Infinity) return 'inf';
  if (number === -Infinity) return '-inf';
  if (Object.is(number, -0)) return '-0';
  const absolute = Math.abs(number);
  let text;
  if (absolute !== 0 && (absolute < 1e-4 || absolute >= 1e6)) {
    const [rawMantissa, rawExponent] = number.toExponential(5).split('e');
    const mantissa = rawMantissa.replace(/(?:\.0+|(?<=\.[0-9]*?)0+)$/, '').replace(/\.$/, '');
    const exponent = Number(rawExponent);
    const sign = exponent >= 0 ? '+' : '-';
    text = `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, '0')}`;
  } else {
    const exponent = Math.floor(Math.log10(absolute || 1));
    const decimalPlaces = Math.max(0, 5 - exponent);
    text = number.toFixed(decimalPlaces).replace(/(?:\.0+|(?<=\.[0-9]*?)0+)$/, '').replace(/\.$/, '');
  }
  return text;
}
function amountText(value) {
  return isPythonFloat(value) ? formatGeneral(pythonFloat(value)) : '?';
}

// Python round(x, 1) uses ties-to-even; round the exact IEEE-754 value.
function roundOne(value) {
  if (!Number.isFinite(value)) return value;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = (bits >> 63n) !== 0n;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  let mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  const exponent = exponentBits === 0 ? -1022 - 52 : exponentBits - 1023 - 52;
  let numerator = mantissa * 10n;
  let rounded;
  if (exponent >= 0) rounded = numerator << BigInt(exponent);
  else {
    const denominator = 1n << BigInt(-exponent);
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    const twice = remainder * 2n;
    rounded = twice > denominator || (twice === denominator && quotient % 2n === 1n) ? quotient + 1n : quotient;
  }
  const result = Number(rounded) / 10;
  return negative ? -result : result;
}

function budgetValues(job, stats) {
  const minimum = stats.budget_min;
  const maximum = stats.budget_max;
  const currencyValue = stats.currency;
  if (minimum != null && maximum != null) {
    const min = pythonFloat(minimum), max = pythonFloat(maximum);
    if (isPythonFloat(minimum) && isPythonFloat(maximum)) {
      return [(min + max) / 2, currencyValue ? String(currencyValue).toUpperCase() : null];
    }
  }
  const budget = job.budget || '';
  const numbers = budget.match(/[0-9]+(?:[,.][0-9]+)*/g) || [];
  if (!numbers.length) return [null, null];
  const parsed = numbers.slice(0, 2).map((item) => Number(item.replaceAll(',', '')));
  const amount = parsed.reduce((sum, item) => sum + item, 0) / parsed.length;
  let currency = null;
  for (const code of Object.keys(CURRENCY_TO_USD)) {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<!${WORD})${escaped}(?!${WORD})`, 'iu').test(budget)) { currency = code; break; }
  }
  if (currency == null) {
    for (const [symbol, code] of Object.entries(CURRENCY_SYMBOL_TO_CODE)) {
      if (budget.includes(symbol)) { currency = code; break; }
    }
  }
  return [amount, currency];
}

function ageHours(stats) {
  const safeMaxZero = (value) => Number.isNaN(value) || value < 0 ? 0 : value;
  if (stats.age_hours != null) {
    const age = pythonFloat(stats.age_hours);
    return isPythonFloat(stats.age_hours) ? safeMaxZero(age) : null;
  }
  if (stats.time_submitted != null) {
    const submitted = pythonFloat(stats.time_submitted);
    if (!isPythonFloat(stats.time_submitted)) return null;
    return safeMaxZero((Date.now() / 1000 - submitted) / 3600);
  }
  return null;
}

function competitionPoints(bidCount) {
  const rawCount = pythonFloat(bidCount);
  const count = Number.isNaN(rawCount) ? 0 : Math.max(0, rawCount);
  const low = Number(COMPETITION_LOW_MAX_BIDS), high = Number(COMPETITION_HIGH_MIN_BIDS);
  if (count <= low) return SCORING_COMPETITION_MAX_POINTS * (1 - SCORING_LOW_COMPETITION_REDUCTION_FRACTION * count / Math.max(1, low));
  if (count < high) {
    const start = SCORING_COMPETITION_MAX_POINTS * SCORING_MEDIUM_COMPETITION_START_FRACTION;
    return start * (high - count) / Math.max(1, high - low);
  }
  return 0;
}

export function labelForScore(score) {
  if (score >= SCORING_LABEL_FIRE_MIN) return '🔥';
  if (score >= SCORING_LABEL_THUMBS_MIN) return '👍';
  return '😐';
}

export function scoreJob(job, stats = null) {
  stats = stats || {};
  const title = job.title || '', description = job.description || '';
  const titleMatches = KEYWORDS.reduce((count, keyword) => count + Number(matches(title, keyword)), 0);
  const descriptionMatches = KEYWORDS.reduce((count, keyword) => count + Number(matches(description, keyword)), 0);
  const titlePoints = Math.min(SCORING_TITLE_KEYWORD_CAP, titleMatches * SCORING_TITLE_KEYWORD_WEIGHT);
  const descriptionPoints = Math.min(SCORING_DESCRIPTION_KEYWORD_CAP, descriptionMatches * SCORING_DESCRIPTION_KEYWORD_WEIGHT);
  const [amount, currency] = budgetValues(job, stats);
  let usdAmount = null;
  let budgetPoints;
  if (amount != null && Object.hasOwn(CURRENCY_TO_USD, currency)) {
    usdAmount = amount * CURRENCY_TO_USD[currency];
    const ratio = usdAmount / Math.max(1, SCORING_BUDGET_SATURATION_USD);
    budgetPoints = SCORING_BUDGET_MAX_POINTS * Math.min(1, Math.max(0, Number.isNaN(ratio) ? 0 : ratio));
  } else budgetPoints = SCORING_BUDGET_NEUTRAL_POINTS;
  const bidCount = stats.bid_count;
  let competition = SCORING_COMPETITION_NEUTRAL_POINTS;
  if (bidCount != null) {
    const count = pythonFloat(bidCount);
    if (isPythonFloat(bidCount)) competition = competitionPoints(count);
  }
  const age = ageHours(stats);
  const freshness = age == null ? SCORING_FRESHNESS_NEUTRAL_POINTS : SCORING_FRESHNESS_MAX_POINTS * Math.max(0, 1 - age / Math.max(1, SCORING_FRESHNESS_WINDOW_HOURS));
  const score = roundOne(Math.min(10, Math.max(0, titlePoints + descriptionPoints + budgetPoints + competition + freshness)));

  const bidText = bidCount != null ? String(bidCount) : 'غير متاح';
  const budgetText = usdAmount != null ? `ميزانية≈${formatGeneral(usdAmount)} USD` : 'ميزانية غير معروفة';
  let averageText;
  if (stats.bid_avg != null) {
    let average = amountText(stats.bid_avg);
    if (stats.currency) average += ` ${stats.currency}`;
    averageText = `متوسط ${average}`;
  } else averageText = 'متوسط غير متاح';
  const ageText = age != null ? `عمر ${formatGeneral(age)}س` : 'العمر غير متاح';
  let line;
  if (Object.keys(stats).length === 0) line = '📋 الأرقام مش متاحة، افتح الرابط وشوف العروض والميزانية';
  else {
    const metricsAvailable = ['budget_min','budget_max','currency','bid_count','bid_avg','age_hours','time_submitted'].some((key) => stats[key] != null) || Boolean(job.budget);
    if (metricsAvailable) line = `كلمات عنوان ${titleMatches}/وصف ${descriptionMatches} | ${budgetText} | عروض ${bidText} | ${averageText} | ${ageText}`;
    else line = `كلمات عنوان ${titleMatches}/وصف ${descriptionMatches} | 📋 الأرقام مش متاحة، افتح الرابط وشوف العروض والميزانية`;
  }
  return { score, label: labelForScore(score), line };
}

