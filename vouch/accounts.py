"""User accounts: registration, login, roles. Passwords are salted scrypt hashes (stdlib, no extra dependency).

CLI:
  python -m vouch.accounts create-user --username anna --display-name "Anna Peeters" --role expert --person "Anna Peeters"
  python -m vouch.accounts seed-demo          # demo accounts; password from VOUCH_DEMO_PASSWORD
  python -m vouch.accounts list
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import getpass
import hashlib
import hmac
import os
import re
import secrets
import sys
from dataclasses import dataclass

from .db import transaction

ROLES = ("consultant", "expert", "admin")
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{2,31}$")
MIN_PASSWORD, MAX_PASSWORD = 12, 128
MAX_FAILED_LOGINS, LOCKOUT_MINUTES = 5, 15
_N, _R, _P, _DKLEN = 2 ** 14, 8, 1, 32
_COMMON = {"password1234", "123456789012", "qwertyuiopas", "welcome12345", "letmein12345", "passwordpassword"}


class AuthError(Exception):
    """Login failed. The message is deliberately generic."""


@dataclass(frozen=True)
class User:
    id: int
    username: str
    display_name: str
    person_name: str | None
    role: str
    active: bool

    @property
    def is_expert(self) -> bool:
        return self.role in ("expert", "admin") and bool(self.person_name)

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


# ------------------------------------------------------------------------------------------------ hashing

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=_DKLEN)
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return f"scrypt${_N}${_R}${_P}${b64(salt)}${b64(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, dk = stored.split("$")
        if algo != "scrypt":
            return False
        expected = base64.b64decode(dk)
        got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p),
                             dklen=len(expected))
        return hmac.compare_digest(got, expected)
    except (ValueError, TypeError):
        return False


_DUMMY_HASH = hash_password(secrets.token_urlsafe(16))   # equalizes timing for unknown usernames


# ------------------------------------------------------------------------------------------------ validation

def validate_username(username: str) -> str:
    u = (username or "").strip().lower()
    if not USERNAME_RE.fullmatch(u):
        raise ValueError("Username must be 3–32 characters: lowercase letters, digits, '.', '_' or '-'.")
    return u


def validate_password(password: str, username: str = "") -> None:
    if not isinstance(password, str) or not (MIN_PASSWORD <= len(password) <= MAX_PASSWORD):
        raise ValueError(f"Password must be {MIN_PASSWORD}–{MAX_PASSWORD} characters.")
    low = password.lower()
    if low in _COMMON or (username and username.lower() in low) or len(set(password)) < 5:
        raise ValueError("Password is too easy to guess — use a longer passphrase.")


def _clean_name(name: str, field: str = "Display name") -> str:
    n = " ".join((name or "").split())
    if not (2 <= len(n) <= 60) or any(ch in n for ch in "<>{}[]`$\\"):
        raise ValueError(f"{field} must be 2–60 characters without special symbols.")
    return n


def _row_to_user(row) -> User:
    return User(row["id"], row["username"], row["display_name"], row["person_name"], row["role"], bool(row["active"]))


# ------------------------------------------------------------------------------------------------ operations

def register(username: str, display_name: str, password: str, *, role: str = "consultant",
             person_name: str | None = None) -> User:
    """Self-registration always creates a consultant; only the CLI / an admin can grant other roles."""
    username = validate_username(username)
    validate_password(password, username)
    display_name = _clean_name(display_name)
    if role not in ROLES:
        raise ValueError("unknown role")
    person_name = _clean_name(person_name, "Person") if person_name else None
    with transaction() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            raise ValueError("That username is already taken.")
        cur = conn.execute(
            "INSERT INTO users (username, display_name, person_name, role, pw_hash, created_at) VALUES (?,?,?,?,?,?)",
            (username, display_name, person_name, role, hash_password(password), _now().isoformat()))
        return get_user(cur.lastrowid, conn=conn)


def authenticate(username: str, password: str) -> User:
    u = (username or "").strip().lower()
    error = None
    # Decide inside the transaction but raise only after it commits: raising inside would roll back the
    # failed-login counter and the lockout would never trigger.
    with transaction() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (u,)).fetchone()
        if row is None:
            verify_password(password or "", _DUMMY_HASH)
            error = "Invalid username or password."
        elif row["locked_until"] and dt.datetime.fromisoformat(row["locked_until"]) > _now():
            error = "Too many failed attempts. Try again later."
        elif not verify_password(password or "", row["pw_hash"]) or not row["active"]:
            failed = row["failed_logins"] + 1
            locked = (_now() + dt.timedelta(minutes=LOCKOUT_MINUTES)).isoformat() if failed >= MAX_FAILED_LOGINS else None
            conn.execute("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?",
                         (0 if locked else failed, locked, row["id"]))
            error = "Invalid username or password."
        else:
            conn.execute("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?", (row["id"],))
    if error:
        raise AuthError(error)
    return _row_to_user(row)


def get_user(user_id: int, conn=None) -> User | None:
    if conn is None:
        with transaction() as c:
            return get_user(user_id, conn=c)
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _row_to_user(row) if row else None


def list_users() -> list[User]:
    with transaction() as conn:
        return [_row_to_user(r) for r in conn.execute("SELECT * FROM users ORDER BY role, username")]


def update_user(actor: User, user_id: int, *, role: str | None = None, active: bool | None = None,
                person_name: str | None = None) -> User:
    """Admin-only. An admin can't demote or deactivate themself (avoids locking everyone out)."""
    if not actor.is_admin:
        raise PermissionError("only admins can manage users")
    if user_id == actor.id and (role not in (None, "admin") or active is False):
        raise PermissionError("you can't remove your own admin access")
    if role is not None and role not in ROLES:
        raise ValueError("unknown role")
    with transaction() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone():
            raise ValueError("user not found")
        if role is not None:
            conn.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
        if active is not None:
            conn.execute("UPDATE users SET active = ? WHERE id = ?", (int(active), user_id))
        if person_name is not None:
            conn.execute("UPDATE users SET person_name = ? WHERE id = ?",
                         (_clean_name(person_name, "Person") if person_name.strip() else None, user_id))
        return get_user(user_id, conn=conn)


