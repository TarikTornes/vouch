// Expert cases: creation, information requests, resolution, and re-review.
// Permissions and identities are enforced here from the server-side user.
import { countryName, evaluateIntent, findResolution, inScopeClaims, makeLookups, routeExpert } from '../../shared/evidence'
import type { ClaimKey, ClaimResult, Condition, Topic } from '../../shared/types'
import type { User } from '../auth'
import type { Config } from '../config'
import { json, nextId, nowIso, tx, type DB } from '../db'
import { loadKB } from './evidence'
import { caseEmail, enqueueEmail, notify, type OutboxRow } from './notifications'
import { UserError } from './documents'

type Row = Record<string, unknown>

export function getCaseRow(db: DB, id: string) {
  return db.prepare('SELECT * FROM cases WHERE id = ?').get(id) as Row | undefined
}

/** Who may see a case: the requesting consultant or the assigned expert. Knowing the id is not enough. */
export function canView(user: User, c: Row) {
  return c.assigned_to === user.id || (user.role === 'consultant' && c.requested_by === user.id)
}

export function assertAssignedExpert(user: User, c: Row) {
  if (user.role !== 'expert' || c.assigned_to !== user.id) throw new UserError('Only the assigned expert can act on this case.', 403)
}

const keyOf = (c: Row): ClaimKey => ({ topic: c.topic as Topic, condition: c.condition as Condition, country: c.country as 'BE' | 'NL', client: c.client as string })

function evidenceVersions(result: ClaimResult) {
  return result.evidence.filter((e) => e.status !== 'Excluded').map((e) => ({
    claimId: e.claim.id, sourceId: e.source.id, documentId: e.source.documentId, version: e.source.version, contentHash: e.source.contentHash, value: e.claim.value, status: e.status,
  }))
}

function openCaseTx(db: DB, config: Config, p: {
  key: ClaimKey; result: ClaimResult; question: string; questionId: string | null; requestedBy: string | null; requesterName: string
  assignedTo: string; reason: 'consultant_request' | 'rereview'; rereviewOf?: string; rereviewText?: string
}): { caseId: string; outbox: OutboxRow | null; created: boolean } {
  const existing = db.prepare(`SELECT id FROM cases WHERE topic = ? AND condition = ? AND country = ? AND client = ? AND status IN ('open', 'info_requested')`)
    .get(p.key.topic, p.key.condition, p.key.country, p.key.client) as { id: string } | undefined
  if (existing) {
    const ob = db.prepare(`SELECT id FROM email_outbox WHERE case_id = ? ORDER BY created_at DESC LIMIT 1`).get(existing.id) as { id: string } | undefined
    return { caseId: existing.id, outbox: ob ? (db.prepare('SELECT * FROM email_outbox WHERE id = ?').get(ob.id) as unknown as OutboxRow) : null, created: false }
  }
  const id = nextId(db, 'cases', 'CASE-')
  const now = nowIso()
  const kb = loadKB(db)
  const L = makeLookups(kb)
  db.prepare(`INSERT INTO cases (id, question_id, requested_by, assigned_to, topic, condition, country, client, label, question, opened_reason, rereview_of,
      status, answer_snapshot, evidence_versions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
    .run(id, p.questionId, p.requestedBy, p.assignedTo, p.key.topic, p.key.condition, p.key.country, p.key.client, p.result.label, p.question,
      p.reason, p.rereviewOf ?? null, JSON.stringify(p.result), JSON.stringify(evidenceVersions(p.result)), now, now)
  db.prepare('INSERT INTO case_events (case_id, actor_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, p.requestedBy, p.reason === 'rereview' ? 'rereview_opened' : 'created', p.rereviewText ?? null, now)
  const clientName = L.clientName(p.key.client)
  notify(db, {
    userId: p.assignedTo, kind: p.reason, caseId: id, link: `#/cases/${id}`,
    title: p.reason === 'rereview' ? `Re-review needed: ${p.result.label} — ${clientName}` : `New expert request: ${p.result.label} — ${clientName}`,
    body: p.reason === 'rereview' ? p.rereviewText : `${p.requesterName} asked: “${p.question}”`,
  })
  const expert = db.prepare('SELECT email FROM users WHERE id = ?').get(p.assignedTo) as { email: string | null }
  let outbox: OutboxRow | null = null
  // External email only when a provider is configured; otherwise nothing is queued or claimed as sent.
  if (expert.email && config.resendApiKey) {
    const values = [...new Set(p.result.evidence.filter((e) => e.status === 'Applicable').map((e) => e.claim.value))]
    const mail = caseEmail(config, { id, question: p.question, label: p.result.label, clientName, countryName: countryName(p.key.country), values, requester: p.requesterName, rereview: p.rereviewText })
    outbox = enqueueEmail(db, { caseId: id, kind: p.reason, recipient: expert.email, ...mail })
  }
  return { caseId: id, outbox, created: true }
}

