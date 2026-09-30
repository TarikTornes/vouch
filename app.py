"""Vouch — Streamlit UI: Consultant | Expert | Knowledge health | Evaluation.

Security notes: no unsafe_allow_html anywhere; all document/user text is escaped before markdown rendering;
authorization for resolving requests lives in vouch.experts.resolve_request (server side).
"""
from __future__ import annotations

import hmac
import os
import re

import streamlit as st
from dotenv import load_dotenv

from vouch import llm, paths, store
from vouch.experts import create_request, open_requests_for, resolve_request
from vouch.health import report
from vouch.models import BADGES, CONFLICTING, POSSIBLY_OUTDATED, SOURCE_TYPE_LABELS, UNSUPPORTED, VERIFIED, Context
from vouch.parse import MAX_QUESTION
from vouch.pipeline import answer, display_value, plain_rag
from vouch.score import pretty_date
from vouch.verdict import judge

load_dotenv()
st.set_page_config(page_title="Vouch", page_icon="✅", layout="wide")

PRESETS = [
    "What overtime surcharge do we pay on Saturday hours?",
    "Do Saturday hours count as overtime?",
    "What surcharge applies to public holidays falling on a Sunday?",
    "What is the home-working allowance?",
]
_MD_SPECIAL = re.compile(r"([\\`*_{}\[\]()#+\-.!|<>~$])")


def esc(text) -> str:
    """Escape markdown so document / user text renders literally."""
    return _MD_SPECIAL.sub(r"\\\1", str(text or ""))


@st.cache_data(ttl=20, show_spinner=False)
def llm_status() -> bool:
    return llm.llm_available()


def kb():
    return store.load_kb()


# ------------------------------------------------------------------------------------------------ sidebar

vocab = store.load_vocabulary()
rules = store.load_rules()

with st.sidebar:
    st.title("✅ Vouch")
    st.caption("Search finds answers. Vouch tells you which ones you can act on — and when you can't, who to ask.")
    page = st.radio("Page", ["Consultant", "Expert", "Knowledge health", "Evaluation"], label_visibility="collapsed")
    st.divider()
    st.caption(f"📅 Knowledge as of **{pretty_date(rules['as_of'])}**")
    if llm_status():
        st.caption(f"🟢 Local LLM running ({esc(llm.MODEL)} via Ollama)")
    else:
        st.caption("🟠 Local LLM offline — keyword parser + recorded plain-RAG runs")
    if st.button("🔄 Reset demo", width="stretch"):
        store.reset_demo()
        st.session_state.clear()
        st.rerun()


# ------------------------------------------------------------------------------------------------ helpers

def owner_line(e, k) -> str:
    return f"{esc(e.doc.owner)} ({'active' if k.owner_active(e.doc) else 'has left'})"


def render_evidence(e, k, *, show_score=True):
    st.markdown(
        f"**{esc(e.claim.value)}** — {esc(e.doc.title)}  \n"
        f"{esc(SOURCE_TYPE_LABELS.get(e.doc.source_type, e.doc.source_type))} · {pretty_date(e.doc.date)} · "
        f"owner: {owner_line(e, k)}" + (f" · **score {e.score}**" if show_score else "")
    )
    with st.expander("Why this score · source quote"):
        for r in e.reasons:
            st.markdown(f"- {esc(r)}")
        st.caption("Verbatim quote from the source:")
        st.text(e.claim.quote)


def render_key(kv, k, primary: bool):
    label = vocab["topics"][kv.topic]["label"]
    cond = "" if kv.condition == "general" else f" · {kv.condition.replace('_', ' ')}"
    with st.container(border=True):
        value = f" — **{esc(display_value(kv.value))}**" if kv.value and kv.verdict != CONFLICTING else ""
        st.markdown(f"#### {BADGES[kv.verdict]} · {esc(label)}{esc(cond)}{value}")
        for n in kv.notes:
            st.markdown(f"- {esc(n)}")
        if kv.verdict == CONFLICTING:
            st.markdown("**Credible sources disagree:**")
            for e in kv.in_scope:
                render_evidence(e, k)
        elif kv.verdict in (VERIFIED, POSSIBLY_OUTDATED):
            st.markdown("**Evidence:**")
            for e in kv.supporting:
                render_evidence(e, k)
            if kv.competing:
                st.markdown("**Other in-scope sources:**")
                for e in kv.competing:
                    render_evidence(e, k)
        if kv.stale and kv.verdict == POSSIBLY_OUTDATED:
            st.markdown("**Other outdated sources:**")
            for e in kv.stale:
                render_evidence(e, k)
        if kv.ignored:
            with st.expander(f"Ignored ({len(kv.ignored)})", expanded=primary):
                for e in kv.ignored:
                    st.markdown(f"- {esc(e.claim.value)} from *{esc(e.doc.title)}* — {esc(e.ignore_reason)}")


