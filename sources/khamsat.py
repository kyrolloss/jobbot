import re
import time
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from config import (
    KHAMSAT_BASE_URL,
    KHAMSAT_REQUESTS_URL,
    KHAMSAT_REQUEST_GAP_SECONDS,
    KHAMSAT_TIMEOUT_SECONDS,
    KHAMSAT_USER_AGENT,
)
from models import Job
from sources.base import Source


_LAST_REQUEST_AT = 0.0
_REQUEST_ID = re.compile(r"^/community/requests/(\d+)(?:-|/|$)")


def _get(url: str) -> httpx.Response:
    """Make one permitted request, keeping at least two seconds between starts."""
    global _LAST_REQUEST_AT
    now = time.monotonic()
    if _LAST_REQUEST_AT:
        time.sleep(max(0.0, KHAMSAT_REQUEST_GAP_SECONDS - (now - _LAST_REQUEST_AT)))
    _LAST_REQUEST_AT = time.monotonic()
    return httpx.get(
        url,
        headers={"User-Agent": KHAMSAT_USER_AGENT},
        timeout=KHAMSAT_TIMEOUT_SECONDS,
        follow_redirects=False,
    )


def parse_list(html: str) -> list[Job]:
    soup = BeautifulSoup(html, "lxml")
    jobs = []
    seen_ids = set()

    for row in soup.select("tr.forum_post"):
        link = row.select_one("td.details-td h3.details-head a[href]")
        if link is None:
            continue
        href = link.get("href", "").strip()
        path = urlparse(href).path
        match = _REQUEST_ID.match(path)
        title = " ".join(link.get_text(" ", strip=True).split())
        if not match or not title:
            continue
        external_id = match.group(1)
        if external_id in seen_ids:
            continue
        seen_ids.add(external_id)
        jobs.append(
            Job(
                source="khamsat",
                external_id=external_id,
                title=title,
                description="",
                url=urljoin(KHAMSAT_BASE_URL, href),
                budget="",
            )
        )
    return jobs


def parse_stats(html: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    stats = {}

    # The saved page labels this count as comments, not bids; expose the count
    # through the shared bid_count interface for the existing scoring pipeline.
    for heading in soup.select("div.card h3"):
        match = re.search(r"التعليقات\s*\(([\d,]+)\)", heading.get_text(" ", strip=True))
        if match:
            stats["bid_count"] = int(match.group(1).replace(",", ""))
            break

    published = soup.select_one('#community_sidebar #sidebar span[title]')
    if published:
        try:
            date_text = published["title"].strip()
            submitted = datetime.strptime(date_text, "%d/%m/%Y %H:%M:%S GMT").replace(
                tzinfo=timezone.utc
            )
            stats["age_hours"] = max(
                0.0,
                round((datetime.now(timezone.utc) - submitted).total_seconds() / 3600, 1),
            )
        except (ValueError, TypeError, KeyError):
            pass
    return stats


def parse_details(html: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    article = soup.select_one(".js-page article.replace_urls")
    description = article.get_text("\n", strip=True) if article else ""
    details = {"description": description, "budget": ""}
    details.update(parse_stats(html))
    return details


class KhamsatSource(Source):
    name = "khamsat"

    def __init__(self):
        self.details_blocked = False

    def fetch(self) -> list[Job]:
        self.details_blocked = False
        try:
            response = _get(KHAMSAT_REQUESTS_URL)
            if response.status_code != 200:
                print(f"Khamsat list unavailable: HTTP {response.status_code}")
                return []
            if not response.text.strip():
                print("Khamsat list unavailable: empty response")
                return []
            return parse_list(response.text)
        except Exception as exc:
            print(f"Khamsat list unavailable: {type(exc).__name__}")
            return []

    def fetch_details(self, job: Job) -> Job:
        if self.details_blocked:
            return job
        path = urlparse(job.url).path
        if not _REQUEST_ID.match(path):
            print("Khamsat details unavailable: invalid request URL")
            return job
        try:
            response = _get(job.url)
            if response.status_code != 200:
                self.details_blocked = True
                print(
                    f"Khamsat details unavailable (HTTP {response.status_code}); "
                    "skipping details for this scan"
                )
                return job
            if not response.text.strip():
                self.details_blocked = True
                print("Khamsat details unavailable (empty response); skipping details for this scan")
                return job
            details = parse_details(response.text)
            if details["description"]:
                job.description = details["description"]
            if details["budget"]:
                job.budget = details["budget"]
            return job
        except Exception as exc:
            print(f"Khamsat details unavailable: {type(exc).__name__}")
            return job

    def fetch_stats(self, job: Job) -> dict:
        if self.details_blocked:
            return {}
        path = urlparse(job.url).path
        if not _REQUEST_ID.match(path):
            print("Khamsat stats unavailable: invalid request URL")
            return {}
        try:
            response = _get(job.url)
            if response.status_code != 200:
                self.details_blocked = True
                print(
                    f"Khamsat details unavailable (HTTP {response.status_code}); "
                    "skipping details for this scan"
                )
                return {}
            if not response.text.strip():
                self.details_blocked = True
                print("Khamsat details unavailable (empty response); skipping details for this scan")
                return {}
            return parse_stats(response.text)
        except Exception as exc:
            print(f"Khamsat stats unavailable: {type(exc).__name__}")
            return {}
