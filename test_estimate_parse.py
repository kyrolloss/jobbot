import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import db
from estimate import compute_pricing, estimate_job, format_estimate_message, parse_estimate
from models import Job
from prices import get_market_medians


class EstimateParseTests(unittest.TestCase):
    def setUp(self):
        self.job = Job(
            "freelancer",
            "estimate-test",
            "Flutter mobile app with Firebase",
            "Build a Flutter app and connect Firebase authentication.",
            "https://example.invalid",
            "100-200 USD",
        )

    def test_good_json(self):
        result = parse_estimate(json.dumps({
            "tasks": [{"name": "Build UI", "hours": 4}, {"name": "Firebase auth", "hours": 6}],
            "total_hours": 10,
            "risks": ["No designs provided"],
            "questions_for_client": ["Do you have designs?"],
        }))
        self.assertEqual(10, result["total_hours"])
        self.assertEqual(2, len(result["tasks"]))
        self.assertEqual([], result.get("error", []))

    def test_json_inside_markdown_fences(self):
        result = parse_estimate('```json\n{"tasks": [{"name": "API", "hours": 2}], "total_hours": 2}\n```')
        self.assertEqual(2, result["total_hours"])

    def test_bad_json_returns_error_fallback(self):
        result = parse_estimate("not JSON")
        self.assertEqual([], result["tasks"])
        self.assertEqual(0, result["total_hours"])
        self.assertTrue(result["error"])
        pricing = compute_pricing(result, self.job, {}, {})
        self.assertIsNone(pricing["price_usd"])

    def test_missing_fields_are_accepted(self):
        result = parse_estimate('{"tasks": [{"name": "Setup", "hours": 3}]}')
        self.assertEqual(3, result["total_hours"])
        self.assertEqual([], result["risks"])
        self.assertEqual([], result["questions_for_client"])

    def test_hours_are_clamped_and_total_recomputed(self):
        result = parse_estimate(json.dumps({
            "tasks": [
                {"name": "Large", "hours": 250},
                {"name": "Small", "hours": 2.25},
                {"name": "Invalid zero", "hours": 0},
                {"name": "Invalid text", "hours": "many"},
            ],
            "total_hours": 7,
        }))
        self.assertEqual([200, 2.25], [task["hours"] for task in result["tasks"]])
        self.assertEqual(202.25, result["total_hours"])

    def test_risks_and_questions_are_limited(self):
        result = parse_estimate(json.dumps({
            "risks": [f"risk {index}" for index in range(8)],
            "questions_for_client": [f"question {index}" for index in range(6)],
        }))
        self.assertEqual(5, len(result["risks"]))
        self.assertEqual(3, len(result["questions_for_client"]))

    def test_price_math_uses_usd_rate_and_buffer(self):
        result = compute_pricing({"total_hours": 10}, self.job, {}, {})
        self.assertEqual(187.5, result["price_usd"])
        self.assertEqual(150, result["floor_usd"])

    def test_market_comparison_labels(self):
        estimate = {"total_hours": 10}
        low = compute_pricing(estimate, self.job, {}, {"flutter": {"median_bid_avg_usd": 300, "samples": 3}})
        average = compute_pricing(estimate, self.job, {}, {"flutter": {"median_bid_avg_usd": 187.5, "samples": 5}})
        high = compute_pricing(estimate, self.job, {}, {"flutter": {"median_bid_avg_usd": 100, "samples": 4}})
        missing = compute_pricing(estimate, self.job, {}, {})
        self.assertEqual("أقل من السوق", low["market_label"])
        self.assertEqual("في المتوسط", average["market_label"])
        self.assertEqual("أعلى من السوق", high["market_label"])
        self.assertEqual("مفيش بيانات سوق كفاية", missing["market_label"])

    def test_market_budget_fallback_is_labeled_and_group_b_job_gets_stronger_currency_note(self):
        inr_job = Job(
            "freelancer", "inr-estimate", "Flutter mobile app", "", "https://example.invalid",
            "12500-37500 INR",
        )
        market = {
            "flutter": {
                "median_bid_avg_usd": None,
                "samples": 0,
                "median_budget_usd": 500,
                "budget_samples": 6,
            }
        }
        estimate = {"total_hours": 10}
        pricing = compute_pricing(estimate, inr_job, {"currency": "INR"}, market)
        message = format_estimate_message(inr_job, estimate, pricing)

        self.assertEqual(187.5, pricing["price_usd"])
        self.assertEqual(500, pricing["market_median_usd"])
        self.assertEqual("budget", pricing["market_source"])
        self.assertIn("ميزانيات العملاء مش عروض", message)
        self.assertIn("مقارنة بعملات أقوى", message)

    def test_group_a_bid_comparison_precedes_budget_fallback(self):
        market = {
            "flutter": {"median_bid_avg_usd": None, "samples": 0, "median_budget_usd": 500, "budget_samples": 8},
            "firebase": {"median_bid_avg_usd": 200, "samples": 4, "median_budget_usd": 300, "budget_samples": 6},
        }
        pricing = compute_pricing({"total_hours": 10}, self.job, {}, market)
        self.assertEqual("firebase", pricing["market_tag"])
        self.assertEqual("bids", pricing["market_source"])
        self.assertNotIn("ميزانيات العملاء مش عروض", pricing["market_notes"])

    def test_market_medians_and_tag_with_most_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            temp_db = Path(directory) / "market.sqlite3"
            connection = sqlite3.connect(temp_db)
            connection.execute(
                "CREATE TABLE jobs (created_at TEXT, tags TEXT, budget TEXT, currency TEXT, bid_avg REAL, bid_count INTEGER)"
            )
            for index, amount in enumerate((100, 200, 300)):
                connection.execute(
                    "INSERT INTO jobs VALUES (CURRENT_TIMESTAMP, ?, '', 'USD', ?, 2)",
                    (json.dumps(["flutter"]), amount),
                )
            for index in range(3):
                connection.execute(
                    "INSERT INTO jobs VALUES (CURRENT_TIMESTAMP, ?, '', 'EUR', ?, 2)",
                    (json.dumps(["firebase"]), 100 + index * 100),
                )
            connection.commit()
            connection.close()

            market = get_market_medians(db_path=temp_db)
            self.assertEqual(200, market["flutter"]["median_bid_avg_usd"])
            self.assertEqual(3, market["firebase"]["samples"])
            mixed_job = Job(
                "freelancer", "mixed", "Flutter and Firebase", "", "https://example.invalid", "100-200 USD"
            )
            pricing = compute_pricing(
                {"total_hours": 10},
                mixed_job,
                {},
                {
                    "flutter": {"median_bid_avg_usd": 100, "samples": 4},
                    "firebase": {"median_bid_avg_usd": 200, "samples": 8},
                },
            )
            self.assertEqual("firebase", pricing["market_tag"])
            self.assertEqual("في المتوسط", pricing["market_label"])

    def test_low_budget_flag_and_hourly_budget_skip(self):
        low_budget_job = Job("freelancer", "low", "Flutter", "", "https://example.invalid", "$50.00 - $100.00")
        low = compute_pricing({"total_hours": 10}, low_budget_job, {}, {})
        self.assertTrue(low["low_budget"])
        hourly_job = Job("freelancer", "hourly", "Flutter", "", "https://example.invalid", "15-25 USD/hr")
        hourly = compute_pricing({"total_hours": 10}, hourly_job, {"currency": "USD"}, {})
        self.assertIsNone(hourly["budget_usd"])
        self.assertFalse(hourly["low_budget"])

    def test_message_is_phone_friendly_and_capped(self):
        estimate = {
            "tasks": [{"name": "Task " + ("x" * 250), "hours": 2} for _ in range(60)],
            "total_hours": 120,
            "risks": ["Risk " + ("r" * 300) for _ in range(5)],
            "questions_for_client": ["Question " + ("q" * 300) for _ in range(3)],
        }
        pricing = compute_pricing(estimate, self.job, {}, {})
        message = format_estimate_message(self.job, estimate, pricing)
        self.assertLessEqual(len(message), 3500)
        self.assertIn("أقل سعر مقبول", message)
        self.assertIn("أسئلة للعميل", message)

    def test_gemini_prompt_uses_only_job_text_and_fallback_is_safe(self):
        with patch("proposal.generate_gemini_text", return_value=None) as generate:
            result = estimate_job(self.job, stats={"currency": "USD"}, market={"flutter": {"median": 100}})
        prompt = generate.call_args.args[0]
        self.assertIn(self.job.description, prompt)
        self.assertNotIn("median", prompt)
        self.assertTrue(result["error"])

    def test_estimate_database_cache_on_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            temp_db = Path(directory) / "estimate.sqlite3"
            with patch.object(db, "DB_PATH", temp_db):
                db.save(self.job)
                rowid = 1
                estimate = {"tasks": [{"name": "Build", "hours": 2}], "total_hours": 2}
                db.save_estimate(rowid, estimate)
                self.assertEqual(estimate, db.get_estimate(rowid))


if __name__ == "__main__":
    unittest.main()
