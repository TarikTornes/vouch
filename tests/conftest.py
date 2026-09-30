"""Fixture KB: real hand-written corpus docs + hand-written claims (NOT LLM output) -> deterministic tests."""
import pytest

from vouch import paths
from vouch.ingest import load_docs
from vouch.models import Claim
from vouch.store import KB, apply_overlay, load_people, load_rules, load_vocabulary

C = [
    # (source_id, topic, condition, value, quote)
    ("policy_be_payroll_2026-05", "overtime_eligibility", "saturday", "yes", "Saturday hours count as overtime."),
    ("policy_be_payroll_2026-05", "overtime_surcharge", "saturday", "50%", "The overtime surcharge for Saturday hours is 50%."),
    ("policy_be_payroll_2026-05", "overtime_surcharge", "sunday", "100%", "The overtime surcharge for Sunday hours is 100%."),
    ("policy_be_payroll_2026-05", "meal_voucher", "general", "€8", "The employer part of the meal voucher is €8 per working day."),
    ("teams_tom_2026-03-12", "overtime_surcharge", "saturday", "35%", "for Janssens it's 35% on Saturdays"),
    ("manual_nl_payroll_2025-11", "overtime_eligibility", "saturday", "yes", "Saturday hours count as overtime."),
    ("manual_nl_payroll_2025-11", "overtime_surcharge", "saturday", "40%", "The overtime surcharge for Saturday hours is 40%."),
    ("procedure_be_payroll_2023-03", "meal_voucher", "general", "€7", "The employer part of the meal voucher is €7 per working day."),
    ("procedure_be_payroll_2023-03", "homework_allowance", "general", "€140", "The home-working allowance is €140 per month."),
    ("email_handover_janssens_2026-09", "overtime_eligibility", "saturday", "yes", "Saturday hours count as overtime for Janssens."),
    ("procedure_be_overtime_faq_2025-11", "overtime_eligibility", "saturday", "yes", "Saturday hours count as overtime."),
    ("procedure_be_overtime_faq_2025-11", "overtime_surcharge", "night", "25%", "The overtime surcharge for night work is 25%."),
    ("guideline_be_travel_2024-02", "mileage_allowance", "general", "€0.43/km", "The mileage allowance is €0.43 per km."),
    ("manual_nl_homework_2026-01", "homework_allowance", "general", "€2.35", "The home-working allowance is €2.35 per working day."),
    ("agreement_desmet_2026-01", "overtime_surcharge", "saturday", "60%", "the overtime surcharge for Saturday hours at Bakkerij De Smet is 60%."),
]


def build_claims(docs):
    out, counters = [], {}
    for sid, topic, cond, value, quote in C:
        d = docs[sid]
        i = counters.get(sid, 0)
        counters[sid] = i + 1
        out.append(Claim(claim_id=f"{sid}#{i}", topic=topic, condition=cond, value=value, country=d.country,
                         client=d.client, valid_from=d.date, source_id=sid, quote=quote))
    return out


def claim_id(kb, source_id, topic, condition="saturday"):
    return next(c.claim_id for c in kb.claims if c.source_id == source_id and c.topic == topic and c.condition == condition)


@pytest.fixture
def tmp_store(tmp_path, monkeypatch):
    """Runtime JSON files go to a temp dir so tests never touch data/."""
    monkeypatch.setattr(paths, "RESOLUTIONS", tmp_path / "resolutions.json")
    monkeypatch.setattr(paths, "QUESTIONS_LOG", tmp_path / "questions_log.json")
    return tmp_path


@pytest.fixture
def make_kb():
    def _make(requests=None):
        docs = {d.id: d for d in load_docs()}
        claims = apply_overlay(build_claims(docs), requests or [])
        return KB(docs, claims, load_rules(), load_people(), load_vocabulary())
    return _make


@pytest.fixture
def kb(make_kb):
    return make_kb()
