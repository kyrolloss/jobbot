"""Fast, opt-in Freelancer scanner. It never submits bids."""
import json
import re
import random
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import config
import sources.freelancer as freelancer_module
from db import count_radar_alerts_since, get_job_rowid, is_new, mark_radar_alert, set_status
from main import SCAN_LOCK, process_new_job
from notifier import send_job, send_radar_proposal
from score import score_job

SETTINGS_PATH = Path(__file__).with_name("settings.json")
_lock = threading.RLock()
_enabled = bool(config.RADAR_ENABLED)
_query_index = 0
_last_cycle = None
_last_error = None
_backoff_seconds = max(60, int(config.RADAR_INTERVAL_SECONDS))
_stop = threading.Event()


def _call_source(callback):
    global _backoff_seconds
    original_printer = getattr(freelancer_module, "print", print)
    messages = []
    def capture(*args, **kwargs):
        messages.append(" ".join(str(item) for item in args))
        original_printer(*args, **kwargs)
    freelancer_module.print = capture
    try:
        result = callback()
    finally:
        try:
            del freelancer_module.print
        except AttributeError:
            freelancer_module.print = original_printer
    issue = next((line for line in messages if re.search(
        r"HTTP (?:429|5\d\d)|(?:failed|unavailable): (?:Connect|Read|Write|RemoteProtocol|Proxy|Network|Timeout)",
        line,
        re.I,
    )), None)
    if issue:
        _backoff_seconds = min(900, max(60, _backoff_seconds * 2))
        _log(f"Freelancer fetch issue: {issue}")
    return result, bool(issue)


def interval_seconds() -> int:
    try:
        return max(60, int(config.RADAR_INTERVAL_SECONDS))
    except Exception:
        return 120


def load_enabled() -> bool:
    global _enabled
    try:
        stored = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        if isinstance(stored.get("radar_enabled"), bool):
            _enabled = stored["radar_enabled"]
    except FileNotFoundError:
        pass
    except Exception as exc:
        _log(f"settings load failed: {type(exc).__name__}")
    return _enabled


def set_enabled(enabled: bool) -> bool:
    global _enabled
    try:
        enabled = bool(enabled)
        settings = {}
        try:
            settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if not isinstance(settings, dict):
                settings = {}
        except FileNotFoundError:
            pass
        settings["radar_enabled"] = enabled
        temp = SETTINGS_PATH.with_suffix(".json.tmp")
        temp.write_text(json.dumps(settings, indent=2), encoding="utf-8")
        temp.replace(SETTINGS_PATH)
        with _lock:
            _enabled = enabled
        return True
    except Exception as exc:
        _log(f"settings save failed: {type(exc).__name__}")
        return False


def _log(message: str) -> None:
    global _last_error
    _last_error = message
    print(f"[radar] {message}")


def _hourly_count(now=None) -> int:
    now = now or datetime.now(timezone.utc)
    return count_radar_alerts_since((now - timedelta(hours=1)).isoformat(timespec="seconds"))


def in_quiet_hours(now=None) -> bool:
    value = str(config.RADAR_QUIET_HOURS or "").strip()
    if not value:
        return False
    try:
        start_text, end_text = value.split("-", 1)
        start, end = int(start_text), int(end_text)
        if not (0 <= start <= 23 and 0 <= end <= 23):
            return False
        local_hour = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo("Africa/Cairo")).hour
        return start <= local_hour < end if start < end else local_hour >= start or local_hour < end
    except Exception:
        return False


def _age_minutes(stats: dict, now=None) -> float | None:
    try:
        submitted = float(stats["time_submitted"])
        if submitted <= 0:
            return None
        return max(0.0, ((now or datetime.now(timezone.utc)).timestamp() - submitted) / 60)
    except (KeyError, TypeError, ValueError, OverflowError, OSError):
        return None


def qualifies(stats: dict, score: float, now=None) -> bool:
    try:
        bids = stats.get("bid_count")
        age = _age_minutes(stats, now)
        return (
            bids is not None and int(bids) <= int(config.RADAR_MAX_BIDS)
            and age is not None and age <= float(config.RADAR_MAX_AGE_MINUTES)
            and float(score) >= float(config.RADAR_MIN_SCORE)
            and not in_quiet_hours(now)
            and _hourly_count(now) < int(config.RADAR_MAX_ALERTS_PER_HOUR)
        )
    except Exception:
        return False


def _rotating_queries() -> list[str]:
    global _query_index
    queries = list(freelancer_module.FREELANCER_QUERIES)
    if not queries:
        return []
    try:
        count = max(1, int(config.RADAR_QUERIES_PER_CYCLE))
    except Exception:
        count = 2
    count = min(count, len(queries))
    selected = [queries[(_query_index + offset) % len(queries)] for offset in range(count)]
    _query_index = (_query_index + count) % len(queries)
    return selected


