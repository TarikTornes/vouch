"""answer(): parse -> judge primary + related keys -> templated headline. plain_rag(): the naive baseline."""
from __future__ import annotations

import datetime as dt
import math
import re

from . import llm, store
from .experts import route
from .models import CONFLICTING, UNSUPPORTED, VERIFIED, Answer, Context, KeyVerdict
from .parse import MAX_QUESTION, parse_question
from .store import KB
from .verdict import judge


def display_value(value: str | None) -> str:
    return {"yes": "Yes", "no": "No"}.get(value, value or "")


def headline(kv: KeyVerdict | None, kb: KB) -> str:
    if kv is None or kv.verdict == UNSUPPORTED:
        return "❓ No source in the knowledge base answers this. I won't guess."
    label = kb.vocab["topics"][kv.topic]["label"].lower()
    if kv.verdict == VERIFIED:
        top = kv.supporting[0].doc
        return f"✅ {display_value(kv.value)}. Based on {top.title}."
    if kv.verdict == CONFLICTING:
        return f"⚠️ I can't give you a reliable answer on the {label}."
    return "🕓 The only source is outdated — verify before using."


def answer(question: str, ctx: Context, kb: KB | None = None, *, use_llm: bool = True, log: bool = False) -> Answer:
    kb = kb or store.load_kb()
    question = (question or "").strip()[:MAX_QUESTION]
    p = parse_question(question, use_llm=use_llm)
    primary, related = None, []
    if p["topic"]:
        primary = judge(p["topic"], p["condition"], ctx, kb)
        for rt in kb.vocab["topics"][p["topic"]].get("related", []):
            kv = judge(rt, p["condition"], ctx, kb)
            if kv.verdict != UNSUPPORTED:                                # only show related keys we have evidence for
                related.append(kv)
    abstain = primary is None or primary.verdict != VERIFIED
    expert = route(primary, kb) if primary is not None and abstain else None
    ans = Answer(question=question, ctx=ctx, topic=p["topic"], condition=p["condition"], parser=p["parser"],
                 primary=primary, related=related, headline=headline(primary, kb), abstain=abstain, expert=expert)
    if log and (primary is None or primary.verdict == UNSUPPORTED):
        store.log_question({"question": question, "ctx": {"country": ctx.country, "client": ctx.client},
                            "topic": p["topic"], "condition": p["condition"],
                            "routed_to": expert["name"] if expert else None,
                            "asked_at": dt.datetime.now().isoformat(timespec="seconds")})
    return ans


# ---------------------------------------------------------------- plain RAG baseline

RAG_SYSTEM = "You are a helpful payroll assistant. Answer the consultant's question concisely and directly using the context."
_WORD = re.compile(r"[a-zà-ÿ0-9]{3,}")
_STOP = {"what", "the", "do", "does", "are", "and", "for", "our", "pay", "how", "which", "with", "this", "that", "hours", "applies"}


def _tokens(text: str) -> list[str]:
    return [w.rstrip("s") for w in _WORD.findall(text.lower()) if w not in _STOP]


def retrieve(question: str, ctx: Context, kb: KB, k: int = 3) -> list:
    """Standard BM25 over title + body (what a typical naive RAG would do); the client name is added to the query."""
    docs = sorted(kb.docs.values(), key=lambda d: d.id)
    toks = [_tokens(f"{d.title} {d.body}") for d in docs]
    avg = sum(map(len, toks)) / len(toks)
    query = set(_tokens(question)) | set(_tokens(ctx.client if ctx.client != "all" else ""))
    k1, b = 1.5, 0.75

    def bm25(t: list[str]) -> float:
        total = 0.0
        for term in query:
            df = sum(term in other for other in toks)
            tf = t.count(term)
            if tf:
                idf = math.log(1 + (len(toks) - df + 0.5) / (df + 0.5))
                total += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * len(t) / avg))
        return total

    ranked = sorted(zip(docs, toks), key=lambda dt_: -bm25(dt_[1]))
    return [d for d, _ in ranked[:k]]


def rag_prompt(question: str, ctx: Context, docs: list) -> str:
    context = "\n\n".join(f"### {d.title}\n{d.body}" for d in docs)
    return f"Context:\n{context}\n\nClient: {ctx.client} (country: {ctx.country})\nQuestion: {question}"


def recorded_rag(question: str, ctx: Context) -> str | None:
    runs = store.read_json(store.paths.EVAL_RESULTS, {}).get("rows", [])
    for r in runs:
        if r["question"] == question and r["ctx"] == {"country": ctx.country, "client": ctx.client}:
            return r.get("plain_rag_text")
    return None


def plain_rag(question: str, ctx: Context, kb: KB | None = None) -> dict:
    """Returns {text, mode: live|recorded|unavailable, sources}."""
    kb = kb or store.load_kb()
    question = (question or "").strip()[:MAX_QUESTION]
    docs = retrieve(question, ctx, kb)
    out = llm.text(RAG_SYSTEM, rag_prompt(question, ctx, docs))
    if out:
        return {"text": out.strip(), "mode": "live", "sources": [d.title for d in docs]}
    rec = recorded_rag(question, ctx)
    if rec:
        return {"text": rec, "mode": "recorded", "sources": [d.title for d in docs]}
    return {"text": "Plain RAG is unavailable: the local LLM is offline and there is no recorded run for this question.",
            "mode": "unavailable", "sources": []}
