import time
from datetime import datetime, timezone

import httpx

from config import FREELANCER_QUERIES
from models import Job
from sources.base import Source

API_URL = "https://www.freelancer.com/api/projects/0.1/projects/active/"
PROJECT_URL_BASE = "https://www.freelancer.com/projects/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0.0.0 Safari/537.36"
)


def _format_amount(value) -> str:
    number = float(value)
    return str(int(number)) if number.is_integer() else f"{number:g}"


def parse_projects(data: dict) -> list[Job]:
    jobs = []
    seen_ids = set()
    result = data.get("result")
    projects = result.get("projects", []) if isinstance(result, dict) else []

    for project in projects:
        if not isinstance(project, dict):
            continue
        project_id = project.get("id")
        title = project.get("title")
        description = project.get("description")
        seo_url = project.get("seo_url")
        if project_id is None or not title or not seo_url or str(project_id) in seen_ids:
            continue
        seen_ids.add(str(project_id))

        budget_data = project.get("budget") or {}
        currency_data = project.get("currency") or {}
        minimum = budget_data.get("minimum")
        maximum = budget_data.get("maximum")
        currency_code = currency_data.get("code", "").strip()
        if minimum is not None and maximum is not None and currency_code:
            budget = f"{_format_amount(minimum)}-{_format_amount(maximum)} {currency_code}"
            if project.get("type") == "hourly":
                budget += "/hr"
        else:
            budget = ""

        jobs.append(
            Job(
                source="freelancer",
                external_id=str(project_id),
                title=str(title).strip(),
                description=str(description or "").strip(),
                url=PROJECT_URL_BASE + str(seo_url).lstrip("/"),
                budget=budget,
            )
        )
    return jobs


def parse_stats(data: dict, project_id: str | None = None) -> dict:
    result = data.get("result")
    projects = result.get("projects", []) if isinstance(result, dict) else []
    project = next(
        (item for item in projects if project_id is None or str(item.get("id")) == str(project_id)),
        None,
    )
    if not isinstance(project, dict):
        return {}

    bid_stats = project.get("bid_stats") or {}
    budget = project.get("budget") or {}
    currency = project.get("currency") or {}
    stats = {
        "bid_count": bid_stats.get("bid_count"),
        "bid_avg": bid_stats.get("bid_avg"),
        "budget_min": budget.get("minimum"),
        "budget_max": budget.get("maximum"),
        "currency": currency.get("code"),
        "hourly": project.get("type") == "hourly",
    }
    submitted = project.get("time_submitted")
    if submitted is not None:
        stats["time_submitted"] = submitted
    return {key: value for key, value in stats.items() if value is not None}


class FreelancerSource(Source):
    name = "freelancer"

    def fetch(self) -> list[Job]:
        jobs = []
        seen_ids = set()
        for index, query in enumerate(FREELANCER_QUERIES):
            if index:
                time.sleep(1.5)
            try:
                response = httpx.get(
                    API_URL,
                    params={
                        "query": query,
                        "limit": 20,
                        "full_description": True,
                        "job_details": True,
                        "sort_field": "time_submitted",
                        "reverse_sort": True,
                    },
                    headers={"User-Agent": USER_AGENT},
                    timeout=30,
                )
                if response.status_code != 200:
                    print(f"Freelancer query failed: HTTP {response.status_code}")
                    continue
                parsed = parse_projects(response.json())
            except (httpx.HTTPError, ValueError) as exc:
                print(f"Freelancer query failed: {type(exc).__name__}")
                continue
            except Exception as exc:
                print(f"Freelancer query failed: {type(exc).__name__}")
                continue

            for job in parsed:
                if job.external_id not in seen_ids:
                    seen_ids.add(job.external_id)
                    jobs.append(job)
        return jobs

    def fetch_details(self, job: Job) -> Job:
        # The active-project response already includes the full description.
        return job

    def fetch_stats(self, job: Job) -> dict:
        try:
            response = httpx.get(
                API_URL,
                params={
                    "project_ids[]": job.external_id,
                    "limit": 1,
                    "full_description": True,
                    "job_details": True,
                },
                headers={"User-Agent": USER_AGENT},
                timeout=30,
            )
            if response.status_code != 200:
                print(f"Freelancer stats unavailable: HTTP {response.status_code}")
                return {}
            stats = parse_stats(response.json(), job.external_id)
            submitted = stats.get("time_submitted")
            if submitted is not None:
                age_hours = (datetime.now(timezone.utc).timestamp() - float(submitted)) / 3600
                stats["age_hours"] = max(0, round(age_hours, 1))
            return stats
        except Exception as exc:
            print(f"Freelancer stats unavailable: {type(exc).__name__}")
            return {}
