import json
import atexit
import ctypes
import hashlib
import io
import logging
import msvcrt
import os
import random
import re
import sys
import threading
import time
from datetime import datetime
from ctypes import wintypes
from logging.handlers import RotatingFileHandler
from pathlib import Path

import httpx

from bot import POLL_TIMEOUT, _api, _authorized_chat, _handle_callback, _handle_prices, _handle_proto_demo, _handle_proto_link, _handle_timing, _report_polling_error
from config import INTERVAL_MINUTES, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
from db import count_by_status
from main import run_once
from notifier import TelegramRequestError
from report_server import serve_report_server

BASE_DIR = Path(__file__).resolve().parent
SETTINGS_PATH = BASE_DIR / "settings.json"
LOCK_PATH = BASE_DIR / "run.lock"
LOG_DIR = BASE_DIR / "logs"
LOG_PATH = LOG_DIR / "bot.log"
_RUN_MUTEX_HANDLE = None
_KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
_KERNEL32.CreateMutexW.argtypes = (wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR)
_KERNEL32.CreateMutexW.restype = wintypes.HANDLE
_KERNEL32.CloseHandle.argtypes = (wintypes.HANDLE,)
_KERNEL32.CloseHandle.restype = wintypes.BOOL


class _TeeStream(io.TextIOBase):
    """Mirror console output into logging while preserving terminal output."""

    def __init__(self, original, logger):
        self.original = original if original is not None else open(os.devnull, "w", encoding="utf-8")
        self.logger = logger
        self._buffer = ""

    @property
    def encoding(self):
        return getattr(self.original, "encoding", "utf-8")

    def writable(self):
        return True

    def isatty(self):
        return bool(getattr(self.original, "isatty", lambda: False)())

    def write(self, text):
        if not isinstance(text, str):
            text = str(text)
        text = _redact_secrets(text)
        written = self.original.write(text)
        self._buffer += text
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            if line:
                self.logger.info(line)
        return len(text) if written is None else written

    def flush(self):
        self.original.flush()
        if self._buffer:
            self.logger.info(self._buffer)
            self._buffer = ""


def _redact_secrets(text: str) -> str:
    for secret in (TELEGRAM_BOT_TOKEN,):
        if secret:
            text = text.replace(secret, "<redacted>")
    try:
        from config import GEMINI_API_KEY

        if GEMINI_API_KEY:
            text = text.replace(GEMINI_API_KEY, "<redacted>")
    except Exception:
        pass
    return text


