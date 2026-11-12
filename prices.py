import json
import math
import re
import statistics

from config import (
    CURRENCY_SYMBOL_TO_CODE,
    CURRENCY_TO_USD,
    MIN_PRICE_SAMPLES,
    PRICE_REPORT_DEFAULT_DAYS,
    PRICE_GROUPS,
)
from db import get_price_rows


_BUDGET_RANGE = re.compile(
    r"^\s*(?P<symbol1>[$€£₹])?\s*(?P<low>\d[\d,]*(?:\.\d+)?)"
    r"\s*[-–]\s*(?P<symbol2>[$€£₹])?\s*(?P<high>\d[\d,]*(?:\.\d+)?)"
    r"\s*(?P<code>[A-Za-z]{3})?\s*(?P<hourly>/hr)?\s*$",
    re.IGNORECASE,
)
_CURRENCY_CODE = re.compile(r"\b([A-Za-z]{3})\b")


def _infer_currency(budget):
    """Infer only an explicitly written supported code or configured symbol."""
    if not isinstance(budget, str):
        return None
    codes = {match.group(1).upper() for match in _CURRENCY_CODE.finditer(budget)}
    symbols = {CURRENCY_SYMBOL_TO_CODE[symbol] for symbol in budget if symbol in CURRENCY_SYMBOL_TO_CODE}
    if any(code not in CURRENCY_TO_USD for code in codes):
        return None
    candidates = codes | symbols
    if len(candidates) != 1:
        return None
    return next(iter(candidates))


def _budget_midpoint_usd_for_kind(budget, saved_currency, hourly):
    if not isinstance(budget, str):
        return None
    match = _BUDGET_RANGE.fullmatch(budget)
    if not match or bool(match.group("hourly")) != hourly:
        return None

    symbol1 = match.group("symbol1")
    symbol2 = match.group("symbol2")
    if symbol1 and symbol2 and symbol1 != symbol2:
        return None
    symbol = symbol1 or symbol2
    budget_currency = (match.group("code") or "").upper()
    if symbol:
        symbol_currency = CURRENCY_SYMBOL_TO_CODE.get(symbol)
        if budget_currency and symbol_currency != budget_currency:
            return None
        budget_currency = budget_currency or symbol_currency

    currency = str(saved_currency or "").strip().upper()
    if not currency or currency not in CURRENCY_TO_USD:
        return None
    if budget_currency and budget_currency != currency:
        return None
    if not budget_currency:
        return None
    try:
        low = float(match.group("low").replace(",", ""))
        high = float(match.group("high").replace(",", ""))
        if low < 0 or high < 0:
            return None
        return ((low + high) / 2) * CURRENCY_TO_USD[currency]
    except (TypeError, ValueError, OverflowError):
        return None


def _budget_midpoint_usd(budget, saved_currency):
    return _budget_midpoint_usd_for_kind(budget, saved_currency, hourly=False)


def _hourly_midpoint_usd(budget, saved_currency):
    return _budget_midpoint_usd_for_kind(budget, saved_currency, hourly=True)


def _tags_from_json(raw_tags):
    try:
        tags = json.loads(raw_tags) if isinstance(raw_tags, str) else raw_tags
        if not isinstance(tags, list):
            return []
        return sorted({tag.strip() for tag in tags if isinstance(tag, str) and tag.strip()})
    except Exception:
        return []


def _number(value):
    try:
        number = float(value)
        return number if number >= 0 and number < float("inf") else None
    except (TypeError, ValueError, OverflowError):
        return None


def _usd_text(value):
    try:
        if 0 < float(value) < 1:
            return f"${float(value):.2f}"
    except (TypeError, ValueError, OverflowError):
        pass
    return f"${value:,.0f}"


def _currency_group(currency):
    currency = str(currency or "").strip().upper()
    for group, currencies in PRICE_GROUPS.items():
        if currency in currencies:
            return group
    return None


def currency_for_budget(budget, currency=None):
    """Use the saved currency, or an explicit supported code/symbol in the budget."""
    saved = str(currency or "").strip().upper()
    return saved or _infer_currency(budget)