def run_cycle(source=None, *, now=None) -> bool:
    """Run once; returns False if the regular scanner owns the shared lock."""
    global _last_cycle, _last_error, _backoff_seconds
    if not SCAN_LOCK.acquire(blocking=False):
        return False
    try:
        source = source or freelancer_module.FreelancerSource()
        query_set = _rotating_queries()
        original_queries = freelancer_module.FREELANCER_QUERIES
        freelancer_module.FREELANCER_QUERIES = query_set
        try:
            jobs, fetch_had_error = _call_source(source.fetch)
        finally:
            freelancer_module.FREELANCER_QUERIES = original_queries
        if not fetch_had_error:
            _backoff_seconds = interval_seconds()
            _last_error = None
        _last_cycle = (now or datetime.now(timezone.utc)).isoformat(timespec="seconds")
        for found in jobs:
            try:
                if not is_new(found):
                    continue
                result, stats_had_error = _call_source(lambda: process_new_job(source, found, stats_fetch_allowed=True))
                if stats_had_error:
                    _last_error = _last_error or "Freelancer stats unavailable"
                if not result or not result["matched"]:
                    continue
                job, stats, score = result["job"], result["stats"], result["score"]
                should_alert = qualifies(stats, score, now)
                delivered = send_job(job, prefix="⚡ رادار السرعة\n" if should_alert else "")
                if delivered:
                    set_status(job, "sent")
                    if should_alert:
                        mark_radar_alert(job, (now or datetime.now(timezone.utc)).isoformat(timespec="seconds"))
                        rowid = get_job_rowid(job)
                        if config.RADAR_AUTO_PROPOSAL:
                            try:
                                if not send_radar_proposal(job, rowid):
                                    from bot import _api
                                    _api("sendMessage", {"chat_id": config.TELEGRAM_CHAT_ID, "text": "⚠️ تعذرت كتابة المسودة؛ تقدر تستخدم زر ✅ قدّم."})
                            except Exception as exc:
                                _log(f"proposal failed: {type(exc).__name__}")
                                try:
                                    from bot import _api
                                    _api("sendMessage", {"chat_id": config.TELEGRAM_CHAT_ID, "text": "⚠️ تعذرت كتابة المسودة؛ تقدر تستخدم زر ✅ قدّم."})
                                except Exception:
                                    pass
            except Exception as exc:
                _log(f"job processing failed: {type(exc).__name__}")
        return True
    except Exception as exc:
        _log(f"cycle failed: {type(exc).__name__}")
        _backoff_seconds = min(900, max(60, _backoff_seconds * 2))
        return False
    finally:
        SCAN_LOCK.release()


def status_text() -> str:
    enabled = _enabled
    cap = int(config.RADAR_MAX_ALERTS_PER_HOUR)
    sent = _hourly_count()
    lines = [
        f"رادار السرعة: {'شغال' if enabled else 'موقوف'}",
        f"الفاصل: {interval_seconds()} ثانية | الدرجة: {config.RADAR_MIN_SCORE} | أقصى عروض: {config.RADAR_MAX_BIDS}",
        f"تنبيهات آخر ساعة: {sent}/{cap}",
        f"آخر دورة: {_last_cycle or '—'}",
    ]
    if _last_error:
        lines.append(f"آخر خطأ: {_last_error}")
    return "\n".join(lines)


def handle_command(chat_id, arguments: list[str], send_text) -> None:
    if not arguments:
        send_text(chat_id, status_text())
    elif len(arguments) == 1 and arguments[0].lower() in ("on", "off"):
        enabled = arguments[0].lower() == "on"
        if set_enabled(enabled):
            send_text(chat_id, f"✅ الرادار {'اشتغل' if enabled else 'اتوقف'}.")
        else:
            send_text(chat_id, "⚠️ مقدرتش أحفظ إعداد الرادار.")
    else:
        send_text(chat_id, "استخدم /radar أو /radar on أو /radar off")


def radar_loop() -> None:
    load_enabled()
    while not _stop.is_set():
        if not _enabled:
            _stop.wait(3)
            continue
        try:
            run_cycle()
        except Exception as exc:
            _log(f"thread error: {type(exc).__name__}")
            global _backoff_seconds
            _backoff_seconds = min(900, max(60, _backoff_seconds * 2))
        delay = max(interval_seconds(), _backoff_seconds) + random.uniform(0, 15)
        _stop.wait(delay)

