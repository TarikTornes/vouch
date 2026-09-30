import { describe, expect, it } from 'vitest'
import { EXAMPLE_QUESTION, fixtureKB, SEED_DOCUMENTS, versionId } from './fixtures'
import { evaluateIntent, evaluateIntents, findResolution, healthReport } from './evidence'
import { assessQuality, qualityColor } from './quality'
import { GENERAL, type Intent, type KnowledgeBase, type Resolution } from './types'

const JANSSENS = { country: 'BE', client: 'janssens' } as const
const MAES = { country: 'BE', client: 'maes' } as const
const SAT_SURCHARGE: Intent = { topic: 'overtime_surcharge', condition: 'saturday' }

function withJanssensResolution(kb: KnowledgeBase = fixtureKB()): KnowledgeBase {
  const res: Resolution = {
    id: 'RES-1', caseId: 'CASE-1',
    key: { ...SAT_SURCHARGE, ...JANSSENS },
    value: '50%', acceptedClaimIds: ['C2'], outdatedClaimIds: ['C4'],
    considered: ['C2', 'C4', 'C5'].map((id) => ({ claimId: id, sourceId: kb.claims.find((c) => c.id === id)!.sourceId, contentHash: 'x' })),
    reason: 'Agreement expired 31 Dec 2025 (fictional).', reference: 'Client file CF-JAN-2025-114 (fictional)',
    resolvedBy: 'anna', resolvedByName: 'Anna Peeters', resolvedAt: '2026-06-15T10:00:00Z', status: 'active',
  }
  return { ...kb, resolutions: [res] }
}

describe('example question for Janssens', () => {
  const answer = evaluateIntents(EXAMPLE_QUESTION, [SAT_SURCHARGE], JANSSENS, fixtureKB())
  const [elig, surcharge] = answer.claims

  it('returns two separate claims: supported eligibility and conflicting surcharge', () => {
    expect(answer.claims).toHaveLength(2)
    expect(elig.status).toBe('Supported')
    expect(elig.headline).toMatch(/qualify as overtime under the supplied client conditions/)
    expect(surcharge.status).toBe('Conflicting')
    expect(surcharge.headline).toMatch(/cannot yet be determined/)
  })

  it('never lets the Dutch source determine a Belgian answer', () => {
    const nl = surcharge.evidence.find((e) => e.source.documentId === 'S5')!
    expect(nl.status).toBe('Excluded')
    expect(nl.reasons.some((r) => r.text.startsWith('Country differs'))).toBe(true)
    expect(surcharge.explanation.map((r) => r.text).join(' ')).not.toContain('40%')
  })

  it('keeps the general Belgian policy alongside the client-specific claim and flags the unverified exception', () => {
    expect(surcharge.evidence.find((e) => e.source.documentId === 'S1')!.status).toBe('Applicable')
    expect(surcharge.evidence.find((e) => e.source.documentId === 'S3')!.status).toBe('Applicable')
    expect(surcharge.explanation.some((r) => r.text.includes('Client exception unverified'))).toBe(true)
  })

  it('does not count the forwarded copy as corroboration', () => {
    expect(surcharge.evidence.find((e) => e.claim.id === 'C5')!.status).toBe('Copy')
  })

  it('routes the conflict to the Belgian policy owner', () => {
    expect(surcharge.expert?.id).toBe('anna')
  })
})

describe('honest unsupported states', () => {
  it('no intents means not recognized and no invented answer', () => {
    const a = evaluateIntents('What is the holiday allowance?', [], JANSSENS, fixtureKB())
    expect(a.recognized).toBe(false)
    expect(a.claims).toHaveLength(0)
  })
  it('returns Unsupported when no applicable evidence matches', () => {
    expect(evaluateIntent({ topic: 'overtime_eligibility', condition: 'sunday' }, JANSSENS, fixtureKB()).status).toBe('Unsupported')
  })
})

describe('unknown scope stays unknown', () => {
  it('a claim with unknown country or client is excluded, never treated as general', () => {
    const kb = fixtureKB()
    kb.claims.push({ id: 'C90', sourceId: versionId('S1'), country: 'unknown', client: GENERAL, topic: 'overtime_surcharge', condition: 'saturday', value: '70%', excerpt: 'x' })
    kb.claims.push({ id: 'C91', sourceId: versionId('S1'), country: 'BE', client: 'unknown', topic: 'overtime_surcharge', condition: 'saturday', value: '80%', excerpt: 'x' })
    const r = evaluateIntent(SAT_SURCHARGE, MAES, kb)
    expect(r.evidence.find((e) => e.claim.id === 'C90')!.status).toBe('Excluded')
    expect(r.evidence.find((e) => e.claim.id === 'C91')!.status).toBe('Excluded')
    expect(r.explanation.map((x) => x.text).join(' ')).not.toMatch(/70%|80%/)
  })
})

