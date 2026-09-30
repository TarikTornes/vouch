"""Expert routing and the resolve loop. Authorization is enforced here (server side), never in the UI."""
from __future__ import annotations

import datetime as dt
import uuid

from . import store
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


def create_request(question: str, ctx: Context, kv: KeyVerdict, kb: KB) -> dict:
    expert = route(kv, kb)
    if expert is None:
        raise ValueError("no active expert available for this topic")
    requests = store.load_requests()
    for r in requests:                                                  # don't spam the expert with duplicates
        if (r["status"] == "open" and r["topic"] == kv.topic and r["condition"] == kv.condition
                and r["ctx"] == {"country": ctx.country, "client": ctx.client}):
            return r
    req = {
        "id": str(uuid.uuid4()),
        "question": question[:300],
        "ctx": {"country": ctx.country, "client": ctx.client},
        "topic": kv.topic,
        "condition": kv.condition,
        "kind": "gap" if kv.verdict == UNSUPPORTED else kv.verdict.lower(),
        "candidate_claim_ids": candidates(kv),
        "assigned_to": expert["name"],
        "assigned_why": expert["why"],
        "status": "open",
        "created_at": dt.datetime.now().isoformat(timespec="seconds"),
    }
    requests.append(req)
    store.save_requests(requests)
    return req


def open_requests_for(person: str) -> list[dict]:
    return [r for r in store.load_requests() if r["status"] == "open" and r["assigned_to"] == person]


def resolve_request(request_id: str, resolver: str, chosen_claim_id: str, note: str = "", *, as_of: str | None = None) -> dict:
    """Confirm one candidate claim; every other candidate becomes outdated (via the overlay).

    Server-side checks: request exists and is open, resolver is the assigned expert,
    the chosen claim is one of the request's candidates.
    """
    try:
        uuid.UUID(str(request_id))
    except ValueError:
        raise ValueError("invalid request id") from None
    requests = store.load_requests()
    req = next((r for r in requests if r["id"] == request_id), None)
    if req is None:
        raise ValueError("request not found")
    if req["status"] != "open":
        raise ValueError("request is already resolved")
    if resolver != req["assigned_to"]:
        raise PermissionError(f"{resolver} is not assigned to this request")
    if chosen_claim_id not in req["candidate_claim_ids"]:
        raise ValueError("chosen claim is not one of this request's candidates")
    req.update(
        status="resolved",
        chosen_claim_id=chosen_claim_id,
        resolved_by=resolver,
        resolved_at=as_of or store.load_rules()["as_of"],
        note=(note or "").strip()[:MAX_NOTE] or None,
    )
    store.save_requests(requests)
    return req