def ask(question: str):
    st.session_state.last = {"question": question.strip()[:MAX_QUESTION],
                             "country": st.session_state.country, "client": st.session_state.client}
    st.session_state.logged = False
    st.session_state.pop("rag", None)


def preset_clicked(q: str):
    st.session_state.question = q
    ask(q)


# ------------------------------------------------------------------------------------------------ pages

def consultant_page():
    st.header("Ask a payroll question")
    st.caption("You are **Sophie Lambert**, payroll consultant. You just inherited Brouwerij Janssens.")
    c1, c2, c3 = st.columns([1, 1, 2])
    c1.selectbox("Country", vocab["countries"], key="country")
    c2.selectbox("Client", [c for c in vocab["clients"] if c != "all"] + ["all"], key="client")
    c3.toggle("Plain RAG mode (baseline, no trust checks)", key="plain_rag")

    st.text_input("Question", key="question", max_chars=MAX_QUESTION,
                  placeholder="e.g. What overtime surcharge do we pay on Saturday hours?")
    b1, *preset_cols = st.columns([1, 2, 2, 2, 2])
    if b1.button("Ask", type="primary", width="stretch") and st.session_state.question.strip():
        ask(st.session_state.question)
    for col, q in zip(preset_cols, PRESETS):
        col.button(q, on_click=preset_clicked, args=(q,), width="stretch")

    last = st.session_state.get("last")
    if not last:
        return
    ctx = Context(last["country"], last["client"])
    st.divider()
    st.caption(f"Question: {esc(last['question'])} · {esc(ctx.country)} · client {esc(ctx.client)}")

    if st.session_state.plain_rag:
        if "rag" not in st.session_state:
            with st.spinner("Plain RAG: retrieving top-3 documents and asking the local LLM…"):
                st.session_state.rag = plain_rag(last["question"], ctx)
        rag = st.session_state.rag
        with st.container(border=True):
            st.markdown("**Assistant**")
            st.text(rag["text"])
        mode = {"live": "live local LLM", "recorded": "recorded run", "unavailable": "unavailable"}[rag["mode"]]
        st.caption(f"Plain RAG ({mode}) · sources used: {esc(', '.join(rag['sources']))}")
        return

    k = kb()
    ans = answer(last["question"], ctx, k, log=not st.session_state.get("logged", True))
    st.session_state.logged = True
    kv = ans.primary
    show = {VERIFIED: st.success, CONFLICTING: st.warning, POSSIBLY_OUTDATED: st.info}.get(
        kv.verdict if kv else UNSUPPORTED, st.error)
    show(ans.headline)
    parsed = f"{ans.topic} · {ans.condition}" if ans.topic else "no known topic"
    st.caption(f"Understood as **{esc(parsed)}** (parser: {esc(ans.parser)})")

    if kv:
        render_key(kv, k, primary=True)
    for rkv in ans.related:
        render_key(rkv, k, primary=False)

    if ans.expert:
        name = ans.expert["name"]
        st.info(f"👉 Ask **{esc(name)}** ({esc(ans.expert['why'])})")
        sent_key = f"sent::{last['question']}::{ctx.country}::{ctx.client}"
        if st.session_state.get(sent_key):
            st.success(f"Request sent to {name.split()[0]} — "
                       + ("they'll see both sources side by side." if kv and kv.verdict == CONFLICTING
                          else "logged as a knowledge gap for them to fill."))
        elif kv and st.button(f"Ask {name.split()[0]}", type="primary"):
            try:
                create_request(last["question"], ctx, kv, k)
                st.session_state[sent_key] = True
                st.rerun()
            except ValueError as err:
                st.error(str(err))


