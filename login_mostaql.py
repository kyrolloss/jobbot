from pathlib import Path

from playwright.sync_api import sync_playwright

BASE_DIR = Path(__file__).resolve().parent
PROFILE_DIR = BASE_DIR / "browser_profile"


def main() -> None:
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("https://mostaql.com", wait_until="domcontentloaded")
        print("سجّل الدخول يدويًا في نافذة المتصفح. اضغط Enter هنا لإغلاقها.")
        try:
            input()
        finally:
            context.close()


if __name__ == "__main__":
    main()
