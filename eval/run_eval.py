"""Plain RAG vs. Vouch on eval/questions.json -> eval/results.json + eval/results.md.

Usage: python eval/run_eval.py            (needs Ollama for the plain-RAG baseline)
Grades: correct | confidently_wrong | flagged_or_abstained. Report whatever the real run gives.
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vouch import llm, paths, store  # noqa: E402
from vouch.models import VERIFIED, Context  # noqa: E402
from vouch.normalize import numbers_in  # noqa: E402
from vouch.pipeline import RAG_SYSTEM, answer, display_value, rag_prompt, retrieve  # noqa: E402

HEDGES = ["not sure", "conflict", "verify", "unclear", "cannot", "can't", "don't know", "do not know",
          "not specified", "not mentioned", "no information", "not provided", "check with", "confirm"]
CORRECT, WRONG, FLAGGED = "correct", "confidently_wrong", "flagged_or_abstained"
ICON = {CORRECT: "✅ correct", WRONG: "❌ confidently wrong", FLAGGED: "🟡 flagged / abstained"}


def mentions(text: str, value: str) -> bool:
    t = text.lower()
    if value in ("yes", "no"):
        return re.search(rf"\b{value}\b", t) is not None
    n = numbers_in(value)[0]
    ns = f"{n:g}"
    if value.endswith("%"):
        return re.search(rf"(?<![\d.,]){re.escape(ns)}\s*(%|percent)", t) is not None
    return re.search(rf"(€\s*{re.escape(ns)}(?![\d])|(?<![\d.,]){re.escape(ns)}\s*(€|eur))", t) is not None


def grade_rag(text: str, q: dict) -> str:
    hedged = any(h in text.lower() for h in HEDGES)
    # A wrong value stated without hedging is what the consultant would act on -> checked first.
    if any(mentions(text, w) for w in q["wrong_values"]) and not hedged:
        return WRONG
    if q["truth"] and mentions(text, q["truth"]) and not hedged:
        return CORRECT
    return FLAGGED


def grade_vouch(verdict: str, value: str | None, q: dict) -> str:
    if verdict != VERIFIED:
        return FLAGGED
    return CORRECT if q["truth"] and value == q["truth"] else WRONG


def cell(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").replace("|", "\\|").replace("`", "'")


def main() -> int:
    if not llm.llm_available():
        print(f"Ollama model {llm.MODEL} not available — the plain-RAG baseline needs it.", file=sys.stderr)
        return 1
    questions = json.loads((paths.EVAL_DIR / "questions.json").read_text(encoding="utf-8"))
    # Evaluate against the base knowledge (no expert resolutions) so runs are reproducible.
    kb = store.KB(store.load_docs_by_id(), store.load_base_claims(), store.load_rules(),
                  store.load_people(), store.load_vocabulary())
    rows = []
    for q in questions:
        ctx = Context(**q["ctx"])
        docs = retrieve(q["question"], ctx, kb)
        rag_text = (llm.text(RAG_SYSTEM, rag_prompt(q["question"], ctx, docs)) or "").strip()
        ans = answer(q["question"], ctx, kb, use_llm=False)
        verdict = ans.primary.verdict if ans.primary else "UNSUPPORTED"
        value = ans.primary.value if ans.primary else None
        rag_grade = q.get("manual_override") or grade_rag(rag_text, q)
        rows.append({
            "id": q["id"], "type": q["type"], "question": q["question"], "ctx": q["ctx"],
            "truth": q["truth"], "truth_note": q["truth_note"],
            "plain_rag_text": rag_text, "plain_rag_sources": [d.id for d in docs], "plain_rag_grade": rag_grade,
            "plain_rag_manual_override": bool(q.get("manual_override")),
            "vouch_verdict": verdict, "vouch_value": value, "vouch_expected": q["vouch_expected"],
            "vouch_grade": grade_vouch(verdict, value, q), "vouch_headline": ans.headline,
            "vouch_expert": ans.expert["name"] if ans.expert else None,
        })
        print(f"#{q['id']} {q['type']:13} RAG={rag_grade:22} Vouch={verdict:18} {value or ''}")

    n = len(rows)
    count = lambda key, g: sum(r[key] == g for r in rows)  # noqa: E731
    unsafe = [r for r in rows if r["type"] != "corroborated" and r["type"] != "out-of-scope"]
    headline = (
        f"Plain RAG was confidently wrong on {count('plain_rag_grade', WRONG)}/{n} questions "
        f"(correct {count('plain_rag_grade', CORRECT)}/{n}). "
        f"Vouch was confidently wrong on {count('vouch_grade', WRONG)}/{n}, correct on {count('vouch_grade', CORRECT)}/{n}, "
        f"and flagged or abstained on {sum(r['vouch_grade'] == FLAGGED for r in unsafe)}/{len(unsafe)} unsafe cases "
        f"(conflict, outdated, unanswerable)."
    )
    summary = {"headline": headline, "matches_expected": sum(r["vouch_verdict"] == r["vouch_expected"] for r in rows)}
    store.atomic_write_json(paths.EVAL_RESULTS, {
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"), "model": llm.MODEL,
        "as_of": kb.rules["as_of"], "summary": summary, "rows": rows,
    })

    md = [f"**{headline}**", "",
          f"Model: `{llm.MODEL}` (local, Ollama) · knowledge as of {kb.rules['as_of']} · "
          f"Vouch verdict matched the expected verdict on {summary['matches_expected']}/{n}.", "",
          "| # | Case | Question (context) | Ground truth | Plain RAG | Vouch |", "|---|---|---|---|---|---|"]
    for r in rows:
        vouch = f"{ICON[r['vouch_grade']]} — {r['vouch_verdict'].replace('_', ' ').lower()}"
        if r["vouch_value"] and r["vouch_verdict"] == VERIFIED:
            vouch += f" {display_value(r['vouch_value'])}"
        if r["vouch_expert"]:
            vouch += f" → ask {r['vouch_expert']}"
        rag = ICON[r["plain_rag_grade"]] + (" (manual)" if r["plain_rag_manual_override"] else "")
        md.append(f"| {r['id']} | {r['type']} | {cell(r['question'])} ({r['ctx']['country']}, {r['ctx']['client']}) "
                  f"| {cell(r['truth'] or '—')}: {cell(r['truth_note'])} | {rag} | {vouch} |")
    md += ["", "### Raw plain-RAG answers", ""]
    for r in rows:
        md += [f"**#{r['id']} {r['type']}** — retrieved: {', '.join(r['plain_rag_sources'])}", "", "```text",
               (r["plain_rag_text"] or "(empty)").replace("```", "'''"), "```", ""]
    md += ["Grading: plain RAG is graded by rules — a listed wrong value without hedge words is *confidently wrong* "
           "(checked first, since that is what the consultant would act on); the true value without hedging → *correct*; "
           "otherwise *flagged*. Vouch is graded from its structured verdict. `manual_override` in "
           "`questions.json` allows an honest human correction and is marked (manual)."]
    paths.EVAL_RESULTS_MD.write_text("\n".join(md) + "\n", encoding="utf-8")
    print("\n" + headline)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