def _empty_group_metrics():
    return {"jobs": 0, "fixed": [], "hourly": [], "bids": [], "bid_counts": []}


def _has_group_data(metrics):
    return any(metrics[key] for key in ("fixed", "hourly", "bids", "bid_counts"))


def _metric_text(label, values, formatter):
    count = len(values)
    value = formatter(values) if count >= MIN_PRICE_SAMPLES else "-"
    return f"{label}: {value} (من {count} وظيفة)"


def _group_report_lines(label, metrics):
    if not _has_group_data(metrics):
        return []
    def short_metric(name, values, formatter):
        text = _metric_text(name, values, formatter)
        return text.replace(f"{name}:", name, 1)

    pieces = [
        short_metric("ثابتة", metrics["fixed"], lambda values: _usd_text(statistics.median(values))),
        short_metric("ساعي", metrics["hourly"], lambda values: f"{_usd_text(statistics.median(values))}/ساعة"),
    ]
    bid_pieces = []
    if len(metrics["bids"]) >= MIN_PRICE_SAMPLES:
        bid_pieces.extend([
            short_metric("وسيط", metrics["bids"], lambda values: _usd_text(statistics.median(values))),
            short_metric("متوسط", metrics["bids"], lambda values: _usd_text(statistics.mean(values))),
        ])
    if len(metrics["bid_counts"]) >= MIN_PRICE_SAMPLES:
        bid_pieces.append(
            short_metric("عدد العروض", metrics["bid_counts"], lambda values: f"{statistics.mean(values):.1f}")
        )
    line = f"{label}: " + " | ".join(pieces)
    if bid_pieces:
        line += " | عروض: " + "، ".join(bid_pieces)
    return [line]


def _report_footer(
    skipped_unknown_currency,
    skipped_unsupported_currency,
    skipped_missing_budget,
    skipped_unparseable_budget,
):
    lines = []
    skipped_total = (
        skipped_unknown_currency + skipped_unsupported_currency +
        skipped_missing_budget + skipped_unparseable_budget
    )
    lines.append(f"وظايف اتخطت لعدم وجود أي سعر قابل للحساب: {skipped_total}.")
    if skipped_unknown_currency:
        lines.append(f"اتخطينا {skipped_unknown_currency} وظيفة؛ مفيش عملة محفوظة أو ظاهرة بوضوح في الميزانية.")
    if skipped_unsupported_currency:
        lines.append(f"اتخطينا {skipped_unsupported_currency} وظيفة لأن العملة مش موجودة في جدول التحويل.")
    if skipped_missing_budget:
        lines.append(f"ميزانية ناقصة ومن غير متوسط عروض قابل للتحويل: {skipped_missing_budget}.")
    if skipped_unparseable_budget:
        lines.append(f"ميزانية ناقصة أو غير قابلة للتحليل، ومن غير متوسط عروض صالح: {skipped_unparseable_budget}.")
    lines.append("الأرقام دي من وظايف مفتوحة شافها البوت (ميزانيات ومتوسط عروض حالية) مش أسعار نهائية اتسندت.")
    lines.append("ملاحظة: فصلنا المجموعات لأن ميزانيات الوظايف بالروبية الهندية أقل بكتير من العملات الأقوى.")
    return lines


