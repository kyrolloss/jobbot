import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve explicitly to this Node port's .env; never load the Python parent's file.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const secret = (name) => (process.env[name] ?? '').trim();
const positiveSetting = (raw, fallback) => {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const GEMINI_API_KEY = secret('GEMINI_API_KEY');
export const GEMINI_MODEL = secret('GEMINI_MODEL');
export const GEMINI_MIN_GAP_MS = positiveSetting(process.env.GEMINI_MIN_GAP_MS, 5000);
export const GEMINI_TIMEOUT_MS = positiveSetting(process.env.GEMINI_TIMEOUT_MS, 60000);
export const GEMINI_MAX_OUTPUT_TOKENS = Number.isInteger(Number(process.env.GEMINI_MAX_OUTPUT_TOKENS)) ? Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) : 8192;
export const DB_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', process.env.NODE_DB_PATH || 'jobs_node.db');
export const API_HOST = process.env.API_HOST?.trim() || '127.0.0.1';
export const API_PORT = Number.parseInt(process.env.PORT || process.env.API_PORT || '8787', 10);
export const API_KEY = secret('API_KEY');
export const CORS_ORIGINS = Object.freeze((process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean));
export const EVENTS_BUFFER_SIZE = positiveSetting(process.env.EVENTS_BUFFER_SIZE, 500);
export const EVENTS_KEEPALIVE_SECONDS = positiveSetting(process.env.EVENTS_KEEPALIVE_SECONDS, 25);
export const EVENTS_MAX_CLIENTS = positiveSetting(process.env.EVENTS_MAX_CLIENTS, 20);
export const EVENTS_MAX_BUFFER_BYTES = positiveSetting(process.env.EVENTS_MAX_BUFFER_BYTES, 1_048_576);
const boolSetting = (raw) => String(raw ?? '').toLowerCase() === 'true';
export const SAAS_ENABLED = boolSetting(process.env.SAAS_ENABLED);
export const AI_RATE_LIMIT_PER_MINUTE = positiveSetting(process.env.AI_RATE_LIMIT_PER_MINUTE, 5);
export const FEATURE_COSTS = Object.freeze({ estimate: 1, evaluate: 1, proposal: 2, prototype: 8, ...(process.env.FEATURE_COSTS ? JSON.parse(process.env.FEATURE_COSTS) : {}) });
export const PLAN_SEEDS = Object.freeze(process.env.SAAS_PLAN_SEEDS ? JSON.parse(process.env.SAAS_PLAN_SEEDS) : { free: { monthly_points: 15, daily_points_cap: 10 }, pro: { monthly_points: 150, daily_points_cap: 40 }, power: { monthly_points: 600, daily_points_cap: 120 } });
export const GEMINI_PRICE_PER_MTOK_INPUT = Number(process.env.GEMINI_PRICE_PER_MTOK_INPUT || 0);
export const GEMINI_PRICE_PER_MTOK_OUTPUT = Number(process.env.GEMINI_PRICE_PER_MTOK_OUTPUT || 0);
export const SOURCE_POLICY = Object.freeze({ freelancer: { saas: true }, mostaql: { saas: false }, khamsat: { saas: false } });

