import json
import re
import threading
import time

import httpx

from config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
from db import count_by_status, get_job_by_rowid, get_job_status, get_proposal, get_prototype_url, save_evaluation, save_proposal, save_prototype_url, set_status
from notifier import API_BASE, TELEGRAM_BOT_TOKEN as _BOT_TOKEN_FOR_REDACTION, _post
from notifier import TelegramRequestError

POLL_TIMEOUT = 30
_PROTOTYPE_LOCK = threading.Lock()


def split_message(text, limit=4000) -> list[str]:
    """Split text on line boundaries, breaking overlong lines at spaces when possible."""
    try:
        text = str(text or "")
        limit = int(limit)
        if limit < 1:
            limit = 4000
    except Exception:
        text, limit = "", 4000
    if not text:
        return []

    units = []
    for line in text.splitlines(keepends=True):
        if len(line) <= limit:
            units.append(line)
            continue
        remaining = line
        while len(remaining) > limit:
            cut = remaining.rfind(" ", 0, limit)
            if cut <= 0:
                cut = limit
            else:
                cut += 1
            units.append(remaining[:cut])
            remaining = remaining[cut:]
        if remaining:
            units.append(remaining)

    if not units:
        units = [text[index:index + limit] for index in range(0, len(text), limit)]
    chunks = []
    current = ""
    for unit in units:
        if len(current) + len(unit) > limit:
            if current:
                chunks.append(current)
            current = unit
        else:
            current += unit
    if current:
        chunks.append(current)
    return chunks


def _send_long_reply(chat_id, text) -> bool:
    try:
        chunks = split_message(text)
    except Exception as exc:
        print(f"Long reply split failed: {type(exc).__name__}")
        return False
    failed = False
    for index, chunk in enumerate(chunks, start=1):
        try:
            _api("sendMessage", {"chat_id": chat_id, "text": chunk})
        except Exception as exc:
            failed = True
            print(f"Long reply chunk {index}/{len(chunks)} failed: {type(exc).__name__}")
    return not failed


def _api(method: str, data: dict) -> dict:
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("Telegram not configured: fill TELEGRAM_BOT_TOKEN in .env")
    request_options = {}
    if method == "getUpdates":
        request_options["timeout"] = httpx.Timeout(connect=10, read=40, write=10, pool=10)
    response = _post(
        f"{API_BASE}/bot{TELEGRAM_BOT_TOKEN}/{method}",
        method_name=method,
        data=data,
        **request_options,
    )
    result = response.json()
    if not result.get("ok"):
        raise TelegramRequestError(
            f"{method} failed: {result.get('error_code', 'unknown')}",
            status_code=result.get("error_code"),
            description=result.get("description"),
        )
    return result["result"]


def _authorized_chat(chat_id) -> bool:
    return TELEGRAM_CHAT_ID and str(chat_id) == str(TELEGRAM_CHAT_ID)


def _report_polling_error(exc) -> int | None:
    status_code = getattr(exc, "status_code", None)
    description = getattr(exc, "description", None)
    if status_code == 401:
        print("Telegram polling error: 401 Unauthorized — التوكن غلط أو اتلغى")
        return 401
    if status_code == 409:
        print("Telegram polling error: 409 Conflict — في نسخة تانية بتسحب التحديثات")
        return 409
    if status_code is not None:
        detail = description or ""
        detail = detail.replace(_BOT_TOKEN_FOR_REDACTION, "<redacted>")
        detail = re.sub(r"https?://\S+", "<URL>", detail)
        print(f"Telegram polling error: {status_code} {detail}".rstrip())
    else:
        original_type = getattr(exc, "original_type", None) or type(exc).__name__
        print(f"Telegram polling error: {original_type}")
    return status_code


def _answer_callback(callback_id: str, text: str) -> None:
    try:
        _api("answerCallbackQuery", {"callback_query_id": callback_id, "text": text})
    except Exception:
        pass


def _remove_keyboard(chat_id, message_id: int, text: str) -> None:
    _api(
        "editMessageReplyMarkup",
        {
            "chat_id": chat_id,
            "message_id": message_id,
            "reply_markup": json.dumps({"inline_keyboard": []}),
        },
    )


def _fetch_job_stats(job) -> dict:
    if job.source == "freelancer":
        from sources.freelancer import FreelancerSource

        return FreelancerSource().fetch_stats(job)
    if job.source == "mostaql":
        from sources.mostaql import Mostaql

        return Mostaql().fetch_stats(job)
    return {}


def _format_number(value) -> str:
    try:
        return f"{float(value):g}"
    except (TypeError, ValueError):
        return "غير متاح"


