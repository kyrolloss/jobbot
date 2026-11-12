import httpx
import json
import socket
from pathlib import Path

from config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
from models import Job

API_BASE = "https://api.telegram.org"


class TelegramRequestError(RuntimeError):
    def __init__(self, message, *, status_code=None, description=None, original_type=None):
        super().__init__(message)
        self.status_code = status_code
        self.description = description
        self.original_type = original_type


class IPv4HTTPTransport(httpx.HTTPTransport):
    def handle_request(self, request):
        original_getaddrinfo = socket.getaddrinfo

        def ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
            return original_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)

        socket.getaddrinfo = ipv4_getaddrinfo
        try:
            return super().handle_request(request)
        finally:
            socket.getaddrinfo = original_getaddrinfo


def _post(url: str, *, method_name: str, **kwargs) -> httpx.Response:
    last_error = None
    for attempt in range(3):
        try:
            with httpx.Client(transport=IPv4HTTPTransport(), timeout=30) as client:
                response = client.post(url, **kwargs)
            if response.is_error:
                error_text = response.text
                print(f"{method_name}: {error_text}")
                try:
                    description = response.json().get("description")
                except (ValueError, AttributeError):
                    description = None
                raise TelegramRequestError(
                    f"{method_name} failed: HTTP {response.status_code}",
                    status_code=response.status_code,
                    description=description,
                )
            return response
        except (httpx.HTTPError, TelegramRequestError) as exc:
            last_error = exc
            if method_name == "getUpdates" and isinstance(exc, (httpx.ReadTimeout, httpx.ConnectTimeout)):
                raise
            if isinstance(exc, TelegramRequestError) and exc.status_code in (401, 409):
                raise
            if attempt == 2:
                if isinstance(exc, TelegramRequestError):
                    raise TelegramRequestError(
                        f"{method_name} failed: HTTP {exc.status_code}",
                        status_code=exc.status_code,
                        description=exc.description,
                    ) from None
                raise TelegramRequestError(
                    f"{method_name} failed: {type(exc).__name__}",
                    original_type=type(exc).__name__,
                ) from None
    raise TelegramRequestError(
        f"{method_name} failed",
        original_type=type(last_error).__name__ if last_error else "UnknownError",
    )


def send_job(job: Job, prefix: str = "") -> bool:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("Telegram not configured: fill TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env")
        return False

    from db import get_job_score, get_job_rowid, set_message_id

    rowid = get_job_rowid(job)
    if rowid is None:
        raise RuntimeError("sendMessage: job is not saved in the database")

    score_prefix = ""
    saved_score = get_job_score(job)
    if saved_score is not None:
        from score import label_for_score

        score, score_line = saved_score
        score_prefix = f"{label_for_score(score)} {score:.1f}/10\n{score_line}\n"
    source_labels = {
        "freelancer": "🟦 Freelancer",
        "mostaql": "🟩 Mostaql",
        "khamsat": "🟧 Khamsat",
    }
    source_label = source_labels.get(job.source.casefold(), job.source)
    from tech import extract_tags

    tags = extract_tags(job)[:4]
    tags_line = f"🏷 {', '.join(tags)}\n" if tags else ""
    message = f"{prefix}{source_label}\n{score_prefix}{tags_line}{job.title}\n{job.budget}\n{job.description[:300]}\n{job.url}"
    message = message[:4000]
    endpoint = f"{API_BASE}/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    reply_markup = {
        "inline_keyboard": [[
            {"text": "✅ قدّم", "callback_data": f"a|{rowid}"},
            {"text": "❌ تجاهل", "callback_data": f"r|{rowid}"},
        ], [
            {"text": "💰 قدّر السعر", "callback_data": f"e|{rowid}"},
        ], [
            {"text": "🧪 جهّز نموذج", "callback_data": f"p|{rowid}"},
        ]]
    }
    if any(
        len(button["callback_data"].encode("utf-8")) >= 64
        for row in reply_markup["inline_keyboard"]
        for button in row
    ):
        raise ValueError("sendMessage: callback_data must be shorter than 64 bytes")
    response = _post(
        endpoint,
        method_name="sendMessage",
        data={"chat_id": TELEGRAM_CHAT_ID, "text": message, "reply_markup": json.dumps(reply_markup, ensure_ascii=False)},
    )
    result = response.json()
    if not result.get("ok"):
        raise RuntimeError(f"Telegram API error: {result}")

    message_id = (result.get("result") or {}).get("message_id")
    if message_id is not None:
        set_message_id(rowid, message_id)
    return True


def send_radar_proposal(job: Job, rowid: int) -> bool:
    """Draft and deliver a proposal without submitting it to Freelancer."""
    from db import get_proposal, save_proposal
    from proposal import write_proposal

    proposal = get_proposal(rowid)
    if not proposal:
        proposal = write_proposal(job)
        if not proposal:
            return False
        save_proposal(rowid, proposal)
    endpoint = f"{API_BASE}/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    response = _post(
        endpoint,
        method_name="sendMessage radar proposal",
        data={"chat_id": TELEGRAM_CHAT_ID, "text": f"✍️ مسودة عرض — راجعها وقدّمها بنفسك\n\n{proposal}"[:4000]},
    )
    return bool(response.json().get("ok"))


def send_proposal_reply(job: Job, rowid: int, message_id: int | None = None) -> bool:
    from db import get_proposal, save_proposal
    from proposal import write_proposal

    try:
        if get_proposal(rowid):
            return True
        proposal = write_proposal(job)
        if not proposal:
            return False

        save_proposal(rowid, proposal)
        endpoint = f"{API_BASE}/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        text = f"✍️ العرض المقترح\n{job.title}\n\n{proposal}"[:4000]
        data = {"chat_id": TELEGRAM_CHAT_ID, "text": text}
        if message_id is not None:
            data["reply_to_message_id"] = message_id
        response = _post(
            endpoint,
            method_name="sendMessage proposal reply",
            data=data,
        )
        result = response.json()
        if not result.get("ok"):
            print(f"sendMessage proposal reply: {response.text}")
            return False
        return True
    except Exception as exc:
        safe_error = str(exc).replace(TELEGRAM_BOT_TOKEN, "<redacted>")
        print(f"Proposal delivery failed for job rowid {rowid}: {safe_error}")
        return False


def _send_proposal_reply(job: Job, rowid: int, message_id: int) -> None:
    send_proposal_reply(job, rowid, message_id)


def send_document(chat_id, file_path, caption: str = "") -> bool:
    """Upload one local document without logging the token-bearing endpoint URL."""
    if not TELEGRAM_BOT_TOKEN or not chat_id:
        print("sendDocument skipped: Telegram is not configured")
        return False
    try:
        path = Path(file_path)
        caption = str(caption or "")[:1024]
        endpoint = f"{API_BASE}/bot{TELEGRAM_BOT_TOKEN}/sendDocument"
        with path.open("rb") as document:
            with httpx.Client(transport=IPv4HTTPTransport(), timeout=30) as client:
                response = client.post(
                    endpoint,
                    data={"chat_id": str(chat_id), "caption": caption},
                    files={"document": (path.name, document, "text/html")},
                )
        if response.is_error:
            print(f"sendDocument failed: HTTP {response.status_code}")
            return False
        try:
            result = response.json()
        except (ValueError, AttributeError):
            print("sendDocument failed: invalid Telegram response")
            return False
        if not result.get("ok"):
            print("sendDocument failed: Telegram rejected the document")
            return False
        return True
    except Exception as exc:
        print(f"sendDocument failed: {type(exc).__name__}")
        return False
