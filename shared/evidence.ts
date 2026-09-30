// Evidence logic: applicability filtering, conflict detection, scoped resolutions.
// Pure functions over a KnowledgeBase (loaded from the database on the server).
// The model never runs here: verdicts are computed deterministically.
import {
  GENERAL, UNKNOWN,
  type Answer, type Claim, type ClaimKey, type ClaimResult, type Context, type EvidenceItem,
  type Expert, type Intent, type KnowledgeBase, type Reason, type Resolution, type Source,
} from './types'

export const COUNTRY_NAMES: Record<string, string> = { BE: 'Belgium', NL: 'Netherlands', unknown: 'Unknown country' }
export const countryName = (id: string) => COUNTRY_NAMES[id] ?? id

export function makeLookups(kb: KnowledgeBase) {
  const sources = new Map(kb.sources.map((s) => [s.id, s]))
  const claims = new Map(kb.claims.map((c) => [c.id, c]))
  return {
    sourceById: (id: string): Source => {
      const s = sources.get(id)
      if (!s) throw new Error(`Unknown source ${id}`)
      return s
    },
    claimById: (id: string): Claim | undefined => claims.get(id),
    clientName: (id: string) =>
      id === GENERAL ? 'all clients' : id === UNKNOWN ? 'unknown client scope' : kb.clients.find((c) => c.id === id)?.name ?? id,
  }
}

export const CONDITION_LABEL: Record<string, string> = {
  saturday: 'Saturday', sunday: 'Sunday', public_holiday: 'Public holiday', night: 'Night',
}

export function intentLabel(i: Intent): string {
  const day = CONDITION_LABEL[i.condition]
  return i.topic === 'overtime_eligibility' ? `Do ${day} hours count as overtime?` : `${day} overtime surcharge`
}

export const keyEquals = (a: ClaimKey, b: ClaimKey) =>
  a.topic === b.topic && a.condition === b.condition && a.country === b.country && a.client === b.client

/** The expert who owns a topic in a country (policy owner), from the server-side directory. */
export function routeExpert(key: ClaimKey, experts: Expert[]): Expert | undefined {
  return experts.find((e) => e.country === key.country && e.ownsTopics.includes(key.topic))
}

type Lookups = ReturnType<typeof makeLookups>

function assessClaim(claim: Claim, ctx: Context, resolution: Resolution | undefined, L: Lookups): EvidenceItem {
  const source = L.sourceById(claim.sourceId)
  const reasons: Reason[] = []
  let status: EvidenceItem['status'] = 'Applicable'

  // 1. Applicability first: country, then client. Unknown scope is never widened.
  if (claim.country === UNKNOWN) {
    status = 'Excluded'
    reasons.push({ kind: 'no', text: 'Country unknown — scope was not established, so it cannot decide this answer' })
  } else if (claim.country !== ctx.country) {
    status = 'Excluded'
    reasons.push({ kind: 'no', text: `Country differs (${countryName(claim.country)}, question is about ${countryName(ctx.country)})` })
  } else {
    reasons.push({ kind: 'ok', text: 'Country matches' })
    if (claim.client === GENERAL) {
      reasons.push({ kind: 'ok', text: `General ${countryName(claim.country)} scope — applies to every client, including ${L.clientName(ctx.client)}` })
    } else if (claim.client === UNKNOWN) {
      status = 'Excluded'
      reasons.push({ kind: 'no', text: 'Client scope unknown — not treated as general or client-specific' })
    } else if (claim.client === ctx.client) {
      reasons.push({ kind: 'ok', text: 'Client matches' })
    } else {
      status = 'Excluded'
      reasons.push({ kind: 'no', text: `Different client (${L.clientName(claim.client)})` })
    }
  }

  if (claim.exception) {
    reasons.push(
      claim.exception.documentedBy
        ? { kind: 'ok', text: `Client exception documented in ${claim.exception.documentedBy}` }
        : { kind: 'warn', text: `Client exception unverified — mentions “${claim.exception.label}” but it is not in the sources` },
    )
  }

  if (status !== 'Excluded' && resolution) {
    const outdated = resolution.outdatedClaimIds.includes(claim.id) ||
      (claim.duplicateOf !== undefined && resolution.outdatedClaimIds.includes(claim.duplicateOf))
    if (outdated) {
      status = 'Marked outdated by expert'
      reasons.push({ kind: 'no', text: `Marked outdated by ${resolution.resolvedByName} (${resolution.id})` })
    } else if (resolution.acceptedClaimIds.includes(claim.id)) {
      reasons.push({ kind: 'ok', text: `Confirmed by ${resolution.resolvedByName} (${resolution.id})` })
    }
  }

  if (status === 'Applicable' && claim.duplicateOf) {
    status = 'Copy'
    const orig = L.claimById(claim.duplicateOf)
    reasons.push({ kind: 'info', text: `Repeats ${claim.duplicateOf}${orig ? ` (${orig.sourceId})` : ''} — not independent corroboration` })
  }

  return { claim, source, status, reasons }
}