export const REPORT_PORT = 8765;
export const PROTOTYPE_MAX_KB = 200;
export const PROTOTYPE_DIR = 'prototypes';
export const PROTOTYPE_GEMINI_ATTEMPTS = 2;
export const KEYWORDS = ['flutter', 'dart', 'فلاتر', 'mobile app', 'تطبيق موبايل', 'تطبيق جوال', 'react', 'next.js', 'node', 'python', 'fastapi', 'django', 'backend', 'باك إند', 'api', 'موقع', 'تطوير ويب', 'web app', 'firebase', 'supabase', 'ai', 'ذكاء اصطناعي', 'chatbot', 'شات بوت', 'llm', 'automation', 'أتمتة', 'scraping'];
export const NEGATIVE_KEYWORDS = ['wordpress', 'ووردبريس', 'لوجو', 'logo', 'seo', 'سيو', 'shopify', 'شوبيفاي', 'سلة', 'تصميم جرافيك', 'ترجمة', 'كتابة محتوى'];
export const FREELANCER_QUERIES = ['flutter', 'mobile app', 'python', 'api backend', 'website', 'ai chatbot'];
export const KHAMSAT_BASE_URL = 'https://khamsat.com';
export const KHAMSAT_REQUESTS_URL = 'https://khamsat.com/community/requests';
export const KHAMSAT_USER_AGENT = 'Jobbot/1.0 (automated public job listing monitor; owner-operated)';
export const KHAMSAT_TIMEOUT_SECONDS = 30;
export const KHAMSAT_REQUEST_GAP_SECONDS = 2.0;
export const COMPETITION_LOW_MAX_BIDS = 10;
export const COMPETITION_HIGH_MIN_BIDS = 41;
export const CURRENCY_TO_USD = Object.freeze({ USD: 1.0, EUR: 1.08, GBP: 1.27, EGP: 0.02, SAR: 0.2667, AED: 0.2723, INR: 0.012, AUD: 0.65, CAD: 0.72, NZD: 0.59 });
const STRONG_PRICE_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'NZD', 'SAR', 'AED']);
export const PRICE_GROUPS = Object.freeze({
  A: STRONG_PRICE_CURRENCIES,
  B: new Set(Object.keys(CURRENCY_TO_USD).filter((currency) => !STRONG_PRICE_CURRENCIES.has(currency))),
});
export const CURRENCY_SYMBOL_TO_CODE = Object.freeze({ '$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR' });
export const TECH_TAGS = Object.freeze({
  flutter: ['flutter', 'فلاتر'], dart: ['dart'], firebase: ['firebase'], supabase: ['supabase'],
  python: ['python', 'بايثون'], fastapi: ['fastapi'], django: ['django'], flask: ['flask'],
  node: ['node', 'node.js'], react: ['react', 'ريأكت'], nextjs: ['next.js', 'nextjs', 'next js'],
  wordpress: ['wordpress', 'ووردبريس'], shopify: ['shopify', 'شوبيفاي'],
  'ai-chatbot': ['ai', 'ai chatbot', 'chatbot', 'شات بوت', 'بوت', 'ذكاء اصطناعي'],
  llm: ['openai', 'gemini', 'gpt', 'llm'], 'whatsapp-bot': ['whatsapp bot', 'واتساب بوت', 'بوت واتساب'],
  scraping: ['scraping', 'web scraping', 'استخراج البيانات', 'كشط البيانات'],
  automation: ['n8n', 'zapier', 'make.com', 'automation', 'أتمتة', 'اوتوميشن'],
  'laravel/php': ['laravel', 'php'], ios: ['ios', 'آي أو إس'], android: ['android', 'أندرويد'],
  'ui-ux': ['ui/ux', 'ui ux', 'ui', 'ux', 'تصميم واجهات', 'تجربة المستخدم'],
  api: ['api', 'apis', 'واجهة برمجة التطبيقات'],
  'mobile-app': ['mobile app', 'تطبيق موبايل', 'تطبيق جوال', 'تطبيق هاتف'],
});
export const SCORING_TITLE_KEYWORD_WEIGHT = 1.0;
export const SCORING_DESCRIPTION_KEYWORD_WEIGHT = 0.5;
export const SCORING_TITLE_KEYWORD_CAP = 3.0;
export const SCORING_DESCRIPTION_KEYWORD_CAP = 2.0;
export const SCORING_BUDGET_MAX_POINTS = 2.0;
export const SCORING_BUDGET_NEUTRAL_POINTS = 1.0;
export const SCORING_BUDGET_SATURATION_USD = 1000.0;
export const SCORING_COMPETITION_MAX_POINTS = 2.0;
export const SCORING_COMPETITION_NEUTRAL_POINTS = 1.0;
export const SCORING_LOW_COMPETITION_REDUCTION_FRACTION = 0.25;
export const SCORING_MEDIUM_COMPETITION_START_FRACTION = 0.75;
export const SCORING_FRESHNESS_MAX_POINTS = 1.0;
export const SCORING_FRESHNESS_NEUTRAL_POINTS = 0.5;
export const SCORING_FRESHNESS_WINDOW_HOURS = 168.0;
export const SCORING_LABEL_FIRE_MIN = 7.5;
export const SCORING_LABEL_THUMBS_MIN = 4.5;
export const SCORING_STATS_MAX_PER_SCAN = 40;
export const SCORING_STATS_MIN_INTERVAL_SECONDS = 1.0;
export const INTERVAL_MINUTES = 60;
export const SCAN_MIN_INTERVAL_MINUTES = 5;
export const SCAN_MAX_INTERVAL_MINUTES = 1440;
export const RADAR_ENABLED = false;
export const RADAR_INTERVAL_SECONDS = 120;
export const RADAR_MAX_BIDS = 3;
export const RADAR_MIN_SCORE = 6;
export const RADAR_MAX_AGE_MINUTES = 30;
export const RADAR_MAX_ALERTS_PER_HOUR = 6;
export const RADAR_QUERIES_PER_CYCLE = 2;
export const RADAR_QUIET_HOURS = '';
export const RADAR_AUTO_PROPOSAL = true;
export const MIN_PRICE_SAMPLES = 3;
export const PRICE_REPORT_DEFAULT_DAYS = 30;
export const HIGH_SCORE_THRESHOLD = 6;
export const TIMING_REPORT_DEFAULT_DAYS = 30;
export const TIMING_REPORT_MIN_DAYS = 1;
export const TIMING_REPORT_MAX_DAYS = 365;
export const TIMING_MIN_JOB_COUNT = 10;
export const TIMING_HIGH_SCORE_MIN_FOR_CHART = 5;
export const TIMING_TOP_N = 3;
export const TIMING_BAR_MAX_WIDTH = 10;
export const TIMING_FAST_APPLY_MINUTES = 30;
export const TIMING_GOOD_APPLY_MINUTES = 180;
export const MIN_ACCEPTABLE_MULTIPLIER = 0.8;
export const ESTIMATE_BUFFER = 1.25;
export const MARKET_LOW_RATIO = 0.7;
export const MARKET_HIGH_RATIO = 1.3;
export const LOW_BUDGET_RATIO = 0.5;

export function validateConfig() {
  const missing = [];
  if ((process.env.API_KEY || '').trim().length < 24) missing.push('API_KEY');
  return missing;
}
