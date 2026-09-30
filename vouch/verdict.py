"""Per-key verdicts: filter candidates by scope/freshness, score them, decide. Pure and deterministic."""
from __future__ import annotations

from .models import (CONFLICTING, POSSIBLY_OUTDATED, SOURCE_TYPE_LABELS, UNSUPPORTED, VERIFIED, Context,
                     Evidence, KeyVerdict)
from .score import months_between, pretty_date, score
from .store import KB


def _stale_reasons(doc, kb: KB) -> list[str]:
    rules, reasons = kb.rules, []
    newer = [d for d in kb.docs.values() if doc.id in d.supersedes]
    if newer:
        reasons.append(f"superseded by {newer[0].title}")
    if doc.valid_to and doc.valid_to < rules["as_of"]:
        reasons.append(f"expired on {doc.valid_to}")
    age = months_between(doc.date, rules["as_of"])
    if age > rules["stale_after_months"]:
        reasons.append(f"{age} months old (older than {rules['stale_after_months']} months)")
    return reasons


def _has_agreement(kb: KB, client: str) -> bool:
    return any(d.source_type == "client_agreement" and d.client == client for d in kb.docs.values())


def _src(e: Evidence) -> str:
    return f"{SOURCE_TYPE_LABELS.get(e.doc.source_type, e.doc.source_type)} “{e.doc.title}”"


def judge(topic: str, condition: str, ctx: Context, kb: KB) -> KeyVerdict:
    kv = KeyVerdict(topic=topic, condition=condition, verdict=UNSUPPORTED)
    in_scope: list[Evidence] = []

    for c in (c for c in kb.claims if c.topic == topic and c.condition == condition):
        doc = kb.docs.get(c.source_id)
        if doc is None:
            continue
        if c.status == "outdated":
            kv.ignored.append(Evidence(c, doc, "ignored", ignore_reason=f"marked outdated by {c.outdated_by} on {pretty_date(c.outdated_at)}"))
        elif c.country != ctx.country:
            kv.ignored.append(Evidence(c, doc, "ignored", ignore_reason=f"applies to {c.country}, not {ctx.country}"))
        elif c.client not in ("all", ctx.client):
            kv.ignored.append(Evidence(c, doc, "ignored", ignore_reason=f"specific to client {c.client}"))
        elif c.status != "confirmed" and (why := _stale_reasons(doc, kb)):
            kv.stale.append(Evidence(c, doc, "stale", ignore_reason="; ".join(why)))
        else:
            in_scope.append(Evidence(c, doc, "in_scope"))

    for e in kv.stale:
        e.score, e.reasons = score(e.claim, e.doc, [], kb.rules, kb.owner_active(e.doc))
        e.reasons.append(f"⚠ {e.ignore_reason}")
    kv.stale.sort(key=lambda e: -e.score)

    if not in_scope and not kv.stale:
        return kv                                                       # ❓ UNSUPPORTED

    if not in_scope:
        best = kv.stale[0]
        kv.verdict, kv.value, kv.supporting, kv.stale = POSSIBLY_OUTDATED, best.claim.value, [best], kv.stale[1:]
        kv.notes.append(f"The only source ({_src(best)}, {pretty_date(best.doc.date)}) is {best.ignore_reason}.")
        if not kb.owner_active(best.doc):
            kv.notes.append(f"Its owner {best.doc.owner} has left — nobody maintains it.")
        return kv                                                       # 🕓 POSSIBLY_OUTDATED

    pairs = [(e.claim, e.doc) for e in in_scope]
    for e in in_scope:
        e.score, e.reasons = score(e.claim, e.doc, pairs, kb.rules, kb.owner_active(e.doc))

    general_values = {e.claim.value for e in in_scope if e.claim.client == "all"}
    for e in in_scope:
        if (e.claim.client != "all" and e.doc.source_type != "client_agreement"
                and general_values - {e.claim.value} and not _has_agreement(kb, e.claim.client)):
            e.reasons.append(f"mentions a client exception, but no agreement document found for {e.claim.client} (+0)")

    groups: dict[str, list[Evidence]] = {}
    for e in sorted(in_scope, key=lambda e: -e.score):
        groups.setdefault(e.claim.value, []).append(e)
    ranked = sorted(groups.items(), key=lambda kv_: -kv_[1][0].score)   # by best score per value

    def verified(value: str) -> KeyVerdict:
        kv.verdict, kv.value = VERIFIED, value
        kv.supporting = groups[value]
        kv.competing = [e for v, es in ranked if v != value for e in es]
        n = len({e.doc.id for e in kv.supporting})
        if n > 1:
            kv.notes.append(f"{n} sources agree.")
        for e in kv.supporting:
            if e.claim.status == "confirmed":
                kv.notes.append(f"Confirmed by {e.claim.confirmed_by} on {pretty_date(e.claim.confirmed_at)}."
                                + (f" Note: “{e.claim.note}”" if e.claim.note else ""))
        for e in kv.ignored:
            if e.claim.status == "outdated" and e.claim.value != value:
                kv.notes.append(f"{SOURCE_TYPE_LABELS.get(e.doc.source_type, e.doc.source_type).capitalize()} "
                                f"({e.claim.value}) marked outdated by {e.claim.outdated_by}.")
        for e in kv.stale:
            if e.claim.value != value:
                kv.notes.append(f"{e.doc.title} stated {e.claim.value} — {e.ignore_reason}.")
        return kv

    if len(ranked) == 1:
        return verified(ranked[0][0])                                   # ✅ one value

    agreement_values = {e.claim.value for e in in_scope
                        if e.doc.source_type == "client_agreement" and e.claim.client == ctx.client}
    if len(agreement_values) == 1:
        value = agreement_values.pop()
        verified(value)
        general = [v for v, es in ranked if v != value and any(e.claim.client == "all" for e in es)]
        kv.notes.insert(0, f"Client agreement for {ctx.client} overrides the general policy"
                           + (f" (general rule: {', '.join(general)})." if general else "."))
        return kv                                                       # ✅ documented client exception

    (top_value, top), (_, second) = ranked[0], ranked[1]
    client_specific_dissent = any(
        e.claim.client == ctx.client and e.claim.client != "all" and e.doc.source_type != "client_agreement"
        for _, es in ranked for e in es                                 # len(ranked) > 1: every value disagrees
    )
    lead = top[0].score - second[0].score
    if not client_specific_dissent and lead >= kb.rules["verified_lead"]:
        verified(top_value)
        for v, es in ranked[1:]:
            kv.notes.append(f"Weaker source: {_src(es[0])} says {v} (score {es[0].score}, {lead}+ points behind).")
        return kv                                                       # ✅ clear lead

    kv.verdict = CONFLICTING
    kv.supporting = top
    kv.competing = [e for _, es in ranked[1:] for e in es]
    if client_specific_dissent:
        kv.notes.append("A client-specific source disagrees with the general rule and no agreement document backs it — "
                        "it might be a legitimate exception, so a human has to decide.")
    else:
        kv.notes.append(f"Sources disagree and the best one leads by only {lead} point(s) "
                        f"(needs {kb.rules['verified_lead']}).")
    return kv                                                           # ⚠️ CONFLICTING