describe('scoped resolutions', () => {
  it('a resolution changes the repeated answer and preserves original evidence', () => {
    const r = evaluateIntent(SAT_SURCHARGE, JANSSENS, withJanssensResolution())
    expect(r.status).toBe('Supported')
    expect(r.expertConfirmed).toBe(true)
    expect(r.headline).toBe('50% — expert-confirmed')
    expect(r.evidence.find((e) => e.claim.id === 'C4')!.status).toBe('Marked outdated by expert')
    expect(r.evidence.find((e) => e.claim.id === 'C5')!.status).toBe('Marked outdated by expert')
    expect(r.evidence.find((e) => e.claim.id === 'C4')!.claim.value).toBe('35%')
    expect(r.explanation.some((x) => x.text.includes('no longer applies'))).toBe(true)
  })

  it('does not affect another client or another condition', () => {
    const kb = withJanssensResolution()
    expect(evaluateIntent(SAT_SURCHARGE, MAES, kb).status).toBe('Conflicting')
    expect(evaluateIntent({ topic: 'overtime_surcharge', condition: 'sunday' }, JANSSENS, kb).resolution).toBeUndefined()
  })

  it('cannot override newly relevant evidence it never considered', () => {
    const kb = withJanssensResolution()
    kb.sources.push({ ...kb.sources[0], id: 'S9-v1', documentId: 'S9', title: 'New memo' })
    kb.claims.push({ id: 'C99', sourceId: 'S9-v1', country: 'BE', client: 'janssens', topic: 'overtime_surcharge', condition: 'saturday', value: '60%', excerpt: 'x' })
    const f = findResolution({ ...SAT_SURCHARGE, ...JANSSENS }, kb)
    expect(f.active).toBeUndefined()
    expect(f.unseen).toEqual(['C99'])
    const r = evaluateIntent(SAT_SURCHARGE, JANSSENS, kb)
    expect(r.status).toBe('Conflicting')
    expect(r.explanation.some((x) => x.text.includes('did not consider C99'))).toBe(true)
  })

  it('a resolution awaiting re-review is not applied', () => {
    const kb = withJanssensResolution()
    kb.resolutions[0].status = 'needs_rereview'
    expect(evaluateIntent(SAT_SURCHARGE, JANSSENS, kb).status).toBe('Conflicting')
  })

  it('open-conflict count decreases after resolution', () => {
    expect(healthReport(fixtureKB()).openConflicts).toHaveLength(2)
    const h = healthReport(withJanssensResolution())
    expect(h.openConflicts).toHaveLength(1)
    expect(h.outdatedClaims.map((o) => o.claim.id).sort()).toEqual(['C4', 'C5'])
    expect(healthReport(fixtureKB()).ownerlessSources.map((s) => s.documentId)).toEqual(['S6'])
  })
})

describe('rules that must not decide on their own', () => {
  it('a documented client exception may override the general policy', () => {
    const kb = fixtureKB()
    kb.claims.find((c) => c.id === 'C4')!.exception = { label: 'agreement', documentedBy: 'S2' }
    kb.claims.find((c) => c.id === 'C5')!.exception = { label: 'agreement', documentedBy: 'S2' }
    const r = evaluateIntent(SAT_SURCHARGE, JANSSENS, kb)
    expect(r.status).toBe('Supported')
    expect(r.value).toBe('35%')
  })
  it('a single agreeing source is supported; general claims stay applicable', () => {
    const r = evaluateIntent(SAT_SURCHARGE, { country: 'NL', client: 'devries' }, fixtureKB())
    expect(r.status).toBe('Supported')
    expect(r.value).toBe('40%')
  })
})

describe('fixture integrity', () => {
  it('every claim excerpt is an exact substring of its source text', () => {
    const kb = fixtureKB()
    for (const c of kb.claims) expect(kb.sources.find((s) => s.id === c.sourceId)!.text, c.id).toContain(c.excerpt)
  })
  it('has 6–8 seed documents', () => {
    expect(SEED_DOCUMENTS.length).toBeGreaterThanOrEqual(6)
    expect(SEED_DOCUMENTS.length).toBeLessThanOrEqual(8)
  })
})

describe('document quality checks', () => {
  const base = {
    status: 'active', contentHash: 'abc123abc123abc', originalFilename: 'memo.txt', link: null, uploadedByName: 'Sophie',
    uploadedAt: '2026-06-15', ownerName: 'Anna', sourceUpdated: '2026-05-01', effectiveFrom: null, currencyReviewed: true,
    reviewedByName: 'Sophie', reviewedAt: '2026-06-15', claims: [{ status: 'confirmed', country: 'BE', client: '*' }],
  }
  it('scores 20 points per completed check', () => {
    expect(assessQuality(base).score).toBe(100)
    expect(assessQuality({ ...base, ownerName: null }).score).toBe(80)
  })
  it('an unreviewed LLM extraction earns no human-review or applicability points', () => {
    const q = assessQuality({ ...base, reviewedByName: null, status: 'needs_review' })
    expect(q.checks.find((c) => c.key === 'human_review')!.passed).toBe(false)
    expect(q.checks.find((c) => c.key === 'applicability')!.passed).toBe(false)
  })
  it('unknown scope fails the applicability check; failed processing is not assessed', () => {
    expect(assessQuality({ ...base, claims: [{ status: 'confirmed', country: 'unknown', client: '*' }] }).checks[2].passed).toBe(false)
    expect(assessQuality({ ...base, status: 'failed' }).score).toBeNull()
  })
  it('interpolates colours continuously between the stops', () => {
    expect(qualityColor(0)).toBe('#7F1D1D')
    expect(qualityColor(50)).toBe('#EA580C')
    expect(qualityColor(100)).toBe('#15803D')
    expect(qualityColor(62.5)).not.toBe(qualityColor(50))
  })
})
