import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import db
import timing
from models import Job


try:
    ZoneInfo("Africa/Cairo")
    CAIRO_ZONE_AVAILABLE = True
except ZoneInfoNotFoundError:
    CAIRO_ZONE_AVAILABLE = False


class TimingTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "timing.sqlite3"
        connection = sqlite3.connect(self.db_path)
        connection.execute(
            """CREATE TABLE jobs (
                source TEXT, external_id TEXT, title TEXT, description TEXT,
                url TEXT, budget TEXT, status TEXT, created_at TEXT,
                proposal TEXT, message_id INTEGER, evaluation TEXT,
                bid_count INTEGER, bid_avg REAL, score REAL, score_line TEXT,
                tags TEXT, currency TEXT, posted_at TEXT, applied_at TEXT,
                PRIMARY KEY (source, external_id)
            )"""
        )
        connection.commit()
        connection.close()

    def tearDown(self):
        self.temp_dir.cleanup()

    def add_row(self, external_id, posted_at, score=0, status="sent", applied_at=None, created_at=None):
        if created_at is None:
            created_at = (datetime.fromisoformat(posted_at) - timedelta(days=4)).isoformat()
        connection = sqlite3.connect(self.db_path)
        connection.execute(
            """INSERT INTO jobs
               (source, external_id, title, description, url, budget, status,
                created_at, score, posted_at, applied_at)
               VALUES ('test', ?, '', '', '', '', ?, ?, ?, ?, ?)""",
            (external_id, status, created_at, score, posted_at, applied_at),
        )
        connection.commit()
        connection.close()

    def build_report_in_utc(self, days=30):
        with patch.object(timing, "ZoneInfo", return_value=timezone.utc):
            return timing.build_timing_report(days, db_path=self.db_path)

    @unittest.skipUnless(CAIRO_ZONE_AVAILABLE, "tzdata is required for Africa/Cairo rules")
    def test_cairo_conversion_crosses_utc_date_boundary(self):
        cairo = ZoneInfo("Africa/Cairo")
        posted = datetime(2024, 1, 15, 22, 30, tzinfo=timezone.utc)
        local = posted.astimezone(cairo)
        self.assertEqual((2024, 1, 16, 0, 30), (local.year, local.month, local.day, local.hour, local.minute))

    def test_top_three_ordering_for_high_score_jobs(self):
        now = datetime.now(timezone.utc)
        monday = (now - timedelta(days=now.weekday())).replace(hour=9, minute=0, second=0, microsecond=0)
        if monday > now:
            monday -= timedelta(days=7)
        tuesday = monday + timedelta(days=1)
        wednesday = monday + timedelta(days=2)
        times = [
            monday.replace(hour=9), monday.replace(hour=9), monday.replace(hour=9),
            tuesday.replace(hour=10), tuesday.replace(hour=10), wednesday.replace(hour=11),
        ]
        for index, posted in enumerate(times):
            self.add_row(f"high-{index}", posted.isoformat(), score=8)
        for index in range(4):
            posted = monday.replace(hour=14 + (index % 2))
            self.add_row(f"low-{index}", posted.isoformat(), score=4)

        report = self.build_report_in_utc()
        self.assertIn("أفضل 3 ساعات — وظايف عالية الدرجة:", report)
        self.assertLess(report.index("09:00"), report.index("10:00"))
        self.assertIn("09:00 ██████████ 3", report)
        self.assertIn("10:00 ███████ 2", report)
        self.assertIn("11:00 ███ 1", report)
        self.assertLess(report.index("الإثنين ██████████ 3"), report.index("التلات ███████ 2"))
        self.assertLess(report.index("التلات ███████ 2"), report.index("الأربع ███ 1"))

    def test_high_score_chart_falls_back_to_all_jobs(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        for index in range(10):
            posted = now - timedelta(hours=index + 1)
            self.add_row(f"all-{index}", posted.isoformat(), score=8 if index < 2 else 3)
        report = self.build_report_in_utc()
        self.assertIn("أفضل 3 ساعات — كل الوظايف (العالية أقل من 5):", report)
        self.assertIn("أفضل 3 أيام — كل الوظايف (العالية أقل من 5):", report)

    def test_applied_speed_uses_median_and_advice(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        for index, gap in enumerate((10, 30, 300)):
            posted = now - timedelta(days=1, hours=index)
            applied = posted + timedelta(minutes=gap)
            self.add_row(
                f"applied-{index}",
                posted.isoformat(),
                score=8,
                status="applied",
                applied_at=applied.isoformat(),
            )
        for index in range(7):
            self.add_row(f"extra-{index}", (now - timedelta(hours=index + 2)).isoformat(), score=2)
        report = self.build_report_in_utc()
        self.assertIn("سرعة التقديم: الوسيط 30 دقيقة (3 وظيفة). كويس", report)

    def test_not_enough_data_message(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        for index in range(9):
            self.add_row(f"few-{index}", (now - timedelta(hours=index + 1)).isoformat())
        report = self.build_report_in_utc()
        self.assertIn("لسه البيانات قليلة: عندي 9 وظيفة", report)

    def test_old_table_migration_posted_backfill_and_applied_timestamp(self):
        legacy_db = self.db_path.with_name("legacy.sqlite3")
        connection = sqlite3.connect(legacy_db)
        connection.execute(
            """CREATE TABLE jobs (
                source TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL,
                description TEXT NOT NULL, url TEXT NOT NULL, budget TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                proposal TEXT, message_id INTEGER, evaluation TEXT, bid_count INTEGER,
                bid_avg REAL, score REAL, score_line TEXT, tags TEXT, currency TEXT,
                PRIMARY KEY (source, external_id)
            )"""
        )
        connection.execute(
            "INSERT INTO jobs (source, external_id, title, description, url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("freelancer", "old", "Old", "", "https://example.invalid", "sent", "2026-11-01 12:00:00"),
        )
        connection.commit()
        connection.close()

        with patch.object(db, "DB_PATH", legacy_db):
            self.assertEqual(1, db.backfill_posted_at())
            self.assertEqual(0, db.backfill_posted_at())
            connection = db._connect()
            try:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
                self.assertIn("posted_at", columns)
                self.assertIn("applied_at", columns)
                row = connection.execute("SELECT posted_at, applied_at FROM jobs WHERE external_id = 'old'").fetchone()
                self.assertEqual("2026-11-01T12:00:00+00:00", row[0])
                self.assertIsNone(row[1])
                connection.commit()
            finally:
                connection.close()

            db.set_status(Job("freelancer", "old", "Old", "", "https://example.invalid"), "applied")
            connection = sqlite3.connect(legacy_db)
            try:
                applied_at = connection.execute("SELECT applied_at FROM jobs WHERE external_id = 'old'").fetchone()[0]
            finally:
                connection.close()
            self.assertTrue(applied_at.endswith("+00:00"))

    def test_source_times_replace_fallback_but_do_not_replace_real_time(self):
        with patch.object(db, "DB_PATH", self.db_path):
            freelancer = Job("freelancer", "freelancer-time", "F", "", "https://example.invalid")
            db.save(freelancer)
            expected = datetime.fromtimestamp(1793474037, timezone.utc).replace(microsecond=0).isoformat()
            self.assertTrue(db.save_posted_at(freelancer, {"time_submitted": 1793474037}))
            self.assertFalse(db.save_posted_at(freelancer, {"time_submitted": 1793475000}))

            mostaql = Job("mostaql", "mostaql-time", "M", "", "https://example.invalid")
            db.save(mostaql)
            self.assertTrue(db.save_posted_at(mostaql, {"age_hours": 6}))

            connection = sqlite3.connect(self.db_path)
            try:
                stored_freelancer = connection.execute(
                    "SELECT posted_at FROM jobs WHERE external_id = 'freelancer-time'"
                ).fetchone()[0]
                stored_mostaql = connection.execute(
                    "SELECT posted_at FROM jobs WHERE external_id = 'mostaql-time'"
                ).fetchone()[0]
            finally:
                connection.close()
            self.assertEqual(expected, stored_freelancer)
            self.assertTrue(stored_mostaql.endswith("+00:00"))


if __name__ == "__main__":
    unittest.main()
