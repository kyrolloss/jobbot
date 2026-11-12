import http.client
import json
import re
import socket
import sqlite3
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import report_server


class ReportServerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "report-tests.sqlite3"
        connection = sqlite3.connect(self.db_path)
        connection.execute(
            """CREATE TABLE jobs (
                source TEXT, external_id TEXT, title TEXT, description TEXT,
                url TEXT, budget TEXT, status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                proposal TEXT, message_id INTEGER, evaluation TEXT, bid_count INTEGER,
                bid_avg REAL, score REAL, score_line TEXT, tags TEXT, currency TEXT,
                posted_at TEXT, applied_at TEXT, estimate TEXT,
                PRIMARY KEY (source, external_id)
            )"""
        )
        connection.execute(
            """INSERT INTO jobs (source, external_id, title, description, url, status, message_id, score,
                                tags, currency, bid_avg, bid_count, posted_at, applied_at)
               VALUES ('test', 'one', 'Flutter', '', '', 'applied', 1, 8,
                       '["flutter"]', 'USD', 100, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"""
        )
        connection.execute(
            """INSERT INTO jobs (source, external_id, title, description, url, status, score,
                                tags, currency, bid_avg, bid_count, posted_at)
               VALUES ('test', 'two', 'Python', '', '', 'new', 2,
                       '["python"]', 'USD', 50, 1, CURRENT_TIMESTAMP)"""
        )
        connection.commit()
        connection.close()

        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.bind(("127.0.0.1", 0))
        self.port = probe.getsockname()[1]
        probe.close()
        self.key = "test-only-report-key-never-real"
        self.server = report_server.create_report_server(
            port=self.port,
            report_key=self.key,
            db_path=self.db_path,
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)
        self.temp_dir.cleanup()

    def request(self, method, path, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        status = response.status
        content_type = response.getheader("Content-Type")
        body = response.read()
        connection.close()
        return status, content_type, body

    def test_authentication_rejects_missing_and_wrong_key(self):
        self.assertEqual(401, self.request("GET", "/report/weekly")[0])
        self.assertEqual(
            401,
            self.request("GET", "/report/weekly", {"X-Report-Key": "wrong"})[0],
        )

    def test_all_three_report_endpoints_return_utf8_json(self):
        headers = {"X-Report-Key": self.key}
        for path in ("/report/weekly", "/report/prices?days=30", "/report/timing?days=30"):
            with self.subTest(path=path):
                status, content_type, body = self.request("GET", path, headers)
                self.assertEqual(200, status)
                self.assertEqual("application/json; charset=utf-8", content_type)
                result = json.loads(body.decode("utf-8"))
                self.assertIsInstance(result.get("text"), str)
        weekly = json.loads(self.request("GET", "/report/weekly", headers)[2].decode("utf-8"))["text"]
        self.assertIn("وظايف اتلاقت: 2", weekly)
        self.assertIn("وظايف اتبعتت تليجرام: 1", weekly)
        self.assertIn("وظايف اتعلم عليها تم التقديم: 1", weekly)
        self.assertLessEqual(len(weekly.splitlines()), 40)
        self.assertIn("الأرقام دي", weekly)
        self.assertIn("سرعة التقديم:", weekly)

    def test_unknown_path_and_non_get_method(self):
        headers = {"X-Report-Key": self.key}
        self.assertEqual(404, self.request("GET", "/unknown", headers)[0])
        self.assertEqual(405, self.request("POST", "/report/weekly", headers)[0])
        self.assertEqual(405, self.request("TRACE", "/report/weekly", headers)[0])
        self.assertEqual(401, self.request("POST", "/report/weekly")[0])

    def test_invalid_days_rejected(self):
        headers = {"X-Report-Key": self.key}
        self.assertEqual(400, self.request("GET", "/report/prices?days=0", headers)[0])
        self.assertEqual(400, self.request("GET", "/report/timing?days=366", headers)[0])

    def test_server_binds_only_to_ipv4_loopback(self):
        self.assertEqual("127.0.0.1", self.server.server_address[0])

    def test_server_is_disabled_without_key_and_logs_one_generic_line(self):
        output = StringIO()
        with patch.object(report_server, "REPORT_API_KEY", ""), redirect_stdout(output):
            result = report_server.serve_report_server()
        self.assertIsNone(result)
        lines = output.getvalue().splitlines()
        self.assertEqual(1, len(lines))
        self.assertIn("Report server disabled", lines[0])
        self.assertNotIn(self.key, output.getvalue())
        self.assertIsNone(report_server.create_report_server(port=0, report_key=""))

    def test_key_is_never_written_to_request_logs(self):
        output = StringIO()
        with redirect_stdout(output):
            self.request("GET", "/report/weekly", {"X-Report-Key": self.key})
        self.assertNotIn(self.key, output.getvalue())
        self.assertIn("Report server request received", output.getvalue())

    def test_internal_error_is_generic_to_client_and_redacted_in_log(self):
        output = StringIO()
        with patch("reports.build_weekly_report", side_effect=RuntimeError(f"failure {self.key}")):
            with redirect_stdout(output):
                status, _content_type, body = self.request(
                    "GET", "/report/weekly", {"X-Report-Key": self.key}
                )
        self.assertEqual(500, status)
        self.assertEqual({"error": "Internal server error"}, json.loads(body))
        self.assertNotIn(self.key, output.getvalue())
        self.assertIn("RuntimeError", output.getvalue())
        self.assertIn("<redacted>", output.getvalue())

    def test_n8n_workflow_has_three_nodes_and_no_secret_values(self):
        workflow_path = Path(__file__).resolve().parent / "n8n" / "weekly_reports.json"
        raw = workflow_path.read_text(encoding="utf-8")
        workflow = json.loads(raw)
        self.assertEqual("jobbot weekly report", workflow["name"])
        self.assertEqual(3, len(workflow["nodes"]))
        self.assertEqual(
            ["Schedule Trigger", "HTTP Request", "Telegram"],
            [node["name"] for node in workflow["nodes"]],
        )
        schedule, http_node, telegram = workflow["nodes"]
        self.assertEqual("Africa/Cairo", workflow["settings"]["timezone"])
        self.assertEqual("weeks", schedule["parameters"]["rule"]["interval"][0]["field"])
        self.assertEqual([5], schedule["parameters"]["rule"]["interval"][0]["triggerAtDay"])
        self.assertEqual(18, schedule["parameters"]["rule"]["interval"][0]["triggerAtHour"])
        self.assertEqual("http://127.0.0.1:8765/report/weekly", http_node["parameters"]["url"])
        self.assertEqual("genericCredentialType", http_node["parameters"]["authentication"])
        self.assertEqual("httpHeaderAuth", http_node["parameters"]["genericAuthType"])
        self.assertEqual("YOUR_CHAT_ID", telegram["parameters"]["chatId"]["value"])
        self.assertEqual("={{ $json.text }}", telegram["parameters"]["text"])
        self.assertIsNone(re.search(r"\b\d{8,}:[A-Za-z0-9_-]{20,}\b", raw))
        self.assertNotIn("AIza", raw)
        try:
            from config import REPORT_API_KEY, TELEGRAM_BOT_TOKEN
        except Exception:
            REPORT_API_KEY = TELEGRAM_BOT_TOKEN = ""
        self.assertFalse(REPORT_API_KEY and REPORT_API_KEY in raw, "Workflow contains REPORT_API_KEY")
        self.assertFalse(TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_TOKEN in raw, "Workflow contains a bot token")


if __name__ == "__main__":
    unittest.main()
