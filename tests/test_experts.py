import pytest

from vouch.experts import create_request, resolve_request, route
from vouch.models import Context
from vouch.store import load_requests
from vouch.verdict import judge

from conftest import claim_id

Q = "What overtime surcharge do we pay on Saturday hours?"
CTX = Context("BE", "Janssens")


@pytest.fixture
def request_(kb, tmp_store):
    kv = judge("overtime_surcharge", "saturday", CTX, kb)
    return create_request(Q, CTX, kv, kb)


def test_route_conflict_to_anna(kb):
    kv = judge("overtime_surcharge", "saturday", CTX, kb)
    assert route(kv, kb) == {"name": "Anna Peeters", "why": "owns the official policy, answered 6 similar questions"}


def test_create_request_dedupes(kb, request_):
    assert request_["assigned_to"] == "Anna Peeters"
    assert set(request_["candidate_claim_ids"]) == {claim_id(kb, "policy_be_payroll_2026-05", "overtime_surcharge"),
                                                    claim_id(kb, "teams_tom_2026-03-12", "overtime_surcharge")}
    kv = judge("overtime_surcharge", "saturday", CTX, kb)
    assert create_request(Q, CTX, kv, kb)["id"] == request_["id"]
    assert len(load_requests()) == 1


def test_resolve_wrong_resolver(kb, request_):
    with pytest.raises(PermissionError):
        resolve_request(request_["id"], "Tom Maes", request_["candidate_claim_ids"][0])


def test_resolve_claim_outside_candidates(kb, request_):
    with pytest.raises(ValueError):
        resolve_request(request_["id"], "Anna Peeters", claim_id(kb, "manual_nl_payroll_2025-11", "overtime_surcharge"))


def test_resolve_twice(kb, request_):
    policy = claim_id(kb, "policy_be_payroll_2026-05", "overtime_surcharge")
    resolve_request(request_["id"], "Anna Peeters", policy, "agreement ended Jan 2026")
    with pytest.raises(ValueError):
        resolve_request(request_["id"], "Anna Peeters", policy)


def test_resolve_bad_ids(tmp_store):
    with pytest.raises(ValueError):
        resolve_request("../../etc/passwd", "Anna Peeters", "x")
    with pytest.raises(ValueError):
        resolve_request("00000000-0000-0000-0000-000000000000", "Anna Peeters", "x")


def test_full_loop_verifies(make_kb, request_):
    kb = make_kb()
    policy = claim_id(kb, "policy_be_payroll_2026-05", "overtime_surcharge")
    resolve_request(request_["id"], "Anna Peeters", policy, "agreement ended Jan 2026")
    kv = judge("overtime_surcharge", "saturday", CTX, make_kb(load_requests()))
    assert kv.verdict == "VERIFIED" and kv.value == "50%"
    assert any("agreement ended Jan 2026" in n for n in kv.notes)
