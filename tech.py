import re

from config import TECH_TAGS


_SHORT_KEYWORDS = {
    "api", "apis", "ai", "php", "ios", "llm", "dart", "n8n", "ui", "ux",
    "gpt", "node", "react", "flask", "django", "firebase", "supabase",
    "python", "fastapi", "gemini", "openai", "zapier", "android",
}


def extract_tags(job) -> list[str]:
    """Return sorted configured technology tags mentioned in a job."""
    try:
        text = f"{job.title or ''}\n{job.description or ''}".casefold()
        found = set()
        for tag, keywords in TECH_TAGS.items():
            for keyword in keywords:
                normalized = keyword.casefold().strip()
                if not normalized:
                    continue
                if normalized in _SHORT_KEYWORDS:
                    pattern = rf"(?<!\w){re.escape(normalized)}(?!\w)"
                    matched = re.search(pattern, text, flags=re.IGNORECASE) is not None
                else:
                    matched = normalized in text
                if matched:
                    found.add(tag)
                    break
        return sorted(found)
    except Exception:
        return []
