import re
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

from config import PROTOTYPE_DIR, PROTOTYPE_MAX_KB
from prototype_kit import ALLOWED_CLASSES, THEMES, build_page, normalize_theme


_ARABIC = re.compile(r"[\u0600-\u06ff]")
_HTML_START = re.compile(r"<!doctype\b|<html\b", re.IGNORECASE)
_HTML_END = re.compile(r"</html\s*>", re.IGNORECASE)
_ATTR_URL = re.compile(
    r"\b(?:src|href)\s*=\s*(?:(['\"])(.*?)\1|([^\s>]+))",
    re.IGNORECASE | re.DOTALL,
)
_EXTERNAL_URL = re.compile(r"^(?:[a-z][a-z0-9+.-]*:)?//|^[a-z][a-z0-9+.-]*://|^www\.", re.IGNORECASE)
_SCRIPT_SRC = re.compile(r"<script\b[^>]*\bsrc\s*=", re.IGNORECASE | re.DOTALL)
_CSS_IMPORT = re.compile(r"@import\b", re.IGNORECASE)
_CSS_URL = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.IGNORECASE | re.DOTALL)
_SIGNOFF = re.compile(
    r"^(?:best(?:\s+regards)?|kind\s+regards|regards|sincerely|thanks|thank\s+you|cheers|"
    r"مع\s+خالص\s+التحية|مع\s+أطيب\s+التحيات|تحياتي(?:\s+لك)?|شكراً|شكرا|في\s+انتظار\s+ردك)(?:\b|\s|[،,:.!]|$)",
    re.IGNORECASE,
)


def detect_language(text) -> str:
    return "ar" if _ARABIC.search(str(text or "")) else "en"


def clean_html(text: str) -> str:
    """Remove surrounding fences/prose, then validate a self-contained HTML page."""
    if not isinstance(text, str):
        raise ValueError("Gemini ما رجعش نص HTML.")
    cleaned = text.strip()
    cleaned = re.sub(r"^\s*```(?:html)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```\s*$", "", cleaned)
    start = _HTML_START.search(cleaned)
    if not start:
        raise ValueError("النموذج اللي رجع مفيهوش صفحة HTML واضحة.")
    cleaned = cleaned[start.start():]
    end_matches = list(_HTML_END.finditer(cleaned))
    if not re.search(r"<html\b", cleaned, re.IGNORECASE) or not end_matches:
        raise ValueError("صفحة HTML ناقصة وسم البداية أو النهاية.")
    cleaned = cleaned[:end_matches[0].end()].strip()

    if _SCRIPT_SRC.search(cleaned):
        raise ValueError("النموذج فيه سكريبت خارجي، فرفضت أحفظه.")
    if _CSS_IMPORT.search(cleaned):
        raise ValueError("النموذج بيستورد CSS خارجي، فرفضت أحفظه.")
    for match in _ATTR_URL.finditer(cleaned):
        value = (match.group(2) if match.group(1) else match.group(3) or "").strip()
        if _EXTERNAL_URL.match(value):
            raise ValueError("النموذج فيه رابط أصل خارجي، فرفضت أحفظه.")
    for match in _CSS_URL.finditer(cleaned):
        if _EXTERNAL_URL.match(match.group(2).strip()):
            raise ValueError("النموذج فيه رابط CSS خارجي، فرفضت أحفظه.")

    max_bytes = max(1, int(PROTOTYPE_MAX_KB)) * 1024
    if len(cleaned.encode("utf-8")) > max_bytes:
        raise ValueError(f"حجم النموذج أكبر من الحد المسموح ({PROTOTYPE_MAX_KB} كيلوبايت).")
    return cleaned


_THEME_LINE = re.compile(r"^\s*THEME\s*:\s*([a-z-]+)\s*$", re.IGNORECASE)
_FORBIDDEN_TAG = re.compile(r"</?\s*(?:script|style|iframe|link)\b", re.IGNORECASE)
_EVENT_ATTR = re.compile(r"\s+on[a-z0-9_-]+\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)", re.IGNORECASE)
_CLASS_ATTR = re.compile(r"\bclass\s*=\s*([\"'])(.*?)\1", re.IGNORECASE | re.DOTALL)
_VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


