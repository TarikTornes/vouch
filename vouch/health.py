"""Knowledge health: open conflicts, open requests, stale docs, ownerless docs, unanswered questions."""
from __future__ import annotations

from . import store
from .models import CONFLICTING, Context
from .score import months_between
from .store import KB
from .verdict import judge


def conflicts(kb: KB) -> list[dict]:
    rows, seen = [], set()
    clients = kb.vocab["clients"]
    for c in kb.claims:
        # a general claim can conflict with any client's exception -> check every client in that country
        for client in ([c.client] if c.client != "all" else clients):
            key = (c.topic, c.condition, c.country, client)
            if key in seen:
                continue
            seen.add(key)
            kv = judge(c.topic, c.condition, Context(c.country, client), kb)
            if kv.verdict == CONFLICTING:
                rows.append({
                    "topic": kb.vocab["topics"][c.topic]["label"], "condition": c.condition,
                    "country": c.country, "client": client,
                    "values": ", ".join(f"{e.claim.value} ({e.doc.title}, score {e.score})" for e in kv.in_scope),
                })
    return rows


def stale_docs(kb: KB) -> list[dict]:
    rows, rules = [], kb.rules
    for d in kb.docs.values():
        why = []
        newer = [n.title for n in kb.docs.values() if d.id in n.supersedes]
        if newer:
            why.append(f"superseded by {newer[0]}")
        if d.valid_to and d.valid_to < rules["as_of"]:
            why.append(f"expired {d.valid_to}")
        age = months_between(d.date, rules["as_of"])
        if age > rules["stale_after_months"]:
            why.append(f"{age} months old")
        if why:
            rows.append({"document": d.title, "date": d.date, "owner": d.owner, "why": "; ".join(why)})
    return rows


def ownerless_docs(kb: KB) -> list[dict]:
    rows = []
    for d in kb.docs.values():
        if not kb.owner_active(d):
            p = kb.person(d.owner)
            why = "owner not in directory" if p is None else f"owner left{' in ' + p['left'] if p.get('left') else ''}"
            rows.append({"document": d.title, "owner": d.owner, "why": why})
    return rows


def open_requests() -> list[dict]:
    return [{"question": r["question"], "client": r["ctx"]["client"], "kind": r.get("kind", ""),
             "assigned_to": r["assigned_to"], "created_at": r["created_at"]}
            for r in store.load_requests() if r["status"] == "open"]


def unanswered() -> list[dict]:
    return [{"question": q["question"], "country": q["ctx"]["country"], "client": q["ctx"]["client"],
             "routed_to": q.get("routed_to") or "", "asked_at": q["asked_at"]} for q in store.load_question_log()]


def report(kb: KB) -> dict[str, list[dict]]:
    return {
        "Open conflicts": conflicts(kb),
        "Open expert requests": open_requests(),
        "Stale / superseded docs": stale_docs(kb),
        "Ownerless docs": ownerless_docs(kb),
        "Unanswered questions": unanswered(),
    }
