import pytest

from vouch.accounts import update_user
from vouch.experts import create_request, open_requests_for, resolve_request, route
from vouch.models import Context
from vouch.store import load_requests
from vouch.verdict import judge

from conftest import claim_id

Q = "What overtime surcharge do we pay on Saturday hours?"
CTX = Context("BE", "Janssens")


@pytest.fixture
def request_(kb, users):
    kv = judge("overtime_surcharge", "saturday", CTX, kb)
    return create_request(Q, CTX, kv, kb, created_by=users["sophie"].id)


def test_route_conflict_to_anna(kb):
    kv = judge("overtime_surcharge", "saturday", CTX, kb)
    assert route(kv, kb) == {"name": "Anna Peeters", "why": "owns the official policy, answered 6 similar questions"}


def test_create_request_dedupes(kb, users, request_):
    assert request_["assigned_to"] == "Anna Peeters"
    assert request_["created_by"] == users["sophie"].id
    assert set(request_["candidate_claim_ids"]) == {claim_id(kb, "policy_be_payroll_2026-05", "overtime_surcharge"),
                                                    claim_id(kb, "teams_tom_2026-03-12", "overtime_surcharge")}
    kv = judge("overtime_surcharge", "saturday", CTX, kb)
    assert create_request(Q, CTX, kv, kb)["id"] == request_["id"]
    assert len(load_requests()) == 1


def test_inbox_only_shows_own_requests(users, request_):
    assert [r["id"] for r in open_requests_for(users["anna"])] == [request_["id"]]
    assert open_requests_for(users["pieter"]) == []
    assert open_requests_for(users["sophie"]) == []          # consultants have no inbox


def test_resolve_wrong_expert(kb, users, request_):
    with pytest.raises(PermissionError):
        resolve_request(request_["id"], users["pieter"], request_["candidate_claim_ids"][0])


def test_resolve_by_consultant_even_if_named_after_assignee(kb, users, request_):
    # Tom is a consultant whose person_name matches people.json — role, not name, grants resolve rights.
    with pytest.raises(PermissionError):
        resolve_request(request_["id"], users["tom"], request_["candidate_claim_ids"][0])


def test_resolve_by_deactivated_expert(kb, users, request_):
    update_user(users["lotte"], users["anna"].id, active=False)
    with pytest.raises(PermissionError):
        resolve_request(request_["id"], users["anna"], request_["candidate_claim_ids"][0])   # stale User object


def test_resolve_claim_outside_candidates(kb, users, request_):
    with pytest.raises(ValueError):
        resolve_request(request_["id"], users["anna"], claim_id(kb, "manual_nl_payroll_2025-11", "overtime_surcharge"))


def test_resolve_twice(kb, users, request_):
    policy = claim_id(kb, "policy_be_payroll_2026-05", "overtime_surcharge")
    resolve_request(request_["id"], users["anna"], policy, "agreement ended Jan 2026")
    with pytest.raises(ValueError):
        resolve_request(request_["id"], users["anna"], policy)


def test_resolve_bad_ids(users):
    with pytest.raises(ValueError):
        resolve_request("../../etc/passwd", users["anna"], "x")
    with pytest.raises(ValueError):
        resolve_request("00000000-0000-0000-0000-000000000000", users["anna"], "x")
    with pytest.raises(ValueError):
        resolve_request("x' OR '1'='1", users["anna"], "x")


def test_full_loop_verifies(make_kb, users, request_):
    kb = make_kb()
    policy = claim_id(kb, "policy_be_payroll_2026-05", "overtime_surcharge")
    req = resolve_request(request_["id"], users["anna"], policy, "agreement ended Jan 2026")
    assert req["resolved_by_user"] == users["anna"].id
    kv = judge("overtime_surcharge", "saturday", CTX, make_kb(load_requests()))
    assert kv.verdict == "VERIFIED" and kv.value == "50%"
    assert any("agreement ended Jan 2026" in n for n in kv.notes)