class _FragmentChecker(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.error = None

    def handle_starttag(self, tag, attrs):
        if tag in {"html", "head", "body"}:
            self.error = "الرد لازم يكون محتوى الصفحة فقط."
        for attr, _value in attrs:
            if attr and attr.lower().startswith("on"):
                self.error = "الرد فيه معالج حدث غير مسموح."
            if attr and attr.lower() == "style":
                self.error = "استخدم مكونات التصميم الجاهزة بدل التنسيق المباشر."
        if tag not in _VOID_TAGS:
            class_names = dict(attrs).get("class", "").split()
            self.stack.append({"tag": tag, "stat": "stat" in class_names, "sample": False})

    def handle_endtag(self, tag):
        if tag in _VOID_TAGS:
            return
        if not self.stack or self.stack[-1]["tag"] != tag:
            self.error = "فيه وسوم HTML مش متقفلة بالترتيب الصحيح."
            return
        frame = self.stack.pop()
        if frame["stat"] and not frame["sample"]:
            self.error = 'كل قيمة إحصائية لازم يكون جنبها وسم "Sample data".'

    def handle_data(self, data):
        if "sample data" in data.casefold():
            for frame in self.stack:
                if frame["stat"]:
                    frame["sample"] = True


def _strip_unknown_classes(fragment: str) -> str:
    def replace(match):
        quote, value = match.groups()
        kept = [name for name in value.split() if name in ALLOWED_CLASSES]
        return f"class={quote}{' '.join(kept)}{quote}" if kept else ""
    return _CLASS_ATTR.sub(replace, fragment)


def fallback_theme_for_job(job) -> str:
    try:
        from tech import extract_tags
        tags = set(extract_tags(job))
    except Exception:
        tags = set()
    text = f"{getattr(job, 'title', '')} {getattr(job, 'description', '')}".casefold()
    if tags.intersection({"shopify", "wordpress"}) or any(word in text for word in ("shop", "store", "متجر", "تجارة")):
        return "clean-light"
    if any(word in text for word in ("clinic", "health", "medical", "عيادة", "صحة", "طبي")):
        return "fresh-green"
    if any(word in text for word in ("luxury", "premium", "jewelry", "فخم", "مجوهرات")):
        return "midnight-gold"
    if any(word in text for word in ("food", "cafe", "restaurant", "مطعم", "طعام")):
        return "sunset"
    if any(word in text for word in ("dashboard", "admin", "analytics", "لوحة تحكم", "تحليلات")):
        return "mono-pro"
    return "aurora"


def validate_generated(text: str, job=None) -> tuple[str, str]:
    """Return sanitized theme and body markup; reject unsafe or incomplete output."""
    if not isinstance(text, str):
        raise ValueError("النموذج ما رجعش نص.")
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:html)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    lines = cleaned.splitlines()
    first = lines[0].strip() if lines else ""
    match = _THEME_LINE.fullmatch(first)
    fallback = fallback_theme_for_job(job) if job is not None else "aurora"
    theme = normalize_theme(match.group(1).lower() if match else None, fallback)
    body = "\n".join(lines[1:]) if match else cleaned
    if re.search(r"\bTHEME\s*:", body, re.IGNORECASE):
        raise ValueError("سطر الثيم لازم يكون أول سطر مرة واحدة.")
    if _FORBIDDEN_TAG.search(body) or re.search(r"\bjavascript\s*:", body, re.IGNORECASE):
        raise ValueError("النموذج فيه عنصر أو رابط برمجي غير مسموح.")
    if re.search(r"https?\s*:\s*/\s*/|@import\b|url\s*\(", body, re.IGNORECASE):
        raise ValueError("النموذج فيه رابط خارجي غير مسموح.")
    if _EVENT_ATTR.search(body):
        raise ValueError("النموذج فيه معالج حدث غير مسموح.")
    body = _strip_unknown_classes(body)
    checker = _FragmentChecker()
    try:
        checker.feed(body)
        checker.close()
    except Exception as exc:
        raise ValueError("HTML الناتج غير مكتمل.") from exc
    if checker.error:
        raise ValueError(checker.error)
    if checker.stack:
        raise ValueError("HTML الناتج غير مكتمل.")
    if not body.strip():
        raise ValueError("المحتوى الناتج فاضي.")
    if not re.search(r"<[a-z][^>]*>", body, re.IGNORECASE):
        raise ValueError("الرد مفيهوش HTML مكتمل.")
    maximum_bytes = min(200, max(1, int(PROTOTYPE_MAX_KB))) * 1024
    if len(body.encode("utf-8")) > maximum_bytes:
        raise ValueError("حجم النموذج أكبر من الحد المسموح.")
    return theme, body


sanitize_generated = validate_generated


