import json
from pathlib import Path

from models import Job
from score import score_job
from sources.freelancer import parse_projects, parse_stats
from sources.mostaql import parse_details, parse_stats as parse_mostaql_stats

ROOT = Path(__file__).resolve().parent
SAMPLES = ROOT / "samples"
data = json.loads((SAMPLES / "freelancer_sample.json").read_text(encoding="utf-8"))
projects = data.get("result", {}).get("projects", [])
print("Freelancer sample scoring:")
for project in projects[:3]:
    job = parse_projects({"result": {"projects": [project]}})[0]
    stats = parse_stats({"result": {"projects": [project]}})
    print(job.title, score_job(job, stats))

html_samples = sorted(path for path in SAMPLES.glob("*.html") if "job" in path.name.casefold())
if html_samples:
    html = html_samples[0].read_text(encoding="utf-8", errors="replace")
    description, budget = parse_details(html)
    stats = parse_mostaql_stats(html)
    job = Job("mostaql", "sample", "وظيفة تطوير تطبيق Flutter", description, "https://mostaql.com/project/sample", budget)
    print(f"Mostaql sample scoring ({html_samples[0].name}):", score_job(job, stats))
