import json
import math
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from models import Job

DB_PATH = Path(__file__).with_name("jobs.db")


def _connect():
    connection = sqlite3.connect(DB_PATH)
    connection.execute(
        """CREATE TABLE IF NOT EXISTS jobs (
            source TEXT NOT NULL,
            external_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            url TEXT NOT NULL,
            budget TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'new',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            proposal TEXT,
            message_id INTEGER,
            evaluation TEXT,
            bid_count INTEGER,
            bid_avg REAL,
            score REAL,
            score_line TEXT,
            tags TEXT,
            currency TEXT,
            PRIMARY KEY (source, external_id)
        )"""
    )
    columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
    if "proposal" not in columns:
        connection.execute("ALTER TABLE jobs ADD COLUMN proposal TEXT")
    if "message_id" not in columns:
        connection.execute("ALTER TABLE jobs ADD COLUMN message_id INTEGER")
    for column, definition in (
        ("evaluation", "TEXT"),
        ("bid_count", "INTEGER"),
        ("bid_avg", "REAL"),
        ("score", "REAL"),
        ("score_line", "TEXT"),
        ("tags", "TEXT"),
        ("currency", "TEXT"),
        ("posted_at", "TEXT"),
        ("applied_at", "TEXT"),
        ("estimate", "TEXT"),
        ("prototype_url", "TEXT"),
        ("radar_alerted_at", "TEXT"),
    ):
        if column not in columns:
            try:
                connection.execute(f"ALTER TABLE jobs ADD COLUMN {column} {definition}")
            except sqlite3.OperationalError:
                pass
    return connection


def is_new(job: Job) -> bool:
    with _connect() as connection:
        row = connection.execute(
            "SELECT 1 FROM jobs WHERE source = ? AND external_id = ?",
            (job.source, job.external_id),
        ).fetchone()
    return row is None


