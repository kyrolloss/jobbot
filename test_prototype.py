import re
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import db
import bot
import notifier
import prototype
import prototype_kit
import config
import run
from models import Job


class PrototypeTests(unittest.TestCase):
    def setUp(self):
        self.job = Job(
            "Freelancer!",
            "id/ 7",
            "Flutter grocery app",
            "Build a small grocery ordering app.",
            "https://client.example.invalid/grocery",
        )

    def test_clean_html_strips_fences_and_surrounding_text(self):
        generated = "Intro text\n```html\n<!doctype html><html><body>Hi</body></html>\n```\nTrailing explanation </html>"
        self.assertEqual(
            "<!doctype html><html><body>Hi</body></html>",
            prototype.clean_html(generated),
        )

    def test_clean_html_rejects_missing_html_tags(self):
        with self.assertRaises(ValueError):
            prototype.clean_html("<!doctype html><body>no html root</body>")
        with self.assertRaises(ValueError):
            prototype.clean_html("<html><body>missing close")

    def test_clean_html_rejects_external_resources(self):
        rejected = (
            '<html><head><script src="https://cdn.example.invalid/app.js"></script></head></html>',
            '<html><head><link href="https://cdn.example.invalid/style.css"></head></html>',
            '<html><body><img src="//cdn.example.invalid/image.png"></body></html>',
            '<html><style>@import url("https://cdn.example.invalid/font.css");</style></html>',
            '<html><style>body{background:url(https://cdn.example.invalid/bg.png)}</style></html>',
        )
        for html in rejected:
            with self.subTest(html=html[:40]), self.assertRaises(ValueError):
                prototype.clean_html(html)

    def test_clean_html_enforces_size_limit(self):
        with patch.object(prototype, "PROTOTYPE_MAX_KB", 1):
            with self.assertRaisesRegex(ValueError, "أكبر من الحد"):
                prototype.clean_html("<html><body>" + ("x" * 1100) + "</body></html>")

    def test_file_name_is_sanitized_and_uses_source_and_external_id(self):
        with tempfile.TemporaryDirectory() as directory:
            path = prototype.prototype_path_for(self.job, directory)
        self.assertEqual("Freelancer__id__7.html", path.name)
        self.assertRegex(path.stem, re.compile(r"^[A-Za-z0-9_-]+$"))

    def test_make_prototype_saves_valid_html_with_mocked_gemini(self):
        generated = 'THEME: aurora\n<header class="nav">Northstar</header><section class="hero"><h1>Plan with clarity</h1><a class="btn" href="#start">Explore</a></section><section class="section"><h2 class="section-title">A better flow</h2><div class="grid-3"><article class="card">Simple</article><article class="card">Clear</article><article class="card">Useful</article></div></section>'
        with tempfile.TemporaryDirectory() as directory, patch.object(prototype, "PROTOTYPE_DIR", directory):
            with patch("proposal.generate_gemini_text", return_value=generated) as generate:
                result = prototype.make_prototype(self.job)
            self.assertTrue(result["ok"])
            self.assertEqual(set(("ok", "path", "html", "error", "fallback")), set(result))
            self.assertFalse(result["fallback"])
            self.assertTrue(Path(result["path"]).is_file())
            self.assertEqual(result["html"], Path(result["path"]).read_text(encoding="utf-8"))
            prompt = generate.call_args.args[0]
            self.assertIn("THEME:", prompt)
            self.assertIn("never invent testimonials", prompt)

    def test_make_prototype_returns_failure_dict_for_invalid_gemini_html(self):
        with patch("proposal.generate_gemini_text", return_value="not html"):
            result = prototype.make_prototype(self.job)
        self.assertTrue(result["ok"])
        self.assertTrue(result["fallback"])
        self.assertIn("Prototype - concept design only", result["html"])

    def test_two_failed_attempts_write_fallback_and_caption_flag(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(prototype, "PROTOTYPE_DIR", directory):
            with patch("proposal.generate_gemini_text", side_effect=[None, RuntimeError("quota")]) as generate:
                result = prototype.make_prototype(self.job)
        self.assertEqual(2, generate.call_count)
        self.assertTrue(result["ok"])
        self.assertTrue(result["fallback"])
        self.assertIn("grocery app", result["html"].lower())

    def test_quota_failure_then_valid_response_uses_second_attempt(self):
        valid = 'THEME: clean-light\n<section class="hero"><h1>Fresh choices</h1><a class="btn" href="#shop">Browse</a></section>'
        with tempfile.TemporaryDirectory() as directory, patch.object(prototype, "PROTOTYPE_DIR", directory):
            with patch("proposal.generate_gemini_text", side_effect=[None, valid]) as generate:
                result = prototype.make_prototype(self.job)
        self.assertEqual(2, generate.call_count)
        self.assertFalse(result["fallback"])
        self.assertIn("--primary:#315eea", result["html"])

    def test_all_themes_build_complete_local_pages_with_direction(self):
        for theme in prototype_kit.THEMES:
            page = prototype_kit.build_page(theme, '<main class="section">Preview</main>', "Preview", False)
            self.assertTrue(page.startswith("<!doctype html>"))
            self.assertIn('<meta name="viewport"', page)
            self.assertIn("Prototype - concept design only", page)
            self.assertNotRegex(page, r"https?://")
            self.assertLess(len(page.encode("utf-8")), 200 * 1024)
        self.assertIn('<html lang="ar" dir="rtl">', prototype_kit.build_page("aurora", "<p>مرحبا</p>", "تجربة", True))
        self.assertIn('<html lang="en" dir="ltr">', prototype_kit.build_page("aurora", "<p>Hello</p>", "Demo", False))

    def test_generated_fragment_validation_and_class_stripping(self):
        theme, body = prototype.validate_generated('THEME: aurora\n<section class="hero made-up"><h1>Hello</h1></section>', self.job)
        self.assertEqual("aurora", theme)
        self.assertIn('class="hero"', body)
        bad_fragments = (
            'THEME: aurora\n<section><p>truncated</section>',
            'THEME: aurora\n<script>alert(1)</script>',
            'THEME: aurora\n<a href="https://outside.invalid">link</a>',
            'THEME: aurora\n<button onclick="go()">Go</button>',
        )
        for fragment in bad_fragments:
            with self.subTest(fragment=fragment), self.assertRaises(ValueError):
                prototype.validate_generated(fragment, self.job)
        missing_theme, _body = prototype.validate_generated('<section>Hi</section>', self.job)
        unknown_theme, _body = prototype.validate_generated('THEME: not-a-theme\n<section>Hi</section>', self.job)
        self.assertEqual(prototype.fallback_theme_for_job(self.job), missing_theme)
        self.assertEqual(prototype.fallback_theme_for_job(self.job), unknown_theme)
        with patch.object(prototype, "PROTOTYPE_MAX_KB", 1), self.assertRaises(ValueError):
            prototype.validate_generated('THEME: aurora\n<div>' + ('x' * 1200) + '</div>', self.job)

    def test_proto_demo_command_arguments_and_static_file(self):
        replies, documents, existed = [], [], []
        with tempfile.TemporaryDirectory() as directory, patch.object(prototype, "PROTOTYPE_DIR", directory), \
             patch.object(bot, "_authorized_chat", return_value=True), \
             patch.object(bot, "_api", side_effect=lambda _method, data: replies.append(data["text"])), \
             patch("notifier.send_document", side_effect=lambda _chat, path, caption: documents.append((path, caption)) or existed.append(Path(path).is_file()) or True), \
             patch("proposal.generate_gemini_text", side_effect=AssertionError("demo must not call Gemini")):
            bot._handle_proto_demo("123", [])
            bot._handle_proto_demo("123", ["sunset"])
            bot._handle_proto_demo("123", ["invalid"])
        self.assertIn("aurora", replies[0])
        self.assertEqual([True, True], existed)
        self.assertEqual("prototype_demo_sunset.html", Path(documents[1][0]).name)
        self.assertIn("مش معروف", replies[-1])

    def test_proto_demo_is_registered_in_both_command_loops(self):
        with patch.object(bot, "_authorized_chat", return_value=True), patch.object(bot, "_handle_proto_demo") as bot_handler:
            bot._handle_message({"chat": {"id": "123"}, "text": "/proto_demo aurora"})
        bot_handler.assert_called_once_with("123", ["aurora"])
        with patch.object(run, "_authorized_chat", return_value=True), patch.object(run, "_handle_proto_demo") as run_handler:
            run._handle_command({"chat": {"id": "123"}, "text": "/proto_demo sunset"})
        run_handler.assert_called_once_with("123", ["sunset"])

    def test_add_prototype_line_arabic_english_signoff_and_idempotence(self):
        url = "https://example.invalid/prototype"
        arabic = "أهلاً، أقدر أساعدك في تنفيذ التطبيق.\n\nتحياتي،\nKerollos"
        updated_ar = prototype.add_prototype_line(arabic, url)
        self.assertLess(updated_ar.index(url), updated_ar.index("تحياتي"))
        self.assertIn("جهّزتلك نموذج أولي بسيط", updated_ar)
        self.assertEqual(updated_ar, prototype.add_prototype_line(updated_ar, url, "ar"))

        english = "Hello, I can build this for you.\n\nBest regards,\nKerollos"
        updated_en = prototype.add_prototype_line(english, url)
        self.assertLess(updated_en.index(url), updated_en.index("Best regards"))
        self.assertIn("I put together a quick prototype", updated_en)
        self.assertEqual(updated_en, prototype.add_prototype_line(updated_en, url))

    def test_url_validation_requires_https_or_localhost_http_and_under_300_chars(self):
        self.assertTrue(prototype.validate_prototype_url("https://example.invalid/site"))
        self.assertTrue(prototype.validate_prototype_url("http://localhost:8080/site"))
        self.assertTrue(prototype.validate_prototype_url("http://127.0.0.1/site"))
        self.assertFalse(prototype.validate_prototype_url("http://example.invalid/site"))
        self.assertFalse(prototype.validate_prototype_url("javascript:alert(1)"))
        self.assertFalse(prototype.validate_prototype_url("https://user:pass@example.invalid/"))
        self.assertFalse(prototype.validate_prototype_url("https://example.invalid/" + ("x" * 280)))

    def test_prototype_url_migration_and_helpers_use_temporary_database(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prototype.sqlite3"
            with patch.object(db, "DB_PATH", path):
                db.save(self.job)
                connection = sqlite3.connect(path)
                try:
                    columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
                    rowid = connection.execute(
                        "SELECT rowid FROM jobs WHERE source = ? AND external_id = ?",
                        (self.job.source, self.job.external_id),
                    ).fetchone()[0]
                finally:
                    connection.close()
                self.assertIn("prototype_url", columns)
                url = "https://example.invalid/prototype"
                self.assertTrue(db.save_prototype_url(rowid, url))
                self.assertEqual(url, db.get_prototype_url(rowid))

    def test_proto_link_command_validates_and_updates_saved_proposal(self):
        messages = []
        original = "I can build the app.\n\nBest regards,\nKerollos"
        with patch.object(bot, "TELEGRAM_CHAT_ID", "123"), \
             patch.object(bot, "save_prototype_url", return_value=True) as save_url, \
             patch.object(bot, "get_proposal", return_value=original), \
             patch.object(bot, "save_proposal", return_value=True) as save_text, \
             patch.object(bot, "_send_long_reply", return_value=True) as send_long, \
             patch.object(bot, "_api", side_effect=lambda method, data: messages.append(data["text"])):
            bot._handle_proto_link("123", ["42", "http://example.invalid/prototype"])
            self.assertFalse(save_url.called)
            self.assertIn("الرابط لازم يبدأ", messages[-1])

            url = "https://example.invalid/prototype"
            bot._handle_proto_link("123", ["42", url])

        save_url.assert_called_once_with(42, "https://example.invalid/prototype")
        save_text.assert_called_once()
        self.assertEqual(42, save_text.call_args.args[0])
        self.assertTrue(save_text.call_args.kwargs["overwrite"])
        saved_proposal = save_text.call_args.args[1]
        self.assertIn(url, saved_proposal)
        self.assertLess(saved_proposal.index(url), saved_proposal.index("Best regards"))
        send_long.assert_called_once_with("123", saved_proposal)

    def test_prototype_callback_sends_three_line_caption_and_busy_press_is_answered(self):
        class FakeLock:
            def __init__(self, acquired):
                self.acquired = acquired
                self.released = False

            def acquire(self, blocking=False):
                return self.acquired

            def release(self):
                self.released = True

        callback = {
            "id": "callback-id",
            "data": "p|42",
            "message": {"chat": {"id": "123"}, "message_id": 9},
        }
        job = self.job
        lock = FakeLock(True)
        ack_texts = []
        api_texts = []
        with patch.object(bot, "_PROTOTYPE_LOCK", lock), \
             patch.object(bot, "_authorized_chat", return_value=True), \
             patch.object(bot, "get_job_by_rowid", return_value=job), \
             patch.object(bot, "get_job_status", return_value="sent"), \
             patch.object(bot, "_answer_callback", side_effect=lambda _id, text: ack_texts.append(text)), \
             patch.object(bot, "_api", side_effect=lambda _method, data: api_texts.append(data["text"])), \
             patch("prototype.make_prototype", return_value={"ok": True, "path": "local.html", "fallback": True}), \
             patch("notifier.send_document", return_value=True) as send_document:
            bot._handle_callback(callback)

        self.assertTrue(lock.released)
        self.assertIn("بجهّز النموذج", api_texts[0])
        caption = send_document.call_args.args[2]
        self.assertEqual(3, len(caption.splitlines()))
        self.assertIn("قالب احتياطي", caption)
        self.assertIn("/proto_link 42", caption)

        busy_lock = FakeLock(False)
        busy_acks = []
        with patch.object(bot, "_PROTOTYPE_LOCK", busy_lock), \
             patch.object(bot, "_authorized_chat", return_value=True), \
             patch.object(bot, "get_job_by_rowid", return_value=job), \
             patch.object(bot, "get_job_status", return_value="sent"), \
             patch.object(bot, "_answer_callback", side_effect=lambda _id, text: busy_acks.append(text)):
            bot._handle_callback(callback)
        self.assertIn("في نموذج بيتجهّز دلوقتي", busy_acks)

    def test_send_document_caps_caption_and_does_not_log_endpoint_token(self):
        class FakeResponse:
            is_error = False

            @staticmethod
            def json():
                return {"ok": True}

        class FakeClient:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def post(self, url, *, data, files):
                self.request = (url, data, files)
                return FakeResponse()

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prototype.html"
            path.write_text("<html></html>", encoding="utf-8")
            client = FakeClient()
            output = []
            with patch.object(notifier, "TELEGRAM_BOT_TOKEN", "synthetic-test-token"), \
                 patch("notifier.httpx.Client", return_value=client), \
                 patch("builtins.print", side_effect=lambda *args: output.append(" ".join(map(str, args)))):
                self.assertTrue(notifier.send_document(123, path, "x" * 1500))
        self.assertEqual(1024, len(client.request[1]["caption"]))
        self.assertIn("synthetic-test-token", client.request[0])
        self.assertFalse(any("synthetic-test-token" in line for line in output))


if __name__ == "__main__":
    unittest.main()
