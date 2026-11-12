import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "").strip()
REPORT_API_KEY = os.getenv("REPORT_API_KEY", "").strip()
REPORT_PORT = 8765
PROTOTYPE_MAX_KB = 200
PROTOTYPE_DIR = "prototypes"
PROTOTYPE_GEMINI_ATTEMPTS = 2

KEYWORDS = ["flutter", "dart", "فلاتر", "mobile app", "تطبيق موبايل", "تطبيق جوال", "react", "next.js", "node", "python", "fastapi", "django", "backend", "باك إند", "api", "موقع", "تطوير ويب", "web app", "firebase", "supabase", "ai", "ذكاء اصطناعي", "chatbot", "شات بوت", "llm", "automation", "أتمتة", "scraping"]
NEGATIVE_KEYWORDS = ["wordpress", "ووردبريس", "لوجو", "logo", "seo", "سيو", "shopify", "شوبيفاي", "سلة", "تصميم جرافيك", "ترجمة", "كتابة محتوى"]
FREELANCER_QUERIES = ["flutter", "mobile app", "python", "api backend", "website", "ai chatbot"]
KHAMSAT_BASE_URL = "https://khamsat.com"
KHAMSAT_REQUESTS_URL = "https://khamsat.com/community/requests"
KHAMSAT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36"
KHAMSAT_TIMEOUT_SECONDS = 30
KHAMSAT_REQUEST_GAP_SECONDS = 2.0
COMPETITION_LOW_MAX_BIDS = 10
COMPETITION_HIGH_MIN_BIDS = 41
CURRENCY_TO_USD = {
    "USD": 1.0,
    "EUR": 1.08,
    "GBP": 1.27,
    "EGP": 0.02,
    "SAR": 0.2667,
    "AED": 0.2723,
    "INR": 0.012,
    # Approximate USD conversions; the owner can edit these rates.
    "AUD": 0.65,
    "CAD": 0.72,
    "NZD": 0.59,
}
_STRONG_PRICE_CURRENCIES = frozenset(("USD", "EUR", "GBP", "AUD", "CAD", "NZD", "SAR", "AED"))
PRICE_GROUPS = {
    "A": _STRONG_PRICE_CURRENCIES,
    "B": frozenset(CURRENCY_TO_USD) - _STRONG_PRICE_CURRENCIES,
}
CURRENCY_SYMBOL_TO_CODE = {"$": "USD", "€": "EUR", "£": "GBP", "₹": "INR"}
TECH_TAGS = {
    "flutter": ["flutter", "فلاتر"],
    "dart": ["dart"],
    "firebase": ["firebase"],
    "supabase": ["supabase"],
    "python": ["python", "بايثون"],
    "fastapi": ["fastapi"],
    "django": ["django"],
    "flask": ["flask"],
    "node": ["node", "node.js"],
    "react": ["react", "ريأكت"],
    "nextjs": ["next.js", "nextjs", "next js"],
    "wordpress": ["wordpress", "ووردبريس"],
    "shopify": ["shopify", "شوبيفاي"],
    "ai-chatbot": ["ai", "ai chatbot", "chatbot", "شات بوت", "بوت", "ذكاء اصطناعي"],
    "llm": ["openai", "gemini", "gpt", "llm"],
    "whatsapp-bot": ["whatsapp bot", "واتساب بوت", "بوت واتساب"],
    "scraping": ["scraping", "web scraping", "استخراج البيانات", "كشط البيانات"],
    "automation": ["n8n", "zapier", "make.com", "automation", "أتمتة", "اوتوميشن"],
    "laravel/php": ["laravel", "php"],
    "ios": ["ios", "آي أو إس"],
    "android": ["android", "أندرويد"],
    "ui-ux": ["ui/ux", "ui ux", "ui", "ux", "تصميم واجهات", "تجربة المستخدم"],
    "api": ["api", "apis", "واجهة برمجة التطبيقات"],
    "mobile-app": ["mobile app", "تطبيق موبايل", "تطبيق جوال", "تطبيق هاتف"],
}
SCORING_TITLE_KEYWORD_WEIGHT = 1.0
SCORING_DESCRIPTION_KEYWORD_WEIGHT = 0.5
SCORING_TITLE_KEYWORD_CAP = 3.0
SCORING_DESCRIPTION_KEYWORD_CAP = 2.0
SCORING_BUDGET_MAX_POINTS = 2.0
SCORING_BUDGET_NEUTRAL_POINTS = 1.0
SCORING_BUDGET_SATURATION_USD = 1000.0
SCORING_COMPETITION_MAX_POINTS = 2.0
SCORING_COMPETITION_NEUTRAL_POINTS = 1.0
SCORING_LOW_COMPETITION_REDUCTION_FRACTION = 0.25
SCORING_MEDIUM_COMPETITION_START_FRACTION = 0.75
SCORING_FRESHNESS_MAX_POINTS = 1.0
SCORING_FRESHNESS_NEUTRAL_POINTS = 0.5
SCORING_FRESHNESS_WINDOW_HOURS = 168.0
SCORING_LABEL_FIRE_MIN = 7.5
SCORING_LABEL_THUMBS_MIN = 4.5
SCORING_STATS_MAX_PER_SCAN = 40
SCORING_STATS_MIN_INTERVAL_SECONDS = 1.0
INTERVAL_MINUTES = 60
RADAR_ENABLED = False
RADAR_INTERVAL_SECONDS = 120
RADAR_MAX_BIDS = 3
RADAR_MIN_SCORE = 6
RADAR_MAX_AGE_MINUTES = 30
RADAR_MAX_ALERTS_PER_HOUR = 6
RADAR_QUERIES_PER_CYCLE = 2
RADAR_QUIET_HOURS = ""
RADAR_AUTO_PROPOSAL = True
MIN_PRICE_SAMPLES = 3
PRICE_REPORT_DEFAULT_DAYS = 30
# Scores rarely reach 7 in practice (max seen 6.9; about 3% of scored jobs are >= 6).
HIGH_SCORE_THRESHOLD = 6
TIMING_REPORT_DEFAULT_DAYS = 30
TIMING_REPORT_MIN_DAYS = 1
TIMING_REPORT_MAX_DAYS = 365
TIMING_MIN_JOB_COUNT = 10
TIMING_HIGH_SCORE_MIN_FOR_CHART = 5
TIMING_TOP_N = 3
TIMING_BAR_MAX_WIDTH = 10
TIMING_FAST_APPLY_MINUTES = 30
TIMING_GOOD_APPLY_MINUTES = 180
HOURLY_RATE_USD = 15
MIN_ACCEPTABLE_MULTIPLIER = 0.8
ESTIMATE_BUFFER = 1.25
MARKET_LOW_RATIO = 0.7
MARKET_HIGH_RATIO = 1.3
LOW_BUDGET_RATIO = 0.5