/** Consultant asks an expert. The server recomputes the answer; it does not trust the browser's copy. */
export function createCaseFromQuestion(db: DB, config: Config, user: User, questionId: string, topic: Topic, condition: Condition) {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId) as Row | undefined
  if (!q || q.user_id !== user.id) throw new UserError('Question not found.', 404)
  const ctx = { country: q.country as 'BE' | 'NL', client: q.client as string }
  const kb = loadKB(db)
  const result = evaluateIntent({ topic, condition }, ctx, kb)
  if (result.status !== 'Conflicting' && result.status !== 'Unsupported' && result.status !== 'Possibly outdated') {
    throw new UserError(`This claim is currently ${result.expertConfirmed ? 'expert-confirmed' : result.status}; no expert review is needed.`, 409)
  }
  const key = { ...ctx, topic, condition }
  const expert = routeExpert(key, kb.experts)
  if (!expert) throw new UserError('No expert in the directory owns this topic for this country.', 422)
  return tx(db, () => openCaseTx(db, config, { key, result, question: q.question as string, questionId, requestedBy: user.id, requesterName: user.displayName, assignedTo: expert.id, reason: 'consultant_request' }))
}

export function requestInfo(db: DB, user: User, caseId: string, rowVersion: number, message: string) {
  if (!message.trim()) throw new UserError('Say what information is needed.')
  return tx(db, () => {
    const c = getCaseRow(db, caseId)
    if (!c) throw new UserError('Case not found.', 404)
    assertAssignedExpert(user, c)
    const r = db.prepare(`UPDATE cases SET status = 'info_requested', row_version = row_version + 1, updated_at = ? WHERE id = ? AND row_version = ? AND status = 'open'`)
      .run(nowIso(), caseId, rowVersion)
    if (r.changes === 0) throw new UserError('This case changed since you opened it. Reload and try again.', 409)
    db.prepare('INSERT INTO case_events (case_id, actor_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)').run(caseId, user.id, 'info_requested', message.trim(), nowIso())
    if (c.requested_by) notify(db, { userId: c.requested_by as string, kind: 'info_requested', caseId, link: `#/cases/${caseId}`, title: `${user.displayName} needs more information on ${caseId}`, body: message.trim() })
  })
}

export function provideInfo(db: DB, user: User, caseId: string, rowVersion: number, message: string) {
  if (!message.trim()) throw new UserError('Add the requested information.')
  return tx(db, () => {
    const c = getCaseRow(db, caseId)
    if (!c) throw new UserError('Case not found.', 404)
    if (user.role !== 'consultant' || c.requested_by !== user.id) throw new UserError('Only the requesting consultant can reply.', 403)
    const r = db.prepare(`UPDATE cases SET status = 'open', row_version = row_version + 1, updated_at = ? WHERE id = ? AND row_version = ? AND status = 'info_requested'`)
      .run(nowIso(), caseId, rowVersion)
    if (r.changes === 0) throw new UserError('This case changed since you opened it. Reload and try again.', 409)
    db.prepare('INSERT INTO case_events (case_id, actor_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)').run(caseId, user.id, 'info_provided', message.trim(), nowIso())
    notify(db, { userId: c.assigned_to as string, kind: 'info_provided', caseId, link: `#/cases/${caseId}`, title: `${user.displayName} replied on ${caseId}`, body: message.trim() })
  })
}

export interface ResolveInput {
  rowVersion: number
  value: string
  outdatedClaimIds: string[]
  reason: string
  supportingDocumentId: string | null
  expertStatement: string | null
}

/**
 * Resolve a case: validated against the CURRENT evidence, saved with the case
 * transition in one transaction; a stale rowVersion (concurrent submission) is rejected.
 */
