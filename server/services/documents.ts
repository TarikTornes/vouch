// Manual document ingestion: text extraction, live claim extraction via Claude,
// traceability checks, human review, activation, and re-review triggers.
import crypto from 'node:crypto'
import path from 'node:path'
import { GENERAL, UNKNOWN, type Condition, type Topic } from '../../shared/types'
import type { Config } from '../config'
import { nextId, nowIso, tx, type DB } from '../db'
import type { LlmClient } from './llm'

export class UserError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const normalizeText = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim()

/** Extract plain text from an uploaded .txt, .md or text-based .pdf, within bounds. */
export async function extractUploadText(file: { buffer: Buffer; originalname: string; size: number }, config: Config): Promise<string> {
  if (file.size > config.limits.maxUploadBytes) throw new UserError(`File too large (max ${config.limits.maxUploadBytes / 1_000_000} MB).`, 413)
  const ext = path.extname(file.originalname).toLowerCase()
  let text: string
  if (ext === '.txt' || ext === '.md') {
    if (file.buffer.includes(0)) throw new UserError('This file looks binary, not text.')
    text = file.buffer.toString('utf8')
  } else if (ext === '.pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf')
    try {
      const pdf = await getDocumentProxy(new Uint8Array(file.buffer))
      text = (await extractText(pdf, { mergePages: true })).text as string
    } catch {
      throw new UserError('Could not read this PDF. Paste the text instead.')
    }
    if (text.replace(/\s/g, '').length < 40) {
      throw new UserError('This PDF has no extractable text (it is probably scanned). OCR is not available in this prototype — use “Paste text” instead.')
    }
  } else {
    throw new UserError('Unsupported file type. Upload .txt, .md or a text-based .pdf, or paste the text.', 415)
  }
  return checkText(text, config)
}

export function checkText(raw: string, config: Config): string {
  const text = normalizeText(raw)
  if (text.length < 20) throw new UserError('The document text is too short to process.')
  if (text.length > config.limits.maxTextChars) throw new UserError(`The document text is too long (${text.length} characters; max ${config.limits.maxTextChars}).`, 413)
  return text
}

export interface NewDocumentInput {
  documentId?: string // set for a new version of an existing document
  title: string
  sourceType: string
  ownerName: string | null
  country: 'BE' | 'NL' | 'unknown'
  client: string // client id, GENERAL, or UNKNOWN
  link: string | null
  sourceUpdated: string | null
  effectiveFrom: string | null
  effectiveTo: string | null
  text: string
  originalFilename: string | null
  mimeType: string | null
  sizeBytes: number | null
}

