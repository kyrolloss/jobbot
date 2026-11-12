import json
from pathlib import Path

from sources.freelancer import parse_stats as parse_freelancer_stats
from sources.mostaql import parse_stats as parse_mostaql_stats

SAMPLES_DIR = Path(__file__).resolve().parent / "samples"
freelancer_sample = SAMPLES_DIR / "freelancer_sample.json"
data = json.loads(freelancer_sample.read_text(encoding="utf-8"))
projects = data.get("result", {}).get("projects", [])

print("Freelancer stats (first 3 projects):")
for project in projects[:3]:
    project_data = {"result": {"projects": [project]}}
    print(f"{project.get('title', '(بدون عنوان)')}: {parse_freelancer_stats(project_data)}")

mostaql_samples = sorted(
    path for path in SAMPLES_DIR.glob("*.html")
    if "job" in path.name.casefold()
)
if not mostaql_samples:
    print("No saved Mostaql job HTML samples found.")
else:
    for path in mostaql_samples:
        html = path.read_text(encoding="utf-8", errors="replace")
        print(f"Mostaql stats ({path.name}): {parse_mostaql_stats(html)}")
