import pytest

from vouch import accounts
from vouch.accounts import AuthError, authenticate, register, update_user, verify_password

from conftest import TEST_PASSWORD


def test_password_hash_roundtrip():
    h = accounts.hash_password(TEST_PASSWORD)
    assert h.startswith("scrypt$") and TEST_PASSWORD not in h
    assert verify_password(TEST_PASSWORD, h)
    assert not verify_password(TEST_PASSWORD + "x", h)
    assert accounts.hash_password(TEST_PASSWORD) != h                 # salted
    assert not verify_password(TEST_PASSWORD, "garbage")


def test_register_is_consultant_by_default(tmp_store):
    u = register("NewUser", "New User", TEST_PASSWORD)
    assert u.username == "newuser" and u.role == "consultant" and not u.is_expert


@pytest.mark.parametrize("username,password", [
    ("ab", TEST_PASSWORD),                        # too short
    ("bad name", TEST_PASSWORD),                  # space
    ("../admin", TEST_PASSWORD),                  # path chars
    ("valid_user", "short"),                      # short password
    ("valid_user", "password1234"),               # common
    ("valid_user", "aaaaaaaaaaaaaaaa"),           # too few distinct characters
    ("valid_user", "my-valid_user-pass"),         # contains username
])
def test_register_validation(tmp_store, username, password):
    with pytest.raises(ValueError):
        register(username, "Some Name", password)


def test_register_rejects_markup_in_name(tmp_store):
    with pytest.raises(ValueError):
        register("mallory", "<script>alert(1)</script>", TEST_PASSWORD)


def test_duplicate_username_case_insensitive(tmp_store):
    register("sophie", "Sophie Lambert", TEST_PASSWORD)
    with pytest.raises(ValueError):
        register("Sophie", "Someone Else", TEST_PASSWORD)


def test_login(users):
    assert authenticate("ANNA", TEST_PASSWORD).id == users["anna"].id
    with pytest.raises(AuthError, match="Invalid username or password"):
        authenticate("anna", "wrong-password-123")
    with pytest.raises(AuthError, match="Invalid username or password"):
        authenticate("nobody", TEST_PASSWORD)                         # same message: no user enumeration


def test_lockout_after_repeated_failures(users):
    for _ in range(accounts.MAX_FAILED_LOGINS):
        with pytest.raises(AuthError):
            authenticate("sophie", "wrong-password-123")
    with pytest.raises(AuthError, match="Too many failed attempts"):
        authenticate("sophie", TEST_PASSWORD)                          # even the right password is refused


def test_deactivated_user_cannot_login(users):
    update_user(users["lotte"], users["sophie"].id, active=False)
    with pytest.raises(AuthError):
        authenticate("sophie", TEST_PASSWORD)


def test_only_admin_manages_users(users):
    with pytest.raises(PermissionError):
        update_user(users["anna"], users["sophie"].id, role="admin")
    promoted = update_user(users["lotte"], users["sophie"].id, role="expert", person_name="Sophie Lambert")
    assert promoted.role == "expert" and promoted.is_expert


def test_admin_cannot_lock_themself_out(users):
    with pytest.raises(PermissionError):
        update_user(users["lotte"], users["lotte"].id, role="consultant")
    with pytest.raises(PermissionError):
        update_user(users["lotte"], users["lotte"].id, active=False)


def test_seed_demo_is_idempotent(tmp_store):
    first = accounts.seed_demo(TEST_PASSWORD)
    again = accounts.seed_demo(TEST_PASSWORD)
    assert all(l.startswith("created") for l in first) and all(l.startswith("updated") for l in again)
    assert authenticate("anna", TEST_PASSWORD).is_expert
    assert authenticate("lotte", TEST_PASSWORD).is_admin
    assert authenticate("sophie", TEST_PASSWORD).role == "consultant"