def build_price_report(days=PRICE_REPORT_DEFAULT_DAYS, db_path=None, compact=False) -> str:
    try:
        try:
            days = int(days)
        except (TypeError, ValueError, OverflowError):
            days = PRICE_REPORT_DEFAULT_DAYS
        days = max(1, min(days, 365))
        rows = get_price_rows(days, db_path=db_path)
        grouped = {}
        skipped_unknown_currency_rows = 0
        skipped_unsupported_currency_rows = 0
        skipped_missing_budget_rows = 0
        skipped_unparseable_budget_rows = 0
        usable_row_count = 0

        for row in rows:
            tags = _tags_from_json(row.get("tags"))
            if not tags:
                continue
            budget = row.get("budget")
            budget = budget.strip() if isinstance(budget, str) else ""
            currency = currency_for_budget(budget, row.get("currency")) or ""
            group = _currency_group(currency)
            currency_supported = currency in CURRENCY_TO_USD and group is not None
            budget_usd = _budget_midpoint_usd(budget, currency) if currency_supported and budget else None
            hourly_usd = _hourly_midpoint_usd(budget, currency) if currency_supported and budget else None
            bid_avg = _number(row.get("bid_avg"))
            bid_avg_usd = bid_avg * CURRENCY_TO_USD[currency] if bid_avg is not None and currency_supported else None

            if budget_usd is None and hourly_usd is None and bid_avg_usd is None:
                if budget and currency and currency not in CURRENCY_TO_USD:
                    skipped_unsupported_currency_rows += 1
                elif budget and not currency:
                    skipped_unknown_currency_rows += 1
                elif not budget:
                    skipped_missing_budget_rows += 1
                else:
                    skipped_unparseable_budget_rows += 1
                continue

            bid_count = _number(row.get("bid_count"))
            usable_row_count += 1
            for tag in tags:
                tag_groups = grouped.setdefault(tag, {"A": _empty_group_metrics(), "B": _empty_group_metrics()})
                metrics = tag_groups[group]
                metrics["jobs"] += 1
                if budget_usd is not None:
                    metrics["fixed"].append(budget_usd)
                if hourly_usd is not None:
                    metrics["hourly"].append(hourly_usd)
                if bid_avg_usd is not None:
                    metrics["bids"].append(bid_avg_usd)
                if bid_count is not None:
                    metrics["bid_counts"].append(bid_count)

        qualified = [
            (tag, metrics)
            for tag, metrics in grouped.items()
            if any(
                max(len(group_metrics["fixed"]), len(group_metrics["hourly"]), len(group_metrics["bids"])) >= MIN_PRICE_SAMPLES
                for group_metrics in metrics.values()
            )
        ]
        qualified.sort(key=lambda item: (-item[1]["A"]["jobs"], item[0]))
        if compact:
            qualified = [
                item for item in qualified
                if max(len(item[1]["A"][key]) for key in ("fixed", "hourly", "bids")) >= MIN_PRICE_SAMPLES
            ][:6]
        else:
            qualified = qualified[:12]
        heading = f"📊 تقرير أسعار الوظايف المفتوحة — آخر {days} يوم"

        if not qualified:
            text = (
                f"{heading}\nلسه مفيش بيانات كفاية: عندي "
                f"{usable_row_count} وظيفة فيها سعر قابل للحساب، والتقرير هيتحسن مع تشغيل البوت."
            )
            return "\n".join([
                text,
                *_report_footer(
                    skipped_unknown_currency_rows,
                    skipped_unsupported_currency_rows,
                    skipped_missing_budget_rows,
                    skipped_unparseable_budget_rows,
                ),
            ])

        lines = [heading]
        for tag, metrics in qualified:
            if compact:
                strong = metrics["A"]
                total_a_samples = max(len(strong[key]) for key in ("fixed", "hourly", "bids"))
                fixed = _metric_text("ثابت", strong["fixed"], lambda values: _usd_text(statistics.median(values)))
                hourly = _metric_text("ساعي", strong["hourly"], lambda values: f"{_usd_text(statistics.median(values))}/س")
                bid_median = _metric_text("عروض وسيط", strong["bids"], lambda values: _usd_text(statistics.median(values)))
                bid_average = _metric_text("متوسط", strong["bids"], lambda values: _usd_text(statistics.mean(values)))
                bid_count = _metric_text("عدد عروض", strong["bid_counts"], lambda values: f"{statistics.mean(values):.1f}")
                lines.append(
                    f"{tag} ({strong['jobs']} وظيفة؛ عينة {total_a_samples}) | "
                    f"{fixed} | {hourly} | {bid_median} | {bid_average} | {bid_count}"
                )
                continue

            jobs_total = metrics["A"]["jobs"] + metrics["B"]["jobs"]
            lines.append(f"{tag} — {jobs_total} وظيفة قابلة للحساب")
            lines.extend(_group_report_lines("دولار وعملات قوية", metrics["A"]))
            lines.extend(_group_report_lines("روبية وعملات تانية", metrics["B"]))
        lines.extend(
            _report_footer(
                skipped_unknown_currency_rows,
                skipped_unsupported_currency_rows,
                skipped_missing_budget_rows,
                skipped_unparseable_budget_rows,
            )
        )
        return "\n".join(lines)
    except Exception as exc:
        print(f"Price report failed: {type(exc).__name__}")
        return "⚠️ مقدرتش أجهز تقرير الأسعار دلوقتي. جرّب تاني بعد شوية."


