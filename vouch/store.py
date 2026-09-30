"""JSON-file persistence. claims.json is immutable; expert resolutions are an overlay applied at load time."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from .ingest import load_docs
from .models import Claim, Doc
from . import paths


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def atomic_write_json(path: Path, data) -> None:
    """Write to a temp file in the same directory, then os.replace -> never a half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def load_vocabulary() -> dict:
    return read_json(paths.VOCABULARY, {})


def load_rules() -> dict:
    return read_json(paths.TRUST_RULES, {})


def load_people() -> list[dict]:
    return read_json(paths.PEOPLE, [])


def load_requests() -> list[dict]:
    return read_json(paths.RESOLUTIONS, [])


def save_requests(requests: list[dict]) -> None:
    atomic_write_json(paths.RESOLUTIONS, requests)


def apply_overlay(claims: list[Claim], requests: list[dict]) -> list[Claim]:
    """Resolved requests: chosen claim -> confirmed, other candidates -> outdated."""
    by_id = {c.claim_id: c for c in claims}
    for r in requests:
        if r.get("status") != "resolved":
            continue
        for cid in r.get("candidate_claim_ids", []):
            c = by_id.get(cid)
            if c is None:
                continue
            if cid == r.get("chosen_claim_id"):
                c.status, c.confirmed_by, c.confirmed_at, c.note = "confirmed", r["resolved_by"], r["resolved_at"], r.get("note")
            elif c.status != "confirmed":
                c.status, c.outdated_by, c.outdated_at = "outdated", r["resolved_by"], r["resolved_at"]
    return claims


def load_base_claims() -> list[Claim]:
    return [Claim(**c) for c in read_json(paths.CLAIMS, [])]


def load_claims() -> list[Claim]:
    return apply_overlay(load_base_claims(), load_requests())


def load_docs_by_id() -> dict[str, Doc]:
    return {d.id: d for d in load_docs()}


def log_question(entry: dict) -> None:
    log = read_json(paths.QUESTIONS_LOG, [])
    log.append(entry)
    atomic_write_json(paths.QUESTIONS_LOG, log)


def load_question_log() -> list[dict]:
    return read_json(paths.QUESTIONS_LOG, [])


def reset_demo() -> None:
    for p in (paths.RESOLUTIONS, paths.QUESTIONS_LOG):
        p.unlink(missing_ok=True)


class KB:
    """Everything the deterministic core needs, loaded once per request. Tests build one by hand."""

    def __init__(self, docs: dict[str, Doc], claims: list[Claim], rules: dict, people: list[dict], vocab: dict):
        self.docs, self.claims, self.rules, self.people, self.vocab = docs, claims, rules, people, vocab

    def person(self, name: str) -> dict | None:
        return next((p for p in self.people if p["name"] == name), None)

    def owner_active(self, doc: Doc) -> bool:
        p = self.person(doc.owner)
        return bool(doc.owner_active and p is not None and p.get("active"))


def load_kb() -> KB:
    return KB(load_docs_by_id(), load_claims(), load_rules(), load_people(), load_vocabulary())
