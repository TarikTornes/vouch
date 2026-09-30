"""Value normalization + text helpers shared by extraction and the plain-RAG grader."""
from __future__ import annotations

import re

_NUM = re.compile(r"\d+(?:[.,]\d+)?")


def numbers_in(text: str) -> list[float]:
    return [float(n.replace(",", ".")) for n in _NUM.findall(text or "")]


def _fmt(n: float) -> str:
    return str(int(n)) if n == int(n) else f"{n:.2f}".rstrip("0")


def normalize_value(raw: str, value_type: str) -> str | None:
    """Return the canonical value string, or None if it can't be normalized."""
    raw = (raw or "").strip()
    if value_type == "yes_no":
        low = raw.lower()
        if low in {"yes", "y", "true"}:
            return "yes"
        if low in {"no", "n", "false"}:
            return "no"
        return None
    nums = numbers_in(raw)
    if len(nums) != 1:
        return None
    n = nums[0]
    if value_type == "percent":
        return f"{_fmt(n)}%"
    if value_type == "eur":
        return f"€{_fmt(n)}"
    if value_type == "eur_per_km":
        return f"€{_fmt(n)}/km"
    return None


def squash(text: str) -> str:
    """Whitespace-normalize and lower-case for verbatim-substring checks."""
    return re.sub(r"\s+", " ", (text or "").replace("**", "")).strip().lower()