def budget_to_usd(budget, currency=None):
    """Parse a confirmed range format and convert it, excluding hourly budgets."""
    try:
        match = _BUDGET_RANGE.fullmatch(budget) if isinstance(budget, str) else None
        if not match:
            return None
        detected_currency = (match.group("code") or "").upper()
        symbol = match.group("symbol1") or match.group("symbol2")
        if symbol:
            symbol_currency = CURRENCY_SYMBOL_TO_CODE.get(symbol)
            if detected_currency and detected_currency != symbol_currency:
                return None
            detected_currency = detected_currency or symbol_currency or ""
        selected_currency = str(currency or detected_currency).strip().upper()
        converted = _budget_midpoint_usd(budget, selected_currency)
        return converted if converted is not None and math.isfinite(converted) else None
    except Exception:
        return None


def get_market_medians(days=PRICE_REPORT_DEFAULT_DAYS, db_path=None) -> dict:
    """Return bid-average medians plus a fixed-budget fallback per tag."""
    try:
        rows = get_price_rows(days, db_path=db_path)
        grouped = {}
        for row in rows:
            budget = row.get("budget")
            currency = currency_for_budget(budget, row.get("currency")) or ""
            group = _currency_group(currency)
            if currency not in CURRENCY_TO_USD or group is None:
                continue
            bid_avg = _number(row.get("bid_avg"))
            bid_usd = bid_avg * CURRENCY_TO_USD[currency] if bid_avg is not None else None
            budget_usd = _budget_midpoint_usd(budget, currency)
            for tag in _tags_from_json(row.get("tags")):
                tag_groups = grouped.setdefault(tag, {"A": {"bids": [], "budgets": []}, "B": {"bids": [], "budgets": []}})
                metrics = tag_groups[group]
                if bid_usd is not None:
                    metrics["bids"].append(bid_usd)
                if budget_usd is not None:
                    metrics["budgets"].append(budget_usd)
        result = {}
        for tag, groups in grouped.items():
            strong = groups["A"]
            other = groups["B"]
            strong_bids = strong["bids"]
            strong_budgets = strong["budgets"]
            other_bids = other["bids"]
            other_budgets = other["budgets"]
            if all(len(values) < MIN_PRICE_SAMPLES for values in (strong_bids, strong_budgets, other_bids, other_budgets)):
                continue
            result[tag] = {
                "median_bid_avg_usd": statistics.median(strong_bids) if len(strong_bids) >= MIN_PRICE_SAMPLES else None,
                "samples": len(strong_bids),
                "median_budget_usd": statistics.median(strong_budgets) if len(strong_budgets) >= MIN_PRICE_SAMPLES else None,
                "budget_samples": len(strong_budgets),
                "group_b_median_bid_avg_usd": statistics.median(other_bids) if len(other_bids) >= MIN_PRICE_SAMPLES else None,
                "group_b_samples": len(other_bids),
                "group_b_median_budget_usd": statistics.median(other_budgets) if len(other_budgets) >= MIN_PRICE_SAMPLES else None,
                "group_b_budget_samples": len(other_budgets),
            }
        return result
    except Exception as exc:
        print(f"Market medians unavailable: {type(exc).__name__}")
        return {}
