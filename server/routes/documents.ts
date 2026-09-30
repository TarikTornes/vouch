import { Router, type Request } from 'express'
import multer from 'multer'
import { assessQuality } from '../../shared/quality'
import { CONDITIONS, GENERAL, SOURCE_TYPES, TOPICS, UNKNOWN } from '../../shared/types'
import { requireAuth, requireRole } from '../auth'
import type { DB } from '../db'
import { triggerRereviews } from '../services/cases'
import {
  activateVersion, addManualClaim, checkText, createVersion, skipExtraction, extractUploadText, processVersion, rejectVersion, reviewClaim, UserError, type ClaimReview,
} from '../services/documents'
import { deliver } from '../services/notifications'
import { handle, isoDate, optStr, str, type Deps } from './context'

type Row = Record<string, unknown>

export function versionView(db: DB, v: Row, includeText = false) {
  const claims = db.prepare('SELECT * FROM claims WHERE version_id = ? ORDER BY id').all(v.id as string) as Row[]
  const names = db.prepare('SELECT id, display_name FROM users').all() as { id: string; display_name: string }[]
  const nameOf = (id: unknown) => names.find((n) => n.id === id)?.display_name ?? null
  const quality = assessQuality({
    status: v.status as string, contentHash: v.content_hash as string, originalFilename: (v.original_filename as string) ?? null,
    link: (v.link as string) ?? null, uploadedByName: nameOf(v.uploaded_by), uploadedAt: v.uploaded_at as string,
    ownerName: (v.owner_name as string) ?? null, sourceUpdated: (v.source_updated as string) ?? null, effectiveFrom: (v.effective_from as string) ?? null,
    currencyReviewed: !!v.currency_reviewed, reviewedByName: nameOf(v.reviewed_by), reviewedAt: (v.reviewed_at as string) ?? null,
    claims: claims.map((c) => ({ status: c.status as string, country: c.country as string, client: c.client as string })),
  })
  return {
    id: v.id, documentId: v.document_id, version: v.version, status: v.status, failureReason: v.failure_reason,
    title: v.title, sourceType: v.source_type, ownerName: v.owner_name, country: v.country, client: v.client, link: v.link,
    contentHash: v.content_hash, originalFilename: v.original_filename, sizeBytes: v.size_bytes, mimeType: v.mime_type,
    sourceUpdated: v.source_updated, effectiveFrom: v.effective_from, effectiveTo: v.effective_to,
    uploadedBy: nameOf(v.uploaded_by), uploadedAt: v.uploaded_at, llmModel: v.llm_model,
    processingStartedAt: v.processing_started_at, processingFinishedAt: v.processing_finished_at,
    reviewedBy: nameOf(v.reviewed_by), reviewedAt: v.reviewed_at, currencyReviewed: !!v.currency_reviewed,
    claimCounts: {
      total: claims.length,
      confirmed: claims.filter((c) => c.status === 'confirmed').length,
      proposed: claims.filter((c) => c.status === 'proposed').length,
      invalid: claims.filter((c) => c.status === 'invalid').length,
    },
    quality,
    ...(includeText ? {
      text: v.text,
      claims: claims.map((c) => ({
        id: c.id, topic: c.topic, condition: c.condition, country: c.country, client: c.client, scopeSource: c.scope_source,
        value: c.value, unit: c.unit, effectiveFrom: c.effective_from, effectiveTo: c.effective_to, excerpt: c.excerpt, location: c.location,
        exceptionLabel: c.exception_label, exceptionAgreementRef: c.exception_agreement_ref, exceptionDocumentedBy: c.exception_documented_by,
        duplicateOf: c.duplicate_of, origin: c.origin, status: c.status, invalidReason: c.invalid_reason,
        reviewedBy: nameOf(c.reviewed_by), reviewedAt: c.reviewed_at,
      })),
    } : {}),
  }
}

const VERSION_SELECT = `SELECT v.*, d.title, d.source_type, d.owner_name, d.country, d.client, d.link FROM document_versions v JOIN documents d ON d.id = v.document_id`

