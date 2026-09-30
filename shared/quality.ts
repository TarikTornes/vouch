// Document quality checks: a transparent checklist score, NOT a probability that
// an answer is correct. Five checks x 20 points. Missing checks earn zero.

export interface QualityInput {
  status: string // document version lifecycle status
  contentHash: string | null
  originalFilename: string | null
  link: string | null
  uploadedByName: string | null
  uploadedAt: string | null
  ownerName: string | null
  sourceUpdated: string | null
  effectiveFrom: string | null
  currencyReviewed: boolean
  reviewedByName: string | null // a human; an LLM extraction can never set this
  reviewedAt: string | null
  claims: { status: string; country: string; client: string }[]
}

export interface QualityCheck {
  key: string
  label: string
  passed: boolean
  evidence: string
}

export interface QualityResult {
  assessed: boolean
  score: number | null
  checks: QualityCheck[]
  note: string
}

export function assessQuality(d: QualityInput): QualityResult {
  if (d.status === 'failed' || d.status === 'rejected') {
    return { assessed: false, score: null, checks: [], note: 'Not assessed — processing failed.' }
  }
  const confirmed = d.claims.filter((c) => c.status === 'confirmed')
  const unknownScope = confirmed.filter((c) => c.country === 'unknown' || c.client === 'unknown')
  const checks: QualityCheck[] = [
    {
      key: 'provenance',
      label: 'Provenance recorded',
      passed: !!d.contentHash && !!(d.originalFilename || d.link) && !!d.uploadedByName,
      evidence: d.contentHash
        ? `SHA-256 ${d.contentHash.slice(0, 12)}…, ${d.originalFilename ? `file “${d.originalFilename}”` : d.link ? `location ${d.link}` : 'no location'}, added by ${d.uploadedByName ?? 'unknown'}${d.uploadedAt ? ` on ${d.uploadedAt.slice(0, 10)}` : ''}`
        : 'No content hash recorded',
    },
    {
      key: 'owner',
      label: 'Responsible owner assigned',
      passed: !!d.ownerName?.trim(),
      evidence: d.ownerName?.trim() ? `Owner: ${d.ownerName}` : 'No owner — nobody is accountable for keeping it current',
    },
    {
      key: 'applicability',
      label: 'Applicability reviewed',
      passed: !!d.reviewedByName && confirmed.length > 0 && unknownScope.length === 0,
      evidence: !d.reviewedByName
        ? 'Scope not yet reviewed by a person'
        : confirmed.length === 0
          ? 'No confirmed claims'
          : unknownScope.length
            ? `${unknownScope.length} of ${confirmed.length} confirmed claims still have unknown country or client scope`
            : `${confirmed.length} confirmed claim${confirmed.length === 1 ? '' : 's'} with known country and client scope`,
    },
    {
      key: 'currency',
      label: 'Currency / effective-date review completed',
      passed: d.currencyReviewed && !!(d.sourceUpdated || d.effectiveFrom),
      evidence: d.currencyReviewed
        ? `Reviewed; ${d.effectiveFrom ? `effective from ${d.effectiveFrom}` : d.sourceUpdated ? `source dated ${d.sourceUpdated}` : 'but no date recorded'}`
        : 'Dates not reviewed',
    },
    {
      key: 'human_review',
      label: 'Claim extraction reviewed by a human',
      passed: !!d.reviewedByName,
      evidence: d.reviewedByName ? `Reviewed by ${d.reviewedByName}${d.reviewedAt ? ` on ${d.reviewedAt.slice(0, 10)}` : ''}` : 'Awaiting human review (automatic extraction cannot mark itself reviewed)',
    },
  ]
  return {
    assessed: true,
    score: checks.filter((c) => c.passed).length * 20,
    checks,
    note: '100% means all five checks are complete — not that a payroll answer is guaranteed correct.',
  }
}

/** Proposed semantic status colours (application colours, not brand colours). */
export const QUALITY_STOPS: [number, string][] = [
  [0, '#7F1D1D'], [25, '#DC2626'], [50, '#EA580C'], [75, '#CA8A04'], [100, '#15803D'],
]

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))

/** Continuous interpolation between the stops. */
export function qualityColor(pct: number): string {
  const p = Math.max(0, Math.min(100, pct))
  for (let i = 1; i < QUALITY_STOPS.length; i++) {
    const [p1, c1] = QUALITY_STOPS[i]
    const [p0, c0] = QUALITY_STOPS[i - 1]
    if (p <= p1) {
      const t = (p - p0) / (p1 - p0)
      const a = hex(c0), b = hex(c1)
      return '#' + a.map((v, j) => Math.round(v + (b[j] - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase()
    }
  }
  return QUALITY_STOPS[QUALITY_STOPS.length - 1][1]
}