function supportedHeadline(key: ClaimKey, value: string, applicable: Claim[]): string {
  const day = CONDITION_LABEL[key.condition]
  if (key.topic === 'overtime_eligibility') {
    const clientSpecific = applicable.some((c) => c.client !== GENERAL)
    return value === 'qualifies'
      ? `${day} hours qualify as overtime ${clientSpecific ? 'under the supplied client conditions' : 'under the general policy'}.`
      : `${day} hours do not qualify as overtime.`
  }
  return `A ${value} surcharge applies to ${day.toLowerCase()} overtime.`
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)]
const ORDER = ['Applicable', 'Copy', 'Marked outdated by expert', 'Excluded']

/** Claims that are in scope for a key (not excluded), ignoring any resolution. */
export function inScopeClaims(key: ClaimKey, kb: KnowledgeBase): EvidenceItem[] {
  const L = makeLookups(kb)
  return kb.claims
    .filter((c) => c.topic === key.topic && c.condition === key.condition)
    .map((c) => assessClaim(c, key, undefined, L))
    .filter((e) => e.status !== 'Excluded')
}

/**
 * A resolution applies only to its exact key, only while active, and only if it
 * considered every claim that is currently in scope. It cannot override evidence it never saw.
 */
export function findResolution(key: ClaimKey, kb: KnowledgeBase): { active?: Resolution; stale?: Resolution; unseen: string[] } {
  const r = kb.resolutions.find((x) => keyEquals(x.key, key) && x.status !== 'superseded')
  if (!r) return { unseen: [] }
  const considered = new Set(r.considered.map((c) => c.claimId))
  const unseen = inScopeClaims(key, kb).map((e) => e.claim.id).filter((id) => !considered.has(id))
  if (r.status === 'active' && unseen.length === 0) return { active: r, unseen }
  return { stale: r, unseen }
}

