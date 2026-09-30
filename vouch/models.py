"""Plain dataclasses shared by every module."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Optional

VERIFIED = "VERIFIED"
CONFLICTING = "CONFLICTING"
POSSIBLY_OUTDATED = "POSSIBLY_OUTDATED"
UNSUPPORTED = "UNSUPPORTED"

BADGES = {
    VERIFIED: "✅ Verified",
    CONFLICTING: "⚠️ Conflicting",
    POSSIBLY_OUTDATED: "🕓 Possibly outdated",
    UNSUPPORTED: "❓ Unsupported",
}

SOURCE_TYPE_LABELS = {
    "policy": "official policy",
    "client_agreement": "client agreement",
    "manual": "manual",
    "procedure": "procedure",
    "email": "email",
    "teams_message": "Teams message",
}


@dataclass
class Doc:
    id: str
    title: str
    source_type: str
    author: str
    owner: str
    owner_active: bool
    date: str
    country: str
    client: str
    supersedes: list[str]
    body: str
    valid_to: Optional[str] = None


@dataclass
class Claim:
    claim_id: str
    topic: str
    condition: str
    value: str
    country: str
    client: str
    valid_from: str
    source_id: str
    quote: str
    status: str = "active"          # active | confirmed | outdated
    confirmed_by: Optional[str] = None
    confirmed_at: Optional[str] = None
    outdated_by: Optional[str] = None
    outdated_at: Optional[str] = None
    note: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Evidence:
    claim: Claim
    doc: Doc
    state: str                       # in_scope | stale | ignored
    score: int = 0
    reasons: list[str] = field(default_factory=list)
    ignore_reason: Optional[str] = None


@dataclass
class KeyVerdict:
    topic: str
    condition: str
    verdict: str
    value: Optional[str] = None
    supporting: list[Evidence] = field(default_factory=list)   # evidence behind the chosen / leading value
    competing: list[Evidence] = field(default_factory=list)    # in-scope evidence for other values
    stale: list[Evidence] = field(default_factory=list)
    ignored: list[Evidence] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def in_scope(self) -> list[Evidence]:
        return sorted(self.supporting + self.competing, key=lambda e: -e.score)


@dataclass
class Context:
    country: str = "BE"
    client: str = "all"

    def validate(self, vocab: dict) -> "Context":
        """Server-side whitelist: never trust the UI to restrict country/client."""
        if self.country not in vocab["countries"] or self.client not in vocab["clients"]:
            raise ValueError("unknown country or client")
        return self


@dataclass
class Answer:
    question: str
    ctx: Context
    topic: Optional[str]
    condition: Optional[str]
    parser: str
    primary: Optional[KeyVerdict]
    related: list[KeyVerdict]
    headline: str
    abstain: bool
    expert: Optional[dict] = None
