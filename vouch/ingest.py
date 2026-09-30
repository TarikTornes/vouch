"""Load corpus/*.md and parse YAML front matter into Doc objects."""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import yaml

from .models import Doc
from .paths import CORPUS_DIR

REQUIRED = ["id", "title", "source_type", "author", "owner", "owner_active", "date", "country", "client", "supersedes"]
SOURCE_TYPES = {"policy", "client_agreement", "manual", "procedure", "email", "teams_message"}


def _as_str(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()[:10]
    return str(v)


def parse_doc(text: str, origin: str = "<string>") -> Doc:
    if not text.startswith("---"):
        raise ValueError(f"{origin}: missing front matter")
    _, fm, body = text.split("---", 2)
    meta = yaml.safe_load(fm) or {}
    missing = [k for k in REQUIRED if k not in meta]
    if missing:
        raise ValueError(f"{origin}: missing front matter fields {missing}")
    if meta["source_type"] not in SOURCE_TYPES:
        raise ValueError(f"{origin}: unknown source_type {meta['source_type']!r}")
    return Doc(
        id=str(meta["id"]),
        title=str(meta["title"]),
        source_type=meta["source_type"],
        author=str(meta["author"]),
        owner=str(meta["owner"]),
        owner_active=bool(meta["owner_active"]),
        date=_as_str(meta["date"]),
        country=str(meta["country"]),
        client=str(meta["client"]),
        supersedes=list(meta.get("supersedes") or []),
        valid_to=_as_str(meta.get("valid_to")),
        body=body.strip(),
    )


def load_docs(corpus_dir: Path = CORPUS_DIR) -> list[Doc]:
    docs = [parse_doc(p.read_text(encoding="utf-8"), p.name) for p in sorted(corpus_dir.glob("*.md"))]
    ids = [d.id for d in docs]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate doc ids in corpus")
    return docs
