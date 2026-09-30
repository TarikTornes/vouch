"""Deterministic trust scoring: (claim, doc) -> (score, human-readable reasons). No ML, no LLM."""
from __future__ import annotations

import datetime as dt

from .models import SOURCE_TYPE_LABELS, Claim, Doc


def pts(p: int) -> str:
    return f"(+{p})" if p >= 0 else f"(−{abs(p)})"


def months_between(start: str, end: str) -> int:
    a, b = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    m = (b.year - a.year) * 12 + (b.month - a.month)
    return m - 1 if b.day < a.day else m


def pretty_date(iso: str) -> str:
    return dt.date.fromisoformat(iso).strftime("%-d %b %Y")


def score(claim: Claim, doc: Doc, in_scope: list[tuple[Claim, Doc]], rules: dict, owner_active: bool) -> tuple[int, list[str]]:
    total, reasons = 0, []

    p = rules["source_type_points"].get(doc.source_type, 0)
    total += p
    reasons.append(f"{SOURCE_TYPE_LABELS.get(doc.source_type, doc.source_type)} {pts(p)}")

    age = months_between(doc.date, rules["as_of"])
    if age <= rules["recent_months"]:
        p = rules["recent_points"]
        reasons.append(f"updated {age} month{'s' if age != 1 else ''} ago {pts(p)}")
    elif age > rules["old_months"]:
        p = rules["old_points"]
        reasons.append(f"older than {rules['old_months']} months — {age} months old {pts(p)}")
    else:
        p = 0
        reasons.append(f"updated {age} months ago {pts(0)}")
    total += p

    if owner_active:
        p = rules["owner_active_points"]
        total += p
        reasons.append(f"owner {doc.owner} active {pts(p)}")
    else:
        reasons.append(f"owner {doc.owner} has left {pts(0)}")

    corroborating = {d.id for c, d in in_scope if c.value == claim.value and d.id != doc.id}
    if corroborating:
        p = rules["corroboration_points"] * len(corroborating)
        total += p
        n = len(corroborating)
        reasons.append(f"corroborated by {n} other source{'s' if n != 1 else ''} {pts(p)}")

    if claim.status == "confirmed":
        p = rules["confirmed_points"]
        total += p
        reasons.append(f"confirmed by {claim.confirmed_by} on {claim.confirmed_at} {pts(p)}")

    return total, reasons
