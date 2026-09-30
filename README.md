# ✅ Vouch

> **Search finds answers. Vouch tells you which ones you can act on — and when you can't, who to ask.**

Built for the SD Worx challenge *"Unlock the Knowledge Within — Find it. Understand it. Trust it."*

A payroll consultant (Sophie) inherits the Belgian client **Brouwerij Janssens**. The client asks:
*"What overtime surcharge do we pay on Saturday hours?"* The knowledge base holds the official Belgian
policy (50%), a Teams message from her predecessor ("35% for Janssens, special agreement"), and a Dutch manual (40%).
A plain RAG assistant blends them and confidently answers. **Vouch** instead:

- **Trust:** gives every answer a verdict — ✅ Verified · ⚠️ Conflicting · 🕓 Possibly outdated · ❓ Unsupported —
  with the scored reasons behind it (source type, age, owner, corroboration, expert confirmation) and the verbatim quote.
- **Detect:** ignores out-of-scope sources (other country / other client) and says why; flags superseded, stale and
  ownerless documents; notices a client "exception" that has no agreement document behind it.
- **Connect:** when it can't answer, it abstains and routes the doubt to the right expert
  (owner of the best source, or the colleague who answered most similar questions).
- **Capture:** the expert sees the sources side by side and resolves the conflict with one click; the next person
  gets ✅ *"Confirmed by Anna Peeters on 30 Sep 2026; Teams message marked outdated."* Unanswerable questions are
  logged as knowledge gaps.

## How it works

```
 corpus/*.md ──(local LLM, offline)──► claims.json ──┐          resolutions.json (expert overlay)
   YAML front matter: type, owner,     verbatim-quote │                     │
   date, country, client, supersedes   checked claims ▼                     ▼
 question ─► parse (keywords → local LLM fallback) ─► (topic, condition) ─► judge() ─► templated answer
                                                        deterministic rules: scope, freshness, score, verdict
```

- **A free local LLM (Ollama, `qwen2.5:7b`) is used in exactly three places:** extracting claims at ingest,
  mapping a paraphrased question to the vocabulary (only if the keyword matcher fails), and the plain-RAG baseline.
  **Trust is never decided by the LLM.** Scoring, verdicts, routing and the answer text are deterministic Python
  (`vouch/score.py`, `vouch/verdict.py`), configured in `config/trust_rules.json`.
- **Answers are composed from verified claims**, so the answer text can't hallucinate: every value shown comes
  from a claim whose quote is a verbatim substring of its source document.
- **Anti-hallucination at ingest:** an extracted claim is dropped unless its topic/condition are in the fixed
  vocabulary (enforced by an enum JSON schema *and* re-validated in Python), its value normalizes, its quote is found
  verbatim in the document, and the value literally appears in that quote.
- **Nothing leaves the machine.** No API keys, no cloud LLM, no payroll data sent to a third party.
- The whole Vouch path works **without Ollama running** (keyword parser; plain RAG replays the recorded eval run).

### Trust rules (`config/trust_rules.json`)

| Signal | Points |
|---|---|
| Official policy / client agreement | +3 |
| Manual / procedure | +2 |
| Email | +1 |
| Teams message | 0 |
| Updated within 12 months | +2 |
| Older than 24 months | −2 |
| Owner still active | +1 |
| Each other document stating the same value | +1 |
| Confirmed by an expert | +5 |
| Marked outdated by an expert / other country / other client | ignored, with the reason shown |
| Superseded, expired, or older than 24 months | only counts as 🕓 possibly outdated |

Verdict: one value → ✅. An active client agreement for that client overrides the general policy → ✅.
A client-specific claim without an agreement document that disagrees → ⚠️ (it might be a real exception, so a
human decides). Otherwise ✅ only if the best value leads by ≥ 4 points, else ⚠️. All values in "knowledge as of"
calculations use the fixed date `as_of: 2026-09-30` so the demo and tests are reproducible.

## Run it

```bash
brew install ollama && brew services start ollama
ollama pull qwen2.5:7b                      # free, ~4.7 GB; optional — the app works without it

uv venv --python 3.12 && source .venv/bin/activate
uv pip install -r requirements.txt
cp .env.example .env                        # optionally set VOUCH_EXPERT_PIN

streamlit run app.py                        # the app
pytest                                      # deterministic tests (fixture claims, no LLM)
python -m vouch.extract                     # re-extract data/claims.json with the local LLM
python eval/run_eval.py                     # plain RAG vs. Vouch -> eval/results.md
```

### Demo script (≈ 3 min)
1. Consultant page, client **Janssens**, toggle **Plain RAG mode**, ask the Saturday-surcharge preset → a confident answer.
2. Toggle it off → ⚠️ both sources with reasons, Dutch manual under *Ignored*, ✅ "Saturday counts as overtime (3 sources agree)", **Ask Anna**.
3. **Expert** page as Anna → both sources side by side → pick 50%, note "agreement ended Jan 2026" → Resolve.
4. Re-ask → ✅ 50%, confirmed by Anna Peeters; Teams message marked outdated.
5. Public-holiday-on-Sunday preset → ❓ abstains, routes to Pieter, logged as a gap.
6. **Knowledge health** and **Evaluation** pages. **🔄 Reset demo** in the sidebar restores the start state.

## Evaluation

**Plain RAG was confidently wrong on 3/5 questions (correct 2/5). Vouch was confidently wrong on 0/5, correct on 2/5, and flagged or abstained on 3/3 unsafe cases (conflict, outdated, unanswerable).**

