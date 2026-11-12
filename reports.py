import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from db import DB_PATH
from prices import build_price_report
from timing import build_timing_report


_SENT_STATUSES = ("sent", "approved", "applied", "rejected")
_NOTE_MARKERS = (
    "الأرقام دي",
    "مش أسعار نهائية",
    "ملاحظة:",
    "مفيش عملة محفوظة",
    "مش موجودة في جدول التحويل",
    "ميزانية ناقصة",
    "سرعة التقديم:",
    "توقيت مصدر مؤكد",
)


def _period_counts(days: int, db_path=None) -> tuple[int, int, int]:
    path = Path(db_path) if db_path is not None else DB_PATH
    if not path.is_file():
        return 0, 0, 0
    connection = sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)
    try:
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'"
        ).fetchone()
        if not table:
            return 0, 0, 0
        columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
        if not {"created_at", "status"}.issubset(columns):
            return 0, 0, 0
        days_modifier = f"-{max(1, min(int(days), 365))} days"
        found = connection.execute(
            "SELECT COUNT(*) FROM jobs WHERE datetime(created_at) >= datetime('now', ?)",
            (days_modifier,),
        ).fetchone()[0]
        sent = connection.execute(
            """SELECT COUNT(*) FROM jobs
               WHERE datetime(created_at) >= datetime('now', ?)
                 AND status IN (?, ?, ?, ?)""",
            (days_modifier, *_SENT_STATUSES),
        ).fetchone()[0]
        applied_time = (
            "COALESCE(NULLIF(applied_at, ''), created_at)"
            if "applied_at" in columns
            else "created_at"
        )
        applied = connection.execute(
            f"""SELECT COUNT(*) FROM jobs
                WHERE status = 'applied'
                  AND datetime({applied_time}) >= datetime('now', ?)
                  AND datetime({applied_time}) <= datetime('now')""",
            (days_modifier,),
        ).fetchone()[0]
        return int(found), int(sent), int(applied)
    finally:
        connection.close()


def _compact_section(text: str, max_lines: int, max_chars: int) -> list[str]:
    lines = [line for line in str(text or "").splitlines() if line.strip()]
    if len(lines) <= max_lines and sum(len(line) + 1 for line in lines) <= max_chars:
        return lines

    required = {0} if lines else set()
    for index, line in enumerate(lines):
        if any(marker in line for marker in _NOTE_MARKERS):
            required.add(index)
        if "أفضل 3" in line:
            required.add(index)
            required.update(range(index + 1, min(index + 4, len(lines))))

    selected = set(required)
    selected_chars = sum(len(lines[index]) + 1 for index in selected if index < len(lines))
    for index, line in enumerate(lines):
        if len(selected) >= max_lines:
            break
        if index in selected:
            continue
        if selected_chars + len(line) + 1 > max_chars:
            continue
        selected.add(index)
        selected_chars += len(line) + 1

    result = [lines[index] for index in sorted(selected) if index < len(lines)]
    if len(result) > max_lines:
        required_lines = [lines[index] for index in sorted(required) if index < len(lines)]
        result = required_lines[:max_lines]
    return result


def build_weekly_report(days=7, db_path=None) -> str:
    try:
        try:
            days = int(days)
        except (TypeError, ValueError, OverflowError):
            days = 7
        days = max(1, min(days, 365))
        now_utc = datetime.now(timezone.utc)
        try:
            now_local = now_utc.astimezone(ZoneInfo("Africa/Cairo"))
            start_local = now_local - timedelta(days=days)
            date_range = f"{start_local:%Y-%m-%d} إلى {now_local:%Y-%m-%d} (القاهرة)"
        except (ZoneInfoNotFoundError, OSError):
            start_utc = now_utc - timedelta(days=days)
            date_range = f"{start_utc:%Y-%m-%d} إلى {now_utc:%Y-%m-%d} (UTC)"

        found, sent, applied = _period_counts(days, db_path=db_path)
        lines = [
            f"📬 التقرير الأسبوعي — {date_range}",
            f"ملخص آخر {days} أيام:",
            f"وظايف اتلاقت: {found}",
            f"وظايف اتبعتت تليجرام: {sent}",
            f"وظايف اتعلم عليها تم التقديم: {applied}",
            "أسعار السوق — آخر 30 يوم:",
        ]
        lines.extend(_compact_section(build_price_report(days=30, db_path=db_path), 12, 1900))
        lines.append("توقيت الوظايف — آخر 30 يوم:")
        lines.extend(_compact_section(build_timing_report(days=30, db_path=db_path), 20, 1300))
        if len(lines) > 40:
            lines = lines[:40]
        result = "\n".join(lines)
        if len(result) > 3800:
            result = result[:3799].rstrip() + "…"
        return result
    except Exception:
        return "⚠️ مقدرتش أجهز التقرير الأسبوعي دلوقتي. جرّب تاني بعد شوية."
