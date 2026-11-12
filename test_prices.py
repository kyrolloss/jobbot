import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch

from config import CURRENCY_TO_USD, MIN_PRICE_SAMPLES, PRICE_GROUPS
import db
from models import Job
from prices import _infer_currency, budget_to_usd, build_price_report, get_market_medians
from bot import _handle_prices, _handle_timing, _send_long_reply, split_message


class PriceReportTests(unittest.TestCase):
    def test_approximate_currency_rates_exist(self):
        self.assertEqual({"AUD": 0.65, "CAD": 0.72, "NZD": 0.59}, {
            code: CURRENCY_TO_USD[code] for code in ("AUD", "CAD", "NZD")
        })

    def test_currency_groups_are_partition_of_existing_rate_table(self):
        self.assertEqual({"USD", "EUR", "GBP", "AUD", "CAD", "NZD", "SAR", "AED"}, set(PRICE_GROUPS["A"]))
        self.assertEqual(set(CURRENCY_TO_USD) - set(PRICE_GROUPS["A"]), set(PRICE_GROUPS["B"]))

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "prices.sqlite3"
        connection = sqlite3.connect(self.db_path)
        connection.execute(
            """CREATE TABLE jobs (
                source TEXT, external_id TEXT, title TEXT, description TEXT,
                url TEXT, budget TEXT, status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                proposal TEXT, message_id INTEGER, evaluation TEXT, bid_count INTEGER,
                bid_avg REAL, score REAL, score_line TEXT, tags TEXT, currency TEXT,
                PRIMARY KEY (source, external_id)
            )"""
        )
        connection.commit()
        connection.close()

    def tearDown(self):
        self.temp_dir.cleanup()

    def add_row(self, external_id, tags, currency, bid_avg, bid_count, budget, created_at=None):
        connection = sqlite3.connect(self.db_path)
        connection.execute(
            """INSERT INTO jobs
               (source, external_id, title, description, url, budget, status,
                bid_count, bid_avg, tags, currency, created_at)
               VALUES ('test', ?, '', '', '', ?, 'new', ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))""",
            (
                external_id,
                budget,
                bid_count,
                bid_avg,
                json.dumps(tags),
                currency,
                created_at,
            ),
        )
        connection.commit()
        connection.close()

    def populate(self):
        self.add_row("f1", ["flutter", "python"], "USD", 100, 2, "100-200 USD")
        self.add_row("f2", ["flutter"], "USD", 200, 4, "$200.00 - $400.00")
        self.add_row("f3", ["flutter"], "EUR", 100, 6, "100-200 EUR")
        self.add_row("old-currency", ["flutter", "llm"], None, 500, 9, "500-1000 USD")
        self.add_row("unsupported", ["flutter"], "ZZZ", 100, 3, "100-200 ZZZ")
        for index, (bid, count, budget) in enumerate(
            [(10, 2, "100-200 USD"), (20, 4, "200-400 USD"), (30, 6, "300-500 USD"), (40, 8, "400-600 USD")],
            start=1,
        ):
            self.add_row(f"r{index}", ["react"], "USD", bid, count, budget)
        self.add_row("s1", ["shopify"], "USD", 10, 1, "10-20 USD")
        self.add_row("s2", ["shopify"], "USD", 20, 3, "20-30 USD")
        self.add_row(
            "too-old",
            ["react"],
            "USD",
            100,
            1,
            "100-200 USD",
            "2000-01-01 00:00:00",
        )

    def test_report_converts_aggregates_orders_and_discloses_skips(self):
        self.populate()
        report = build_price_report(30, db_path=self.db_path)
        self.assertIn(f"react — {MIN_PRICE_SAMPLES + 1} وظيفة", report)
        self.assertIn("وسيط $25 (من 4 وظيفة)", report)
        self.assertIn("عدد العروض 5.0 (من 4 وظيفة)", report)
        self.assertIn("flutter — 4 وظيفة", report)
        self.assertIn("وسيط $154 (من 4 وظيفة)", report)
        self.assertIn("متوسط $227 (من 4 وظيفة)", report)
        self.assertIn("ثابتة $231 (من 4 وظيفة)", report)
        self.assertIn("عدد العروض 5.2 (من 4 وظيفة)", report)
        self.assertLess(report.index("flutter —"), report.index("react —"))
        self.assertNotIn("shopify:", report)
        self.assertIn("وظايف اتخطت لعدم وجود أي سعر قابل للحساب: 1", report)
        self.assertIn("اتخطينا 1 وظيفة لأن العملة مش موجودة في جدول التحويل.", report)
        self.assertIn(
            "الأرقام دي من وظايف مفتوحة شافها البوت (ميزانيات ومتوسط عروض حالية) مش أسعار نهائية اتسندت.",
            report,
        )

    def test_empty_db_returns_friendly_message(self):
        report = build_price_report(db_path=self.db_path)
        self.assertIn("لسه مفيش بيانات كفاية", report)
        self.assertIn("0 وظيفة فيها سعر قابل للحساب", report)
        self.assertIn("التقرير هيتحسن مع تشغيل البوت", report)
        self.assertIn("مش أسعار نهائية اتسندت", report)

    def test_hourly_budgets_are_not_mixed_with_fixed_budgets(self):
        for index in range(MIN_PRICE_SAMPLES):
            self.add_row(f"hourly-{index}", ["hourly"], "USD", 20, 3, "15-25 USD/hr")
        report = build_price_report(db_path=self.db_path)
        self.assertNotIn("hourly:", report)
        self.assertIn("hourly — 3 وظيفة قابلة للحساب", report)
        self.assertIn("ساعي $20/ساعة (من 3 وظيفة)", report)
        self.assertIn("ثابتة - (من 0 وظيفة)", report)
        self.assertIn("وظايف اتخطت لعدم وجود أي سعر قابل للحساب: 0", report)

    def test_real_fixed_budget_formats_parse_and_hourly_format_stays_excluded(self):
        self.assertEqual(140.0, budget_to_usd("30-250 USD"))
        self.assertEqual(1350.0, budget_to_usd("75000-150000 INR"))
        self.assertEqual(375.0, budget_to_usd("$250.00 - $500.00"))
        self.assertIsNone(budget_to_usd("750-1250 INR/hr"))

    def test_infer_only_explicit_supported_currency_codes_and_symbols(self):
        self.assertEqual("USD", _infer_currency("250-750 USD"))
        self.assertEqual("USD", _infer_currency("$250.00 - $500.00"))
        self.assertIsNone(_infer_currency("250-750"))
        self.assertIsNone(_infer_currency("250-750 XYZ"))

    def test_inferred_currency_converts_bids_and_budget_and_keeps_skips_honest(self):
        for index in range(3):
            self.add_row(f"infer-usd-{index}", ["usd-inferred"], None, 100, 2, "250-750 USD")
            self.add_row(f"infer-symbol-{index}", ["symbol-inferred"], None, 200, 2, "$250.00 - $500.00")
        self.add_row("no-currency-text", ["plain-budget"], None, 100, 2, "250-750")
        self.add_row("unknown-currency-text", ["unknown-budget"], None, 100, 2, "250-750 XYZ")

        report = build_price_report(db_path=self.db_path)
        self.assertIn("usd-inferred — 3 وظيفة قابلة للحساب", report)
        self.assertIn("ثابتة $500 (من 3 وظيفة)", report)
        self.assertIn("symbol-inferred — 3 وظيفة قابلة للحساب", report)
        self.assertIn("ثابتة $375 (من 3 وظيفة)", report)
        self.assertIn("وظايف اتخطت لعدم وجود أي سعر قابل للحساب: 2", report)
        self.assertIn("اتخطينا 2 وظيفة؛ مفيش عملة محفوظة أو ظاهرة بوضوح في الميزانية.", report)

    def test_stats_persistence_does_not_replace_good_values_with_empty_values(self):
        job = Job("test", "stats-preserve", "Title", "", "https://example.invalid")
        with patch.object(db, "DB_PATH", self.db_path):
            db.save(job)
            connection = sqlite3.connect(self.db_path)
            connection.execute(
                "UPDATE jobs SET bid_count = 7, bid_avg = 125.5, currency = 'USD' WHERE external_id = ?",
                (job.external_id,),
            )
            connection.commit()
            connection.close()

            self.assertFalse(db.save_stats(job, {"bid_count": None, "bid_avg": "", "currency": "  "}))
            connection = sqlite3.connect(self.db_path)
            try:
                saved_before_update = connection.execute(
                    "SELECT bid_count, bid_avg, currency FROM jobs WHERE external_id = ?",
                    (job.external_id,),
                ).fetchone()
            finally:
                connection.close()
            self.assertEqual((7, 125.5, "USD"), saved_before_update)

            self.assertTrue(db.save_stats(job, {"bid_count": 0, "bid_avg": 0, "currency": "EUR"}))

            connection = sqlite3.connect(self.db_path)
            try:
                saved = connection.execute(
                    "SELECT bid_count, bid_avg, currency FROM jobs WHERE external_id = ?",
                    (job.external_id,),
                ).fetchone()
            finally:
                connection.close()
        self.assertEqual((0, 0.0, "EUR"), saved)

    def test_report_uses_each_metric_from_its_own_rows(self):
        for i, budget in enumerate(("100-200 USD", "200-400 USD", "300-500 USD")):
            self.add_row(f"fixed-{i}", ["fixed-only"], "USD", None, None, budget)
            self.add_row(f"hourly-{i}", ["hourly-only"], "USD", None, None, f"{10+i*10}-{20+i*10} USD/hr")
            self.add_row(f"bid-{i}", ["bid-only"], "USD", 100 + i * 100, 2 + i, "")

        mixed_rows = [
            ("100-200 USD", 10, 1),
            ("200-400 USD", None, 3),
            ("10-30 USD/hr", 30, None),
            ("20-40 USD/hr", None, 2),
            ("30-50 USD/hr", None, None),
        ]
        for i, (budget, bid_avg, bid_count) in enumerate(mixed_rows):
            self.add_row(f"mixed-{i}", ["metric-counts"], "USD", bid_avg, bid_count, budget)

        self.add_row("skip-unknown", ["skip-unknown"], None, None, None, "100-200 ZZZ")
        self.add_row("skip-empty", ["skip-empty"], "USD", None, None, "")
        self.add_row("skip-unparseable", ["skip-unparseable"], "USD", None, None, "budget TBD")
        self.add_row("skip-unsupported", ["skip-unsupported"], "ZZZ", None, None, "100-200 ZZZ")

        report = build_price_report(db_path=self.db_path)
        self.assertIn("fixed-only — 3 وظيفة قابلة للحساب", report)
        self.assertIn("ثابتة $300 (من 3 وظيفة)", report)
        report_lines = report.splitlines()
        fixed_line_index = next(i for i, line in enumerate(report_lines) if line.startswith("fixed-only —"))
        self.assertNotIn("عروض:", report_lines[fixed_line_index + 1])
        self.assertIn("hourly-only — 3 وظيفة قابلة للحساب", report)
        self.assertIn("ساعي $25/ساعة (من 3 وظيفة)", report)
        hourly_line_index = next(i for i, line in enumerate(report_lines) if line.startswith("hourly-only —"))
        self.assertNotIn("عروض:", report_lines[hourly_line_index + 1])
        self.assertIn("bid-only — 3 وظيفة قابلة للحساب", report)
        self.assertIn("وسيط $200 (من 3 وظيفة)", report)
        self.assertIn("متوسط $200 (من 3 وظيفة)", report)
        self.assertIn("عدد العروض 3.0 (من 3 وظيفة)", report)
        self.assertIn("metric-counts — 5 وظيفة قابلة للحساب", report)
        self.assertIn("ثابتة - (من 2 وظيفة)", report)
        self.assertIn("ساعي $30/ساعة (من 3 وظيفة)", report)
        self.assertIn("عروض: عدد العروض 2.0 (من 3 وظيفة)", report)
        self.assertNotIn("عروض: وسيط -", report)
        self.assertNotIn("عروض: متوسط -", report)
        self.assertIn("عروض: عدد العروض 2.0 (من 3 وظيفة)", report)
        self.assertIn("وظايف اتخطت لعدم وجود أي سعر قابل للحساب: 4", report)
        self.assertIn("اتخطينا 1 وظيفة؛ مفيش عملة محفوظة أو ظاهرة بوضوح في الميزانية.", report)
        self.assertIn("اتخطينا 1 وظيفة لأن العملة مش موجودة في جدول التحويل.", report)
        self.assertIn("ميزانية ناقصة ومن غير متوسط عروض قابل للتحويل: 1.", report)
        self.assertIn("ميزانية ناقصة أو غير قابلة للتحليل", report)

    def test_market_medians_keeps_bid_shape_and_adds_budget_fallback(self):
        for i, amount in enumerate((100, 200, 300)):
            self.add_row(f"market-bid-{i}", ["bid-market"], "USD", amount, 1, "100-200 USD")
            self.add_row(f"market-budget-{i}", ["budget-market"], "INR", None, None, "100-200 INR")
            self.add_row(f"market-bid-inr-{i}", ["bid-inr-market"], "INR", amount, 1, "100-200 INR")

        market = get_market_medians(db_path=self.db_path)
        self.assertEqual(200, market["bid-market"]["median_bid_avg_usd"])
        self.assertEqual(3, market["bid-market"]["samples"])
        self.assertEqual(150, market["bid-market"]["median_budget_usd"])
        self.assertEqual(3, market["bid-market"]["budget_samples"])
        self.assertIsNone(market["budget-market"]["median_bid_avg_usd"])
        self.assertEqual(0, market["budget-market"]["samples"])
        self.assertIsNone(market["budget-market"]["median_budget_usd"])
        self.assertEqual(1.8, market["budget-market"]["group_b_median_budget_usd"])
        self.assertEqual(3, market["budget-market"]["group_b_budget_samples"])
        self.assertIsNone(market["bid-inr-market"]["median_bid_avg_usd"])
        self.assertEqual(2.4, market["bid-inr-market"]["group_b_median_bid_avg_usd"])
        self.assertEqual(3, market["bid-inr-market"]["group_b_samples"])

    def test_usd_and_inr_statistics_are_separated_by_group(self):
        for i, bid in enumerate((100, 200, 300)):
            self.add_row(f"strong-{i}", ["currency-mix"], "USD", bid, 2 + i, "250-750 USD")
            self.add_row(f"other-fixed-{i}", ["currency-mix"], "INR", 10 * (i + 1), 1, "12500-37500 INR")
            self.add_row(f"other-hourly-{i}", ["currency-mix"], "INR", None, None, "750-1250 INR/hr")

        report = build_price_report(db_path=self.db_path)
        self.assertIn("currency-mix — 9 وظيفة قابلة للحساب", report)
        self.assertIn("دولار وعملات قوية: ثابتة $500 (من 3 وظيفة) | ساعي - (من 0 وظيفة)", report)
        self.assertIn("عروض: وسيط $200 (من 3 وظيفة)", report)
        self.assertIn("روبية وعملات تانية: ثابتة $300 (من 3 وظيفة) | ساعي $12/ساعة (من 3 وظيفة)", report)
        self.assertIn("عروض: وسيط $0.24 (من 3 وظيفة)", report)

    def test_compact_mode_is_group_a_top_six_one_line_per_tag(self):
        for tag_index in range(8):
            tag = f"compact-{tag_index}"
            for i in range(MIN_PRICE_SAMPLES):
                self.add_row(f"compact-{tag_index}-{i}", [tag], "USD", 100 + i, 1, "100-200 USD")
            for i in range(MIN_PRICE_SAMPLES):
                self.add_row(f"compact-inr-{tag_index}-{i}", [tag], "INR", 100, 1, "12500-37500 INR")

        report = build_price_report(db_path=self.db_path, compact=True)
        tag_lines = [line for line in report.splitlines() if line.startswith("compact-")]
        self.assertEqual(6, len(tag_lines))
        self.assertTrue(all(" | " in line for line in tag_lines))
        self.assertNotIn("روبية وعملات تانية", report)
        self.assertNotIn("INR", report)

    def test_weekly_compact_report_stays_within_character_limit(self):
        from reports import build_weekly_report

        for tag_index in range(12):
            tag = f"weekly-{tag_index}"
            for i in range(5):
                self.add_row(f"weekly-{tag_index}-{i}", [tag], "USD", 100 + i, 2, "250-750 USD")
                self.add_row(f"weekly-inr-{tag_index}-{i}", [tag], "INR", None, None, "12500-37500 INR")

        report = build_weekly_report(7, db_path=self.db_path)
        self.assertLessEqual(len(report), 3800)

    def test_split_message_respects_limit_and_preserves_complete_lines_and_order(self):
        text = "first line\nsecond\nthird line\nlast"
        chunks = split_message(text, limit=15)
        self.assertTrue(chunks)
        self.assertTrue(all(len(chunk) <= 15 for chunk in chunks))
        self.assertEqual(text, "".join(chunks))
        output_lines = [line for chunk in chunks for line in chunk.splitlines(keepends=True)]
        self.assertEqual(text.splitlines(keepends=True), output_lines)

    def test_split_message_breaks_long_lines_at_spaces_and_handles_empty(self):
        text = "alpha beta gamma delta epsilon\n"
        chunks = split_message(text, limit=10)
        self.assertTrue(all(len(chunk) <= 10 for chunk in chunks))
        self.assertEqual(text, "".join(chunks))
        self.assertTrue(all(chunk.endswith((" ", "\n")) for chunk in chunks))
        self.assertEqual([], split_message("", limit=10))
        self.assertEqual(["a" * 10, "a" * 10, "a" * 5], split_message("a" * 25, limit=10))

    def test_full_report_for_30_tags_sends_several_safe_chunks(self):
        for tag_index in range(30):
            tag = f"fake-{tag_index:02d}-" + ("x" * 160)
            for i in range(3):
                self.add_row(f"large-a-{tag_index}-{i}", [tag], "USD", 100 + i, 2 + i, "100-200 USD")
                self.add_row(f"large-b-{tag_index}-{i}", [tag], "INR", 100 + i, 2 + i, "12500-37500 INR")

        report = build_price_report(30, db_path=self.db_path)
        self.assertGreater(len(report), 4000)
        sent = []
        with patch("prices.build_price_report", return_value=report), patch(
            "bot._api", side_effect=lambda method, data: sent.append(data["text"])
        ):
            _handle_prices("test-chat", [])
        self.assertGreater(len(sent), 1)
        self.assertTrue(all(len(chunk) <= 4000 for chunk in sent))
        self.assertEqual(report, "".join(sent))

        timing_report = "\n".join(f"timing line {index}" for index in range(500))
        timing_sent = []
        with patch("timing.build_timing_report", return_value=timing_report), patch(
            "bot._api", side_effect=lambda method, data: timing_sent.append(data["text"])
        ):
            _handle_timing("test-chat", [])
        self.assertGreater(len(timing_sent), 1)
        self.assertTrue(all(len(chunk) <= 4000 for chunk in timing_sent))
        self.assertEqual(timing_report, "".join(timing_sent))

    def test_failed_chunk_is_logged_and_later_chunks_are_still_sent(self):
        calls = []

        def fake_api(method, data):
            calls.append(data["text"])
            if len(calls) == 1:
                raise RuntimeError("send failed")

        output = StringIO()
        with patch("bot._api", side_effect=fake_api), redirect_stdout(output):
            result = _send_long_reply("test-chat", "a" * 4001 + "\n" + "b" * 4001)
        self.assertFalse(result)
        self.assertGreater(len(calls), 1)
        self.assertIn("Long reply chunk 1/", output.getvalue())


if __name__ == "__main__":
    unittest.main()
