import hmac
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from config import REPORT_API_KEY, REPORT_PORT


def _log_error(exc, key=""):
    message = str(exc)
    if key:
        message = message.replace(key, "<redacted>")
    print(f"Report server internal error ({type(exc).__name__}): {message[:300]}")


class _ReportHandler(BaseHTTPRequestHandler):
    report_key = ""
    db_path = None

    def log_message(self, _format, *_args):
        # Record that a request happened, without writing headers or URL values.
        print("Report server request received")

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self._method_not_allowed
        raise AttributeError(name)

    def _authorized(self) -> bool:
        expected = self.report_key
        supplied = self.headers.get("X-Report-Key", "")
        if not expected or not supplied:
            return False
        try:
            return hmac.compare_digest(expected.encode("utf-8"), supplied.encode("utf-8"))
        except (AttributeError, UnicodeError):
            return False

    def _send_json(self, status: int, payload: dict, *, head_only=False):
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Connection", "close")
        self.end_headers()
        if not head_only:
            self.wfile.write(encoded)

    def _days(self, query: str, default: int) -> int | None:
        values = parse_qs(query, keep_blank_values=True).get("days")
        if values is None:
            return default
        if len(values) != 1 or not values[0].isdigit():
            return None
        try:
            days = int(values[0])
        except (ValueError, OverflowError):
            return None
        return days if 1 <= days <= 365 else None

    def do_GET(self):
        if not self._authorized():
            self._send_json(401, {"error": "Unauthorized"})
            return
        try:
            parsed = urlsplit(self.path)
            if parsed.path == "/report/weekly":
                from reports import build_weekly_report

                text = build_weekly_report(db_path=self.db_path)
            elif parsed.path == "/report/prices":
                days = self._days(parsed.query, 30)
                if days is None:
                    self._send_json(400, {"error": "days must be between 1 and 365"})
                    return
                from prices import build_price_report

                text = build_price_report(days=days, db_path=self.db_path)
            elif parsed.path == "/report/timing":
                days = self._days(parsed.query, 30)
                if days is None:
                    self._send_json(400, {"error": "days must be between 1 and 365"})
                    return
                from timing import build_timing_report

                text = build_timing_report(days=days, db_path=self.db_path)
            else:
                self._send_json(404, {"error": "Not found"})
                return
            self._send_json(200, {"text": text})
        except Exception as exc:
            _log_error(exc, self.report_key)
            self._send_json(500, {"error": "Internal server error"})

    def _method_not_allowed(self, *, head_only=False):
        if not self._authorized():
            self._send_json(401, {"error": "Unauthorized"}, head_only=head_only)
            return
        self._send_json(405, {"error": "Method not allowed"}, head_only=head_only)

    def do_POST(self):
        self._method_not_allowed()

    def do_PUT(self):
        self._method_not_allowed()

    def do_PATCH(self):
        self._method_not_allowed()

    def do_DELETE(self):
        self._method_not_allowed()

    def do_OPTIONS(self):
        self._method_not_allowed()

    def do_HEAD(self):
        self._method_not_allowed(head_only=True)


def create_report_server(port=None, *, report_key=None, db_path=None):
    """Create an authenticated server bound exclusively to IPv4 loopback."""
    key = REPORT_API_KEY if report_key is None else str(report_key)
    if not key.strip():
        return None
    selected_port = REPORT_PORT if port is None else int(port)
    handler = type(
        "ConfiguredReportHandler",
        (_ReportHandler,),
        {"report_key": key, "db_path": db_path},
    )
    server = ThreadingHTTPServer(("127.0.0.1", selected_port), handler)
    server.daemon_threads = True
    return server


def serve_report_server():
    if not REPORT_API_KEY.strip():
        print("Report server disabled: REPORT_API_KEY is empty.")
        return None
    server = None
    try:
        server = create_report_server()
        if server is None:
            print("Report server disabled: REPORT_API_KEY is empty.")
            return None
        print(f"Report server listening on 127.0.0.1:{REPORT_PORT}")
        server.serve_forever()
    except Exception as exc:
        _log_error(exc, REPORT_API_KEY)
    finally:
        if server is not None:
            server.server_close()
    return server