export function resolveCase(db: DB, user: User, caseId: string, input: ResolveInput) {
  if (!input.reason?.trim()) throw new UserError('A reason is required.')
  if (!input.supportingDocumentId && !input.expertStatement?.trim()) throw new UserError('Link a supporting document or record an expert statement.')
  return tx(db, () => {
    const c = getCaseRow(db, caseId)
    if (!c) throw new UserError('Case not found.', 404)
    assertAssignedExpert(user, c)
    const key = keyOf(c)
    const kb = loadKB(db)
    const inScope = inScopeClaims(key, kb)
    const independent = inScope.filter((e) => e.status === 'Applicable')
    const tooOld = inScope.filter((e) => e.status === 'Too old')
    const values = [...new Set(independent.map((e) => e.claim.value))]
    const value = input.value?.trim() ?? ''
    if (values.length) {
      // Current evidence exists: the expert picks one of its values.
      if (!values.includes(value)) throw new UserError(`The resolved value must be one of the values in the current evidence (${values.join(', ')}).`)
    } else {
      // No current evidence (only outdated sources, or none at all): the expert's own answer becomes the source.
      if (!input.expertStatement?.trim() && !input.supportingDocumentId) throw new UserError('Without current evidence, record an expert statement or link a supporting document.')
      const ok = key.topic === 'overtime_surcharge' ? /^\d{1,3}(\.\d{1,2})?%$/.test(value) : value === 'qualifies' || value === 'does not qualify'
      if (!ok) throw new UserError(key.topic === 'overtime_surcharge' ? 'Enter the surcharge as a percentage, e.g. 100%.' : 'Enter “qualifies” or “does not qualify”.')
    }
    input = { ...input, value }
    const others = [...independent, ...tooOld].filter((e) => e.claim.value !== input.value).map((e) => e.claim.id)
    const badOutdated = input.outdatedClaimIds.filter((id) => !others.includes(id))
    if (badOutdated.length) throw new UserError(`Only claims with a different value can be marked outdated (${badOutdated.join(', ')} cannot).`)
    let supportingVersionId: string | null = null
    if (input.supportingDocumentId) {
      const v = db.prepare(`SELECT id FROM document_versions WHERE document_id = ? AND status = 'active'`).get(input.supportingDocumentId) as { id: string } | undefined
      if (!v) throw new UserError('The supporting document must be an active document.')
      supportingVersionId = v.id
    }
    const now = nowIso()
    const r = db.prepare(`UPDATE cases SET status = 'resolved', row_version = row_version + 1, updated_at = ? WHERE id = ? AND row_version = ? AND status IN ('open', 'info_requested')`)
      .run(now, caseId, input.rowVersion)
    if (r.changes === 0) throw new UserError('This case was changed or resolved by another submission. Reload to see the current state.', 409)
    db.prepare(`UPDATE resolutions SET status = 'superseded' WHERE topic = ? AND condition = ? AND country = ? AND client = ? AND status != 'superseded'`)
      .run(key.topic, key.condition, key.country, key.client)
    const resId = nextId(db, 'resolutions', 'RES-')
    db.prepare(`INSERT INTO resolutions (id, case_id, topic, condition, country, client, value, accepted_claim_ids, outdated_claim_ids, considered, reason,
        supporting_version_id, expert_statement, resolved_by, resolved_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`)
      .run(resId, caseId, key.topic, key.condition, key.country, key.client, input.value,
        JSON.stringify([...independent, ...tooOld].filter((e) => e.claim.value === input.value).map((e) => e.claim.id)),
        JSON.stringify(input.outdatedClaimIds),
        JSON.stringify(inScope.map((e) => ({ claimId: e.claim.id, sourceId: e.source.id, contentHash: e.source.contentHash }))),
        input.reason.trim(), supportingVersionId, input.expertStatement?.trim() || null, user.id, now)
    db.prepare('INSERT INTO case_events (case_id, actor_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)').run(caseId, user.id, 'resolved', `${input.value}: ${input.reason.trim()}`, now)
    if (c.requested_by) notify(db, { userId: c.requested_by as string, kind: 'resolved', caseId, link: `#/cases/${caseId}`, title: `${user.displayName} resolved ${caseId}: ${input.value}`, body: `${c.label} — ask again to see the updated answer.` })
    return { resolutionId: resId }
  })
}