def _fallback_body(job, language: str) -> str:
    title = escape(" ".join(str(getattr(job, "title", "مشروعك") or "مشروعك").split())[:150])
    if language == "ar":
        return f'''<header class="nav"><strong>{title}</strong><span class="badge">تصميم مبدئي</span></header>
<main><section class="hero"><span class="badge">فكرة واضحة. تجربة أسهل.</span><h1>خلّي <strong>الخطوة الجاية</strong> أبسط</h1><p>واجهة مبدئية تركّز على احتياج مشروعك وتحوّل الفكرة لتجربة مفهومة وسهلة الاستخدام.</p><a class="btn" href="#start">ابدأ الاستكشاف</a><a class="btn btn-ghost" href="#details">اعرف التفاصيل</a></section>
<section class="section" id="details"><h2 class="section-title">تجربة متصممة حول احتياجك</h2><div class="grid-3"><article class="card"><span class="icon-badge">01</span><h3>بداية واضحة</h3><p>المعلومة المهمة تظهر في مكانها وبأسلوب بسيط.</p></article><article class="card"><span class="icon-badge">02</span><h3>خطوات أسهل</h3><p>مسار مرتب يساعد المستخدم يعرف يعمل إيه بعد كده.</p></article><article class="card"><span class="icon-badge">03</span><h3>شكل متناسق</h3><p>تفاصيل بصرية هادئة تحافظ على تركيز المستخدم.</p></article></div></section>
<section class="section"><h2 class="section-title">رحلة بسيطة من البداية للنهاية</h2><div class="steps"><article>استكشف الخيارات المتاحة</article><article>اختار اللي يناسب احتياجك</article><article>كمّل الخطوة التالية بسهولة</article></div></section>
<section class="section"><div class="stat-row"><div class="stat"><strong>واجهة مرتبة</strong><br><span class="sample">Sample data</span></div><div class="stat"><strong>تجربة مرنة</strong><br><span class="sample">Sample data</span></div><div class="stat"><strong>تفاصيل واضحة</strong><br><span class="sample">Sample data</span></div></div></section>
<section class="cta" id="start"><h2>جاهز تبدأ؟</h2><p>خلّي أول خطوة بسيطة وواضحة.</p><a class="btn" href="#details">اكتشف التجربة</a></section></main>'''
    return f'''<header class="nav"><strong>{title}</strong><span class="badge">Concept preview</span></header>
<main><section class="hero"><span class="badge">A clearer way forward</span><h1>Make the next step <strong>feel effortless</strong></h1><p>A thoughtful starting point for your project, shaped around clear choices and a calm, useful experience.</p><a class="btn" href="#start">Explore the concept</a><a class="btn btn-ghost" href="#details">See how it works</a></section>
<section class="section" id="details"><h2 class="section-title">Designed around what matters</h2><div class="grid-3"><article class="card"><span class="icon-badge">01</span><h3>A clear start</h3><p>Bring the most useful information into focus.</p></article><article class="card"><span class="icon-badge">02</span><h3>Smoother steps</h3><p>Guide people through a natural, simple journey.</p></article><article class="card"><span class="icon-badge">03</span><h3>Thoughtful details</h3><p>Keep every screen calm, consistent, and easy to use.</p></article></div></section>
<section class="section"><h2 class="section-title">A simple journey</h2><div class="steps"><article>Explore the available options</article><article>Choose what fits your needs</article><article>Move forward with confidence</article></div></section>
<section class="section"><div class="stat-row"><div class="stat"><strong>Clear layout</strong><br><span class="sample">Sample data</span></div><div class="stat"><strong>Flexible flow</strong><br><span class="sample">Sample data</span></div><div class="stat"><strong>Useful details</strong><br><span class="sample">Sample data</span></div></div></section>
<section class="cta" id="start"><h2>Ready to get started?</h2><p>Make the first step simple and clear.</p><a class="btn" href="#details">Explore the experience</a></section></main>'''


def _prompt_for(job, language_instruction: str) -> str:
    try:
        from tech import extract_tags
        tags = ", ".join(extract_tags(job))
    except Exception:
        tags = ""
    return f'''Create body HTML markup only for a polished, responsive prototype. Your first line must be exactly THEME: <name>, choosing one of: {", ".join(THEMES)}. Then output only the body fragment; no html/head/body wrappers, no style or script tags.
Use only these CSS classes: {", ".join(sorted(ALLOWED_CLASSES))}. Do not use inline styles or external URLs, images, fonts, CDNs, or assets. Inline SVG is allowed.
Choose an appropriate page type for the request (marketing, dashboard, mobile app mockup in .phone, catalog, booking/clinic, portfolio, or other suitable structure). Include 5-7 composed sections, a strong headline, benefit-led copy, realistic interface details, and a clear CTA. Use {language_instruction}
Honesty: never invent testimonials, customer names, client logos, awards, review counts, user counts, or factual statistics. Any illustrative metric must be clearly labelled “Sample data”. Do not claim the product exists. Do not use real brand names/trademarks belonging to the client or fake contact details. Keep content generic where facts are unknown.

Job title: {getattr(job, 'title', '')}
Job description: {getattr(job, 'description', '')}
Technology tags: {tags}'''