export function evaluateIntent(intent: Intent, ctx: Context, kb: KnowledgeBase): ClaimResult {
  const L = makeLookups(kb)
  const key: ClaimKey = { ...intent, country: ctx.country, client: ctx.client }
  const label = intentLabel(intent)
  // Compare only claims whose topic and condition match.
  const candidates = kb.claims.filter((c) => c.topic === intent.topic && c.condition === intent.condition)
  const { active: resolution, stale, unseen } = findResolution(key, kb)
  const evidence = candidates
    .map((c) => assessClaim(c, ctx, resolution, L))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const independent = evidence.filter((e) => e.status === 'Applicable')
  const copies = evidence.filter((e) => e.status === 'Copy')
  const base = { key, label, evidence }
  const staleNote: Reason[] = stale
    ? [{
        kind: 'warn',
        text: stale.status === 'needs_rereview'
          ? `Earlier resolution ${stale.id} is awaiting re-review${stale.rereviewReason ? `: ${stale.rereviewReason}` : ''}. It is not applied.`
          : `Earlier resolution ${stale.id} did not consider ${unseen.join(', ')}. It is not applied until an expert re-reviews it.`,
      }]
    : []

  if (resolution) {
    const outdated = evidence.filter((e) => e.status === 'Marked outdated by expert')
    const accepted = resolution.acceptedClaimIds.map((id) => L.claimById(id)?.sourceId).filter(Boolean)
    const explanation: Reason[] = [
      { kind: 'ok', text: `Resolved by policy owner ${resolution.resolvedByName} on ${resolution.resolvedAt.slice(0, 10)} (${resolution.id})${accepted.length ? `, against ${accepted.join(', ')}` : ''}` },
      { kind: 'info', text: `Why: ${resolution.reason}` },
      { kind: 'info', text: `Supporting reference: ${resolution.reference}` },
      ...uniq(outdated.map((e) => e.claim.duplicateOf ?? e.claim.id)).map((id): Reason => {
        const c = L.claimById(id)
        const s = c ? L.sourceById(c.sourceId) : undefined
        return { kind: 'no', text: `The older ${s?.type ?? 'source'} claim (${c?.value ?? id}${s?.updated ? `, ${s.updated.slice(0, 7)}` : ''}) no longer applies — marked outdated by the expert${outdated.length > 1 ? '; its copies are outdated too' : ''}.` }
      }),
    ]
    const resolver = kb.experts.find((e) => e.id === resolution.resolvedBy)
    return { ...base, status: 'Supported', expertConfirmed: true, value: resolution.value, headline: `${resolution.value} — expert-confirmed`, explanation, resolution, expert: resolver }
  }

  if (independent.length === 0) {
    const excluded = evidence.filter((e) => e.status === 'Excluded').length
    return {
      ...base, status: 'Unsupported', staleResolution: stale,
      headline: 'No applicable evidence in the active sources.',
      explanation: [
        { kind: 'no', text: 'No active source matching this country, client, topic and condition was found.' },
        ...(excluded ? [{ kind: 'info' as const, text: `${excluded} source claim${excluded === 1 ? ' was' : 's were'} on this topic but excluded as not applicable.` }] : []),
        ...staleNote,
      ],
      expert: routeExpert(key, kb.experts),
    }
  }

  const values = uniq(independent.map((e) => e.claim.value))
  const copyNote: Reason[] = copies.length
    ? [{ kind: 'info', text: `${copies.length} repeated ${copies.length === 1 ? 'copy' : 'copies'} ignored — repetition is not independent corroboration.` }]
    : []

  if (values.length === 1) {
    const unverified = independent.filter((e) => e.claim.exception && !e.claim.exception.documentedBy)
    return {
      ...base, status: 'Supported', value: values[0], staleResolution: stale,
      headline: supportedHeadline(key, values[0], independent.map((e) => e.claim)),
      explanation: [
        { kind: 'ok', text: independent.length === 1 ? '1 applicable source; no other applicable source disagrees.' : `${independent.length} independent applicable sources agree.` },
        ...copyNote,
        ...unverified.map((e): Reason => ({ kind: 'warn', text: `Rests on an unverified client exception (${e.claim.exception!.label}).` })),
        ...(independent.length === 1 && !independent[0].source.ownerName
          ? [{ kind: 'warn' as const, text: 'Single source with no owner — nobody is accountable for keeping it current.' }]
          : []),
        ...staleNote,
      ],
    }
  }

  // Values differ. A client-specific claim may override the general rule only if its exception is documented.
  const clientSpecific = independent.filter((e) => e.claim.client !== GENERAL)
  const csValues = uniq(clientSpecific.map((e) => e.claim.value))
  if (clientSpecific.length && csValues.length === 1 && clientSpecific.every((e) => e.claim.exception?.documentedBy)) {
    return {
      ...base, status: 'Supported', value: csValues[0], staleResolution: stale,
      headline: supportedHeadline(key, csValues[0], clientSpecific.map((e) => e.claim)),
      explanation: [
        { kind: 'ok', text: `Documented client exception overrides the general rule (${clientSpecific[0].claim.exception!.documentedBy}).` },
        ...copyNote,
        ...staleNote,
      ],
    }
  }

  const expert = routeExpert(key, kb.experts)
  return {
    ...base, status: 'Conflicting', staleResolution: stale,
    headline: `The applicable ${key.topic === 'overtime_surcharge' ? 'surcharge' : 'rule'} cannot yet be determined.`,
    explanation: [
      { kind: 'warn', text: `Applicable sources disagree: ${values.map((v) => `${v} (${independent.filter((e) => e.claim.value === v).map((e) => e.source.documentId).join(', ')})`).join(' vs ')}.` },
      ...independent
        .filter((e) => e.claim.exception && !e.claim.exception.documentedBy)
        .map((e): Reason => ({ kind: 'warn', text: `Client exception unverified: ${e.source.documentId} mentions “${e.claim.exception!.label}” without supplying it.` })),
      ...copyNote,
      ...staleNote,
      { kind: 'info', text: 'A newer date or an active owner does not settle which value is correct — an expert must decide.' },
      ...(expert ? [{ kind: 'info' as const, text: `Can resolve: ${expert.name}, ${expert.role}.` }] : []),
    ],
    expert,
  }
}