export function markUnresolved(db: DB, user: User, caseId: string, rowVersion: number, reason: string) {
  if (!reason?.trim()) throw new UserError('Explain why the evidence is insufficient.')
  return tx(db, () => {
    const c = getCaseRow(db, caseId)
    if (!c) throw new UserError('Case not found.', 404)
    assertAssignedExpert(user, c)
    const now = nowIso()
    const r = db.prepare(`UPDATE cases SET status = 'unresolved', row_version = row_version + 1, updated_at = ? WHERE id = ? AND row_version = ? AND status IN ('open', 'info_requested')`)
      .run(now, caseId, rowVersion)
    if (r.changes === 0) throw new UserError('This case was changed by another submission. Reload to see the current state.', 409)
    db.prepare('INSERT INTO case_events (case_id, actor_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)').run(caseId, user.id, 'unresolved', reason.trim(), now)
    if (c.requested_by) notify(db, { userId: c.requested_by as string, kind: 'unresolved', caseId, link: `#/cases/${caseId}`, title: `${user.displayName} left ${caseId} unresolved`, body: reason.trim() })
  })
}

/**
 * After evidence changes, any active resolution that did not consider every in-scope
 * claim (or whose considered evidence is gone) is flagged and a re-review case opened.
 */
export function triggerRereviews(db: DB, config: Config, cause: string): { caseIds: string[]; outbox: OutboxRow[] } {
  return tx(db, () => {
    const kb = loadKB(db)
    const caseIds: string[] = []
    const outbox: OutboxRow[] = []
    for (const r of kb.resolutions.filter((x) => x.status === 'active')) {
      const { unseen } = findResolution(r.key, kb)
      const present = new Set(kb.claims.map((c) => c.id))
      const gone = r.considered.filter((c) => !present.has(c.claimId)).map((c) => c.claimId)
      if (!unseen.length && !gone.length) continue
      const why = [unseen.length ? `new evidence ${unseen.join(', ')} was not considered` : '', gone.length ? `considered evidence ${gone.join(', ')} was replaced or removed` : '']
        .filter(Boolean).join('; ')
      const reason = `${cause}: ${why}`
      db.prepare(`UPDATE resolutions SET status = 'needs_rereview', rereview_reason = ? WHERE id = ?`).run(reason, r.id)
      const refreshed = loadKB(db)
      const result = evaluateIntent(r.key, r.key, refreshed)
      const opened = openCaseTx(db, config, {
        key: r.key, result, question: `Re-review ${r.id}: ${result.label}`, questionId: null, requestedBy: null, requesterName: 'Vouch',
        assignedTo: r.resolvedBy, reason: 'rereview', rereviewOf: r.id, rereviewText: `${r.id} (${r.value}) — ${reason}`,
      })
      caseIds.push(opened.caseId)
      if (opened.outbox) outbox.push(opened.outbox)
    }
    return { caseIds, outbox }
  })
}

export function caseDetail(db: DB, c: Row) {
  const kb = loadKB(db)
  const key = keyOf(c)
  const current = evaluateIntent(key, key, kb)
  const events = db.prepare(`SELECT e.kind, e.message, e.created_at, u.display_name AS actor FROM case_events e LEFT JOIN users u ON u.id = e.actor_id
    WHERE e.case_id = ? ORDER BY e.id`).all(c.id as string)
  const emails = db.prepare(`SELECT id, kind, recipient, status, provider_message_id, attempts, last_error, updated_at FROM email_outbox WHERE case_id = ? ORDER BY created_at`).all(c.id as string)
  const resolution = kb.resolutions.find((r) => r.caseId === c.id) ?? null
  const users = db.prepare('SELECT id, display_name FROM users').all() as { id: string; display_name: string }[]
  const nameOf = (id: unknown) => users.find((u) => u.id === id)?.display_name ?? null
  const L = makeLookups(kb)
  return {
    id: c.id, status: c.status, rowVersion: c.row_version, label: c.label, question: c.question, key,
    clientName: L.clientName(key.client), countryName: countryName(key.country),
    openedReason: c.opened_reason, rereviewOf: c.rereview_of,
    requestedBy: nameOf(c.requested_by), assignedTo: nameOf(c.assigned_to), assignedToId: c.assigned_to, requestedById: c.requested_by,
    createdAt: c.created_at, updatedAt: c.updated_at,
    snapshot: json(c.answer_snapshot as string, null), evidenceVersions: json(c.evidence_versions as string, []),
    current, events, emails, resolution,
    activeDocuments: kb.sources.map((s) => ({ documentId: s.documentId, title: s.title, versionId: s.id })),
  }
}