def _evaluation_message(evaluation: dict, stats: dict, job) -> str:
    verdicts = {"apply": "✅ قدّم", "maybe": "⚠️ متردد", "skip": "⛔ مش مستاهل"}
    competitions = {"low": "منخفضة", "medium": "متوسطة", "high": "عالية"}
    bid_count = stats.get("bid_count")
    bid_avg = stats.get("bid_avg")
    if bid_avg is not None and stats.get("currency"):
        average_text = f"{_format_number(bid_avg)} {stats['currency']}"
    else:
        average_text = _format_number(bid_avg)
    suggested_bid = evaluation.get("suggested_bid")
    suggested_text = _format_number(suggested_bid) if suggested_bid is not None else "غير مقترح"
    reasons = evaluation.get("reasons") or ["مفيش أسباب متاحة."]
    return "\n".join([
        f"الحكم: {verdicts.get(evaluation.get('verdict'), '⚠️ متردد')} | الدرجة: {_format_number(evaluation.get('score'))}/10",
        f"عدد العروض: {_format_number(bid_count)}",
        f"متوسط العروض: {average_text}",
        f"المنافسة: {competitions.get(evaluation.get('competition'), 'غير متاحة')}",
        f"تقييم الميزانية: {evaluation.get('budget_fit', 'غير متاح')} (ميزانية الوظيفة: {job.budget or 'غير محددة'})",
        "الأسباب:",
        *[f"• {reason}" for reason in reasons],
        f"السعر المقترح: {suggested_text}",
    ])


def _write_and_send_proposal(job, rowid: int, chat_id) -> bool:
    proposal = get_proposal(rowid)
    if not proposal:
        from proposal import write_proposal

        proposal = write_proposal(job)
        if not proposal:
            _api("sendMessage", {"chat_id": chat_id, "text": "⚠️ تعذرت كتابة العرض. حاول مرة تانية."})
            return False
        prototype_url = get_prototype_url(rowid)
        if prototype_url:
            from prototype import add_prototype_line

            proposal = add_prototype_line(proposal, prototype_url)
        save_proposal(rowid, proposal)
    else:
        prototype_url = get_prototype_url(rowid)
        if prototype_url:
            from prototype import add_prototype_line

            updated_proposal = add_prototype_line(proposal, prototype_url)
            if updated_proposal != proposal:
                proposal = updated_proposal
                save_proposal(rowid, proposal, overwrite=True)

    _api("sendMessage", {"chat_id": chat_id, "text": proposal})
    markup = {"inline_keyboard": [[
        {"text": "تم التقديم ✔️", "callback_data": f"d|{rowid}"},
        {"text": "🧪 جهّز نموذج", "callback_data": f"p|{rowid}"},
    ]]}
    _api(
        "sendMessage",
        {
            "chat_id": chat_id,
            "text": f"{job.title}\n{job.url}",
            "reply_markup": json.dumps(markup, ensure_ascii=False),
        },
    )
    set_status(job, "approved")
    return True


def _evaluate_and_respond(job, rowid: int, chat_id, original_message_id: int) -> None:
    progress = _api("sendMessage", {"chat_id": chat_id, "text": "⏳ بفحص الوظيفة..."})
    try:
        stats = _fetch_job_stats(job)
        from evaluate import evaluate_job

        evaluation = evaluate_job(job, stats)
        save_evaluation(rowid, evaluation, stats)
        text = _evaluation_message(evaluation, stats, job)
        if evaluation.get("verdict") == "skip":
            markup = {"inline_keyboard": [[{"text": "✍️ اكتب العرض برضه", "callback_data": f"w|{rowid}"}]]}
            _api(
                "editMessageText",
                {
                    "chat_id": chat_id,
                    "message_id": progress.get("message_id"),
                    "text": text,
                    "reply_markup": json.dumps(markup, ensure_ascii=False),
                },
            )
            _remove_keyboard(chat_id, original_message_id, "")
            return

        _api(
            "editMessageText",
            {"chat_id": chat_id, "message_id": progress.get("message_id"), "text": text},
        )
        proposal_sent = False
        try:
            proposal_sent = _write_and_send_proposal(job, rowid, chat_id)
        except Exception as exc:
            print(f"Proposal send failed: {type(exc).__name__}")
        try:
            _estimate_and_send(job, rowid, chat_id, stats=stats)
        except Exception as exc:
            print(f"Estimate send failed: {type(exc).__name__}")
        if proposal_sent:
            _remove_keyboard(chat_id, original_message_id, "")
    except Exception as exc:
        print(f"Job evaluation failed: {type(exc).__name__}")
        _api("sendMessage", {"chat_id": chat_id, "text": "⚠️ تعذر فحص الوظيفة. حاول مرة تانية."})


