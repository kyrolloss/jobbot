from abc import ABC, abstractmethod

from models import Job


class Source(ABC):
    name: str

    @abstractmethod
    def fetch(self) -> list[Job]:
        """Fetch jobs from this source."""
        raise NotImplementedError

    def fetch_stats(self, job: Job) -> dict:
        """Fetch live competition and budget statistics when supported."""
        return {}
