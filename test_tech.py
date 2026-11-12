import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import db
from models import Job
from tech import extract_tags


class ExtractTagsTests(unittest.TestCase):
    def job(self, title="", description=""):
        return Job("test", "1", title, description, "https://example.invalid")

    def test_short_terms_match_whole_words_only(self):
        self.assertNotIn("api", extract_tags(self.job("rapid")))
        self.assertNotIn("ai-chatbot", extract_tags(self.job("email")))

    def test_arabic_keyword(self):
        self.assertIn("flutter", extract_tags(self.job("مطلوب مطور فلاتر")))

    def test_case_insensitive(self):
        self.assertIn("firebase", extract_tags(self.job("FIREBASE integration")))

    def test_empty_text(self):
        self.assertEqual([], extract_tags(self.job()))

    def test_multiple_tags_are_sorted(self):
        self.assertEqual(
            ["firebase", "flutter", "python"],
            extract_tags(self.job("Flutter and Firebase", "Python backend")),
        )

    def test_migration_and_idempotent_backfill(self):
        with tempfile.TemporaryDirectory() as directory:
            temp_db = Path(directory) / "temporary.sqlite3"
            with patch.object(db, "DB_PATH", temp_db):
                connection = sqlite3.connect(temp_db)
                try:
                    connection.execute(
                        """CREATE TABLE jobs (
                            source TEXT NOT NULL, external_id TEXT NOT NULL,
                            title TEXT NOT NULL, description TEXT NOT NULL,
                            url TEXT NOT NULL, budget TEXT NOT NULL DEFAULT '',
                            status TEXT NOT NULL DEFAULT 'new',
                            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            proposal TEXT, message_id INTEGER, evaluation TEXT,
                            bid_count INTEGER, bid_avg REAL, score REAL,
                            score_line TEXT, PRIMARY KEY (source, external_id)
                        )"""
                    )
                    connection.execute(
                        "INSERT INTO jobs (source, external_id, title, description, url) VALUES (?, ?, ?, ?, ?)",
                        ("test", "old", "Flutter API", "Firebase", "https://example.invalid"),
                    )
                    connection.commit()
                finally:
                    connection.close()

                connection = db._connect()
                try:
                    columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
                    self.assertIn("tags", columns)
                    self.assertIn("currency", columns)
                    connection.commit()
                finally:
                    connection.close()

                self.assertEqual(1, db.backfill_tags())
                self.assertEqual(0, db.backfill_tags())
                connection = sqlite3.connect(temp_db)
                try:
                    stored_tags = connection.execute(
                        "SELECT tags FROM jobs WHERE external_id = 'old'"
                    ).fetchone()[0]
                finally:
                    connection.close()
                self.assertEqual(["api", "firebase", "flutter"], json.loads(stored_tags))


if __name__ == "__main__":
    unittest.main()