def _estimate_and_send(job, rowid: int, chat_id, stats: dict | None = None) -> None:
    progress = None
    try:
        progress = _api("sendMessage", {"chat_id": chat_id, "text": "⏳ بقدّر الوقت والسعر"})
        if stats is None:
            try:
                stats = _fetch_job_stats(job)
            except Exception as exc:
                print(f"Estimate stats unavailable: {type(exc).__name__}")
                stats = {}

        from db import get_estimate, save_estimate
        from estimate import compute_pricing, estimate_job, format_estimate_message
        from prices import get_market_medians

        try:
            market = get_market_medians()
        except Exception as exc:
            print(f"Estimate market data unavailable: {type(exc).__name__}")
            market = {}

        estimate = get_estimate(rowid)
        saved = estimate is not None
        if estimate is None:
            estimate = estimate_job(job, stats=stats, market=market)
            if not estimate.get("error"):
                try:
                    save_estimate(rowid, estimate)
                except Exception as exc:
                    print(f"Estimate cache save failed: {type(exc).__name__}")

        pricing = compute_pricing(estimate, job, stats or {}, market)
        if saved:
            pricing["saved"] = True
        response_text = format_estimate_message(job, estimate, pricing)
        message_id = (progress or {}).get("message_id")
        if message_id is not None:
            _api("editMessageText", {"chat_id": chat_id, "message_id": message_id, "text": response_text})
        else:
            _api("sendMessage", {"chat_id": chat_id, "text": response_text})
    except Exception as exc:
        print(f"Estimate action failed: {type(exc).__name__}")
        fallback = "⚠️ تعذر تقدير الوقت والسعر دلوقتي. العرض والتقديم لسه بإيدك."
        try:
            message_id = (progress or {}).get("message_id")
            if message_id is not None:
                _api("editMessageText", {"chat_id": chat_id, "message_id": message_id, "text": fallback})
            else:
                _api("sendMessage", {"chat_id": chat_id, "text": fallback})
        except Exception:
            pass


def _handle_callback(callback: dict) -> None:
    message = callback.get("message") or {}
    chat_id = (message.get("chat") or {}).get("id")
    if not _authorized_chat(chat_id):
        return

    callback_id = callback.get("id", "")
    parts = (callback.get("data") or "").split("|", 1)
    if len(parts) != 2 or parts[0] not in ("a", "r", "d", "w", "e", "p") or not parts[1].isdigit():
        _answer_callback(callback_id, "طلب غير صالح")
        return

    action, rowid_text = parts
    rowid = int(rowid_text)
    job = get_job_by_rowid(rowid)
    current_status = get_job_status(job.source, job.external_id) if job else None
    valid_status = (
        current_status == "approved" if action == "d"
        else current_status in ("new", "sent", "approved") if action == "p"
        else current_status == "sent"
    )
    if not valid_status:
        _answer_callback(callback_id, "اتعالجت قبل كده")
        try:
            _remove_keyboard(chat_id, message.get("message_id"), "")
        except Exception as exc:
            print(f"Could not remove processed buttons: {exc}")
        return

    if action == "p":
        if not _PROTOTYPE_LOCK.acquire(blocking=False):
            _answer_callback(callback_id, "في نموذج بيتجهّز دلوقتي")
            return
        try:
            _answer_callback(callback_id, "⏳ بجهّز النموذج")
            _api("sendMessage", {"chat_id": chat_id, "text": "⏳ بجهّز النموذج (ممكن ياخد دقيقة)"})
            from prototype import make_prototype

            result = make_prototype(job)
            if not result.get("ok"):
                reason = str(result.get("error") or "تعذر تجهيز النموذج.")[:250]
                _send_long_reply(chat_id, f"⚠️ مقدرتش أجهّز النموذج: {reason}")
                return
            title = " ".join(str(job.title or "").split())[:250]
            caption = (
                f"الوظيفة #{rowid}: {title}{' | قالب احتياطي' if result.get('fallback') else ''}\n"
                "افتحه وراجعه، وبعدين ارفعه بنفسك (مثلاً Netlify Drop)\n"
                f"وبعدها ابعت: /proto_link {rowid} <الرابط>"
            )
            from notifier import send_document

            if not send_document(chat_id, result.get("path", ""), caption):
                _send_long_reply(chat_id, "⚠️ النموذج اتجهّز، بس مقدرتش أبعته على تليجرام. تقدر تجرّب تاني.")
        except Exception as exc:
            print(f"Prototype callback failed: {type(exc).__name__}")
            try:
                _send_long_reply(chat_id, "⚠️ حصلت مشكلة وأنا بجهّز النموذج. جرّب تاني بعد شوية.")
            except Exception:
                pass
        finally:
            _PROTOTYPE_LOCK.release()
    elif action == "e":
        _answer_callback(callback_id, "⏳ بقدّر الوقت والسعر")
        _estimate_and_send(job, rowid, chat_id)
    elif action == "a":
        _answer_callback(callback_id, "⏳ جاري الفحص")
        try:
            _evaluate_and_respond(job, rowid, chat_id, message.get("message_id"))
        except Exception as exc:
            print(f"Job evaluation failed: {type(exc).__name__}")
            try:
                _api("sendMessage", {"chat_id": chat_id, "text": "⚠️ تعذر فحص الوظيفة. حاول مرة تانية."})
            except Exception:
                pass
    elif action == "r":
        set_status(job, "rejected")
        result_text = "❌ تم التجاهل"
        _answer_callback(callback_id, result_text)
        _remove_keyboard(chat_id, message.get("message_id"), result_text)
        try:
            _api(
                "editMessageText",
                {"chat_id": chat_id, "message_id": message.get("message_id"), "text": f"{message.get('text', '')}\n\n{result_text}"},
            )
        except Exception as exc:
            print(f"Could not update Telegram message text: {exc}")
    elif action == "d":
        set_status(job, "applied")
        result_text = "✔️ تم التقديم"
        _answer_callback(callback_id, result_text)
        _remove_keyboard(chat_id, message.get("message_id"), "")
        try:
            _api(
                "editMessageText",
                {"chat_id": chat_id, "message_id": message.get("message_id"), "text": f"{message.get('text', '')}\n\n{result_text}"},
            )
        except Exception as exc:
            print(f"Could not update Telegram message text: {exc}")
    else:
        _answer_callback(callback_id, "✍️ جاري كتابة العرض")
        try:
            if _write_and_send_proposal(job, rowid, chat_id):
                _remove_keyboard(chat_id, message.get("message_id"), "")
        except Exception as exc:
            print(f"Proposal action failed: {type(exc).__name__}")
            try:
                _api("sendMessage", {"chat_id": chat_id, "text": "⚠️ تعذرت كتابة العرض. حاول مرة تانية."})
            except Exception:
                pass