export function documentRoutes(deps: Deps) {
  const { db, config, llm } = deps
  const r = Router()
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.limits.maxUploadBytes, files: 1, fields: 20 } })
  const uploadMw = (req: Request, res: Parameters<Parameters<typeof r.post>[1]>[1], next: () => void) =>
    upload.single('file')(req, res, (err: unknown) => {
      if (err) return res.status(err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${config.limits.maxUploadBytes / 1_000_000} MB).` : 'Upload failed.' })
      next()
    })

  r.get('/documents', requireAuth, (req, res) => {
    const status = optStr(req.query.status, 20)
    // Latest version of each document.
    const rows = db.prepare(`${VERSION_SELECT} WHERE v.version = (SELECT MAX(version) FROM document_versions x WHERE x.document_id = v.document_id)
      ${status ? 'AND v.status = ?' : ''} ORDER BY v.uploaded_at DESC, v.document_id DESC`).all(...(status ? [status] : [])) as Row[]
    res.json({ documents: rows.map((v) => versionView(db, v)) })
  })

  r.get('/documents/:id', requireAuth, (req, res) => {
    const versions = db.prepare(`${VERSION_SELECT} WHERE v.document_id = ? ORDER BY v.version DESC`).all(String(req.params.id)) as Row[]
    if (!versions.length) return res.status(404).json({ error: 'Document not found' })
    res.json({ versions: versions.map((v, i) => versionView(db, v, i === 0 || v.status === 'active')) })
  })

  const readInput = async (req: Request, documentId?: string) => {
    const b = req.body ?? {}
    const text = req.file ? await extractUploadText({ buffer: req.file.buffer, originalname: req.file.originalname, size: req.file.size }, config) : checkText(str(b.text, config.limits.maxTextChars + 1000), config)
    const title = optStr(b.title, 200)
    if (!title) throw new UserError('A title is required.')
    const sourceType = str(b.sourceType, 50)
    if (!(SOURCE_TYPES as readonly string[]).includes(sourceType)) throw new UserError('Choose a source type.')
    const country = str(b.country, 10) || UNKNOWN
    if (!['BE', 'NL', UNKNOWN].includes(country)) throw new UserError('Invalid country.')
    const client = str(b.client, 50) || UNKNOWN
    const known = db.prepare('SELECT 1 FROM clients WHERE id = ?').get(client)
    if (![GENERAL, UNKNOWN].includes(client) && !known) throw new UserError('Invalid client scope.')
    return {
      documentId, title, sourceType, ownerName: optStr(b.ownerName, 100), country: country as 'BE' | 'NL' | 'unknown', client,
      link: optStr(b.link, 300), sourceUpdated: isoDate(b.sourceUpdated), effectiveFrom: isoDate(b.effectiveFrom), effectiveTo: isoDate(b.effectiveTo),
      text, originalFilename: req.file?.originalname ?? null, mimeType: req.file?.mimetype ?? (req.file ? null : 'text/plain (pasted)'), sizeBytes: req.file?.size ?? Buffer.byteLength(text),
    }
  }

  const startProcessing = (versionId: string) => {
    if (llm) void processVersion(db, llm, versionId)
    else skipExtraction(db, versionId) // no LLM connected: claims are entered manually
  }

  r.post('/documents', requireRole('consultant'), uploadMw, handle(async (req, res) => {
    const ids = createVersion(db, req.user!.id, await readInput(req))
    startProcessing(ids.versionId)
    res.status(202).json(ids)
  }))

  r.post('/documents/:id/versions', requireRole('consultant'), uploadMw, handle(async (req, res) => {
    const ids = createVersion(db, req.user!.id, await readInput(req, String(req.params.id)))
    startProcessing(ids.versionId)
    res.status(202).json(ids)
  }))

  r.post('/versions/:vid/reprocess', requireRole('consultant'), handle((req, res) => {
    const v = db.prepare(`SELECT status FROM document_versions WHERE id = ?`).get(String(req.params.vid)) as { status: string } | undefined
    if (!v) throw new UserError('Version not found.', 404)
    if (v.status !== 'failed') throw new UserError('Only a failed version can be retried.', 409)
    startProcessing(String(req.params.vid))
    res.status(202).json({ ok: true })
  }))

  r.patch('/claims/:id', requireRole('consultant'), handle((req, res) => {
    const b = req.body ?? {}
    if (!['confirmed', 'rejected'].includes(b.status)) throw new UserError('status must be confirmed or rejected.')
    if (b.topic !== undefined && !(TOPICS as readonly string[]).includes(b.topic)) throw new UserError('Invalid topic.')
    if (b.condition !== undefined && !(CONDITIONS as readonly string[]).includes(b.condition)) throw new UserError('Invalid condition.')
    if (b.country !== undefined && !['BE', 'NL', UNKNOWN].includes(b.country)) throw new UserError('Invalid country.')
    if (b.client !== undefined && ![GENERAL, UNKNOWN].includes(b.client) && !db.prepare('SELECT 1 FROM clients WHERE id = ?').get(String(b.client))) throw new UserError('Invalid client.')
    const review: ClaimReview = {
      status: b.status, topic: b.topic, condition: b.condition, country: b.country, client: b.client,
      value: b.value !== undefined ? str(b.value, 40) : undefined, excerpt: b.excerpt !== undefined ? str(b.excerpt, 2000) : undefined,
      effectiveFrom: b.effectiveFrom !== undefined ? isoDate(b.effectiveFrom) : undefined, effectiveTo: b.effectiveTo !== undefined ? isoDate(b.effectiveTo) : undefined,
      exceptionLabel: b.exceptionLabel !== undefined ? optStr(b.exceptionLabel, 300) : undefined,
      exceptionDocumentedBy: b.exceptionDocumentedBy !== undefined ? optStr(b.exceptionDocumentedBy, 20) : undefined,
    }
    reviewClaim(db, req.user!.id, String(req.params.id), review)
    res.json({ ok: true })
  }))

  r.post('/versions/:vid/claims', requireRole('consultant'), handle((req, res) => {
    const b = req.body ?? {}
    if (!(TOPICS as readonly string[]).includes(b.topic)) throw new UserError('Choose a topic.')
    if (!(CONDITIONS as readonly string[]).includes(b.condition)) throw new UserError('Choose a condition.')
    if (!['BE', 'NL', UNKNOWN].includes(b.country)) throw new UserError('Invalid country.')
    if (![GENERAL, UNKNOWN].includes(b.client) && !db.prepare('SELECT 1 FROM clients WHERE id = ?').get(String(b.client))) throw new UserError('Invalid client.')
    const id = addManualClaim(db, req.user!.id, String(req.params.vid), {
      topic: b.topic, condition: b.condition, country: b.country, client: b.client, value: str(b.value, 40),
      excerpt: str(b.excerpt, 2000), effectiveFrom: isoDate(b.effectiveFrom), effectiveTo: isoDate(b.effectiveTo),
      exceptionLabel: optStr(b.exceptionLabel, 300), exceptionAgreementRef: optStr(b.exceptionAgreementRef, 100), exceptionDocumentedBy: optStr(b.exceptionDocumentedBy, 20),
    })
    res.status(201).json({ id })
  }))

  r.post('/versions/:vid/activate', requireRole('consultant'), handle(async (req, res) => {
    const vid = String(req.params.vid)
    activateVersion(db, req.user!.id, vid, { currencyReviewed: req.body?.currencyReviewed === true })
    // New or changed evidence can invalidate earlier expert approvals.
    const rr = triggerRereviews(db, config, `${vid} was activated`)
    const emails = await Promise.all(rr.outbox.map((o) => deliver(db, config, deps.sendEmail, o.id)))
    res.json({ ok: true, rereviewCases: rr.caseIds, emails })
  }))

  r.post('/versions/:vid/reject', requireRole('consultant'), handle((req, res) => {
    rejectVersion(db, req.user!.id, String(req.params.vid), str(req.body?.reason, 500))
    res.json({ ok: true })
  }))

  return r
}