def save(job: Job, status: str = "new", tags: list[str] | None = None) -> None:
    tags_json = json.dumps(tags or [], ensure_ascii=False)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    created_at = now.strftime("%Y-%m-%d %H:%M:%S")
    posted_at = now.isoformat()
    connection = _connect()
    try:
        connection.execute(
            """INSERT OR IGNORE INTO jobs
               (source, external_id, title, description, url, budget, status, tags, created_at, posted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (job.source, job.external_id, job.title, job.description, job.url, job.budget, status, tags_json, created_at, posted_at),
        )
        connection.commit()
    finally:
        connection.close()


def get_jobs_by_status(status: str) -> list[Job]:
    with _connect() as connection:
        rows = connection.execute(
            """SELECT source, external_id, title, description, url, budget
               FROM jobs WHERE status = ? ORDER BY created_at, rowid""",
            (status,),
        ).fetchall()
    return [Job(*row) for row in rows]


def set_status(job: Job, status: str) -> None:
    applied_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    connection = _connect()
    try:
        connection.execute(
            """UPDATE jobs SET status = ?,
                      applied_at = CASE
                          WHEN ? = 'applied' AND (applied_at IS NULL OR TRIM(applied_at) = '') THEN ?
                          ELSE applied_at
                      END
               WHERE source = ? AND external_id = ?""",
            (status, status, applied_at, job.source, job.external_id),
        )
        connection.commit()
    finally:
        connection.close()


def _posted_at_from_stats(source: str, stats: dict) -> str | None:
    try:
        if source == "freelancer" and stats.get("time_submitted") is not None:
            timestamp = float(stats["time_submitted"])
            if not math.isfinite(timestamp) or timestamp <= 0:
                return None
            posted = datetime.fromtimestamp(timestamp, timezone.utc)
        elif source == "mostaql" and stats.get("age_hours") is not None:
            age_hours = float(stats["age_hours"])
            if not math.isfinite(age_hours) or age_hours < 0:
                return None
            posted = datetime.now(timezone.utc) - timedelta(hours=age_hours)
        else:
            return None
        return posted.replace(microsecond=0).isoformat()
    except (OverflowError, OSError, TypeError, ValueError):
        return None


def save_posted_at(job: Job, stats: dict) -> bool:
    """Save a source-reported posting time without replacing a prior real time."""
    try:
        posted_at = _posted_at_from_stats(job.source, stats or {})
        if posted_at is None:
            return False
        connection = _connect()
        try:
            cursor = connection.execute(
                """UPDATE jobs SET posted_at = ?
                   WHERE source = ? AND external_id = ?
                     AND (posted_at IS NULL OR datetime(posted_at) = datetime(created_at))""",
                (posted_at, job.source, job.external_id),
            )
            connection.commit()
            return cursor.rowcount > 0
        finally:
            connection.close()
    except Exception as exc:
        print(f"Could not save posted_at: {type(exc).__name__}")
        return False


def save_stats(job: Job, stats: dict) -> bool:
    """Persist available scan stats without replacing stored values with empties."""
    try:
        stats = stats if isinstance(stats, dict) else {}
        available = {
            "bid_count": stats.get("bid_count"),
            "bid_avg": stats.get("bid_avg"),
            "currency": stats.get("currency"),
        }
        values = {}
        for field, value in available.items():
            if value is None or (isinstance(value, str) and not value.strip()):
                continue
            values[field] = value.strip() if isinstance(value, str) else value
        if not values:
            return False

        connection = _connect()
        try:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
            values = {field: value for field, value in values.items() if field in columns}
            if not values:
                return False
            assignments = ", ".join(f'"{field}" = ?' for field in values)
            cursor = connection.execute(
                f"UPDATE jobs SET {assignments} WHERE source = ? AND external_id = ?",
                (*values.values(), job.source, job.external_id),
            )
            connection.commit()
            return cursor.rowcount > 0
        finally:
            connection.close()
    except Exception as exc:
        print(f"Could not save job stats: {type(exc).__name__}")
        return False


def get_job_status(source: str, external_id: str) -> str | None:
    with _connect() as connection:
        row = connection.execute(
            "SELECT status FROM jobs WHERE source = ? AND external_id = ?",
            (source, external_id),
        ).fetchone()
    return row[0] if row else None


def get_job_by_rowid(rowid: int) -> Job | None:
    with _connect() as connection:
        row = connection.execute(
            "SELECT source, external_id, title, description, url, budget FROM jobs WHERE rowid = ?",
            (rowid,),
        ).fetchone()
    return Job(*row) if row else None


def get_job(source: str, external_id: str) -> Job | None:
    with _connect() as connection:
        row = connection.execute(
            "SELECT source, external_id, title, description, url, budget FROM jobs WHERE source = ? AND external_id = ?",
            (source, external_id),
        ).fetchone()
    return Job(*row) if row else None


def get_job_rowid(job: Job) -> int | None:
    with _connect() as connection:
        row = connection.execute(
            "SELECT rowid FROM jobs WHERE source = ? AND external_id = ?",
            (job.source, job.external_id),
        ).fetchone()
    return row[0] if row else None


def save_score(job: Job, score: float, score_line: str) -> None:
    with _connect() as connection:
        connection.execute(
            "UPDATE jobs SET score = ?, score_line = ? WHERE source = ? AND external_id = ?",
            (score, score_line, job.source, job.external_id),
        )


def get_job_score(job: Job) -> tuple[float, str] | None:
    with _connect() as connection:
        row = connection.execute(
            "SELECT score, score_line FROM jobs WHERE source = ? AND external_id = ?",
            (job.source, job.external_id),
        ).fetchone()
    return (row[0], row[1] or "") if row and row[0] is not None else None


def mark_radar_alert(job: Job, timestamp: str | None = None) -> bool:
    timestamp = timestamp or datetime.now(timezone.utc).isoformat(timespec="seconds")
    try:
        with _connect() as connection:
            cursor = connection.execute(
                "UPDATE jobs SET radar_alerted_at = ? WHERE source = ? AND external_id = ? AND radar_alerted_at IS NULL",
                (timestamp, job.source, job.external_id),
            )
        return cursor.rowcount > 0
    except Exception as exc:
        print(f"Radar alert timestamp save failed: {type(exc).__name__}")
        return False


def count_radar_alerts_since(since: str) -> int:
    try:
        with _connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) FROM jobs WHERE radar_alerted_at >= ?", (since,)
            ).fetchone()
        return int(row[0] or 0)
    except Exception as exc:
        print(f"Radar alert count failed: {type(exc).__name__}")
        return 0


def get_proposal(rowid: int) -> str | None:
    with _connect() as connection:
        row = connection.execute(
            "SELECT proposal FROM jobs WHERE rowid = ?",
            (rowid,),
        ).fetchone()
    return row[0] if row else None


def get_sent_jobs_without_proposal(limit: int = 5) -> list[tuple[int, Job]]:
    with _connect() as connection:
        rows = connection.execute(
            """SELECT rowid, source, external_id, title, description, url, budget
               FROM jobs
               WHERE status = 'sent' AND (proposal IS NULL OR TRIM(proposal) = '')
               ORDER BY created_at, rowid
               LIMIT ?""",
            (max(0, min(limit, 5)),),
        ).fetchall()
    return [(row[0], Job(*row[1:])) for row in rows]


def get_message_id(rowid: int) -> int | None:
    with _connect() as connection:
        row = connection.execute(
            "SELECT message_id FROM jobs WHERE rowid = ?",
            (rowid,),
        ).fetchone()
    return row[0] if row else None


def set_message_id(rowid: int, message_id: int) -> None:
    with _connect() as connection:
        connection.execute(
            "UPDATE jobs SET message_id = ? WHERE rowid = ?",
            (message_id, rowid),
        )


def save_proposal(rowid: int, text: str, overwrite: bool = False) -> bool:
    try:
        with _connect() as connection:
            if overwrite:
                cursor = connection.execute("UPDATE jobs SET proposal = ? WHERE rowid = ?", (text, rowid))
            else:
                cursor = connection.execute(
                    "UPDATE jobs SET proposal = ? WHERE rowid = ? AND proposal IS NULL",
                    (text, rowid),
                )
        return cursor.rowcount > 0
    except Exception as exc:
        print(f"Could not save proposal: {type(exc).__name__}")
        return False


def save_prototype_url(rowid: int, url: str) -> bool:
    try:
        connection = _connect()
        try:
            cursor = connection.execute(
                "UPDATE jobs SET prototype_url = ? WHERE rowid = ?",
                (url, rowid),
            )
            connection.commit()
            return cursor.rowcount > 0
        finally:
            connection.close()
    except Exception as exc:
        print(f"Could not save prototype URL: {type(exc).__name__}")
        return False


def get_prototype_url(rowid: int) -> str | None:
    try:
        connection = _connect()
        try:
            row = connection.execute(
                "SELECT prototype_url FROM jobs WHERE rowid = ?", (rowid,)
            ).fetchone()
            return row[0] if row and row[0] else None
        finally:
            connection.close()
    except Exception as exc:
        print(f"Could not load prototype URL: {type(exc).__name__}")
        return None


def save_estimate(rowid: int, estimate_dict: dict) -> None:
    try:
        payload = json.dumps(estimate_dict, ensure_ascii=False, allow_nan=False)
        connection = _connect()
        try:
            connection.execute(
                "UPDATE jobs SET estimate = ? WHERE rowid = ?",
                (payload, rowid),
            )
            connection.commit()
        finally:
            connection.close()
    except Exception as exc:
        print(f"Could not save estimate: {type(exc).__name__}")


def get_estimate(rowid: int) -> dict | None:
    try:
        connection = _connect()
        try:
            row = connection.execute(
                "SELECT estimate FROM jobs WHERE rowid = ?", (rowid,)
            ).fetchone()
        finally:
            connection.close()
        if not row or not row[0]:
            return None
        parsed = json.loads(row[0])
        return parsed if isinstance(parsed, dict) else None
    except Exception as exc:
        print(f"Could not load estimate: {type(exc).__name__}")
        return None


def save_evaluation(rowid: int, evaluation: dict, stats: dict) -> None:
    with _connect() as connection:
        source_row = connection.execute(
            "SELECT source FROM jobs WHERE rowid = ?", (rowid,)
        ).fetchone()
        posted_at = _posted_at_from_stats(source_row[0], stats or {}) if source_row else None
        connection.execute(
            """UPDATE jobs
               SET evaluation = ?, bid_count = COALESCE(?, bid_count),
                   bid_avg = COALESCE(?, bid_avg),
                   currency = COALESCE(NULLIF(TRIM(?), ''), currency),
                   posted_at = CASE
                       WHEN ? IS NOT NULL AND (posted_at IS NULL OR datetime(posted_at) = datetime(created_at)) THEN ?
                       ELSE posted_at
                   END
               WHERE rowid = ?""",
            (
                json.dumps(evaluation, ensure_ascii=False),
                stats.get("bid_count"),
                stats.get("bid_avg"),
                stats.get("currency"),
                posted_at,
                posted_at,
                rowid,
            ),
        )


def backfill_tags() -> int:
    """Populate missing tag JSON for existing jobs; safe to call repeatedly."""
    try:
        from tech import extract_tags

        connection = _connect()
        try:
            rows = connection.execute(
                "SELECT rowid, title, description FROM jobs WHERE tags IS NULL OR TRIM(tags) = '' OR tags = '[]'"
            ).fetchall()
            updated = 0
            for rowid, title, description in rows:
                class _StoredJob:
                    pass

                job = _StoredJob()
                job.title = title
                job.description = description
                tags = extract_tags(job)
                connection.execute(
                    "UPDATE jobs SET tags = ? WHERE rowid = ?",
                    (json.dumps(tags, ensure_ascii=False), rowid),
                )
                updated += 1
            connection.commit()
        finally:
            connection.close()
        return updated
    except Exception as exc:
        print(f"Tag backfill failed: {type(exc).__name__}")
        return 0


def count_by_status() -> dict[str, int]:
    with _connect() as connection:
        rows = connection.execute(
            "SELECT status, COUNT(*) FROM jobs GROUP BY status"
        ).fetchall()
    counts = dict(rows)
    return {status: counts.get(status, 0) for status in ("new", "sent", "approved", "applied", "rejected", "skipped")}


def get_price_rows(days: int, db_path=None) -> list[dict]:
    """Read recent price-related fields without creating or migrating a database."""
    path = Path(db_path) if db_path is not None else DB_PATH
    if not path.is_file():
        return []
    connection = sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        if "jobs" not in tables:
            return []
        columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
        fields = ("created_at", "tags", "budget", "currency", "bid_avg", "bid_count")
        selected = [f'"{field}"' if field in columns else f'NULL AS "{field}"' for field in fields]
        days_modifier = f"-{max(1, min(int(days), 365))} days"
        return [
            dict(row)
            for row in connection.execute(
                f"SELECT {', '.join(selected)} FROM jobs WHERE created_at >= datetime('now', ?)",
                (days_modifier,),
            )
        ]
    finally:
        connection.close()


def get_timing_rows(days: int, db_path=None) -> list[dict]:
    """Read recent job timing fields without creating or migrating a database."""
    path = Path(db_path) if db_path is not None else DB_PATH
    if not path.is_file():
        return []
    connection = sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        if "jobs" not in tables:
            return []
        columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
        fields = ("created_at", "posted_at", "applied_at", "score", "status")
        selected = [f'"{field}"' if field in columns else f'NULL AS "{field}"' for field in fields]
        days_modifier = f"-{max(1, min(int(days), 365))} days"
        posted_expr = 'COALESCE("posted_at", "created_at")' if "posted_at" in columns else '"created_at"'
        return [
            dict(row)
            for row in connection.execute(
                f"SELECT {', '.join(selected)} FROM jobs "
                f"WHERE datetime({posted_expr}) >= datetime('now', ?) "
                "AND (status IS NULL OR status != 'skipped')",
                (days_modifier,),
            )
        ]
    finally:
        connection.close()


def backfill_posted_at() -> int:
    """Backfill missing posting times from created_at, explicitly a fallback."""
    try:
        connection = _connect()
        try:
            rows = connection.execute(
                "SELECT rowid, created_at FROM jobs WHERE posted_at IS NULL OR TRIM(posted_at) = ''"
            ).fetchall()
            updated = 0
            for rowid, created_at in rows:
                if not created_at:
                    continue
                try:
                    parsed = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=timezone.utc)
                    posted_at = parsed.astimezone(timezone.utc).isoformat(timespec="seconds")
                except (TypeError, ValueError, OverflowError):
                    continue
                cursor = connection.execute(
                    "UPDATE jobs SET posted_at = ? WHERE rowid = ? AND (posted_at IS NULL OR TRIM(posted_at) = '')",
                    (posted_at, rowid),
                )
                updated += cursor.rowcount
            connection.commit()
        finally:
            connection.close()
        return updated
    except Exception as exc:
        print(f"Posted time backfill failed: {type(exc).__name__}")
        return 0