Model: `qwen2.5:7b` (local, Ollama) · knowledge as of 2026-09-30 · Vouch verdict matched the expected verdict on 5/5.

| # | Case | Question (context) | Ground truth | Plain RAG | Vouch |
|---|---|---|---|---|---|
| 1 | conflict | What overtime surcharge do we pay on Saturday hours? (BE, Janssens) | 50%: the Janssens agreement ended Jan 2026 | ❌ confidently wrong | 🟡 flagged / abstained — conflicting → ask Anna Peeters |
| 2 | out-of-scope | What overtime surcharge do we pay on Saturday hours? (BE, Wouters) | 50%: general BE policy; NL manual (40%) does not apply | ✅ correct | ✅ correct — verified 50% |
| 3 | outdated | What is the home-working allowance? (BE, all) | —: no current value; the 2023 procedure (€140) is superseded | ❌ confidently wrong | 🟡 flagged / abstained — possibly outdated → ask Anna Peeters |
| 4 | corroborated | Do Saturday hours count as overtime? (BE, Janssens) | yes: 3 BE sources agree | ✅ correct | ✅ correct — verified Yes |
| 5 | unanswerable | What surcharge applies to public holidays falling on a Sunday? (BE, Janssens) | —: not in the knowledge base (follows the sector agreement) | ❌ confidently wrong | 🟡 flagged / abstained — unsupported → ask Pieter Claes |

What plain RAG actually said (local `qwen2.5:7b`, top-3 BM25 retrieval, production-style prompt — full text in
[`eval/results.md`](eval/results.md)):

- **#1** *"For Janssens in Belgium, the overtime surcharge for Saturday hours is 35%."* Retrieval missed the policy,
  and the chat message became the answer.
- **#3** *"The home-working allowance in Belgium is €140 per month."* It answered from a superseded 2023 procedure.
- **#5** *"For public holidays falling on a Sunday, the surcharge is 100%."* It reused the plain Sunday rate for a
  question the knowledge base doesn't answer.
- **#4** is graded correct ("yes"), but the same answer also volunteers *"the overtime surcharge for Saturdays is 35%,
  as per the special agreement"* — the wrong value, unasked. We kept the rule-based grade rather than adjusting it.

Also from the real extraction run: the local LLM proposed *"Sunday hours count as overtime"* for the Belgian policy.
The document never says that, so the verbatim-quote check rejected it before it reached the knowledge base.

## Security

- **Server-side authorization:** `experts.resolve_request` checks that the request exists and is open, that the
  resolver is the assigned expert, and that the chosen claim is one of that request's candidates — the UI is not trusted.
  Request IDs must be UUIDs and are only looked up in the store.
- **Expert PIN** from the environment (`VOUCH_EXPERT_PIN`), compared with `hmac.compare_digest`.
  This is demo-grade auth, not a real identity system (see *Unfinished*).
- **LLM output is untrusted:** schema + enum validation, verbatim-quote check, value-in-quote check; the LLM never sets trust.
- **Prompt injection:** document text is wrapped in `<document>` delimiters as data; the worst an injected document can do
  is propose claims that fail validation or that are still scored by fixed rules.
- **Input limits:** question ≤ 300 chars, expert note ≤ 500 chars, country/client whitelisted from the vocabulary.
- **Rendering:** no `unsafe_allow_html`; document, user and LLM text is escaped or rendered as plain text.
- No `eval`/`exec`/`pickle`, no file upload, no user-controlled paths (all paths are constants in `vouch/paths.py`).
- Atomic JSON writes (temp file + `os.replace`); pinned dependencies in `requirements.txt`; no secrets in git (`.env` is ignored).

## Project layout

```
app.py                 Streamlit UI: Consultant · Expert · Knowledge health · Evaluation
vouch/ingest.py        corpus markdown + YAML front matter -> Doc
vouch/extract.py       local-LLM claim extraction + validation (python -m vouch.extract)
vouch/llm.py           Ollama wrapper; every failure returns None so callers fall back
vouch/parse.py         question -> (topic, condition): keywords first, enum-constrained LLM fallback
vouch/score.py         trust rules -> (score, reasons)
vouch/verdict.py       per-key verdict, scope filtering, notes
vouch/experts.py       routing, create_request, resolve_request (authorization)
vouch/health.py        conflicts, open requests, stale, ownerless, unanswered
vouch/pipeline.py      answer() and the plain_rag() baseline
config/                vocabulary.json, trust_rules.json
data/                  corpus/*.md (18 synthetic docs), people.json, claims.json (generated, committed)
eval/                  questions.json, run_eval.py, results.json/.md
tests/                 fixture-based tests for every verdict, the resolve loop and its authorization
```

## Unfinished / honest limitations

- **Synthetic corpus** of 18 short fictional documents; every name is made up.
- **Demo-grade auth:** persona selection + one shared PIN. A real deployment needs SSO and per-expert identity.
- Answers are composed from the vocabulary (5 topics × 5 conditions); questions outside it abstain rather than guess.
  Verifying a free-text LLM draft claim-by-claim ("Check this answer") is the next step.
- Experts can resolve conflicts but not yet answer a knowledge gap directly (a gap needs a new document for now).
- The evaluation is 5 questions — it demonstrates the behaviour, it is not a benchmark.
- Extraction quality depends on the local 7B model; the validators drop bad claims, and the Phase 2 test checks that
  every planted trap was extracted.
