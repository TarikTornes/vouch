"""Vouch — Streamlit UI: Login/Register | Consultant | Expert | Knowledge health | Evaluation | Admin.

Security notes: every page requires a logged-in user; pages are gated by role here AND every state change is
re-authorized server side (vouch.experts.resolve_request, vouch.accounts.update_user). No unsafe_allow_html;
all document/user text is escaped before markdown rendering. Only the user id lives in the session.
"""
from __future__ import annotations

import os
import re
import time

import streamlit as st
from dotenv import load_dotenv

from vouch import llm, paths, store
from vouch.accounts import ROLES, AuthError, User, authenticate, get_user, list_users, register, update_user
from vouch.experts import create_request, open_requests_for, resolve_request
from vouch.health import report
from vouch.models import BADGES, CONFLICTING, POSSIBLY_OUTDATED, SOURCE_TYPE_LABELS, UNSUPPORTED, VERIFIED, Context
from vouch.parse import MAX_QUESTION
from vouch.pipeline import answer, display_value, plain_rag
from vouch.score import pretty_date
from vouch.verdict import judge

load_dotenv()
st.set_page_config(page_title="Vouch", page_icon="✅", layout="wide")

ALLOW_REGISTRATION = os.getenv("VOUCH_ALLOW_REGISTRATION", "true").lower() == "true"
DEMO_MODE = os.getenv("VOUCH_DEMO_MODE", "false").lower() == "true"
IDLE_TIMEOUT_S = 60 * int(os.getenv("VOUCH_SESSION_IDLE_MINUTES", "60"))

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


# ------------------------------------------------------------------------------------------------ auth

vocab = store.load_vocabulary()
rules = store.load_rules()


def current_user() -> User | None:
    """Re-read the user on every run so deactivation / role changes apply immediately; enforce idle timeout."""
    uid = st.session_state.get("uid")
    if uid is None:
        return None
    user = get_user(uid)
    now = time.time()
    if user is None or not user.active or now - st.session_state.get("last_seen", 0) > IDLE_TIMEOUT_S:
        st.session_state.clear()
        st.session_state.auth_msg = "Your session ended. Please log in again."
        return None
    st.session_state.last_seen = now
    return user


def auth_page():
    st.title("✅ Vouch")
    st.caption("Search finds answers. Vouch tells you which ones you can act on — and when you can't, who to ask.")
    if msg := st.session_state.pop("auth_msg", None):
        st.info(msg)
    left, _ = st.columns([1, 1])
    with left:
        login_tab, register_tab = st.tabs(["Log in", "Register"])
        with login_tab, st.form("login"):
            username = st.text_input("Username", max_chars=32, autocomplete="username")
            password = st.text_input("Password", type="password", max_chars=128, autocomplete="current-password")
            if st.form_submit_button("Log in", type="primary", width="stretch"):
                try:
                    user = authenticate(username, password)
                except AuthError as err:
                    st.error(str(err))
                else:
                    st.session_state.clear()                       # fresh session state on login
                    st.session_state.uid, st.session_state.last_seen = user.id, time.time()
                    st.rerun()
        with register_tab:
            if not ALLOW_REGISTRATION:
                st.info("Self-registration is disabled. Ask an administrator for an account.")
            else:
                with st.form("register", clear_on_submit=False):
                    st.caption("New accounts start as **consultant**. An admin can make you an expert.")
                    name = st.text_input("Full name", max_chars=60)
                    new_user = st.text_input("Username", max_chars=32, help="3–32 characters: a–z, 0–9, . _ -")
                    pw1 = st.text_input("Password", type="password", max_chars=128, help="At least 12 characters",
                                        autocomplete="new-password")
                    pw2 = st.text_input("Repeat password", type="password", max_chars=128, autocomplete="new-password")
                    if st.form_submit_button("Create account", width="stretch"):
                        if pw1 != pw2:
                            st.error("Passwords don't match.")
                        else:
                            try:
                                u = register(new_user, name, pw1)
                                st.success(f"Account **{esc(u.username)}** created — you can log in now.")
                            except ValueError as err:
                                st.error(str(err))
        if DEMO_MODE:
            st.caption("Demo accounts: **sophie** (consultant) · **anna**, **pieter** (experts) · **lotte** (admin).")