/** Surcharge questions presuppose eligibility, so both claims are evaluated. */
export function expandIntents(intents: Intent[]): Intent[] {
  const out: Intent[] = []
  const add = (i: Intent) => { if (!out.some((o) => o.topic === i.topic && o.condition === i.condition)) out.push(i) }
  for (const i of intents) {
    if (i.topic === 'overtime_surcharge') add({ topic: 'overtime_eligibility', condition: i.condition })
    add(i)
  }
  return out
}

export function evaluateIntents(question: string, intents: Intent[], ctx: Context, kb: KnowledgeBase): Answer {
  const asked = (i: Intent) => intents.some((x) => x.topic === i.topic && x.condition === i.condition)
  // An implied eligibility check is shown only when there is evidence about it; explicitly asked claims are always shown.
  const claims = expandIntents(intents).map((i) => evaluateIntent(i, ctx, kb)).filter((r) => asked(r.key) || r.status !== 'Unsupported')
  return { question, context: ctx, recognized: intents.length > 0, claims }
}

// ---- Knowledge health: derived from actual state ----

export interface HealthReport {
  openConflicts: ClaimResult[]
  outdatedClaims: { claim: Claim; resolution: Resolution }[]
  ownerlessSources: Source[]
  staleResolutions: Resolution[]
}

export function healthReport(kb: KnowledgeBase): HealthReport {
  const intents = uniq(kb.claims.map((c) => `${c.topic}|${c.condition}`)).map((s) => {
    const [topic, condition] = s.split('|')
    return { topic, condition } as Intent
  })
  const openConflicts = kb.clients.flatMap((client) =>
    intents.map((i) => evaluateIntent(i, { country: client.country, client: client.id }, kb)),
  ).filter((r) => r.status === 'Conflicting')
  const active = kb.resolutions.filter((r) => r.status === 'active')
  const outdatedClaims = active.flatMap((r) =>
    kb.claims.filter((c) => r.outdatedClaimIds.includes(c.id) || (c.duplicateOf && r.outdatedClaimIds.includes(c.duplicateOf)))
      .map((claim) => ({ claim, resolution: r })),
  )
  return {
    openConflicts,
    outdatedClaims,
    ownerlessSources: kb.sources.filter((s) => !s.ownerName),
    staleResolutions: kb.resolutions.filter((r) => r.status === 'needs_rereview'),
  }
}
