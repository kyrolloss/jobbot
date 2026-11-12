import json
import json as json_module
import tempfile
import sqlite3
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import config
import db
import radar
from models import Job


class RadarTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_db = db.DB_PATH
        db.DB_PATH = Path(self.temp.name) / "radar-test.sqlite"
        original_connect = db._connect
        class ClosingConnection:
            def __init__(self, connection):
                self.connection = connection
            def __getattr__(self, name):
                return getattr(self.connection, name)
            def __enter__(self):
                self.connection.__enter__()
                return self
            def __exit__(self, *args):
                try:
                    return self.connection.__exit__(*args)
                finally:
                    self.connection.close()
            def close(self):
                self.connection.close()
        self.old_connect = db._connect
        db._connect = lambda: ClosingConnection(original_connect())
        self.old_settings = radar.SETTINGS_PATH
        radar.SETTINGS_PATH = Path(self.temp.name) / "settings.json"
        with db._connect() as conn:
            pass
        self.job = Job("freelancer", "r-1", "Flutter Python Firebase React app", "Build a Flutter mobile app with Python, Firebase, React and API integration", "https://example.invalid/job", "100-200 USD")
        self.now = datetime.now(timezone.utc)

    def tearDown(self):
        db.DB_PATH = self.old_db
        db._connect = self.old_connect
        radar.SETTINGS_PATH = self.old_settings
        self.temp.cleanup()

    def stats(self, bids=1, submitted=None):
        return {"bid_count": bids, "time_submitted": submitted or self.now.timestamp() - 60}

    def test_qualification_reasons(self):
        fresh = self.stats()
        self.assertTrue(radar.qualifies(fresh, 6.0, self.now))
        self.assertFalse(radar.qualifies(self.stats(4), 8, self.now))
        self.assertFalse(radar.qualifies(self.stats(None), 8, self.now))
        self.assertFalse(radar.qualifies(self.stats(1, self.now.timestamp() - 31 * 60), 8, self.now))
        self.assertFalse(radar.qualifies({"bid_count": 1}, 8, self.now))
        self.assertFalse(radar.qualifies(fresh, 5.9, self.now))

    def test_interval_clamps_and_quiet_hours(self):
        with patch.object(config, "RADAR_INTERVAL_SECONDS", 20):
            self.assertEqual(radar.interval_seconds(), 60)
        with patch.object(config, "RADAR_QUIET_HOURS", "00-23"):
            self.assertTrue(radar.in_quiet_hours(self.now))
        with patch.object(config, "RADAR_QUIET_HOURS", ""):
            self.assertFalse(radar.in_quiet_hours(self.now))

    def test_alert_cap_persists_in_database(self):
        db.save(self.job)
        self.assertTrue(db.mark_radar_alert(self.job, self.now.isoformat()))
        since = (self.now.replace(microsecond=0)).isoformat()
        self.assertEqual(db.count_radar_alerts_since(since), 1)
        self.assertEqual(db.count_radar_alerts_since(since), 1)  # process restart reads the same persisted DB value.

    def test_seventh_alert_candidate_is_sent_normally(self):
        with patch.object(config, "RADAR_MAX_ALERTS_PER_HOUR", 6):
            for index in range(6):
                job = Job("freelancer", f"old-{index}", "Flutter", "", "https://example.invalid", "")
                db.save(job)
                db.mark_radar_alert(job, self.now.isoformat())
            class FakeSource:
                def fetch(self):
                    return [self.job]
                def fetch_details(self, job):
                    return job
                def fetch_stats(self, job):
                    return {"bid_count": 1, "time_submitted": self.now.timestamp() - 60}
            source = FakeSource()
            source.job, source.now = self.job, self.now
            prefixes = []
            with patch.object(radar, "send_job", side_effect=lambda job, prefix="": prefixes.append(prefix) or True), \
                 patch.object(radar, "_rotating_queries", return_value=["flutter"]):
                self.assertTrue(radar.run_cycle(source, now=self.now))
            self.assertEqual(prefixes, [""])
            self.assertEqual(db.count_radar_alerts_since(self.now.replace(microsecond=0).isoformat()), 6)

    def test_gemini_failure_keeps_alert_and_sends_fallback(self):
        class FakeSource:
            def fetch(self):
                return [self.job]
            def fetch_details(self, job):
                return job
            def fetch_stats(self, job):
                return {"bid_count": 1, "time_submitted": self.now.timestamp() - 60}
        source = FakeSource()
        source.job, source.now = self.job, self.now
        prefixes, notices = [], []
        with patch.object(radar, "send_job", side_effect=lambda job, prefix="": prefixes.append(prefix) or True), \
             patch.object(radar, "send_radar_proposal", side_effect=RuntimeError("quota")), \
             patch("bot._api", side_effect=lambda method, data: notices.append(data["text"])), \
             patch.object(radar, "_rotating_queries", return_value=["flutter"]):
            self.assertTrue(radar.run_cycle(source, now=self.now))
        self.assertEqual(prefixes, ["⚡ رادار السرعة\n"])
        self.assertTrue(any("تقدر تستخدم زر" in text for text in notices))

    def test_sample_has_exact_freelancer_submit_time_field(self):
        sample_path = Path(__file__).with_name("samples") / "freelancer_sample.json"
        sample = json_module.loads(sample_path.read_text(encoding="utf-8"))
        project = sample["result"]["projects"][0]
        self.assertIn("time_submitted", project)
        self.assertIn("time_submitted", __import__("sources.freelancer", fromlist=["parse_stats"]).parse_stats(sample, str(project["id"])) )

    def test_cycle_processes_and_sends_alert_without_auto_submit(self):
        class FakeSource:
            def fetch(self):
                return [self.job]
            def fetch_details(self, job):
                return job
            def fetch_stats(self, job):
                return {"bid_count": 1, "bid_avg": 80, "currency": "USD", "time_submitted": self.now.timestamp() - 60}
        source = FakeSource()
        source.job = self.job
        source.now = self.now
        sent = []
        with patch.object(radar, "send_job", side_effect=lambda job, prefix="": sent.append(prefix) or True), \
             patch.object(radar, "send_radar_proposal", return_value=True), \
             patch.object(config, "RADAR_AUTO_PROPOSAL", True), \
             patch.object(radar, "_rotating_queries", return_value=["flutter"]):
            self.assertTrue(radar.run_cycle(source, now=self.now))
        self.assertEqual(sent, ["⚡ رادار السرعة\n"])
        self.assertEqual(db.count_radar_alerts_since(self.now.replace(microsecond=0).isoformat()), 1)

    def test_duplicate_is_not_sent_twice(self):
        db.save(self.job)
        class FakeSource:
            def fetch(self):
                return [self.job]
        source = FakeSource()
        source.job = self.job
        with patch.object(radar, "send_job") as send, patch.object(radar, "_rotating_queries", return_value=["flutter"]):
            radar.run_cycle(source, now=self.now)
        send.assert_not_called()

    def test_lock_busy_and_backoff(self):
        self.assertTrue(radar.SCAN_LOCK.acquire(blocking=False))
        try:
            self.assertFalse(radar.run_cycle(source=object()))
        finally:
            radar.SCAN_LOCK.release()
        with patch.object(radar, "SCAN_LOCK") as lock:
            lock.acquire.return_value = True
            lock.release = lambda: None
            with patch.object(radar, "_rotating_queries", side_effect=RuntimeError("network")):
                old = radar._backoff_seconds
                self.assertFalse(radar.run_cycle(source=object()))
                self.assertEqual(radar._backoff_seconds, min(900, max(60, old * 2)))

    def test_http_429_backoff_and_success_reset(self):
        class FakeSource:
            def fetch(self):
                import sources.freelancer as module
                module.print("Freelancer query failed: HTTP 429")
                return []
        with patch.object(radar, "_rotating_queries", return_value=["flutter"]):
            old = radar._backoff_seconds
            radar.run_cycle(FakeSource(), now=self.now)
            self.assertEqual(radar._backoff_seconds, min(900, max(60, old * 2)))
            class GoodSource:
                def fetch(self):
                    return []
            radar.run_cycle(GoodSource(), now=self.now)
            self.assertEqual(radar._backoff_seconds, radar.interval_seconds())

    def test_settings_commands_persist(self):
        replies = []
        send = lambda chat, text: replies.append((chat, text))
        radar.handle_command(1, ["on"], send)
        self.assertTrue(json.loads(radar.SETTINGS_PATH.read_text(encoding="utf-8"))["radar_enabled"])
        radar.handle_command(1, [], send)
        self.assertIn("شغال", replies[-1][1])
        radar.handle_command(1, ["off"], send)
        self.assertFalse(json.loads(radar.SETTINGS_PATH.read_text(encoding="utf-8"))["radar_enabled"])


if __name__ == "__main__":
    unittest.main()
