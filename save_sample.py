import argparse
import sqlite3
from pathlib import Path

import httpx

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "jobs.db"
OUTPUT_PATH = BASE_DIR / "samples" / "job_sample.html"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0.0.0 Safari/537.36"
)


def first_job_url() -> str:
    with sqlite3.connect(DB_PATH) as connection:
        row = connection.execute(
            "SELECT url FROM jobs ORDER BY created_at, rowid LIMIT 1"
        ).fetchone()
    if row is None:
        raise RuntimeError(f"No jobs found in database: {DB_PATH}")
    return row[0]


def main() -> None:
    parser = argparse.ArgumentParser(description="Save a Mostaql job page for offline inspection.")
    parser.add_argument("url", nargs="?", help="Job URL; defaults to the first URL in jobs.db")
    args = parser.parse_args()
    url = args.url or first_job_url()

    response = httpx.get(
        url,
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
        timeout=30,
    )
    response.raise_for_status()

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    content = response.content
    OUTPUT_PATH.write_bytes(content)
    print(f"Saved {len(content)} bytes to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
