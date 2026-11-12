import json
from pathlib import Path

from config import COMPETITION_HIGH_MIN_BIDS, COMPETITION_LOW_MAX_BIDS
from models import Job
from proposal import PROFILE_PATH, generate_gemini_text


def _fallback(reason: str = "الفحص ما كملش؛ راجع الوظيفة يدويًا.") -> dict:
    return {
        "verdict": "maybe",
        "score": 0,
        "competition": "medium",
        "budget_fit": "مش متاح بسبب تعذر الفحص.",
        "reasons": [reason, "الأرقام أو البيانات مش كفاية لحكم موثوق."],
        "suggested_bid": None,
    }


def parse_evaluation(text: str) -> dict:
    try:
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3].strip()
        result = json.loads(cleaned)
        if not isinstance(result, dict):
            return _fallback()
        if result.get("verdict") not in {"apply", "skip", "maybe"}:
            return _fallback()
        if result.get("competition") not in {"low", "medium", "high"}:
            return _fallback()
        score = float(result.get("score"))
        if not 0 <= score <= 10:
            return _fallback()
        reasons = result.get("reasons")
        if not isinstance(reasons, list) or not 2 <= len(reasons) <= 4 or not all(isinstance(x, str) for x in reasons):
            return _fallback()
        suggested_bid = result.get("suggested_bid")
        if suggested_bid is not None:
            if isinstance(suggested_bid, bool) or not isinstance(suggested_bid, (int, float)):
                return _fallback()
            suggested_bid = float(suggested_bid)
        return {
            "verdict": result["verdict"],
            "score": score,
            "competition": result["competition"],
            "budget_fit": str(result.get("budget_fit", "مش واضح من البيانات المتاحة."))[:240],
            "reasons": [reason.strip()[:200] for reason in reasons],
            "suggested_bid": suggested_bid,
        }
    except (ValueError, TypeError, json.JSONDecodeError):
        return _fallback()


def evaluate_job(job: Job, stats: dict) -> dict:
    if not PROFILE_PATH.is_file():
        print(f"Warning: profile file not found at {PROFILE_PATH}; evaluation unavailable.")
        return _fallback("ملف الخبرات مش موجود، فالتقييم غير مكتمل.")
    profile = PROFILE_PATH.read_text(encoding="utf-8").strip()
    if not profile:
        return _fallback("ملف الخبرات فاضي، فالتقييم غير مكتمل.")

    prompt = f"""أنت مساعد لتقييم فرصة عمل حر. أخرج JSON صالحًا فقط بهذه المفاتيح:
verdict (apply أو skip أو maybe)، score (رقم من 0 إلى 10)، competition (low أو medium أو high)، budget_fit (نص قصير)، reasons (قائمة من 2 إلى 4 جمل قصيرة)، suggested_bid (رقم أو null).
اكتب الأسباب بالعربي المصري البسيط.
اعتمد فقط على وصف الوظيفة والملف الشخصي والأرقام المرفقة، ولا تخترع أي معلومة.
قيّم مدى توافق المطلوب فعلًا مع مهارات وخبرات الملف الشخصي.
لو الأرقام غير متاحة، اذكر ذلك بوضوح في الأسباب ولا تقدّر أرقامًا من عندك.
راعِ عمر الوظيفة: عدد عروض كبير نسبةً لعمر قصير يعني منافسة أشد. حد المنافسة المنخفض حتى {COMPETITION_LOW_MAX_BIDS} عرض، والمرتفع من {COMPETITION_HIGH_MIN_BIDS} عرض فأكثر؛ استخدم العمر لتفسير سرعة وصول العروض.
اقترح سعرًا رقميًا فقط لو الميزانية والأرقام تسمح بتقدير معقول، وإلا اجعل suggested_bid null.

ملف الخبرات:
{profile}

عنوان الوظيفة:
{job.title}

وصف الوظيفة:
{job.description}

ميزانية الوظيفة:
{job.budget or 'غير محددة'}

الأرقام الحية (JSON؛ قد تكون فارغة):
{json.dumps(stats or {}, ensure_ascii=False)}"""
    text = generate_gemini_text(
        prompt,
        response_mime_type="application/json",
        failure_label="فشل فحص الوظيفة",
    )
    if not text:
        return _fallback()
    return parse_evaluation(text)