def expert_page():
    st.header("Expert inbox")
    k = kb()
    active = [p["name"] for p in k.people if p.get("active")]
    persona = st.selectbox("I am", active, index=active.index("Anna Peeters"))
    pin = os.getenv("VOUCH_EXPERT_PIN", "")
    if pin:
        entered = st.text_input("PIN", type="password", max_chars=64)
        if not hmac.compare_digest(entered.encode(), pin.encode()):
            st.caption("Enter the expert PIN to see your requests.")
            return
    else:
        st.caption("Demo mode: VOUCH_EXPERT_PIN is not set, so persona selection is not PIN-protected. "
                   "Resolving is still checked server-side against the assigned expert.")

    if st.session_state.pop("resolved_msg", False):
        st.success("Saved. The next person asking gets a verified answer.")
    reqs = open_requests_for(persona)
    if not reqs:
        st.caption("No open requests. 🎉")
        return
    for r in reqs:
        ctx = Context(r["ctx"]["country"], r["ctx"]["client"])
        with st.container(border=True):
            st.markdown(f"#### ❔ {esc(r['question'])}")
            st.caption(f"{esc(ctx.country)} · client {esc(ctx.client)} · "
                       f"{esc(vocab['topics'][r['topic']]['label'])} / {esc(r['condition'])} · "
                       f"routed to you because you {esc(r.get('assigned_why', ''))}")
            kv = judge(r["topic"], r["condition"], ctx, k)
            ev = {e.claim.claim_id: e for e in kv.in_scope + kv.stale}
            cands = [cid for cid in r["candidate_claim_ids"] if cid in ev]
            if not cands:
                st.warning("Knowledge gap: no source in the knowledge base covers this. "
                           "(Answering gaps directly is on the roadmap — for now, add a document.)")
                continue
            cols = st.columns(len(cands))
            for col, cid in zip(cols, cands):
                e = ev[cid]
                with col, st.container(border=True):
                    st.metric(esc(e.doc.title), e.claim.value, f"score {e.score}", delta_color="off")
                    st.caption(f"{esc(SOURCE_TYPE_LABELS.get(e.doc.source_type))} · {pretty_date(e.doc.date)} · "
                               f"owner {owner_line(e, k)} · client {esc(e.claim.client)}")
                    st.text(e.claim.quote)
                    for reason in e.reasons:
                        st.markdown(f"- {esc(reason)}")
            chosen = st.radio("Which one is correct?", cands, key=f"pick_{r['id']}", horizontal=True,
                              format_func=lambda cid: f"{ev[cid].claim.value} — {ev[cid].doc.title}")
            note = st.text_input("Note (optional)", key=f"note_{r['id']}", max_chars=500,
                                 placeholder="e.g. agreement ended Jan 2026")
            if st.button("Resolve", key=f"resolve_{r['id']}", type="primary"):
                try:
                    resolve_request(r["id"], persona, chosen, note)
                    st.session_state.resolved_msg = True
                    st.rerun()
                except (PermissionError, ValueError) as err:
                    st.error(f"Not allowed: {err}")


def health_page():
    st.header("Knowledge health")
    rep = report(kb())
    cols = st.columns(len(rep))
    for col, (name, rows) in zip(cols, rep.items()):
        col.metric(name, len(rows))
    for name, rows in rep.items():
        st.subheader(name)
        if rows:
            st.dataframe(rows, width="stretch", hide_index=True)
        else:
            st.caption("None 🎉")


def eval_page():
    st.header("Evaluation: plain RAG vs. Vouch")
    if not paths.EVAL_RESULTS_MD.exists():
        st.info("No results yet. Run `python eval/run_eval.py`.")
        return
    st.markdown(paths.EVAL_RESULTS_MD.read_text(encoding="utf-8"))


{"Consultant": consultant_page, "Expert": expert_page,
 "Knowledge health": health_page, "Evaluation": eval_page}[page]()
