"""Read-only Python score probe matching parity_check.js reconstruction."""

import json
import re
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from models import Job  # noqa: E402
from score import score_job  # noqa: E402

GENERIC_LINE = "📋 الأرقام مش متاحة، افتح الرابط وشوف العروض والميزانية"


def split_line(line):
    if line == GENERIC_LINE:
        return {"kind": "generic"}
    sections = line.split(" | ")
    if len(sections) != 5 or not re.fullmatch(r"كلمات عنوان \d+/وصف \d+", sections[0]):
        return None
    return {"kind": "metrics", "sections": sections}


def parse_average(section, stats):
    if section == "متوسط غير متاح":
        return True
    value = section[len("متوسط "):]
    match = re.fullmatch(r"([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|nan|inf|-inf|\?)(?: (.*))?", value, re.I)
    if not match:
        return False
    stats["bid_avg"] = "?" if match.group(1) == "?" else float(match.group(1))
    if match.group(2):
        stats["currency"] = match.group(2)
    return True


def build_stats(job, row, parsed):
    if parsed["kind"] == "generic":
        return {}, None
    sections = parsed["sections"]
    budget_text, bids_text, average_text, age_text = sections[1:]
    stats = {"__parityMarker": True}
    if bids_text != "عروض غير متاح":
        if not bids_text.startswith("عروض "):
            return None, "score line has an unparseable bid count"
        count = bids_text[len("عروض "):]
        if not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", count):
            return None, "score line has an unparseable bid count"
        stats["bid_count"] = float(count)
    if not parse_average(average_text, stats):
        return None, "score line has an unparseable bid average"
    if age_text == "العمر غير متاح":
        stats["age_hours"] = "__parity_unavailable__"
    else:
        age = re.fullmatch(r"عمر ([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)س", age_text, re.I)
        if not age:
            return None, "score line has an unparseable age"
        stats["age_hours"] = float(age.group(1))

    amount = re.fullmatch(r"ميزانية≈(.+) USD", budget_text)
    if amount:
        try:
            usd = float(amount.group(1))
        except ValueError:
            return None, "score line has an unparseable budget"
        natural = score_job(job, stats)
        natural_budget = natural["line"].split(" | ")[1]
        if natural_budget != budget_text:
            currency = stats.get("currency")
            if not currency:
                if stats.get("bid_avg") is not None:
                    return None, "budget currency is not recoverable from score line"
                currency = "USD"
                stats["currency"] = currency
            from config import CURRENCY_TO_USD
            rate = CURRENCY_TO_USD.get(currency.upper())
            if not rate:
                return None, "budget currency is not recoverable from score line"
            amount_in_currency = usd / rate
            stats["budget_min"] = amount_in_currency
            stats["budget_max"] = amount_in_currency
    elif budget_text != "ميزانية غير معروفة":
        return None, "score line has an unrecognized budget value"

    if budget_text == "ميزانية غير معروفة" and job.budget:
        natural_budget = score_job(job, stats)["line"].split(" | ")[1]
        if natural_budget != "ميزانية غير معروفة":
            return None, "stored budget conflicts with score line"
    return stats, None


def input_view(job, stats):
    return {
        "source": job.source,
        "external_id": job.external_id,
        "title_length": len(job.title or ""),
        "description_length": len(job.description or ""),
        "budget": job.budget,
        "bid_count": stats.get("bid_count"),
        "bid_avg": stats.get("bid_avg"),
        "currency": stats.get("currency"),
        "age": stats.get("age_hours", stats.get("time_submitted")),
        "stats_used": stats,
    }


def main():
    if not sys.argv[1:]:
        print("Usage: python scripts/py_score_probe.py <rowid> [rowid ...]")
        return
    db_path = PROJECT_ROOT / "jobs.db"
    connection = sqlite3.connect(f"{db_path.as_uri()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        for value in sys.argv[1:]:
            try:
                rowid = int(value)
            except ValueError:
                print(json.dumps({"rowid": value, "error": "rowid must be an integer"}, ensure_ascii=False))
                continue
            row = connection.execute(
                "SELECT rowid,source,external_id,title,description,url,budget,score,score_line "
                "FROM jobs WHERE rowid=?", (rowid,)
            ).fetchone()
            if row is None:
                print(json.dumps({"rowid": rowid, "error": "row not found"}, ensure_ascii=False))
                continue
            job = Job(row["source"], row["external_id"], row["title"], row["description"], row["url"], row["budget"] or "")
            parsed = split_line(row["score_line"] or "")
            if parsed is None:
                print(json.dumps({"rowid": rowid, "title": (job.title or "")[:60], "error": "missing or unrecognized score_line"}, ensure_ascii=False))
                continue
            stats, error = build_stats(job, row, parsed)
            if error:
                print(json.dumps({"rowid": rowid, "title": (job.title or "")[:60], "error": error}, ensure_ascii=False))
                continue
            result = score_job(job, stats)
            print(json.dumps({
                "rowid": rowid,
                "title": (job.title or "")[:60],
                "inputs": input_view(job, stats),
                "stored": {"score": row["score"], "line": row["score_line"]},
                "python": result,
            }, ensure_ascii=False, default=str))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
