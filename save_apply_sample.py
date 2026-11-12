import argparse
import re
import sqlite3
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE_DIR = Path(__file__).resolve().parent
PROFILE_DIR = BASE_DIR / "browser_profile"
DB_PATH = BASE_DIR / "jobs.db"
SAMPLES_DIR = BASE_DIR / "samples"
HTML_PATH = SAMPLES_DIR / "job_logged_in.html"
SCREENSHOT_PATH = SAMPLES_DIR / "job_logged_in.png"

APPLY_TERMS = re.compile(r"عرض|تقديم|تقدّم|قدم|مستقل|bid|proposal|apply", re.IGNORECASE)


def first_approved_or_sent_url() -> str:
    with sqlite3.connect(DB_PATH) as connection:
        row = connection.execute(
            """SELECT url FROM jobs
               WHERE status IN ('approved', 'sent')
               ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, created_at, rowid
               LIMIT 1"""
        ).fetchone()
    if row is None:
        raise RuntimeError("لا توجد وظيفة approved أو sent في jobs.db؛ مرّر رابطًا كوسيط.")
    return row[0]


def inspect_apply_controls(page) -> None:
    matches = []
    controls = page.locator("button, input[type=submit], input[type=button], a")
    for index in range(controls.count()):
        control = controls.nth(index)
        try:
            description = control.evaluate(
                "el => [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.value].filter(Boolean).join(' ').trim()"
            )
            if description and APPLY_TERMS.search(description):
                matches.append(f"control: {description[:180]}")
        except Exception:
            continue

    forms = page.locator("form")
    for index in range(forms.count()):
        form = forms.nth(index)
        try:
            details = form.evaluate(
                "el => `${el.getAttribute('action') || ''} ${el.innerText || ''} ${[...el.querySelectorAll('input,textarea,button')].map(x => x.name || x.placeholder || x.value || '').join(' ')}`"
            ).strip()
            if details and APPLY_TERMS.search(details):
                matches.append(f"form: {details[:240]}")
        except Exception:
            continue

    if matches:
        print("عناصر محتملة لتقديم عرض (لم يتم الضغط أو الإرسال):")
        for item in matches:
            print(f"- {item}")
    else:
        print("لم أجد زرًا أو نموذجًا واضحًا لتقديم عرض في الصفحة.")


def main() -> None:
    parser = argparse.ArgumentParser(description="احفظ عينة صفحة وظيفة بعد تسجيل الدخول، دون التقديم عليها.")
    parser.add_argument("url", nargs="?", help="رابط الوظيفة؛ الافتراضي أول approved ثم sent من قاعدة البيانات")
    args = parser.parse_args()
    url = args.url or first_approved_or_sent_url()
    if not PROFILE_DIR.is_dir():
        raise RuntimeError("ملف browser_profile غير موجود؛ شغّل login_mostaql.py وسجّل الدخول أولًا.")

    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
        )
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(1500)
            HTML_PATH.write_text(page.content(), encoding="utf-8")
            page.screenshot(path=str(SCREENSHOT_PATH), full_page=True)
            print(f"حُفظ HTML: {HTML_PATH} ({HTML_PATH.stat().st_size} bytes)")
            print(f"حُفظت الصورة: {SCREENSHOT_PATH}")
            inspect_apply_controls(page)
        finally:
            context.close()


if __name__ == "__main__":
    main()