user = current_user()
if user is None:
    auth_page()
    st.stop()

PAGES = ["Consultant"] + (["Expert", "Knowledge health"] if user.is_expert or user.is_admin else []) \
    + ["Evaluation"] + (["Admin"] if user.is_admin else [])

with st.sidebar:
    st.title("✅ Vouch")
    st.caption("Search finds answers. Vouch tells you which ones you can act on — and when you can't, who to ask.")
    st.markdown(f"👤 **{esc(user.display_name)}** · {esc(user.role)}")
    page = st.radio("Page", PAGES, label_visibility="collapsed")
    if st.button("Log out", width="stretch"):
        st.session_state.clear()
        st.rerun()
    st.divider()
    st.caption(f"📅 Knowledge as of **{pretty_date(rules['as_of'])}**")
    if llm_status():
        st.caption(f"🟢 Local LLM running ({esc(llm.MODEL)} via Ollama)")
    else:
        st.caption("🟠 Local LLM offline — keyword parser + recorded plain-RAG runs")
    if DEMO_MODE and user.is_admin and st.button("🔄 Reset demo", width="stretch"):
        store.reset_demo()
        for k in [k for k in st.session_state if k not in ("uid", "last_seen")]:
            del st.session_state[k]
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
    st.caption(f"Signed in as **{esc(user.display_name)}**. Pick the client's country and name, then ask.")
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
    ans = answer(last["question"], ctx, k, log=not st.session_state.get("logged", True), user_id=user.id)
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
                create_request(last["question"], ctx, kv, k, created_by=user.id)
                st.session_state[sent_key] = True
                st.rerun()
            except ValueError as err:
                st.error(str(err))


def expert_page():
    st.header("Expert inbox")
    k = kb()
    if not user.is_expert:
        st.warning("Your account is not linked to an expert profile yet. Ask an admin to set it up.")
        return
    st.caption(f"Requests routed to **{esc(user.person_name)}**.")

    if st.session_state.pop("resolved_msg", False):
        st.success("Saved. The next person asking gets a verified answer.")
    reqs = open_requests_for(user)
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
                    resolve_request(r["id"], user, chosen, note)
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


def admin_page():
    st.header("Users")
    users = list_users()
    st.dataframe([{"username": u.username, "name": u.display_name, "role": u.role,
                   "expert profile": u.person_name or "", "active": u.active} for u in users],
                 width="stretch", hide_index=True)
    st.subheader("Change a user")
    people = [""] + [p["name"] for p in store.load_people()]
    by_name = {u.username: u for u in users}
    with st.form("admin_user"):
        target = by_name[st.selectbox("User", list(by_name))]
        c1, c2, c3 = st.columns(3)
        role = c1.selectbox("Role", ROLES, index=ROLES.index(target.role))
        person = c2.selectbox("Expert profile (people directory)", people,
                              index=people.index(target.person_name) if target.person_name in people else 0)
        active = c3.checkbox("Active", value=target.active)
        if st.form_submit_button("Save", type="primary"):
            try:
                update_user(user, target.id, role=role, active=active, person_name=person)
                st.success(f"Saved {esc(target.username)}.")
                st.rerun()
            except (PermissionError, ValueError) as err:
                st.error(f"Not allowed: {err}")


if page not in PAGES:                                   # defense in depth: never render a page the role can't see
    st.error("Not allowed.")
    st.stop()
{"Consultant": consultant_page, "Expert": expert_page, "Knowledge health": health_page,
 "Evaluation": eval_page, "Admin": admin_page}[page]()
