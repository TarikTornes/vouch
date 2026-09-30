"""Persistence. Corpus/claims/config are read-only files; expert requests and the gap log live in SQLite.
claims.json is immutable; expert resolutions are an overlay applied at load time."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from .ingest import load_docs
from .models import Claim, Doc
from . import paths
from .db import transaction


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


def request_to_dict(row) -> dict:
    d = dict(row)
    d["ctx"] = {"country": d.pop("country"), "client": d.pop("client")}
    d["candidate_claim_ids"] = json.loads(d["candidate_claim_ids"])
    return d


def load_requests(status: str | None = None) -> list[dict]:
    sql, args = "SELECT * FROM requests", ()
    if status:
        sql, args = sql + " WHERE status = ?", (status,)
    with transaction() as conn:
        return [request_to_dict(r) for r in conn.execute(sql + " ORDER BY created_at", args)]


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


def log_question(entry: dict, asked_by: int | None = None) -> None:
    with transaction() as conn:
        conn.execute(
            "INSERT INTO questions_log (question, country, client, topic, condition, routed_to, asked_at, asked_by)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (entry["question"], entry["ctx"]["country"], entry["ctx"]["client"], entry.get("topic"),
             entry.get("condition"), entry.get("routed_to"), entry["asked_at"], asked_by))


def load_question_log() -> list[dict]:
    with transaction() as conn:
        rows = conn.execute("SELECT * FROM questions_log ORDER BY asked_at").fetchall()
    return [{**dict(r), "ctx": {"country": r["country"], "client": r["client"]}} for r in rows]


def reset_demo() -> None:
    """Clear expert requests and the gap log (users are kept)."""
    with transaction() as conn:
        conn.execute("DELETE FROM requests")
        conn.execute("DELETE FROM questions_log")


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
