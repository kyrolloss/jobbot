import json
from pathlib import Path

from sources.freelancer import parse_projects

SAMPLE_PATH = Path(__file__).resolve().parent / "samples" / "freelancer_sample.json"
data = json.loads(SAMPLE_PATH.read_text(encoding="utf-8"))
jobs = parse_projects(data)
print(f"Jobs: {len(jobs)}")
for job in jobs[:3]:
    print(f"{job.title}\n{job.budget}\n{job.url}\n")