def set_password(username: str, password: str) -> None:
    username = validate_username(username)
    validate_password(password, username)
    with transaction() as conn:
        conn.execute("UPDATE users SET pw_hash = ?, failed_logins = 0, locked_until = NULL WHERE username = ?",
                     (hash_password(password), username))


# ------------------------------------------------------------------------------------------------ CLI

DEMO_ACCOUNTS = [
    # username, display name, role, person (people.json)
    ("sophie", "Sophie Lambert", "consultant", "Sophie Lambert"),
    ("anna", "Anna Peeters", "expert", "Anna Peeters"),
    ("pieter", "Pieter Claes", "expert", "Pieter Claes"),
    ("lotte", "Lotte Jacobs", "admin", "Lotte Jacobs"),
]


def seed_demo(password: str) -> list[str]:
    """Create (or reset the password of) the demo accounts. Idempotent."""
    out = []
    for username, name, role, person in DEMO_ACCOUNTS:
        with transaction() as conn:
            exists = conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
        if exists:
            set_password(username, password)
            with transaction() as conn:
                conn.execute("UPDATE users SET role = ?, person_name = ?, display_name = ?, active = 1 WHERE username = ?",
                             (role, person, name, username))
            out.append(f"updated {username} ({role})")
        else:
            register(username, name, password, role=role, person_name=person)
            out.append(f"created {username} ({role})")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m vouch.accounts")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-user")
    c.add_argument("--username", required=True)
    c.add_argument("--display-name", required=True)
    c.add_argument("--role", choices=ROLES, default="consultant")
    c.add_argument("--person", help="name in data/people.json (needed for experts)")
    sub.add_parser("seed-demo")
    sub.add_parser("list")
    args = ap.parse_args(argv)

    try:
        if args.cmd == "create-user":
            pw = getpass.getpass("Password: ")
            if pw != getpass.getpass("Repeat password: "):
                print("Passwords don't match.", file=sys.stderr)
                return 1
            u = register(args.username, args.display_name, pw, role=args.role, person_name=args.person)
            print(f"created {u.username} ({u.role})")
        elif args.cmd == "seed-demo":
            pw = os.getenv("VOUCH_DEMO_PASSWORD", "")
            if not pw:
                print("Set VOUCH_DEMO_PASSWORD (12+ characters) to seed the demo accounts.", file=sys.stderr)
                return 1
            validate_password(pw)
            print("\n".join(seed_demo(pw)))
        else:
            for u in list_users():
                print(f"{u.id:>3} {u.username:16} {u.role:10} {'active' if u.active else 'disabled':8} {u.person_name or ''}")
    except ValueError as err:
        print(f"Error: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
