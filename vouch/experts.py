"""Expert routing and the resolve loop. Authorization is enforced here (server side), never in the UI."""
from __future__ import annotations

import datetime as dt
import json
import uuid

from . import store
from .accounts import User, get_user
from .db import transaction
from .models import CONFLICTING, SOURCE_TYPE_LABELS, UNSUPPORTED, Context, KeyVerdict
from .store import KB

MAX_NOTE = 500


def route(kv: KeyVerdict, kb: KB) -> dict | None:
    """Conflict -> owner of the top in-scope source if active; otherwise the active top answerer on the topic."""
    label = kb.vocab["topics"][kv.topic]["label"].lower()
    if kv.verdict == CONFLICTING and kv.supporting:
        doc = kv.supporting[0].doc
        if kb.owner_active(doc):
            n = kb.person(doc.owner).get("answers", {}).get(kv.topic, 0)
            return {"name": doc.owner,
                    "why": f"owns the {SOURCE_TYPE_LABELS.get(doc.source_type, doc.source_type)}, answered {n} similar questions"}
    active = [p for p in kb.people if p.get("active")]
    best = max(active, key=lambda p: p.get("answers", {}).get(kv.topic, 0), default=None)
    if best and best.get("answers", {}).get(kv.topic, 0) > 0:
        n = best["answers"][kv.topic]
        return {"name": best["name"], "why": f"{best['role']}, answered {n} similar questions on {label}"}
    for e in kv.supporting + kv.stale:                                  # nobody has answered this topic yet
        if kb.owner_active(e.doc):
            return {"name": e.doc.owner, "why": f"owns the only source on {label}"}
    return None


def candidates(kv: KeyVerdict) -> list[str]:
    return [e.claim.claim_id for e in kv.in_scope + kv.stale]


def create_request(question: str, ctx: Context, kv: KeyVerdict, kb: KB, *, created_by: int | None = None) -> dict:
    ctx.validate(kb.vocab)
    expert = route(kv, kb)
    if expert is None:
        raise ValueError("no active expert available for this topic")
    with transaction() as conn:
        dup = conn.execute(                                             # don't spam the expert with duplicates
            "SELECT * FROM requests WHERE status = 'open' AND topic = ? AND condition = ? AND country = ? AND client = ?",
            (kv.topic, kv.condition, ctx.country, ctx.client)).fetchone()
        if dup:
            return store.request_to_dict(dup)
        rid = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO requests (id, question, country, client, topic, condition, kind, candidate_claim_ids,"
            " assigned_to, assigned_why, status, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?, 'open', ?, ?)",
            (rid, question[:300], ctx.country, ctx.client, kv.topic, kv.condition,
             "gap" if kv.verdict == UNSUPPORTED else kv.verdict.lower(), json.dumps(candidates(kv)),
             expert["name"], expert["why"], dt.datetime.now().isoformat(timespec="seconds"), created_by))
        return store.request_to_dict(conn.execute("SELECT * FROM requests WHERE id = ?", (rid,)).fetchone())


def open_requests_for(user: User) -> list[dict]:
    if not user.is_expert:
        return []
    return [r for r in store.load_requests("open") if r["assigned_to"] == user.person_name]


def resolve_request(request_id: str, resolver: User, chosen_claim_id: str, note: str = "", *, as_of: str | None = None) -> dict:
    """Confirm one candidate claim; every other candidate becomes outdated (via the overlay).

    Server-side checks: the resolver is an active expert, the request exists and is open, the resolver is
    the assigned expert, and the chosen claim is one of the request's candidates. The UI is not trusted.
    """
    resolver = get_user(resolver.id) if isinstance(resolver, User) else None     # fresh role/active state
    if resolver is None or not resolver.active or not resolver.is_expert:
        raise PermissionError("only an active expert can resolve requests")
    try:
        uuid.UUID(str(request_id))
    except ValueError:
        raise ValueError("invalid request id") from None
    with transaction() as conn:
        row = conn.execute("SELECT * FROM requests WHERE id = ?", (str(request_id),)).fetchone()
        if row is None:
            raise ValueError("request not found")
        req = store.request_to_dict(row)
        if req["status"] != "open":
            raise ValueError("request is already resolved")
        if resolver.person_name != req["assigned_to"]:
            raise PermissionError(f"{resolver.display_name} is not assigned to this request")
        if chosen_claim_id not in req["candidate_claim_ids"]:
            raise ValueError("chosen claim is not one of this request's candidates")
        resolved_at = as_of or store.load_rules()["as_of"]
        note = (note or "").strip()[:MAX_NOTE] or None
        cur = conn.execute(                                             # status guard makes double-resolve impossible
            "UPDATE requests SET status = 'resolved', chosen_claim_id = ?, resolved_by = ?, resolved_by_user = ?,"
            " resolved_at = ?, note = ? WHERE id = ? AND status = 'open'",
            (chosen_claim_id, resolver.person_name, resolver.id, resolved_at, note, req["id"]))
        if cur.rowcount != 1:
            raise ValueError("request is already resolved")
    req.update(status="resolved", chosen_claim_id=chosen_claim_id, resolved_by=resolver.person_name,
               resolved_by_user=resolver.id, resolved_at=resolved_at, note=note)
    return req