def _configure_logging() -> None:
    LOG_DIR.mkdir(exist_ok=True)
    logger = logging.getLogger("jobbot.stdout")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    handler = RotatingFileHandler(
        LOG_PATH, maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    logger.addHandler(handler)
    sys.stdout = _TeeStream(sys.stdout, logger)
    sys.stderr = _TeeStream(sys.stderr, logger)
    atexit.register(lambda: (sys.stdout.flush(), sys.stderr.flush(), handler.close()))

condition = threading.Condition()
state = {
    "interval_minutes": INTERVAL_MINUTES,
    "paused": False,
    "run_requested": False,
    "last_scan": None,
    "next_scan": time.time(),
    "stopping": False,
}


def _load_settings() -> None:
    try:
        stored = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        minutes = stored.get("interval_minutes")
        if isinstance(minutes, int) and minutes > 0:
            state["interval_minutes"] = minutes
        try:
            import radar
            radar.load_enabled()
        except Exception as exc:
            print(f"Could not load radar setting: {type(exc).__name__}")
    except FileNotFoundError:
        pass
    except Exception as exc:
        print(f"Could not load settings.json: {type(exc).__name__}")


def _save_settings(minutes: int) -> None:
    stored = {}
    try:
        stored = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        if not isinstance(stored, dict):
            stored = {}
    except FileNotFoundError:
        pass
    temp_path = SETTINGS_PATH.with_suffix(".json.tmp")
    stored["interval_minutes"] = minutes
    temp_path.write_text(json.dumps(stored, indent=2), encoding="utf-8")
    temp_path.replace(SETTINGS_PATH)


def _format_time(timestamp) -> str:
    return datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d %H:%M:%S") if timestamp else "—"


def _send_text(chat_id, text: str) -> None:
    _api("sendMessage", {"chat_id": chat_id, "text": text})


def _status_text() -> str:
    with condition:
        paused = state["paused"]
        interval = state["interval_minutes"]
        last_scan = state["last_scan"]
        next_scan = None if paused else state["next_scan"]
    counts = count_by_status()
    lines = [f"{status}: {count}" for status, count in counts.items()]
    lines.extend([
        f"الفحص الدوري: {'موقوف' if paused else 'شغال'}",
        f"الفاصل: {interval} دقيقة",
        f"آخر فحص: {_format_time(last_scan)}",
        f"الفحص الجاي: {_format_time(next_scan)}",
    ])
    return "حالة الوظائف:\n" + "\n".join(lines)


def _parse_interval(value: str) -> int | None:
    match = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?", value.strip().lower())
    if not match or not any(match.groups()):
        return None
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    total = hours * 60 + minutes
    return total if total > 0 else None


def _handle_command(message: dict) -> None:
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    if not _authorized_chat(chat_id):
        return

    parts = (message.get("text") or "").strip().split()
    if not parts:
        return
    command = parts[0].split("@", 1)[0]

    if command == "/status":
        _send_text(chat_id, _status_text())
    elif command == "/prices":
        _handle_prices(chat_id, parts[1:])
    elif command == "/timing":
        _handle_timing(chat_id, parts[1:])
    elif command == "/radar":
        import radar
        radar.handle_command(chat_id, parts[1:], _send_text)
    elif command == "/proto_link":
        _handle_proto_link(chat_id, parts[1:])
    elif command == "/proto_demo":
        _handle_proto_demo(chat_id, parts[1:])
    elif command == "/pause":
        with condition:
            state["paused"] = True
            state["next_scan"] = None
            condition.notify_all()
        _send_text(chat_id, "⏸️ تم إيقاف الفحص الدوري. يظل البوت متاحًا للأزرار.")
    elif command == "/resume":
        with condition:
            state["paused"] = False
            state["next_scan"] = time.time()
            condition.notify_all()
        _send_text(chat_id, "▶️ تم استئناف الفحص الدوري.")
    elif command == "/run_now":
        with condition:
            state["run_requested"] = True
            condition.notify_all()
        _send_text(chat_id, "🔄 بدأ طلب الفحص الفوري.")
    elif command == "/set_interval":
        minutes = _parse_interval(parts[1]) if len(parts) == 2 else None
        if minutes is None:
            _send_text(chat_id, "صيغة غير صحيحة. استخدم مثلًا /set_interval 2h أو /set_interval 90m")
            return
        try:
            _save_settings(minutes)
            with condition:
                state["interval_minutes"] = minutes
                if not state["paused"]:
                    state["next_scan"] = time.time() + minutes * 60 + random.uniform(0, 300)
                condition.notify_all()
            _send_text(chat_id, f"✅ تم ضبط الفاصل إلى {minutes} دقيقة.")
        except Exception as exc:
            print(f"Could not save interval setting: {type(exc).__name__}")
            _send_text(chat_id, "تعذّر حفظ الفاصل.")


def _bot_loop() -> None:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("Telegram not configured: fill TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env")
        return

    offset = None
    while True:
        with condition:
            if state["stopping"]:
                return
        try:
            params = {"timeout": POLL_TIMEOUT}
            if offset is not None:
                params["offset"] = offset
            try:
                updates = _api("getUpdates", params)
            except (httpx.ReadTimeout, httpx.ConnectTimeout):
                continue
            for update in updates:
                offset = update["update_id"] + 1
                if "callback_query" in update:
                    _handle_callback(update["callback_query"])
                elif "message" in update:
                    _handle_command(update["message"])
        except TelegramRequestError as exc:
            status_code = _report_polling_error(exc)
            if status_code == 401:
                return
            time.sleep(10 if status_code == 409 else 5)
        except (httpx.HTTPError, RuntimeError) as exc:
            _report_polling_error(exc)
            time.sleep(5)
        except Exception as exc:
            _report_polling_error(exc)
            time.sleep(5)


def _run_scan() -> None:
    try:
        run_once()
    except Exception as exc:
        safe_error = str(exc).replace(TELEGRAM_BOT_TOKEN, "<redacted>") if TELEGRAM_BOT_TOKEN else str(exc)
        print(f"run_once failed: {type(exc).__name__}: {safe_error}")
        if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID:
            try:
                _send_text(TELEGRAM_CHAT_ID, f"⚠️ خطأ في الفحص: {type(exc).__name__}")
            except Exception as send_exc:
                print(f"Could not send scan error notification: {type(send_exc).__name__}")
    finally:
        with condition:
            now = time.time()
            state["last_scan"] = now
            if not state["paused"] and not state["stopping"]:
                delay = state["interval_minutes"] * 60 + random.uniform(0, 300)
                state["next_scan"] = now + delay
            else:
                state["next_scan"] = None
            condition.notify_all()


def _scheduler_loop() -> None:
    while True:
        with condition:
            while True:
                if state["stopping"]:
                    return
                if state["run_requested"]:
                    state["run_requested"] = False
                    break
                if state["paused"]:
                    condition.wait()
                    continue
                next_scan = state["next_scan"]
                remaining = next_scan - time.time() if next_scan is not None else None
                if remaining is None or remaining <= 0:
                    break
                condition.wait(timeout=remaining)
        _run_scan()


def _acquire_lock():
    global _RUN_MUTEX_HANDLE
    identity = hashlib.sha256(str(BASE_DIR).casefold().encode("utf-8")).hexdigest()[:20]
    mutex_name = f"Local\\jobbot_run_{identity}"
    ctypes.set_last_error(0)
    mutex_handle = _KERNEL32.CreateMutexW(None, True, mutex_name)
    if not mutex_handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        _KERNEL32.CloseHandle(mutex_handle)
        return None

    try:
        descriptor = os.open(LOCK_PATH, os.O_CREAT | os.O_RDWR)
    except OSError:
        _KERNEL32.CloseHandle(mutex_handle)
        raise
    if os.fstat(descriptor).st_size == 0:
        os.write(descriptor, b" ")
    os.lseek(descriptor, 0, os.SEEK_SET)
    try:
        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        os.lseek(descriptor, 0, os.SEEK_SET)
        os.write(descriptor, str(os.getpid()).encode("ascii"))
        _RUN_MUTEX_HANDLE = mutex_handle
        return descriptor
    except OSError:
        os.close(descriptor)
        _KERNEL32.CloseHandle(mutex_handle)
        return None


def _write_lock_pid(descriptor: int) -> None:
    os.lseek(descriptor, 0, os.SEEK_SET)
    os.write(descriptor, str(os.getpid()).encode("ascii"))
    os.ftruncate(descriptor, len(str(os.getpid())))


def main() -> None:
    _configure_logging()
    _load_settings()
    descriptor = _acquire_lock()
    if descriptor is None:
        print("البوت شغال بالفعل")
        return
    _write_lock_pid(descriptor)

    try:
        if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID:
            try:
                _send_text(TELEGRAM_CHAT_ID, "🟢 البوت اشتغل")
            except Exception as exc:
                print(f"Could not send startup notification: {type(exc).__name__}")
        else:
            print("Telegram not configured: startup/shutdown notices and commands are unavailable.")

        report_thread = threading.Thread(target=serve_report_server, name="weekly-report-server", daemon=True)
        report_thread.start()
        import radar
        radar_thread = threading.Thread(target=radar.radar_loop, name="freelancer-speed-radar", daemon=True)
        radar_thread.start()
        bot_thread = threading.Thread(target=_bot_loop, name="telegram-bot", daemon=True)
        bot_thread.start()
        scheduler_thread = threading.Thread(target=_scheduler_loop, name="job-scheduler", daemon=True)
        scheduler_thread.start()

        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            with condition:
                state["stopping"] = True
                condition.notify_all()
            if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID:
                try:
                    _send_text(TELEGRAM_CHAT_ID, "🔴 البوت وقف")
                except Exception as exc:
                    print(f"Could not send shutdown notification: {type(exc).__name__}")
    finally:
        os.lseek(descriptor, 0, os.SEEK_SET)
        try:
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        os.close(descriptor)
        if _RUN_MUTEX_HANDLE:
            _KERNEL32.CloseHandle(_RUN_MUTEX_HANDLE)
            _RUN_MUTEX_HANDLE = None
        # Keep the unlocked file so external launchers can safely probe it.


if __name__ == "__main__":
    main()
