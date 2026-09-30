"""SQLite for all mutable state (users, expert requests, gap log). Corpus, claims and config stay read-only files."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager

from . import paths

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name    TEXT NOT NULL,
    person_name     TEXT,                      -- link to people.json (expert routing)
    role            TEXT NOT NULL CHECK (role IN ('consultant', 'expert', 'admin')),
    pw_hash         TEXT NOT NULL,
    active          INTEGER NOT NULL DEFAULT 1,
    failed_logins   INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
    created_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
    id                  TEXT PRIMARY KEY,      -- uuid4
    question            TEXT NOT NULL,
    country             TEXT NOT NULL,
    client              TEXT NOT NULL,
    topic               TEXT NOT NULL,
    condition           TEXT NOT NULL,
    kind                TEXT NOT NULL,
    candidate_claim_ids TEXT NOT NULL,         -- JSON list
    assigned_to         TEXT NOT NULL,
    assigned_why        TEXT,
    status              TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    created_at          TEXT NOT NULL,
    created_by          INTEGER REFERENCES users(id),
    chosen_claim_id     TEXT,
    resolved_by         TEXT,
    resolved_by_user    INTEGER REFERENCES users(id),
    resolved_at         TEXT,
    note                TEXT
);
CREATE TABLE IF NOT EXISTS questions_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    question    TEXT NOT NULL,
    country     TEXT NOT NULL,
    client      TEXT NOT NULL,
    topic       TEXT,
    condition   TEXT,
    routed_to   TEXT,
    asked_at    TEXT NOT NULL,
    asked_by    INTEGER REFERENCES users(id)
);
"""


def connect() -> sqlite3.Connection:
    paths.DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(paths.DB, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")      # readers don't block the writer
    conn.executescript(SCHEMA)
    return conn


@contextmanager
def transaction():
    """One connection per unit of work; commit on success, roll back on error."""
    conn = connect()
    try:
        with conn:
            yield conn
    finally:
        conn.close()