def prototype_path_for(job, prototype_dir=None) -> Path:
    folder = Path(prototype_dir if prototype_dir is not None else PROTOTYPE_DIR)
    if not folder.is_absolute():
        folder = Path(__file__).resolve().parent / folder
    source = re.sub(r"[^A-Za-z0-9_-]", "_", str(getattr(job, "source", "") or "")) or "source"
    external_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(getattr(job, "external_id", "") or "")) or "job"
    return folder / f"{source}_{external_id}.html"


def make_prototype(job) -> dict:
    result = {"ok": False, "path": "", "html": "", "error": "", "fallback": False}
    try:
        from proposal import generate_gemini_text
        from config import PROTOTYPE_GEMINI_ATTEMPTS

        title = str(getattr(job, "title", "") or "").strip()
        description = str(getattr(job, "description", "") or "").strip()
        language = detect_language(f"{title}\n{description}")
        language_instruction = "Write all interface copy in Egyptian Arabic and support RTL." if language == "ar" else "Write all interface copy in English and support LTR."
        prompt = _prompt_for(job, language_instruction)
        theme = fallback_theme_for_job(job)
        body = ""
        last_error = "Gemini ما رجعش محتوى صالح."
        attempts = max(1, min(2, int(PROTOTYPE_GEMINI_ATTEMPTS)))
        for _attempt in range(attempts):
            try:
                generated = generate_gemini_text(prompt, failure_label="Prototype generation failed")
                if not generated:
                    last_error = "Gemini ما رجعش محتوى."
                    continue
                theme, body = validate_generated(generated, job)
                break
            except Exception as exc:
                last_error = str(exc)[:180] or type(exc).__name__
        fallback_used = not bool(body)
        if fallback_used:
            theme = fallback_theme_for_job(job)
            body = _fallback_body(job, language)
        html = build_page(theme, body, title or "Prototype", language == "ar")
        if len(html.encode("utf-8")) > min(200, max(1, int(PROTOTYPE_MAX_KB))) * 1024:
            raise ValueError("حجم النموذج النهائي أكبر من الحد المسموح.")
        path = prototype_path_for(job)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(html, encoding="utf-8")
        result.update({"ok": True, "path": str(path), "html": html, "fallback": fallback_used})
        if fallback_used:
            result["error"] = last_error
        return result
    except ValueError as exc:
        result["error"] = str(exc)[:250]
        return result
    except Exception as exc:
        print(f"Prototype generation failed: {type(exc).__name__}")
        result["error"] = "حصلت مشكلة وأنا بجهّز النموذج أو بحفظه. جرّب تاني بعد شوية."
        return result


def build_demo(theme: str = "aurora") -> dict:
    """Write a theme preview from static sample content; this never invokes Gemini."""
    theme = normalize_theme(theme)
    demo_job = type("DemoJob", (), {"title": "A calmer way to plan", "description": "A sample concept for a simple planning dashboard.", "source": "demo", "external_id": theme})()
    body = _fallback_body(demo_job, "en")
    html = build_page(theme, body, f"Prototype theme: {theme}", False)
    folder = Path(PROTOTYPE_DIR)
    if not folder.is_absolute():
        folder = Path(__file__).resolve().parent / folder
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"prototype_demo_{theme}.html"
    path.write_text(html, encoding="utf-8")
    return {"ok": True, "theme": theme, "path": str(path), "html": html}


def validate_prototype_url(url) -> bool:
    try:
        if not isinstance(url, str) or not url or len(url) >= 300 or any(ch.isspace() for ch in url):
            return False
        parsed = urlsplit(url)
        if parsed.username or parsed.password or not parsed.hostname:
            return False
        try:
            parsed.port
        except ValueError:
            return False
        if parsed.scheme.lower() == "https":
            return url.lower().startswith("https://")
        if parsed.scheme.lower() == "http":
            hostname = parsed.hostname.lower().strip("[]")
            return url.lower().startswith("http://") and hostname in {"localhost", "127.0.0.1", "::1"}
        return False
    except (TypeError, ValueError):
        return False


def add_prototype_line(proposal_text: str, url: str, language: str | None = None) -> str:
    text = str(proposal_text or "")
    url = str(url or "")
    if url and url in text:
        return text
    selected_language = language if language in {"ar", "en"} else detect_language(text)
    sentence = (
        f"جهّزتلك نموذج أولي بسيط لفكرتك تقدر تشوفه هنا: {url}"
        if selected_language == "ar"
        else f"I put together a quick prototype of your idea so you can see it: {url}"
    )
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if _SIGNOFF.match(line.strip()):
            before = lines[:index]
            while before and not before[-1].strip():
                before.pop()
            after = lines[index:]
            return "\n".join([*before, "", sentence, "", *after]).strip()
    return f"{text.rstrip()}\n\n{sentence}".strip()
