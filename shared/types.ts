// Shared domain types for Vouch (server + browser). All demo data is synthetic.
import type { Freshness } from './freshness'

export type Country = 'BE' | 'NL'
export type ClaimCountry = Country | 'unknown'
export const GENERAL = '*' // claim applies to every client in its country
export const UNKNOWN = 'unknown' // scope not established: never silently widened

export const TOPICS = ['overtime_eligibility', 'overtime_surcharge'] as const
export type Topic = (typeof TOPICS)[number]
export const CONDITIONS = ['saturday', 'sunday', 'public_holiday', 'night'] as const
export type Condition = (typeof CONDITIONS)[number]

export const SOURCE_TYPES = ['Policy document', 'Client conditions sheet', 'Teams message', 'Manual', 'Wiki page', 'Email', 'Agreement', 'Other'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

/** One active document version, as the evidence engine sees it. */
export interface Source {
  id: string // document version id
  documentId: string
  version: number
  title: string
  type: SourceType
  text: string
  updated: string | null // ISO date
  ownerName: string | null
  country: ClaimCountry
  client: string
  link: string
  contentHash: string
}

export interface ClientException {
  label: string
  agreementRef?: string | null
  documentedBy: string | null // document id that supplies the exception, or null if undocumented
}

/** A structured claim tied to an exact excerpt of a source version. */
export interface Claim {
  id: string
  sourceId: string // document version id
  country: ClaimCountry
  client: string // client id, GENERAL, or UNKNOWN
  topic: Topic
  condition: Condition
  value: string
  unit?: string
  effectiveFrom?: string | null
  effectiveTo?: string | null
  excerpt: string
  location?: string
  exception?: ClientException
  duplicateOf?: string
}

export interface Expert {
  id: string
  name: string
  role: string
  country: Country | null
  ownsTopics: Topic[]
}

export interface Client {
  id: string
  name: string
  country: Country
}

export interface Context {
  country: Country
  client: string
}

export interface Intent {
  topic: Topic
  condition: Condition
}

export interface ClaimKey extends Intent {
  country: Country
  client: string
}

export interface ConsideredClaim {
  claimId: string
  sourceId: string
  contentHash: string
}

export interface Resolution {
  id: string
  caseId: string
  key: ClaimKey
  value: string
  acceptedClaimIds: string[]
  outdatedClaimIds: string[]
  considered: ConsideredClaim[]
  reason: string
  reference: string // supporting document or recorded expert statement
  resolvedBy: string
  resolvedByName: string
  resolvedAt: string
  status: 'active' | 'needs_rereview' | 'superseded'
  rereviewReason?: string | null
}

/** Everything the engine needs; loaded from the database on the server. */
export interface KnowledgeBase {
  sources: Source[]
  claims: Claim[]
  experts: Expert[]
  clients: Client[]
  resolutions: Resolution[]
  asOf: string // ISO date that "how old is this evidence" is measured against
}

export type AnswerStatus = 'Supported' | 'Conflicting' | 'Possibly outdated' | 'Unsupported'
export type EvidenceStatus = 'Applicable' | 'Excluded' | 'Marked outdated by expert' | 'Copy' | 'Too old'

export interface Reason {
  kind: 'ok' | 'no' | 'warn' | 'info'
  text: string
}

export interface EvidenceItem {
  claim: Claim
  source: Source
  status: EvidenceStatus
  reasons: Reason[]
  freshness?: Freshness // set for claims in scope (country and client match)
}

export interface ClaimResult {
  key: ClaimKey
  label: string
  status: AnswerStatus
  expertConfirmed?: boolean
  value?: string
  headline: string
  explanation: Reason[]
  evidence: EvidenceItem[]
  resolution?: Resolution
  staleResolution?: Resolution
  expert?: Expert
}

export interface Answer {
  question: string
  context: Context
  recognized: boolean
  unsupportedReason?: string
  claims: ClaimResult[]
}
