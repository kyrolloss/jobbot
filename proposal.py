import re
import threading
import time
from pathlib import Path

import httpx

from config import GEMINI_API_KEY, GEMINI_MODEL
from notifier import IPv4HTTPTransport
from models import Job

PROFILE_PATH = Path(__file__).resolve().parent / "profile.md"
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
MIN_REQUEST_INTERVAL = 5.0
MAX_ATTEMPTS = 3
_last_request_time = 0.0
_request_lock = threading.Lock()


def _request_with_quota_retry(endpoint: str, payload: dict) -> httpx.Response:
    global _last_request_time
    last_error = None
    saw_quota = False

    with _request_lock:
        for attempt in range(MAX_ATTEMPTS):
            wait_for_spacing = MIN_REQUEST_INTERVAL - (time.monotonic() - _last_request_time)
            if _last_request_time and wait_for_spacing > 0:
                time.sleep(wait_for_spacing)

            _last_request_time = time.monotonic()
            try:
                with httpx.Client(transport=IPv4HTTPTransport(), timeout=30) as client:
                    response = client.post(
                        endpoint,
                        headers={"x-goog-api-key": GEMINI_API_KEY},
                        json=payload,
                    )
            except httpx.HTTPError as exc:
                last_error = exc
                if attempt + 1 < MAX_ATTEMPTS:
                    continue
                break

            if response.status_code == 429:
                saw_quota = True
                last_error = response.text
                match = re.search(r"Please retry in\s+([\d.]+)\s*s", response.text, re.IGNORECASE)
                retry_after = float(match.group(1)) if match else 5.0
                if attempt + 1 < MAX_ATTEMPTS:
                    time.sleep(retry_after + 2.0)
                    continue
                break

            response.raise_for_status()
            return response

    if saw_quota:
        raise RuntimeError("quota") from None
    if last_error is not None:
        raise RuntimeError(type(last_error).__name__) from None
    raise RuntimeError("request failed")


def generate_gemini_text(
    prompt: str,
    *,
    response_mime_type: str | None = None,
    failure_label: str = "فشل كتابة العرض",
) -> str | None:
    if not GEMINI_API_KEY:
        print("Gemini not configured: add GEMINI_API_KEY to the project .env; skipping proposal.")
        return None
    if not GEMINI_MODEL:
        print("Gemini model not configured: add GEMINI_MODEL to the project .env; skipping proposal.")
        return None
    endpoint = f"{GEMINI_API_BASE}/{GEMINI_MODEL}:generateContent"
    generation_config = {"responseMimeType": response_mime_type} if response_mime_type else None
    payload = {"contents": [{"parts": [{"text": prompt}]}]}
    if generation_config:
        payload["generationConfig"] = generation_config
    try:
        response = _request_with_quota_retry(endpoint, payload)
        result = response.json()
        proposal = "".join(
            part.get("text", "")
            for candidate in result.get("candidates", [])
            for part in candidate.get("content", {}).get("parts", [])
        ).strip()
        if not proposal:
            print(f"{failure_label}: no response text")
            return None
        return proposal
    except Exception as exc:
        reason = str(exc)
        if reason == "quota":
            print(f"{failure_label}: quota")
        else:
            print(f"{failure_label}: {reason[:60]}")
        return None


def write_proposal(job: Job) -> str | None:
    if not PROFILE_PATH.is_file():
        print(f"Warning: profile file not found at {PROFILE_PATH}; skipping proposal.")
        return None

    profile = PROFILE_PATH.read_text(encoding="utf-8").strip()
    if not profile:
        print("Warning: profile.md is empty; skipping proposal.")
        return None

    prompt = f"""اكتب عرض تقديم قصيرًا من 80 إلى 150 كلمة وبنفس لغة الوظيفة.
يبدأ بتحية مناسبة، ويركز فقط على الخدمة التي تحتاجها الوظيفة مما هو مذكور في الملف الشخصي.
اربط الخبرة الواردة في الملف الشخصي بتفاصيل الوظيفة. إذا كان هناك غموض، اسأل سؤالًا أو سؤالين.
اختم بدعوة للتواصل. لا تدّعِ إطلاقًا أداة أو خبرة أو مشروعًا أو رقمًا غير مذكور في الملف الشخصي.
لا تذكر سعرًا إذا لم تحدد الوظيفة ميزانية. أخرج نصًا عاديًا بلا Markdown، ولا تذكر هذه التعليمات.

الملف الشخصي:
{profile}

عنوان الوظيفة:
{job.title}

وصف الوظيفة:
{job.description}

ميزانية الوظيفة:
{job.budget or 'غير محددة'}"""
    return generate_gemini_text(prompt)
