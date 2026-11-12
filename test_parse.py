from pathlib import Path

from sources.mostaql import parse_details

SAMPLE_PATH = Path(__file__).resolve().parent / "samples" / "job_sample.html"
html = SAMPLE_PATH.read_text(encoding="utf-8")
description, budget = parse_details(html)

print("Description:")
print(description)
print("\nBudget:")
print(budget)
