import re
from datetime import datetime, timezone

from config import (
    CURRENCY_TO_USD,
    CURRENCY_SYMBOL_TO_CODE,
    SCORING_BUDGET_MAX_POINTS,
    SCORING_BUDGET_NEUTRAL_POINTS,
    SCORING_BUDGET_SATURATION_USD,
    SCORING_COMPETITION_MAX_POINTS,
    SCORING_COMPETITION_NEUTRAL_POINTS,
    SCORING_DESCRIPTION_KEYWORD_CAP,
    SCORING_DESCRIPTION_KEYWORD_WEIGHT,
    SCORING_FRESHNESS_MAX_POINTS,
    SCORING_FRESHNESS_NEUTRAL_POINTS,
    SCORING_FRESHNESS_WINDOW_HOURS,
    SCORING_LABEL_FIRE_MIN,
    SCORING_LABEL_THUMBS_MIN,
    SCORING_LOW_COMPETITION_REDUCTION_FRACTION,
    SCORING_MEDIUM_COMPETITION_START_FRACTION,
    SCORING_TITLE_KEYWORD_CAP,
    SCORING_TITLE_KEYWORD_WEIGHT,
    COMPETITION_HIGH_MIN_BIDS,
    COMPETITION_LOW_MAX_BIDS,
    KEYWORDS,
)

SHORT_WORD_KEYWORDS = {"ai", "api", "node"}


def _matches(text: str, keyword: str) -> bool:
    if keyword.casefold() in SHORT_WORD_KEYWORDS:
        return re.search(rf"\b{re.escape(keyword)}\b", text, flags=re.IGNORECASE) is not None
    return keyword.casefold() in text.casefold()


def _amount_text(value) -> str:
    try:
        return f"{float(value):g}"
    except (TypeError, ValueError):
        return "?"


def _budget_values(job, stats: dict) -> tuple[float | None, str | None]:
    minimum = stats.get("budget_min")
    maximum = stats.get("budget_max")
    currency = stats.get("currency")

    if minimum is not None and maximum is not None:
        try:
            return (float(minimum) + float(maximum)) / 2, str(currency).upper() if currency else None
        except (TypeError, ValueError):
            pass

    budget = job.budget or ""
    numbers = re.findall(r"\d+(?:[,.]\d+)*", budget)
    if not numbers:
        return None, None
    parsed = [float(item.replace(",", "")) for item in numbers[:2]]
    amount = sum(parsed) / len(parsed)
    currency_code = None
    for code in CURRENCY_TO_USD:
        if re.search(rf"\b{re.escape(code)}\b", budget, flags=re.IGNORECASE):
            currency_code = code
            break
    if currency_code is None:
        for symbol, code in CURRENCY_SYMBOL_TO_CODE.items():
            if symbol in budget:
                currency_code = code
                break
    return amount, currency_code


def _age_hours(stats: dict) -> float | None:
    if stats.get("age_hours") is not None:
        try:
            return max(0.0, float(stats["age_hours"]))
        except (TypeError, ValueError):
            return None
    if stats.get("time_submitted") is not None:
        try:
            seconds = datetime.now(timezone.utc).timestamp() - float(stats["time_submitted"])
            return max(0.0, seconds / 3600)
        except (TypeError, ValueError, OSError):
            return None
    return None


def _competition_points(bid_count: int | float) -> float:
    count = max(0.0, float(bid_count))
    low = float(COMPETITION_LOW_MAX_BIDS)
    high = float(COMPETITION_HIGH_MIN_BIDS)
    if count <= low:
        return SCORING_COMPETITION_MAX_POINTS * (
            1.0 - SCORING_LOW_COMPETITION_REDUCTION_FRACTION * count / max(1.0, low)
        )
    if count < high:
        start_points = SCORING_COMPETITION_MAX_POINTS * SCORING_MEDIUM_COMPETITION_START_FRACTION
        return start_points * (high - count) / max(1.0, high - low)
    return 0.0


def label_for_score(score: float) -> str:
    if score >= SCORING_LABEL_FIRE_MIN:
        return "🔥"
    if score >= SCORING_LABEL_THUMBS_MIN:
        return "👍"
    return "😐"


def score_job(job, stats: dict | None = None) -> dict:
    stats = stats or {}
    title = job.title or ""
    description = job.description or ""
    title_matches = sum(_matches(title, keyword) for keyword in KEYWORDS)
    description_matches = sum(_matches(description, keyword) for keyword in KEYWORDS)
    title_points = min(SCORING_TITLE_KEYWORD_CAP, title_matches * SCORING_TITLE_KEYWORD_WEIGHT)
    description_points = min(
        SCORING_DESCRIPTION_KEYWORD_CAP,
        description_matches * SCORING_DESCRIPTION_KEYWORD_WEIGHT,
    )

    amount, currency = _budget_values(job, stats)
    usd_amount = None
    if amount is not None and currency in CURRENCY_TO_USD:
        usd_amount = amount * CURRENCY_TO_USD[currency]
        budget_points = SCORING_BUDGET_MAX_POINTS * min(
            1.0,
            max(0.0, usd_amount / max(1.0, SCORING_BUDGET_SATURATION_USD)),
        )
    else:
        budget_points = SCORING_BUDGET_NEUTRAL_POINTS

    bid_count = stats.get("bid_count")
    if bid_count is None:
        competition_points = SCORING_COMPETITION_NEUTRAL_POINTS
    else:
        try:
            competition_points = _competition_points(bid_count)
        except (TypeError, ValueError):
            competition_points = SCORING_COMPETITION_NEUTRAL_POINTS

    age_hours = _age_hours(stats)
    if age_hours is None:
        freshness_points = SCORING_FRESHNESS_NEUTRAL_POINTS
    else:
        freshness_points = SCORING_FRESHNESS_MAX_POINTS * max(
            0.0,
            1.0 - age_hours / max(1.0, SCORING_FRESHNESS_WINDOW_HOURS),
        )

    score = round(min(10.0, max(0.0, title_points + description_points + budget_points + competition_points + freshness_points)), 1)
    bid_text = str(bid_count) if bid_count is not None else "غير متاح"
    if usd_amount is not None:
        budget_text = f"ميزانية≈{_amount_text(usd_amount)} USD"
    else:
        budget_text = "ميزانية غير معروفة"
    bid_avg = stats.get("bid_avg")
    if bid_avg is not None:
        average_text = _amount_text(bid_avg)
        if stats.get("currency"):
            average_text += f" {stats['currency']}"
        average_text = f"متوسط {average_text}"
    else:
        average_text = "متوسط غير متاح"
    age_text = f"عمر {age_hours:g}س" if age_hours is not None else "العمر غير متاح"
    if not stats:
        line = "📋 الأرقام مش متاحة، افتح الرابط وشوف العروض والميزانية"
    else:
        metrics_available = any(
            stats.get(key) is not None
            for key in (
                "budget_min", "budget_max", "currency", "bid_count", "bid_avg",
                "age_hours", "time_submitted",
            )
        ) or bool(job.budget)
        if metrics_available:
            line = (
                f"كلمات عنوان {title_matches}/وصف {description_matches} | "
                f"{budget_text} | عروض {bid_text} | {average_text} | {age_text}"
            )
        else:
            line = (
                f"كلمات عنوان {title_matches}/وصف {description_matches} | "
                "📋 الأرقام مش متاحة، افتح الرابط وشوف العروض والميزانية"
            )
    return {"score": score, "label": label_for_score(score), "line": line}