def _handle_message(message: dict) -> None:
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    if not _authorized_chat(chat_id):
        return
    command = (message.get("text") or "").split()
    if command and command[0].split("@", 1)[0] == "/status":
        counts = count_by_status()
        text = "حالة الوظائف:\n" + "\n".join(f"{status}: {count}" for status, count in counts.items())
        _api("sendMessage", {"chat_id": chat_id, "text": text})
    elif command and command[0].split("@", 1)[0] == "/prices":
        _handle_prices(chat_id, command[1:])
    elif command and command[0].split("@", 1)[0] == "/timing":
        _handle_timing(chat_id, command[1:])
    elif command and command[0].split("@", 1)[0] == "/radar":
        import radar
        radar.handle_command(chat_id, command[1:], lambda target, text: _api("sendMessage", {"chat_id": target, "text": text}))
    elif command and command[0].split("@", 1)[0] == "/proto_link":
        _handle_proto_link(chat_id, command[1:])
    elif command and command[0].split("@", 1)[0] == "/proto_demo":
        _handle_proto_demo(chat_id, command[1:])


def _handle_proto_link(chat_id, arguments: list[str]) -> None:
    if not _authorized_chat(chat_id):
        return
    if len(arguments) != 2:
        _api("sendMessage", {"chat_id": chat_id, "text": "استخدم: /proto_link رقم_الوظيفة https://الرابط"})
        return
    try:
        rowid = int(arguments[0])
    except (TypeError, ValueError, OverflowError):
        rowid = 0
    from prototype import add_prototype_line, validate_prototype_url

    url = arguments[1]
    if rowid <= 0 or not validate_prototype_url(url):
        _api("sendMessage", {"chat_id": chat_id, "text": "الرابط لازم يبدأ بـ https:// (أو http://localhost)، وأقصر من 300 حرف."})
        return
    try:
        if not save_prototype_url(rowid, url):
            _api("sendMessage", {"chat_id": chat_id, "text": "مقدرتش أحفظ الرابط. راجع رقم الوظيفة وجرب تاني."})
            return
        proposal = get_proposal(rowid)
        if not proposal:
            _api("sendMessage", {"chat_id": chat_id, "text": "اتحفظ الرابط، وهضيفه للعرض لما يتكتب."})
            return
        updated = add_prototype_line(proposal, url)
        if updated != proposal and not save_proposal(rowid, updated, overwrite=True):
            _api("sendMessage", {"chat_id": chat_id, "text": "اتحفظ الرابط، بس مقدرتش أعدّل العرض المحفوظ."})
            return
        _send_long_reply(chat_id, updated)
    except Exception as exc:
        print(f"Prototype link command failed: {type(exc).__name__}")
        try:
            _api("sendMessage", {"chat_id": chat_id, "text": "⚠️ مقدرتش أحفظ رابط النموذج دلوقتي. جرّب تاني."})
        except Exception:
            pass


