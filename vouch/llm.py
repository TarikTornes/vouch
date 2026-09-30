"""Free local LLM via Ollama. Every call may fail and return None -> callers fall back.

The LLM is used for exactly three things: claim extraction (offline), question -> vocabulary key,
and the plain-RAG baseline. It never decides trust.
"""
from __future__ import annotations

import json
import os

import ollama
from dotenv import load_dotenv

load_dotenv()
MODEL = os.getenv("VOUCH_MODEL", "qwen2.5:7b")
_client = ollama.Client(host=os.getenv("OLLAMA_HOST", "http://localhost:11434"), timeout=120)


def llm_available() -> bool:
    try:
        _client.show(MODEL)          # server is up and the model is pulled
        return True
    except Exception:
        return False


def _call(system: str, prompt: str, schema: dict | None) -> str | None:
    """One local LLM call. Returns text, or None on any failure."""
    try:
        resp = _client.chat(
            model=MODEL,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            format=schema,                       # structured outputs: decoding constrained to the schema
            options={"temperature": 0},          # reproducible extraction/parsing
        )
        return resp.message.content
    except Exception:                            # server down, model missing -> never crash the demo
        return None


def structured(system: str, prompt: str, schema: dict) -> dict | None:
    out = _call(system, prompt, schema)
    try:
        data = json.loads(out) if out else None
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def text(system: str, prompt: str) -> str | None:
    return _call(system, prompt, None)
