import httpx

from config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID


def main() -> None:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    try:
        httpx.post(
            url,
            json={"chat_id": TELEGRAM_CHAT_ID, "text": "🔴 البوت وقف"},
            timeout=15,
        )
    except Exception:
        # The caller must continue stopping the process even if Telegram fails.
        pass


if __name__ == "__main__":
    main()
