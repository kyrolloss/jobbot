import statistics
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from config import (
    HIGH_SCORE_THRESHOLD,
    TIMING_BAR_MAX_WIDTH,
    TIMING_FAST_APPLY_MINUTES,
    TIMING_GOOD_APPLY_MINUTES,
    TIMING_HIGH_SCORE_MIN_FOR_CHART,
    TIMING_MIN_JOB_COUNT,
    TIMING_REPORT_DEFAULT_DAYS,
    TIMING_REPORT_MAX_DAYS,
    TIMING_REPORT_MIN_DAYS,
    TIMING_TOP_N,
)
from db import get_timing_rows


CAIRO_ZONE = "Africa/Cairo"
WEEKDAYS_AR = ("الإثنين", "التلات", "الأربع", "الخميس", "الجمعة", "السبت", "الأحد")


def _parse_utc(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def _uses_created_fallback(posted_at, created_at) -> bool:
    posted = _parse_utc(posted_at)
    created = _parse_utc(created_at)
    if posted is None or created is None:
        return True
    return abs((posted - created).total_seconds()) < 1


def _format_distribution(items, per_line=6):
    return [" | ".join(items[index:index + per_line]) for index in range(0, len(items), per_line)]


def _bar(count: int, maximum: int) -> str:
    width = max(1, min(TIMING_BAR_MAX_WIDTH, round(count / maximum * TIMING_BAR_MAX_WIDTH))) if maximum else 0
    return "█" * width


def _top_lines(title, counts, labels, use_weekday=False):
    ranked = sorted(
        (item for item in counts.items() if item[1] > 0),
        key=lambda item: (-item[1], item[0]),
    )[:TIMING_TOP_N]
    maximum = max((count for _, count in ranked), default=0)
    lines = [title]
    for key, count in ranked:
        label = labels[key] if use_weekday else f"{key:02d}:00"
        lines.append(f"{label} {_bar(count, maximum)} {count}")
    return lines


def _fallback_line(fallback_count, total):
    if not total or not fallback_count:
        return None
    return (
        f"ملاحظة: {fallback_count} من {total} وقت نشر جاي من وقت رصد البوت كبديل، "
        "مش من توقيت مصدر مؤكد."
    )


def _applied_speed(rows):
    elapsed_minutes = []
    for row in rows:
        if row.get("status") != "applied":
            continue
        posted = _parse_utc(row.get("posted_at") or row.get("created_at"))
        applied = _parse_utc(row.get("applied_at"))
        if posted is None or applied is None:
            continue
        minutes = (applied - posted).total_seconds() / 60
        if minutes >= 0:
            elapsed_minutes.append(minutes)
    if not elapsed_minutes:
        return "سرعة التقديم: لسه مفيش وظائف بتوقيت نشر وتقديم محفوظين."
    median = round(statistics.median(elapsed_minutes))
    if median < TIMING_FAST_APPLY_MINUTES:
        advice = "ممتاز، حافظ على السرعة دي."
    elif median < TIMING_GOOD_APPLY_MINUTES:
        advice = "كويس، حاول تقلل الوقت شوية."
    else:
        advice = "حاول تقدم أسرع بعد مراجعة الوظيفة."
    return f"سرعة التقديم: الوسيط {median} دقيقة ({len(elapsed_minutes)} وظيفة). {advice}"


def build_timing_report(days=TIMING_REPORT_DEFAULT_DAYS, db_path=None) -> str:
    try:
        try:
            days = int(days)
        except (TypeError, ValueError, OverflowError):
            days = TIMING_REPORT_DEFAULT_DAYS
        days = max(TIMING_REPORT_MIN_DAYS, min(days, TIMING_REPORT_MAX_DAYS))
        try:
            cairo = ZoneInfo(CAIRO_ZONE)
        except (ZoneInfoNotFoundError, OSError):
            return "⚠️ بيانات توقيت القاهرة مش متاحة. ثبّت tzdata وبعدين أعد تشغيل البوت."

        rows = get_timing_rows(days, db_path=db_path)
        usable = []
        fallback_count = 0
        for row in rows:
            posted_raw = row.get("posted_at") or row.get("created_at")
            posted_utc = _parse_utc(posted_raw)
            if posted_utc is None:
                continue
            if _uses_created_fallback(row.get("posted_at") or row.get("created_at"), row.get("created_at")):
                fallback_count += 1
            local = posted_utc.astimezone(cairo)
            try:
                score = float(row.get("score"))
            except (TypeError, ValueError, OverflowError):
                score = None
            usable.append({"row": row, "hour": local.hour, "weekday": local.weekday(), "score": score})

        count = len(usable)
        note = _fallback_line(fallback_count, count)
        heading = f"🕒 أوقات نشر الوظايف — آخر {days} يوم (بتوقيت القاهرة)"
        if count < TIMING_MIN_JOB_COUNT:
            lines = [heading, f"لسه البيانات قليلة: عندي {count} وظيفة بتوقيت نشر صالح. التقرير هيتحسن مع تشغيل البوت."]
            if note:
                lines.append(note)
            lines.append(_applied_speed(rows))
            return "\n".join(lines)

        high = [item for item in usable if item["score"] is not None and item["score"] >= HIGH_SCORE_THRESHOLD]
        all_hours = {hour: 0 for hour in range(24)}
        high_hours = {hour: 0 for hour in range(24)}
        all_weekdays = {day: 0 for day in range(7)}
        high_weekdays = {day: 0 for day in range(7)}
        for item in usable:
            all_hours[item["hour"]] += 1
            all_weekdays[item["weekday"]] += 1
        for item in high:
            high_hours[item["hour"]] += 1
            high_weekdays[item["weekday"]] += 1

        lines = [
            heading,
            f"الوظايف المطابقة: {count} | نقاط عالية (≥{HIGH_SCORE_THRESHOLD}): {len(high)}",
            "توزيع الساعات (الكل/عالي):",
        ]
        hour_items = [f"{hour:02d}: {all_hours[hour]}/{high_hours[hour]}" for hour in range(24)]
        lines.extend(_format_distribution(hour_items, per_line=6))
        lines.append("توزيع الأيام (الكل/عالي):")
        weekday_items = [
            f"{WEEKDAYS_AR[day]} {all_weekdays[day]}/{high_weekdays[day]}" for day in range(7)
        ]
        lines.extend(_format_distribution(weekday_items, per_line=4))

        chart_hours, chart_days = (
            (high_hours, high_weekdays)
            if len(high) >= TIMING_HIGH_SCORE_MIN_FOR_CHART
            else (all_hours, all_weekdays)
        )
        chart_title = (
            "وظايف عالية الدرجة"
            if len(high) >= TIMING_HIGH_SCORE_MIN_FOR_CHART
            else "كل الوظايف (العالية أقل من 5)"
        )
        lines.extend(_top_lines(f"أفضل 3 ساعات — {chart_title}:", chart_hours, WEEKDAYS_AR))
        lines.extend(_top_lines(f"أفضل 3 أيام — {chart_title}:", chart_days, WEEKDAYS_AR, use_weekday=True))
        if note:
            lines.append(note)
        lines.append(_applied_speed(rows))
        return "\n".join(lines)
    except Exception as exc:
        print(f"Timing report failed: {type(exc).__name__}")
        return "⚠️ مقدرتش أجهز تقرير التوقيت دلوقتي. جرّب تاني بعد شوية."
