import json
import math
import re

from config import (
    ESTIMATE_BUFFER,
    HOURLY_RATE_USD,
    LOW_BUDGET_RATIO,
    MARKET_HIGH_RATIO,
    MARKET_LOW_RATIO,
    MIN_ACCEPTABLE_MULTIPLIER,
    PRICE_GROUPS,
)
from prices import budget_to_usd, currency_for_budget
from tech import extract_tags


def _fallback(error: str) -> dict:
    return {
        "tasks": [],
        "total_hours": 0,
        "risks": [],
        "questions_for_client": [],
        "error": error,
    }


def _clean_json_text(text: str) -> str:
    cleaned = text.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)\s*```", cleaned, flags=re.IGNORECASE | re.DOTALL)
    if fenced:
        return fenced.group(1).strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3].strip()
    return cleaned


def _clean_string_list(value, limit: int, max_chars: int) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip()[:max_chars] for item in value if isinstance(item, str) and item.strip()][:limit]


def parse_estimate(text: str) -> dict:
    try:
        parsed = json.loads(_clean_json_text(text))
        if not isinstance(parsed, dict):
            return _fallback("الرد مش بصيغة تقدير مفهومة.")

        raw_tasks = parsed.get("tasks")
        tasks = []
        if isinstance(raw_tasks, list):
            for item in raw_tasks:
                if not isinstance(item, dict):
                    continue
                name = item.get("name")
                hours = item.get("hours")
                if not isinstance(name, str) or not name.strip():
                    continue
                if isinstance(hours, bool):
                    continue
                try:
                    hours = float(hours)
                except (TypeError, ValueError, OverflowError):
                    continue
                if not math.isfinite(hours) or hours <= 0:
                    continue
                hours = round(min(hours, 200.0), 2)
                tasks.append({"name": name.strip()[:200], "hours": max(hours, 0.01)})

        raw_total = parsed.get("total_hours")
        try:
            if isinstance(raw_total, bool):
                raise ValueError("total_hours must be numeric")
            total_hours = float(raw_total)
            if not math.isfinite(total_hours) or total_hours < 0:
                total_hours = 0.0
        except (TypeError, ValueError, OverflowError):
            total_hours = 0.0
        if isinstance(raw_tasks, list):
            task_total = sum(task["hours"] for task in tasks)
            if not math.isclose(total_hours, task_total, rel_tol=1e-6, abs_tol=1e-6):
                total_hours = task_total
        total_hours = round(total_hours, 2)

        result = {
            "tasks": tasks,
            "total_hours": total_hours,
            "risks": _clean_string_list(parsed.get("risks"), 5, 300),
            "questions_for_client": _clean_string_list(parsed.get("questions_for_client"), 3, 300),
        }
        error = parsed.get("error")
        if isinstance(error, str) and error.strip():
            result["error"] = error.strip()[:300]
        return result
    except Exception:
        return _fallback("تعذر قراءة رد التقدير؛ مفيش سعر محسوب.")


def estimate_job(job, stats=None, market=None) -> dict:
    """Ask Gemini for a task and hour estimate only; pricing is calculated locally."""
    try:
        from proposal import generate_gemini_text

        prompt = f"""Return valid JSON only, with this exact shape:
{{"tasks": [{{"name": "string", "hours": number}}], "total_hours": number, "risks": ["string"], "questions_for_client": ["string"]}}

Estimate work tasks and hours only. Use only the job title and description below. Do not invent requirements, integrations, deliverables, or constraints. If the description is too vague, say so in risks and keep the hour estimates conservative. Use positive task hours, no more than 200 hours for any one task. Make total_hours equal the sum of task hours. Include up to 5 concrete risks and 3 useful questions to ask the client. Write the questions in the job's language: for an Arabic job use friendly, simple Egyptian Arabic; for an English job use English. Do not estimate or mention a price.

Job title:
{getattr(job, 'title', '')}

Job description:
{getattr(job, 'description', '')}"""
        response = generate_gemini_text(
            prompt,
            response_mime_type="application/json",
            failure_label="فشل تقدير وقت الوظيفة",
        )
        if not response:
            return _fallback("Gemini مش متاح أو ما رجعش تقدير.")
        return parse_estimate(response)
    except Exception as exc:
        print(f"Job estimate failed: {type(exc).__name__}")
        return _fallback("حصل خطأ أثناء تقدير الوقت؛ مفيش سعر محسوب.")


def compute_pricing(estimate, job, stats, market_medians) -> dict:
    """Compute a suggested price and comparisons without making network calls."""
    result = {
        "currency": "USD",
        "price_usd": None,
        "floor_usd": None,
        "market_label": "مفيش بيانات سوق كفاية",
        "market_tag": None,
        "market_median_usd": None,
        "market_samples": 0,
        "market_ratio": None,
        "market_source": None,
        "market_notes": [],
        "budget_usd": None,
        "low_budget": False,
    }
    try:
        if not isinstance(estimate, dict) or estimate.get("error"):
            return result
        hours = float(estimate.get("total_hours", 0))
        if not math.isfinite(hours) or hours <= 0:
            return result

        price = hours * HOURLY_RATE_USD * ESTIMATE_BUFFER
        if not math.isfinite(price):
            return result
        result["price_usd"] = price
        result["floor_usd"] = price * MIN_ACCEPTABLE_MULTIPLIER

        market_medians = market_medians if isinstance(market_medians, dict) else {}
        bid_candidates = []
        budget_candidates = []
        for tag in extract_tags(job):
            entry = market_medians.get(tag)
            if not isinstance(entry, dict):
                continue
            try:
                median = float(entry.get("median_bid_avg_usd"))
                samples = int(entry.get("samples", 0))
            except (TypeError, ValueError, OverflowError):
                median, samples = None, 0
            if median is not None and math.isfinite(median) and median > 0 and samples > 0:
                bid_candidates.append((samples, tag, median))
            try:
                budget_median = float(entry.get("median_budget_usd"))
                raw_budget_samples = entry.get("budget_samples", entry.get("samples", 1))
                budget_samples = int(raw_budget_samples)
            except (TypeError, ValueError, OverflowError):
                budget_median, budget_samples = None, 0
            if budget_median is not None and math.isfinite(budget_median) and budget_median > 0 and budget_samples > 0:
                budget_candidates.append((budget_samples, tag, budget_median))

        market_source = "bids" if bid_candidates else "budget"
        candidates = bid_candidates or budget_candidates
        if candidates:
            samples, tag, market_median = sorted(candidates, key=lambda item: (-item[0], item[1]))[0]
            ratio = price / market_median
            notes = []
            if market_source == "budget":
                notes.append("ميزانيات العملاء مش عروض")
            own_currency = currency_for_budget(
                getattr(job, "budget", ""),
                (stats or {}).get("currency") if isinstance(stats, dict) else None,
            )
            own_group = next(
                (group for group, currencies in PRICE_GROUPS.items() if own_currency in currencies),
                None,
            )
            if own_group == "B":
                notes.append("مقارنة بعملات أقوى")
            result.update({
                "market_tag": tag,
                "market_median_usd": market_median,
                "market_samples": samples,
                "market_ratio": ratio,
                "market_source": market_source,
                "market_notes": notes,
                "market_label": (
                    "أقل من السوق" if ratio < MARKET_LOW_RATIO
                    else "أعلى من السوق" if ratio > MARKET_HIGH_RATIO
                    else "في المتوسط"
                ),
            })

        budget = getattr(job, "budget", "")
        currency = (stats or {}).get("currency") if isinstance(stats, dict) else None
        result["budget_usd"] = budget_to_usd(budget, currency)
        if result["budget_usd"] is not None:
            result["low_budget"] = result["budget_usd"] < LOW_BUDGET_RATIO * price
        return result
    except Exception as exc:
        print(f"Pricing calculation failed: {type(exc).__name__}")
        return result


def _money(value) -> str:
    try:
        number = float(value)
        return f"${number:,.2f} USD"
    except (TypeError, ValueError, OverflowError):
        return "غير متاح"


def format_estimate_message(job, estimate, pricing) -> str:
    try:
        title = str(getattr(job, "title", "الوظيفة"))[:300]
        if not isinstance(estimate, dict):
            estimate = _fallback("بيانات التقدير مش مفهومة.")
        if not isinstance(pricing, dict):
            pricing = {}
        lines = [f"💰 تقدير مبدئي: {title}"]
        if pricing.get("saved"):
            lines.append("📌 (تقدير محفوظ)")

        if estimate.get("error") or pricing.get("price_usd") is None:
            reason = estimate.get("error") or "تقدير الساعات غير متاح أو مفيش بيانات كفاية."
            lines.extend([f"تعذر إكمال تقدير السعر: {str(reason)[:300]}", "مفيش سعر محسوب."])
            return "\n".join(lines)[:3500]

        tasks = estimate.get("tasks") if isinstance(estimate.get("tasks"), list) else []
        lines.append("المهام والوقت:")
        if tasks:
            visible_tasks = tasks[:10]
            for task in visible_tasks:
                if not isinstance(task, dict):
                    continue
                try:
                    hours = float(task.get("hours"))
                    name = str(task.get("name", "مهمة"))[:100]
                    lines.append(f"• {name} — {hours:g} ساعة")
                except (TypeError, ValueError, OverflowError):
                    continue
            if len(tasks) > len(visible_tasks):
                lines.append(f"• وباقي {len(tasks) - len(visible_tasks)} مهام ضمن التقدير")
        else:
            lines.append("• تفاصيل المهام مش متاحة")

        lines.extend([
            f"إجمالي الوقت: {float(estimate.get('total_hours', 0)):g} ساعة",
            f"السعر المقترح: {_money(pricing.get('price_usd'))}",
            f"أقل سعر مقبول: {_money(pricing.get('floor_usd'))}",
        ])
        if pricing.get("market_median_usd") is None:
            lines.append("مقارنة السوق: مفيش بيانات سوق كفاية.")
        else:
            source_label = "وسيط ميزانيات العملاء" if pricing.get("market_source") == "budget" else "وسيط العروض"
            notes = pricing.get("market_notes") if isinstance(pricing.get("market_notes"), list) else []
            note_text = f" — {'، '.join(str(note) for note in notes if note)}" if notes else ""
            lines.append(
                f"مقارنة السوق ({pricing.get('market_tag')}): {pricing.get('market_label')} "
                f"— {source_label} {_money(pricing.get('market_median_usd'))} "
                f"({pricing.get('market_samples')} عينة){note_text}."
            )
        if pricing.get("low_budget"):
            lines.append(f"💸 ميزانية العميل ({_money(pricing.get('budget_usd'))}) أقل من نصف السعر المحسوب.")

        risks = estimate.get("risks") if isinstance(estimate.get("risks"), list) else []
        if risks:
            lines.append("مخاطر أو نقاط محتاجة تأكيد:")
            lines.extend(f"• {str(risk)[:140]}" for risk in risks[:5])
        questions = estimate.get("questions_for_client")
        if isinstance(questions, list) and questions:
            lines.append("أسئلة للعميل:")
            lines.extend(f"• {str(question)[:140]}" for question in questions[:3])
        return "\n".join(lines)[:3500]
    except Exception as exc:
        print(f"Estimate message formatting failed: {type(exc).__name__}")
        return "⚠️ حصل خطأ في تنسيق تقدير الوظيفة؛ مفيش سعر محسوب."
