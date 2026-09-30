import json

import pytest

from vouch import paths
from vouch.models import CONFLICTING, POSSIBLY_OUTDATED, UNSUPPORTED, VERIFIED, Context
from vouch.parse import keyword_parse
from vouch.pipeline import answer
from vouch.store import load_vocabulary
from vouch.verdict import judge

from conftest import claim_id

BE_JANSSENS = Context("BE", "Janssens")


def scores(kv):
    return {e.claim.value: e.score for e in kv.in_scope}


def test_janssens_surcharge_conflicting(kb):
    kv = judge("overtime_surcharge", "saturday", BE_JANSSENS, kb)
    assert kv.verdict == CONFLICTING
    assert scores(kv) == {"50%": 6, "35%": 3}
    policy = next(e for e in kv.in_scope if e.claim.value == "50%")
    teams = next(e for e in kv.in_scope if e.claim.value == "35%")
    assert "official policy (+3)" in policy.reasons
    assert any("no agreement document found for Janssens" in r for r in teams.reasons)
    ignored = {e.claim.value: e.ignore_reason for e in kv.ignored}
    assert "NL" in ignored["40%"]
    assert "DeSmet" in ignored["60%"]


def test_resolution_overlay_verifies(make_kb):
    base = make_kb()
    req = {"status": "resolved", "resolved_by": "Anna Peeters", "resolved_at": "2026-09-30",
           "chosen_claim_id": claim_id(base, "policy_be_payroll_2026-05", "overtime_surcharge"),
           "candidate_claim_ids": [claim_id(base, "policy_be_payroll_2026-05", "overtime_surcharge"),
                                   claim_id(base, "teams_tom_2026-03-12", "overtime_surcharge")]}
    kb = make_kb([req])
    kv = judge("overtime_surcharge", "saturday", BE_JANSSENS, kb)
    assert kv.verdict == VERIFIED and kv.value == "50%"
    assert kv.supporting[0].score == 11
    assert any("Confirmed by Anna Peeters" in n for n in kv.notes)
    assert any("(35%) marked outdated by Anna Peeters" in n for n in kv.notes)
    assert any("marked outdated" in e.ignore_reason for e in kv.ignored if e.claim.value == "35%")


def test_eligibility_corroborated(kb):
    kv = judge("overtime_eligibility", "saturday", BE_JANSSENS, kb)
    assert kv.verdict == VERIFIED and kv.value == "yes"
    assert len({e.doc.id for e in kv.supporting}) == 3
    by_doc = {e.doc.id: e.score for e in kv.supporting}
    assert by_doc == {"policy_be_payroll_2026-05": 8, "email_handover_janssens_2026-09": 6,
                      "procedure_be_overtime_faq_2025-11": 7}
    assert all(any("corroborated by 2 other sources (+2)" == r for r in e.reasons) for e in kv.supporting)
    assert "3 sources agree." in kv.notes
    assert any("NL" in e.ignore_reason for e in kv.ignored)


def test_desmet_client_agreement_overrides(kb):
    kv = judge("overtime_surcharge", "saturday", Context("BE", "DeSmet"), kb)
    assert kv.verdict == VERIFIED and kv.value == "60%"
    assert kv.supporting[0].score == 6
    assert any("overrides the general policy" in n and "50%" in n for n in kv.notes)


def test_wouters_policy_only(kb):
    kv = judge("overtime_surcharge", "saturday", Context("BE", "Wouters"), kb)
    assert kv.verdict == VERIFIED and kv.value == "50%"
    assert {e.claim.value for e in kv.ignored} == {"35%", "40%", "60%"}


def test_homework_possibly_outdated(kb):
    kv = judge("homework_allowance", "general", Context("BE", "all"), kb)
    assert kv.verdict == POSSIBLY_OUTDATED and kv.value == "€140"
    assert kv.supporting[0].score == 1
    assert any("superseded" in n for n in kv.notes)
    assert [(e.claim.value, e.ignore_reason) for e in kv.ignored] == [("€2.35", "applies to NL, not BE")]


