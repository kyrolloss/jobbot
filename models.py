from dataclasses import dataclass


@dataclass
class Job:
    source: str
    external_id: str
    title: str
    description: str
    url: str
    budget: str = ""