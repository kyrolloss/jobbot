import httpx
import random
import time
from datetime import datetime
from bs4 import BeautifulSoup
from urllib.parse import urljoin

from models import Job
from sources.base import Source


def parse_details(html: str) -> tuple[str, str]:
    """Return the full project brief and budget from a Mostaql project page."""
    soup = BeautifulSoup(html, "lxml")

    details_panel = soup.select_one("#projectDetailsTab .text-wrapper-div")
    description = "\n\n".join(
        paragraph.get_text(" ", strip=True)
        for paragraph in details_panel.select("p")
        if paragraph.get_text(" ", strip=True)
    ) if details_panel else ""

    budget = ""
    for row in soup.select(".meta-row"):
        label = row.select_one(".meta-label")
        if label and label.get_text(" ", strip=True) == "الميزانية":
            value = row.select_one('.meta-value[data-type="project-budget_range"]')
            if value:
                budget = value.get_text(" ", strip=True)
                break

    return description, budget


def parse_stats(html: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    bids_panel = soup.select_one("#project-bids")
    if bids_panel is None:
        return {}

    stats = {"bid_count": len(bids_panel.select(".bid[data-bid-item]"))}
    for row in soup.select(".meta-row"):
        label = row.select_one(".meta-label")
        if label and label.get_text(" ", strip=True) == "تاريخ النشر":
            published = row.select_one("time[datetime]")
            if published:
                try:
                    submitted = datetime.fromisoformat(published["datetime"])
                    stats["age_hours"] = max(
                        0,
                        round((datetime.now() - submitted).total_seconds() / 3600, 1),
                    )
                except (ValueError, TypeError):
                    pass
            break
    return stats


class Mostaql(Source):
    name = "mostaql"
    url = "https://mostaql.com/projects?category=development&sort=latest"

    def fetch(self) -> list[Job]:
        time.sleep(random.uniform(1, 3))
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/130.0.0.0 Safari/537.36"
            )
        }
        response = httpx.get(self.url, headers=headers, follow_redirects=True, timeout=30)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "lxml")

        # The live page could not be inspected in this environment (HTTP 403).
        # Extract project links conservatively from their URL shape instead of
        # assuming a page-specific card class.
        jobs = []
        seen = set()
        for link in soup.select('a[href*="/project/"]'):
            href = link.get("href", "").strip()
            title = " ".join(link.get_text(" ", strip=True).split())
            parts = [part for part in href.split("?")[0].split("/") if part]
            external_id = parts[-1] if parts else ""
            if not href or not title or not external_id or external_id in seen:
                continue
            seen.add(external_id)
            full_url = urljoin("https://mostaql.com", href)
            jobs.append(
                Job(
                    source=self.name,
                    external_id=external_id,
                    title=title,
                    description="",
                    url=full_url,
                )
            )
        return jobs

    def fetch_details(self, job: Job) -> Job:
        time.sleep(random.uniform(1, 3))
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/130.0.0.0 Safari/537.36"
            )
        }
        response = httpx.get(job.url, headers=headers, follow_redirects=True, timeout=30)
        response.raise_for_status()
        job.description, job.budget = parse_details(response.text)
        return job

    def fetch_stats(self, job: Job) -> dict:
        time.sleep(random.uniform(1, 3))
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/130.0.0.0 Safari/537.36"
            )
        }
        try:
            response = httpx.get(job.url, headers=headers, follow_redirects=True, timeout=30)
            if response.status_code != 200:
                print(f"Mostaql stats unavailable: HTTP {response.status_code}")
                return {}
            return parse_stats(response.text)
        except Exception as exc:
            print(f"Mostaql stats unavailable: {type(exc).__name__}")
            return {}
