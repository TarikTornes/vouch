import { Router } from 'express'
import { CONDITIONS, TOPICS, type Condition, type Topic } from '../../shared/types'
import { requireAuth, requireRole, type User } from '../auth'
import { caseDetail, canView, createCaseFromQuestion, getCaseRow, markUnresolved, provideInfo, requestInfo, resolveCase } from '../services/cases'
import { UserError } from '../services/documents'
import { makeLookups } from '../../shared/evidence'
import { loadKB } from '../services/evidence'
import { deliver, getOutbox } from '../services/notifications'
import { handle, optStr, str, type Deps } from './context'

export function caseRoutes(deps: Deps) {
  const { db, config } = deps
  const r = Router()

  const loadVisible = (id: string, user: User | undefined) => {
    const c = getCaseRow(db, id)
    // Same response whether the case is missing or not yours: knowing an id grants nothing.
    if (!c || !user || !canView(user, c)) throw new UserError('Case not found or you do not have access to it.', 404)
    return c
  }

  r.get('/cases', requireAuth, (req, res) => {
    const u = req.user!
    const status = optStr(req.query.status, 20)
    const rows = db.prepare(`SELECT c.*, (SELECT status FROM email_outbox o WHERE o.case_id = c.id ORDER BY created_at DESC LIMIT 1) AS email_status
      FROM cases c WHERE (c.assigned_to = ? OR c.requested_by = ?) ${status === 'awaiting' ? `AND c.status IN ('open', 'info_requested')` : status ? 'AND c.status = ?' : ''}
      ORDER BY c.updated_at DESC`).all(u.id, u.id, ...(status && status !== 'awaiting' ? [status] : [])) as Record<string, unknown>[]
    const L = makeLookups(loadKB(db))
    res.json({
      cases: rows.map((c) => ({
        id: c.id, status: c.status, label: c.label, question: c.question, country: c.country, clientName: L.clientName(c.client as string),
        openedReason: c.opened_reason, createdAt: c.created_at, updatedAt: c.updated_at, emailStatus: c.email_status,
        mine: c.assigned_to === u.id ? 'assigned' : 'requested',
      })),
    })
  })

  r.post('/cases', requireRole('consultant'), handle(async (req, res) => {
    const topic = str(req.body?.topic, 40) as Topic
    const condition = str(req.body?.condition, 40) as Condition
    if (!TOPICS.includes(topic) || !CONDITIONS.includes(condition)) throw new UserError('Invalid claim.')
    const out = createCaseFromQuestion(db, config, req.user!, str(req.body?.questionId, 40), topic, condition)
    // Send (or report) the email now so the UI shows the real provider outcome.
    let email = out.outbox
    if (email && (email.status === 'queued' || (out.created && email.status === 'failed'))) email = await deliver(db, config, deps.sendEmail, email.id)
    res.status(out.created ? 201 : 200).json({ caseId: out.caseId, created: out.created, email })
  }))

  r.get('/cases/:id', requireAuth, handle((req, res) => {
    const c = loadVisible(String(req.params.id), req.user)
    res.json(caseDetail(db, c))
  }))

  r.post('/cases/:id/request-info', requireRole('expert'), handle((req, res) => {
    requestInfo(db, req.user!, String(req.params.id), Number(req.body?.rowVersion), str(req.body?.message, 2000))
    res.json({ ok: true })
  }))

  r.post('/cases/:id/respond', requireRole('consultant'), handle((req, res) => {
    provideInfo(db, req.user!, String(req.params.id), Number(req.body?.rowVersion), str(req.body?.message, 2000))
    res.json({ ok: true })
  }))

  r.post('/cases/:id/resolve', requireRole('expert'), handle((req, res) => {
    const b = req.body ?? {}
    const out = resolveCase(db, req.user!, String(req.params.id), {
      rowVersion: Number(b.rowVersion), value: str(b.value, 40), reason: str(b.reason, 2000),
      outdatedClaimIds: Array.isArray(b.outdatedClaimIds) ? b.outdatedClaimIds.map((x: unknown) => str(x, 20)).slice(0, 50) : [],
      supportingDocumentId: optStr(b.supportingDocumentId, 20), expertStatement: optStr(b.expertStatement, 2000),
    })
    res.json(out)
  }))

  r.post('/cases/:id/unresolved', requireRole('expert'), handle((req, res) => {
    markUnresolved(db, req.user!, String(req.params.id), Number(req.body?.rowVersion), str(req.body?.reason, 2000))
    res.json({ ok: true })
  }))

  r.post('/cases/:id/emails/:outboxId/retry', requireAuth, handle(async (req, res) => {
    const c = loadVisible(String(req.params.id), req.user)
    const ob = getOutbox(db, String(req.params.outboxId))
    if (!ob || ob.case_id !== c.id) throw new UserError('Email not found.', 404)
    if (ob.status === 'accepted') throw new UserError('This email was already accepted by the provider; it will not be sent twice.', 409)
    res.json({ email: await deliver(db, config, deps.sendEmail, ob.id) })
  }))

  return r
}