def test_meal_voucher_verified_with_stale_note(kb):
    kv = judge("meal_voucher", "general", Context("BE", "all"), kb)
    assert kv.verdict == VERIFIED and kv.value == "€8"
    assert kv.supporting[0].score == 6
    assert any("€7" in n and "superseded" in n for n in kv.notes)


def test_mileage_ownerless_outdated(kb):
    kv = judge("mileage_allowance", "general", Context("BE", "all"), kb)
    assert kv.verdict == POSSIBLY_OUTDATED
    assert kv.supporting[0].score == 0
    assert "owner Marc Dubois has left (+0)" in kv.supporting[0].reasons
    ans = answer("What is the mileage allowance?", Context("BE", "all"), kb, use_llm=False)
    assert ans.expert["name"] == "Pieter Claes"


def test_public_holiday_unsupported(kb, tmp_store):
    q = "What surcharge applies to public holidays falling on a Sunday?"
    ans = answer(q, BE_JANSSENS, kb, use_llm=False, log=True)
    assert ans.condition == "public_holiday"
    assert ans.primary.verdict == UNSUPPORTED
    assert ans.abstain is True
    assert ans.expert["name"] == "Pieter Claes"
    assert "won't guess" in ans.headline
    log = json.loads(paths.QUESTIONS_LOG.read_text())
    assert log[0]["question"] == q


def test_pipeline_janssens_abstains_and_routes_to_anna(kb):
    ans = answer("What overtime surcharge do we pay on Saturday hours?", BE_JANSSENS, kb, use_llm=False)
    assert ans.abstain and ans.primary.verdict == CONFLICTING
    assert ans.expert["name"] == "Anna Peeters"
    assert "6 similar questions" in ans.expert["why"]
    assert [r.topic for r in ans.related] == ["overtime_eligibility"]
    assert ans.related[0].verdict == VERIFIED


@pytest.mark.parametrize("q,topic,cond", [
    ("What surcharge applies to public holidays falling on a Sunday?", "overtime_surcharge", "public_holiday"),
    ("What overtime surcharge do we pay on Saturday hours?", "overtime_surcharge", "saturday"),
    ("Do Saturday hours count as overtime?", "overtime_eligibility", "saturday"),
    ("What is the home-working allowance?", "homework_allowance", "general"),
])
def test_keyword_parser(q, topic, cond):
    assert keyword_parse(q, load_vocabulary()) == {"topic": topic, "condition": cond}


def test_unknown_topic_abstains(kb):
    ans = answer("Who is the CEO of the brewery?", BE_JANSSENS, kb, use_llm=False)
    assert ans.topic is None and ans.abstain and ans.primary is None


def test_real_claims_contain_traps():
    """Phase 2 gate as a test: the LLM-extracted claims.json contains every trap."""
    claims = json.loads(paths.CLAIMS.read_text())
    sat = {(c["source_id"], c["value"]) for c in claims
           if c["topic"] == "overtime_surcharge" and c["condition"] == "saturday"}
    assert {("policy_be_payroll_2026-05", "50%"), ("teams_tom_2026-03-12", "35%"),
            ("manual_nl_payroll_2025-11", "40%"), ("agreement_desmet_2026-01", "60%")} <= sat
    elig_be = {c["source_id"] for c in claims if c["topic"] == "overtime_eligibility"
               and c["condition"] == "saturday" and c["country"] == "BE" and c["value"] == "yes"}
    assert len(elig_be) == 3
    assert not [c for c in claims if c["condition"] == "public_holiday"]


def test_context_whitelisted_server_side(kb):
    with pytest.raises(ValueError):
        answer("What is the home-working allowance?", Context("BE", "../../etc"), kb, use_llm=False)
    with pytest.raises(ValueError):
        answer("What is the home-working allowance?", Context("FR", "all"), kb, use_llm=False)
