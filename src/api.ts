// Thin API client. Every mutation carries the CSRF header; the browser sends Origin.
import type { Answer, ClaimKey, ClaimResult, Resolution } from '../shared/types'
import type { QualityResult } from '../shared/quality'

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Vouch-CSRF': '1' }
  let body: BodyInit | undefined
  if (opts.form) body = opts.form
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  let r: Response
  try {
    r = await fetch(`/api${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin' })
  } catch {
    throw new ApiError('Cannot reach the Vouch server.', 0)
  }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${r.status})`, r.status)
  return data as T
}

export interface Me { id: string; displayName: string; role: 'consultant' | 'expert'; roleTitle: string; country: string | null }
export interface ClientRow { id: string; name: string; country: 'BE' | 'NL' }
export interface Interpreter { kind: 'claude' | 'rules'; model: string | null }
export interface Meta { clients: ClientRow[]; countries: { id: string; name: string }[]; interpreter: Interpreter; externalEmail: boolean }

export interface EmailStatus {
  id: string; kind: string; recipient: string; status: 'queued' | 'sending' | 'accepted' | 'failed'
  provider_message_id: string | null; attempts: number; last_error: string | null; updated_at: string
}

export interface ClaimRow {
  id: string; topic: string; condition: string; country: string; client: string; scopeSource: string | null
  value: string; unit: string | null; effectiveFrom: string | null; effectiveTo: string | null; excerpt: string; location: string | null
  exceptionLabel: string | null; exceptionAgreementRef: string | null; exceptionDocumentedBy: string | null; duplicateOf: string | null
  origin: 'llm' | 'seed' | 'human'; status: 'proposed' | 'confirmed' | 'rejected' | 'invalid'; invalidReason: string | null
  reviewedBy: string | null; reviewedAt: string | null
}

export interface VersionView {
  id: string; documentId: string; version: number; status: string; failureReason: string | null
  title: string; sourceType: string; ownerName: string | null; country: string; client: string; link: string | null
  contentHash: string; originalFilename: string | null; sizeBytes: number | null; mimeType: string | null
  sourceUpdated: string | null; effectiveFrom: string | null; effectiveTo: string | null
  uploadedBy: string | null; uploadedAt: string; llmModel: string | null; processingStartedAt: string | null; processingFinishedAt: string | null
  reviewedBy: string | null; reviewedAt: string | null; currencyReviewed: boolean
  claimCounts: { total: number; confirmed: number; proposed: number; invalid: number }
  quality: QualityResult
  text?: string
  claims?: ClaimRow[]
}

export interface QuestionResponse { id: string; answer: Answer; interpretation: { requested_information: string; in_domain: boolean }; interpreter: Interpreter }

export interface CaseDetail {
  id: string; status: 'open' | 'info_requested' | 'resolved' | 'unresolved'; rowVersion: number; label: string; question: string; key: ClaimKey
  clientName: string; countryName: string; openedReason: 'consultant_request' | 'rereview'; rereviewOf: string | null
  requestedBy: string | null; assignedTo: string; assignedToId: string; requestedById: string | null; createdAt: string; updatedAt: string
  snapshot: ClaimResult | null
  evidenceVersions: { claimId: string; sourceId: string; documentId: string; version: number; contentHash: string; value: string; status: string }[]
  current: ClaimResult
  events: { kind: string; message: string | null; created_at: string; actor: string | null }[]
  emails: EmailStatus[]
  resolution: Resolution | null
  activeDocuments: { documentId: string; title: string; versionId: string }[]
}

export interface CaseRow {
  id: string; status: string; label: string; question: string; country: string; clientName: string; openedReason: string
  createdAt: string; updatedAt: string; emailStatus: string | null; mine: 'assigned' | 'requested'
}

export interface NotificationRow { id: number; kind: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null }