/** Create a document (or new version) in "uploaded" state. Identical content is refused. */
export function createVersion(db: DB, userId: string, input: NewDocumentInput): { documentId: string; versionId: string } {
  const hash = sha256(input.text)
  return tx(db, () => {
    const same = db.prepare(`SELECT v.id, v.document_id, v.version FROM document_versions v
      WHERE v.content_hash = ? AND v.status NOT IN ('failed', 'rejected')`).get(hash) as { id: string; document_id: string; version: number } | undefined
    if (same) {
      throw new UserError(same.document_id === input.documentId
        ? `No change: this text is identical to ${same.document_id} v${same.version}.`
        : `Identical content is already stored as ${same.document_id} v${same.version}. Repeated copies are not independent corroboration, so it was not added again.`, 409)
    }
    let documentId = input.documentId
    if (documentId) {
      const doc = db.prepare('SELECT id FROM documents WHERE id = ?').get(documentId)
      if (!doc) throw new UserError('Document not found.', 404)
      const pending = db.prepare(`SELECT id FROM document_versions WHERE document_id = ? AND status IN ('uploaded', 'processing', 'needs_review')`).get(documentId)
      if (pending) throw new UserError('This document already has a version waiting for processing or review.', 409)
      db.prepare('UPDATE documents SET title = ?, source_type = ?, owner_name = ?, country = ?, client = ?, link = ? WHERE id = ?')
        .run(input.title, input.sourceType, input.ownerName, input.country, input.client, input.link, documentId)
    } else {
      documentId = nextId(db, 'documents', 'S', 0)
      db.prepare('INSERT INTO documents (id, title, source_type, owner_name, country, client, link, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(documentId, input.title, input.sourceType, input.ownerName, input.country, input.client, input.link, userId, nowIso())
    }
    const version = ((db.prepare('SELECT MAX(version) m FROM document_versions WHERE document_id = ?').get(documentId) as { m: number | null }).m ?? 0) + 1
    const versionId = `${documentId}-v${version}`
    db.prepare(`INSERT INTO document_versions (id, document_id, version, status, text, content_hash, original_filename, mime_type, size_bytes,
        source_updated, effective_from, effective_to, uploaded_by, uploaded_at) VALUES (?, ?, ?, 'uploaded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(versionId, documentId, version, input.text, hash, input.originalFilename, input.mimeType, input.sizeBytes,
        input.sourceUpdated, input.effectiveFrom, input.effectiveTo, userId, nowIso())
    return { documentId, versionId }
  })
}

/** Find an excerpt in the text: exact first, then whitespace-insensitive. Returns char offsets. */
export function locateExcerpt(text: string, excerpt: string): { start: number; end: number } | null {
  const ex = excerpt.trim()
  if (!ex) return null
  const i = text.indexOf(ex)
  if (i >= 0) return { start: i, end: i + ex.length }
  const pattern = ex.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
  const m = new RegExp(pattern).exec(text)
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

const locationLabel = (text: string, pos: { start: number; end: number }) =>
  `line ${text.slice(0, pos.start).split('\n').length}, characters ${pos.start}–${pos.end}`

function mapClient(db: DB, name: string | null): string {
  if (!name) return UNKNOWN
  const clients = db.prepare('SELECT id, name FROM clients').all() as { id: string; name: string }[]
  const n = name.toLowerCase()
  const hit = clients.find((c) => n.includes(c.name.toLowerCase()) || c.name.toLowerCase().includes(n) || n.includes(c.name.split(' ')[0].toLowerCase()))
  return hit?.id ?? UNKNOWN
}

/** Run live extraction for one version. Never throws: failures become an explicit "failed" state. */
export async function processVersion(db: DB, llm: LlmClient, versionId: string): Promise<void> {
  const v = db.prepare(`SELECT v.*, d.title, d.source_type, d.country AS doc_country, d.client AS doc_client
    FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = ?`).get(versionId) as Record<string, string> | undefined
  if (!v) return
  const started = db.prepare(`UPDATE document_versions SET status = 'processing', processing_started_at = ?, failure_reason = NULL, llm_model = ?
    WHERE id = ? AND status IN ('uploaded', 'failed')`).run(nowIso(), llm.model, versionId)
  if (started.changes === 0) return
  try {
    const clientNames = (db.prepare('SELECT name FROM clients').all() as { name: string }[]).map((c) => c.name)
    const extraction = await llm.extractClaims({ title: v.title, sourceType: v.source_type, text: v.text, clientNames })
    const now = nowIso()
    tx(db, () => {
      db.prepare('DELETE FROM claims WHERE version_id = ?').run(versionId)
      for (const c of extraction.claims) {
        const pos = locateExcerpt(v.text, c.excerpt)
        // Unknown stays unknown unless a person declared the document's scope in the metadata.
        let country: string = c.country
        let countrySource = c.country === UNKNOWN ? 'unknown' : 'document text'
        if (country === UNKNOWN && v.doc_country !== UNKNOWN) { country = v.doc_country; countrySource = 'document metadata (entered by uploader)' }
        let client: string = c.client_scope === 'general' ? GENERAL : c.client_scope === 'specific_client' ? mapClient(db, c.client_name) : UNKNOWN
        let clientSource = c.client_scope === 'unknown' ? 'unknown' : client === UNKNOWN ? `client “${c.client_name}” not in directory` : 'document text'
        if (client === UNKNOWN && c.client_scope === 'unknown' && v.doc_client !== UNKNOWN) { client = v.doc_client; clientSource = 'document metadata (entered by uploader)' }
        db.prepare(`INSERT INTO claims (id, version_id, topic, condition, country, client, scope_source, value, unit, effective_from, effective_to,
            excerpt, location, exception_label, exception_agreement_ref, origin, status, invalid_reason, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'llm', ?, ?, ?)`)
          .run(nextId(db, 'claims', 'C', 0), versionId, c.topic, c.condition, country, client, `country: ${countrySource}; client: ${clientSource}`,
            c.value.trim(), c.unit, c.effective_from, c.effective_to, pos ? v.text.slice(pos.start, pos.end) : c.excerpt,
            pos ? locationLabel(v.text, pos) : null,
            c.exception_claimed ? (c.exception_description || 'Claimed exception') : null, c.exception_claimed ? c.referenced_agreement : null,
            pos ? 'proposed' : 'invalid', pos ? null : 'Excerpt not found in the document text — rejected for traceability', now)
      }
      db.prepare(`UPDATE document_versions SET status = 'needs_review', processing_finished_at = ?, failure_reason = ? WHERE id = ?`)
        .run(now, extraction.claims.length === 0 ? `No in-domain claims found${extraction.note ? `: ${extraction.note}` : ''}` : null, versionId)
    })
  } catch (e) {
    db.prepare(`UPDATE document_versions SET status = 'failed', processing_finished_at = ?, failure_reason = ? WHERE id = ?`)
      .run(nowIso(), (e as Error).message || 'Processing failed', versionId)
  }
}

/** Versions left "processing" by a restart become failed (retryable). */
export function recoverProcessing(db: DB) {
  db.prepare(`UPDATE document_versions SET status = 'failed', failure_reason = 'Processing interrupted by a server restart — retry' WHERE status IN ('processing', 'uploaded')`).run()
}

export interface ClaimReview {
  status: 'confirmed' | 'rejected'
  topic?: Topic
  condition?: Condition
  country?: 'BE' | 'NL' | 'unknown'
  client?: string
  value?: string
  effectiveFrom?: string | null
  effectiveTo?: string | null
  excerpt?: string
  exceptionLabel?: string | null
  exceptionDocumentedBy?: string | null
}

export function reviewClaim(db: DB, userId: string, claimId: string, r: ClaimReview) {
  const row = db.prepare(`SELECT c.*, v.status AS version_status, v.text FROM claims c JOIN document_versions v ON v.id = c.version_id WHERE c.id = ?`)
    .get(claimId) as Record<string, string> | undefined
  if (!row) throw new UserError('Claim not found.', 404)
  if (row.version_status !== 'needs_review') throw new UserError('Claims can only be changed while the document version is in review.', 409)
  let excerpt = row.excerpt
  let location = row.location
  let status: string = r.status
  if (r.excerpt !== undefined && r.excerpt !== row.excerpt) {
    const pos = locateExcerpt(row.text, r.excerpt)
    if (!pos) throw new UserError('The corrected excerpt was not found in the document text.')
    excerpt = row.text.slice(pos.start, pos.end)
    location = locationLabel(row.text, pos)
  } else if (row.status === 'invalid' && r.status === 'confirmed') {
    throw new UserError('This claim’s excerpt is not in the document. Correct the excerpt before confirming.')
  }
  if (r.exceptionDocumentedBy) {
    const doc = db.prepare(`SELECT 1 FROM document_versions WHERE document_id = ? AND status = 'active'`).get(r.exceptionDocumentedBy)
    if (!doc) throw new UserError(`Exception can only be marked documented by an active document; ${r.exceptionDocumentedBy} is not one.`)
  }
  db.prepare(`UPDATE claims SET status = ?, topic = ?, condition = ?, country = ?, client = ?, value = ?, effective_from = ?, effective_to = ?,
      excerpt = ?, location = ?, exception_label = ?, exception_documented_by = ?, invalid_reason = NULL, reviewed_by = ?, reviewed_at = ?,
      scope_source = CASE WHEN ? THEN 'reviewed by consultant' ELSE scope_source END WHERE id = ?`)
    .run(status, r.topic ?? row.topic, r.condition ?? row.condition, r.country ?? row.country, r.client ?? row.client, (r.value ?? row.value).trim(),
      r.effectiveFrom === undefined ? row.effective_from : r.effectiveFrom, r.effectiveTo === undefined ? row.effective_to : r.effectiveTo,
      excerpt, location, r.exceptionLabel === undefined ? row.exception_label : r.exceptionLabel,
      r.exceptionDocumentedBy === undefined ? row.exception_documented_by : r.exceptionDocumentedBy, userId, nowIso(),
      r.country !== undefined || r.client !== undefined ? 1 : 0, claimId)
}

/** Activate a reviewed version. Supersedes the previous version and flags duplicate claims. */
export function activateVersion(db: DB, userId: string, versionId: string, opts: { currencyReviewed: boolean }) {
  return tx(db, () => {
    const v = db.prepare('SELECT * FROM document_versions WHERE id = ?').get(versionId) as Record<string, string> | undefined
    if (!v) throw new UserError('Version not found.', 404)
    if (v.status !== 'needs_review') throw new UserError(`Only a version in review can be activated (this one is ${v.status}).`, 409)
    const claims = db.prepare('SELECT * FROM claims WHERE version_id = ?').all(versionId) as Record<string, string>[]
    if (claims.some((c) => c.status === 'proposed')) throw new UserError('Confirm or reject every extracted claim before activating.')
    if (!claims.some((c) => c.status === 'confirmed')) throw new UserError('At least one confirmed claim is needed to activate. Reject the version instead if nothing applies.')
    const now = nowIso()
    db.prepare(`UPDATE document_versions SET status = 'superseded' WHERE document_id = ? AND status = 'active'`).run(v.document_id)
    db.prepare(`UPDATE document_versions SET status = 'active', reviewed_by = ?, reviewed_at = ?, currency_reviewed = ? WHERE id = ?`)
      .run(userId, now, opts.currencyReviewed ? 1 : 0, versionId)
    // Repeated copies of an existing claim in another document are marked as copies, not corroboration.
    for (const c of claims.filter((x) => x.status === 'confirmed')) {
      const orig = db.prepare(`SELECT c.id FROM claims c JOIN document_versions v ON v.id = c.version_id
          WHERE v.status = 'active' AND v.document_id != ? AND c.status = 'confirmed' AND c.duplicate_of IS NULL
          AND c.topic = ? AND c.condition = ? AND c.value = ? AND lower(trim(c.excerpt)) = lower(trim(?)) LIMIT 1`)
        .get(v.document_id, c.topic, c.condition, c.value, c.excerpt) as { id: string } | undefined
      if (orig) db.prepare('UPDATE claims SET duplicate_of = ? WHERE id = ?').run(orig.id, c.id)
    }
  })
}

export function rejectVersion(db: DB, userId: string, versionId: string, reason: string) {
  const r = db.prepare(`UPDATE document_versions SET status = 'rejected', failure_reason = ?, reviewed_by = ?, reviewed_at = ?
    WHERE id = ? AND status IN ('needs_review', 'failed')`).run(reason || 'Rejected by consultant', userId, nowIso(), versionId)
  if (r.changes === 0) throw new UserError('Only a version in review or failed can be rejected.', 409)
}

/** Without an LLM there is no automatic extraction: the version goes straight to manual review. */
export function skipExtraction(db: DB, versionId: string) {
  db.prepare(`UPDATE document_versions SET status = 'needs_review', llm_model = NULL, processing_started_at = ?, processing_finished_at = ?,
    failure_reason = 'No LLM connected: no automatic extraction was run. Add the claims manually from the text.' WHERE id = ? AND status IN ('uploaded', 'failed')`)
    .run(nowIso(), nowIso(), versionId)
}

export interface ManualClaim {
  topic: Topic; condition: Condition; country: 'BE' | 'NL' | 'unknown'; client: string; value: string; excerpt: string
  effectiveFrom: string | null; effectiveTo: string | null; exceptionLabel: string | null; exceptionAgreementRef: string | null; exceptionDocumentedBy: string | null
}

/** A consultant enters a claim by hand. The excerpt must appear verbatim in the stored text. */
export function addManualClaim(db: DB, userId: string, versionId: string, c: ManualClaim): string {
  const v = db.prepare('SELECT status, text FROM document_versions WHERE id = ?').get(versionId) as { status: string; text: string } | undefined
  if (!v) throw new UserError('Version not found.', 404)
  if (v.status !== 'needs_review') throw new UserError('Claims can only be added while the version is in review.', 409)
  if (!c.value.trim()) throw new UserError('A value is required (e.g. 45% or qualifies).')
  const pos = locateExcerpt(v.text, c.excerpt)
  if (!pos) throw new UserError('The excerpt was not found in the document text. Select or paste an exact passage.')
  if (c.exceptionDocumentedBy && !db.prepare(`SELECT 1 FROM document_versions WHERE document_id = ? AND status = 'active'`).get(c.exceptionDocumentedBy)) {
    throw new UserError(`${c.exceptionDocumentedBy} is not an active document.`)
  }
  const id = nextId(db, 'claims', 'C', 0)
  const now = nowIso()
  db.prepare(`INSERT INTO claims (id, version_id, topic, condition, country, client, scope_source, value, unit, effective_from, effective_to, excerpt, location,
      exception_label, exception_agreement_ref, exception_documented_by, origin, status, created_at, reviewed_by, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'entered by consultant', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', 'confirmed', ?, ?, ?)`)
    .run(id, versionId, c.topic, c.condition, c.country, c.client, c.value.trim(), c.value.trim().endsWith('%') ? 'percent' : 'other',
      c.effectiveFrom, c.effectiveTo, v.text.slice(pos.start, pos.end), locationLabel(v.text, pos),
      c.exceptionLabel, c.exceptionAgreementRef, c.exceptionDocumentedBy, now, userId, now)
  return id
}