def _handle_proto_demo(chat_id, arguments: list[str]) -> None:
    if not _authorized_chat(chat_id):
        return
    from prototype_kit import THEMES, normalize_theme
    from prototype import build_demo
    from notifier import send_document

    requested = arguments[0] if len(arguments) == 1 else None
    if len(arguments) > 1:
        _api("sendMessage", {"chat_id": chat_id, "text": "استخدم /proto_demo أو /proto_demo اسم_الثيم"})
        return
    themes_text = "الثيمات: " + "، ".join(THEMES)
    if requested is not None and requested not in THEMES:
        _api("sendMessage", {"chat_id": chat_id, "text": f"اسم الثيم مش معروف. {themes_text}"})
        return
    theme = normalize_theme(requested) if requested else THEMES[0]
    try:
        if requested is None:
            _api("sendMessage", {"chat_id": chat_id, "text": f"{themes_text}\nهبعتلك معاينة {theme}."})
        result = build_demo(theme)
        if not send_document(chat_id, result["path"], f"معاينة الثيم: {theme} (بيانات تجريبية)"):
            _api("sendMessage", {"chat_id": chat_id, "text": "⚠️ مقدرتش أبعت ملف المعاينة دلوقتي."})
    except Exception as exc:
        print(f"Prototype demo failed: {type(exc).__name__}")
        _api("sendMessage", {"chat_id": chat_id, "text": "⚠️ مقدرتش أجهّز المعاينة دلوقتي."})


def _handle_prices(chat_id, arguments: list[str]) -> None:
    from config import PRICE_REPORT_DEFAULT_DAYS
    from prices import build_price_report

    days = PRICE_REPORT_DEFAULT_DAYS
    if arguments:
        if len(arguments) != 1:
            _api("sendMessage", {"chat_id": chat_id, "text": "استخدم /prices أو /prices 7 (من 1 لـ365 يوم)."})
            return
        try:
            days = int(arguments[0])
        except (TypeError, ValueError, OverflowError):
            days = 0
        if not 1 <= days <= 365:
            _api("sendMessage", {"chat_id": chat_id, "text": "استخدم /prices أو /prices 7 (من 1 لـ365 يوم)."})
            return
    try:
        _send_long_reply(chat_id, build_price_report(days))
    except Exception as exc:
        print(f"Price command failed: {type(exc).__name__}")
        try:
            _send_long_reply(chat_id, "⚠️ مقدرتش أجهز تقرير الأسعار دلوقتي. جرّب تاني بعد شوية.")
        except Exception:
            pass


def _handle_timing(chat_id, arguments: list[str]) -> None:
    from config import TIMING_REPORT_DEFAULT_DAYS, TIMING_REPORT_MAX_DAYS, TIMING_REPORT_MIN_DAYS

    try:
        days = TIMING_REPORT_DEFAULT_DAYS
        if arguments:
            if len(arguments) != 1:
                _api("sendMessage", {"chat_id": chat_id, "text": "استخدم /timing أو /timing 7 (من 1 لـ365 يوم)."})
                return
            try:
                days = int(arguments[0])
            except (TypeError, ValueError, OverflowError):
                days = 0
            if not TIMING_REPORT_MIN_DAYS <= days <= TIMING_REPORT_MAX_DAYS:
                _api("sendMessage", {"chat_id": chat_id, "text": "استخدم /timing أو /timing 7 (من 1 لـ365 يوم)."})
                return

        from timing import build_timing_report

        _send_long_reply(chat_id, build_timing_report(days))
    except Exception as exc:
        print(f"Timing command failed: {type(exc).__name__}")
        try:
            _send_long_reply(chat_id, "⚠️ مقدرتش أجهز تقرير التوقيت دلوقتي. جرّب تاني بعد شوية.")
        except Exception:
            pass


def run_bot() -> None:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("Telegram not configured: fill TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env")
        return

    offset = None
    while True:
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
                    _handle_message(update["message"])
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


if __name__ == "__main__":
    run_bot()

