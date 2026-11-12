import re
import time
import threading
from datetime import datetime

from config import (
    KEYWORDS,
    NEGATIVE_KEYWORDS,
    SCORING_STATS_MAX_PER_SCAN,
    SCORING_STATS_MIN_INTERVAL_SECONDS,
)
from db import backfill_posted_at, backfill_tags, get_job_rowid, get_job_score, get_jobs_by_status, is_new, save, save_posted_at, save_score, save_stats, set_status
from notifier import send_job
from sources.freelancer import FreelancerSource
from sources.khamsat import KhamsatSource
from sources.mostaql import Mostaql
from score import score_job
from tech import extract_tags

SOURCES = [Mostaql(), FreelancerSource(), KhamsatSource()]
WHOLE_WORD_KEYWORDS = {"ai", "api", "node"}
_TAG_BACKFILL_STARTED = False
_POSTED_AT_BACKFILL_STARTED = False
SCAN_LOCK = threading.Lock()


def _contains_keyword(text: str, keyword: str) -> bool:
    if keyword.casefold() in WHOLE_WORD_KEYWORDS:
        return re.search(rf"\b{re.escape(keyword)}\b", text, flags=re.IGNORECASE) is not None
    return keyword.casefold() in text.casefold()


def process_new_job(source, job, *, stats_fetch_allowed=True):
    """Shared per-job scan pipeline; returns None for jobs excluded by the broad filter."""
    try:
        job = source.fetch_details(job)
    except Exception as exc:
        print(f"[scan] فشل تفاصيل {source.name}: {type(exc).__name__}")
        return None
    tags = extract_tags(job)
    text = f"{job.title}\n{job.description}".casefold()
    matched = (
        any(_contains_keyword(text, keyword) for keyword in KEYWORDS)
        and not any(_contains_keyword(text, keyword) for keyword in NEGATIVE_KEYWORDS)
    )
    if not matched:
        save(job, status="skipped", tags=tags)
        return {"job": job, "matched": False, "stats": {}, "score": None}
    save(job, status="new", tags=tags)
    stats = {}
    if stats_fetch_allowed:
        try:
            stats = source.fetch_stats(job) or {}
            if not stats:
                print(f"[scan] أرقام {source.name} غير متاحة؛ النقاط بدونها")
        except Exception as exc:
            print(f"[scan] فشل fetch_stats في {source.name}: {type(exc).__name__}")
    try:
        save_stats(job, stats)
    except Exception as exc:
        print(f"[scan] فشل حفظ أرقام {source.name}: {type(exc).__name__}")
    save_posted_at(job, stats)
    scored = score_job(job, stats)
    rowid = get_job_rowid(job)
    if rowid is not None:
        save_score(job, scored["score"], scored["line"])
    return {"job": job, "matched": True, "stats": stats, "score": scored["score"]}


def run_once():
    with SCAN_LOCK:
        return _run_once_locked()


def _run_once_locked():
    global _TAG_BACKFILL_STARTED, _POSTED_AT_BACKFILL_STARTED
    if not _TAG_BACKFILL_STARTED:
        _TAG_BACKFILL_STARTED = True
        try:
            backfill_tags()
        except Exception as exc:
            print(f"[scan] فشل استكمال وسوم الوظايف القديمة: {type(exc).__name__}")
    if not _POSTED_AT_BACKFILL_STARTED:
        _POSTED_AT_BACKFILL_STARTED = True
        try:
            backfill_posted_at()
        except Exception as exc:
            print(f"[scan] فشل استكمال أوقات نشر الوظايف القديمة: {type(exc).__name__}")

    scan_started = time.perf_counter()
    print(f"[scan] بدأ الفحص: {datetime.now().isoformat(timespec='seconds')}")
    candidates = []
    sent_count = 0
    stats_requests = 0
    last_stats_request = None

    for job in get_jobs_by_status("new"):
        saved_score = get_job_score(job)
        candidates.append((job, saved_score[0] if saved_score else None))

    for source in SOURCES:
        fetched_count = new_count = matched_count = skipped_count = 0
        try:
            jobs = source.fetch()
            fetched_count = len(jobs)
        except Exception as exc:
            print(f"[scan] فشل المصدر {source.name}: {type(exc).__name__}")
            print(f"[scan] {source.name}: جُلب 0، جديد 0، مطابق 0، متخطى 0")
            continue

        for job in jobs:
            if not is_new(job):
                continue
            new_count += 1
            allowed = stats_requests < SCORING_STATS_MAX_PER_SCAN
            if allowed:
                if last_stats_request is not None:
                    elapsed = time.monotonic() - last_stats_request
                    remaining = SCORING_STATS_MIN_INTERVAL_SECONDS - elapsed
                    if remaining > 0:
                        time.sleep(remaining)
                stats_requests += 1
                last_stats_request = time.monotonic()
            result = process_new_job(source, job, stats_fetch_allowed=allowed)
            if result is None or not result["matched"]:
                skipped_count += 1
                continue
            matched_count += 1
            candidates.append((result["job"], result["score"]))

        print(
            f"[scan] {source.name}: جُلب {fetched_count}، جديد {new_count}، "
            f"مطابق {matched_count}، متخطى {skipped_count}"
        )

    ranked_candidates = sorted(
        candidates,
        key=lambda candidate: candidate[1] if candidate[1] is not None else -1,
        reverse=True,
    )
    scored_candidates = [candidate for candidate in ranked_candidates if candidate[1] is not None]
    if scored_candidates:
        top_three = " | ".join(
            f"{job.title[:55]} ({score:.1f})" for job, score in scored_candidates[:3]
        )
        print(f"[scan] أعلى 3 نقاط: {top_three}")

    for job, _score in ranked_candidates:
        try:
            if send_job(job):
                set_status(job, "sent")
                sent_count += 1
        except Exception as exc:
            print(f"[scan] فشل إرسال وظيفة: {type(exc).__name__}")

    duration = time.perf_counter() - scan_started
    print(f"[scan] أُرسل {sent_count} | انتهى الفحص خلال {duration:.1f} ثانية")


if __name__ == "__main__":
    run_once()

