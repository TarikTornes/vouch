import { Router } from 'express'
import { healthReport, makeLookups } from '../../shared/evidence'
import { requireAuth } from '../auth'
import { loadKB } from '../services/evidence'
import { versionView } from './documents'
import type { Deps } from './context'

export function dashboardRoutes({ db }: Deps) {
  const r = Router()

  r.get('/notifications', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user!.id)
    const unread = (db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user!.id) as { n: number }).n
    const awaiting = (db.prepare(`SELECT COUNT(*) n FROM cases WHERE status IN ('open', 'info_requested') AND
      ((assigned_to = ? AND status = 'open') OR (requested_by = ? AND status = 'info_requested'))`).get(req.user!.id, req.user!.id) as { n: number }).n
    const docsAwaitingReview = (db.prepare(`SELECT COUNT(*) n FROM document_versions WHERE status = 'needs_review'`).get() as { n: number }).n
    res.json({ notifications: rows, unread, awaitingAction: awaiting, docsAwaitingReview })
  })

  r.post('/notifications/read', requireAuth, (req, res) => {
    const ids: unknown = req.body?.ids
    if (Array.isArray(ids)) {
      const stmt = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL')
      for (const id of ids.slice(0, 100)) stmt.run(new Date().toISOString(), Number(id), req.user!.id)
    } else {
      db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(new Date().toISOString(), req.user!.id)
    }
    res.json({ ok: true })
  })

  r.get('/dashboard', requireAuth, (req, res) => {
    const u = req.user!
    const count = (sql: string, ...p: string[]) => (db.prepare(sql).get(...p) as { n: number }).n
    const kb = loadKB(db)
    const health = healthReport(kb)
    const recentUploads = (db.prepare(`SELECT v.*, d.title, d.source_type, d.owner_name, d.country, d.client, d.link FROM document_versions v
      JOIN documents d ON d.id = v.document_id WHERE v.uploaded_by IS NOT NULL ORDER BY v.uploaded_at DESC, v.id DESC LIMIT 5`).all() as Record<string, unknown>[])
      .map((v) => versionView(db, v))
    const L = makeLookups(kb)
    res.json({
      counts: {
        activeDocuments: count(`SELECT COUNT(*) n FROM document_versions WHERE status = 'active'`),
        awaitingReview: count(`SELECT COUNT(*) n FROM document_versions WHERE status = 'needs_review'`),
        failedDocuments: count(`SELECT COUNT(*) n FROM document_versions WHERE status = 'failed'`),
        openConflicts: health.openConflicts.length,
        requestsAwaiting: count(`SELECT COUNT(*) n FROM cases WHERE status IN ('open', 'info_requested') AND (assigned_to = ? OR requested_by = ?)`, u.id, u.id),
        staleResolutions: health.staleResolutions.length,
        oldSources: health.staleSources.filter((x) => x.freshness.level === 'stale' || x.freshness.level === 'expired').length,
      },
      recentUploads,
      recentResolutions: kb.resolutions.slice(0, 5).map((r) => ({
        id: r.id, caseId: r.caseId, value: r.value, status: r.status, resolvedBy: r.resolvedByName, resolvedAt: r.resolvedAt,
        label: `${r.key.condition} ${r.key.topic === 'overtime_surcharge' ? 'surcharge' : 'eligibility'}`, clientName: L.clientName(r.key.client),
      })),
    })
  })

  r.get('/health-report', requireAuth, (_req, res) => {
    const kb = loadKB(db)
    const h = healthReport(kb)
    const L = makeLookups(kb)
    const docs = (db.prepare(`SELECT v.*, d.title, d.source_type, d.owner_name, d.country, d.client, d.link FROM document_versions v
      JOIN documents d ON d.id = v.document_id WHERE v.status = 'active' ORDER BY v.document_id`).all() as Record<string, unknown>[]).map((v) => versionView(db, v))
    res.json({
      openConflicts: h.openConflicts.map((c) => ({
        label: c.label, key: c.key, clientName: L.clientName(c.key.client), expert: c.expert?.name ?? null,
        values: [...new Set(c.evidence.filter((e) => e.status === 'Applicable').map((e) => `${e.claim.value} (${e.source.documentId})`))],
      })),
      outdatedClaims: h.outdatedClaims.map(({ claim, resolution }) => ({
        claimId: claim.id, value: claim.value, documentId: L.sourceById(claim.sourceId).documentId, title: L.sourceById(claim.sourceId).title,
        duplicateOf: claim.duplicateOf ?? null, resolutionId: resolution.id, resolvedBy: resolution.resolvedByName, resolvedAt: resolution.resolvedAt,
      })),
      ownerlessSources: h.ownerlessSources.map((s) => ({ documentId: s.documentId, title: s.title, updated: s.updated })),
      staleSources: h.staleSources.map((x) => ({ documentId: x.source.documentId, title: x.source.title, updated: x.source.updated, freshness: x.freshness })),
      staleResolutions: h.staleResolutions.map((r) => ({ id: r.id, value: r.value, reason: r.rereviewReason, clientName: L.clientName(r.key.client) })),
      documents: docs,
    })
  })
  return r
}
