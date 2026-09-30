// Freshness: how old the evidence is. Deterministic, relative to the knowledge base's "as of" date.
// Old evidence is still shown (with its age), but evidence past the stale limit never decides an answer.
import type { Reason } from './types'

export const FRESHNESS_RULES = {
  currentMonths: 12, // updated within a year: current
  staleMonths: 24,   // older than two years: too old to decide an answer
} as const

export type FreshnessLevel = 'current' | 'aging' | 'stale' | 'expired' | 'undated'

export interface Freshness {
  level: FreshnessLevel
  ageMonths: number | null
  label: string // short, for badges: "4 months old"
  reason: Reason // full sentence for the evidence card
}

export const todayIso = () => new Date().toISOString().slice(0, 10)

/** Whole months from `from` to `to` (ISO dates or timestamps). */
export function monthsBetween(from: string, to: string): number {
  const a = new Date(from.slice(0, 10) + 'T00:00:00Z')
  const b = new Date(to.slice(0, 10) + 'T00:00:00Z')
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())
  if (b.getUTCDate() < a.getUTCDate()) m -= 1
  return Math.max(0, m)
}

export function ageText(months: number): string {
  if (months < 1) return 'less than a month old'
  if (months < 24) return `${months} month${months === 1 ? '' : 's'} old`
  const y = Math.floor(months / 12)
  return `${y} year${y === 1 ? '' : 's'} old (${months} months)`
}

const monthYear = (iso: string) =>
  new Date(iso.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })

export function assessFreshness(updated: string | null, effectiveTo: string | null | undefined, asOf: string): Freshness {
  if (effectiveTo && effectiveTo.slice(0, 10) < asOf.slice(0, 10)) {
    return {
      level: 'expired', ageMonths: updated ? monthsBetween(updated, asOf) : null, label: 'expired',
      reason: { kind: 'no', text: `Expired on ${effectiveTo.slice(0, 10)} — no longer valid, not used to decide` },
    }
  }
  if (!updated) {
    return {
      level: 'undated', ageMonths: null, label: 'date unknown',
      reason: { kind: 'warn', text: 'No update date — freshness unknown' },
    }
  }
  const age = monthsBetween(updated, asOf)
  if (age > FRESHNESS_RULES.staleMonths) {
    return {
      level: 'stale', ageMonths: age, label: ageText(age),
      reason: { kind: 'no', text: `Last updated ${monthYear(updated)} — ${ageText(age)}, older than ${FRESHNESS_RULES.staleMonths} months: too old to decide an answer` },
    }
  }
  if (age > FRESHNESS_RULES.currentMonths) {
    return {
      level: 'aging', ageMonths: age, label: ageText(age),
      reason: { kind: 'warn', text: `Updated ${monthYear(updated)} — ${ageText(age)}, due for review` },
    }
  }
  return {
    level: 'current', ageMonths: age, label: ageText(age),
    reason: { kind: 'ok', text: `Current — updated ${monthYear(updated)} (${ageText(age)})` },
  }
}

export const isTooOld = (f: Freshness) => f.level === 'stale' || f.level === 'expired'
