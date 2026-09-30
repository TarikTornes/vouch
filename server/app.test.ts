// Integration tests: real Express app + real SQLite file; Claude and the email
// provider are replaced by test doubles (the live paths are verified separately).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { loadConfig, type Config } from './config'
import { migrate, openDb, type DB } from './db'
import { seed } from './db/seed'
import type { Extraction, Interpretation, LlmClient } from './services/llm'
import { LlmError } from './services/llm'
import type { EmailSender } from './services/notifications'

const ORIGIN = 'http://localhost:8787'
const PW = { consultant: 'test-consultant-pw', expert: 'test-expert-pw', nlExpert: 'test-nl-pw' }

let dir: string
let dbFile: string
let db: DB
let config: Config
let sent: { to: string; subject: string; idempotencyKey: string }[]
let emailMode: 'ok' | 'fail'
let nextExtraction: Extraction | Error

const fakeLlm: LlmClient = {
  model: 'test-double',
  async extractClaims() {
    if (nextExtraction instanceof Error) throw nextExtraction
    return nextExtraction
  },
  async interpretQuestion(q: string): Promise<Interpretation> {
    const sat = /saturday/i.test(q)
    return { in_domain: sat, requests: sat ? [{ topic: 'overtime_surcharge', condition: 'saturday' }] : [], requested_information: q, out_of_domain_reason: sat ? null : 'Not about overtime', mentioned_client: null, mentioned_country: null }
  },
}
const fakeSender: EmailSender = async (m) => {
  if (emailMode === 'fail') return { ok: false, status: 500, error: 'Resend 500: simulated provider outage (test double)' }
  sent.push({ to: m.to, subject: m.subject, idempotencyKey: m.idempotencyKey })
  return { ok: true, id: `test-${sent.length}` }
}

function makeApp() {
  return createApp({ db, config, llm: fakeLlm, sendEmail: fakeSender })
}

async function login(app: ReturnType<typeof makeApp>, username: string, password: string) {
  const agent = request.agent(app)
  const r = await agent.post('/api/session').set('Origin', ORIGIN).set('X-Vouch-CSRF', '1').send({ username, password })
  expect(r.status, `login ${username}`).toBe(200)
  const post = (url: string, body?: object) => agent.post(url).set('Origin', ORIGIN).set('X-Vouch-CSRF', '1').send(body ?? {})
  const patch = (url: string, body: object) => agent.patch(url).set('Origin', ORIGIN).set('X-Vouch-CSRF', '1').send(body)
  return { agent, post, patch, get: (url: string) => agent.get(url) }
}

const memo = 'Janssens NV — HR memo (fictional). From 1 July 2026, Saturday overtime for Janssens NV staff in Belgium is paid with a 60% surcharge under agreement JA-2026-02.'

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vouch-test-'))
  dbFile = path.join(dir, 'test.sqlite')
  config = { ...loadConfig({ APP_BASE_URL: ORIGIN } as NodeJS.ProcessEnv), databasePath: dbFile, demoExpertEmail: 'expert-inbox@example.test', resendApiKey: 'test-key-not-real', passwords: PW }
  db = openDb(dbFile)
  migrate(db)
  seed(db, config)
  sent = []
  emailMode = 'ok'
  nextExtraction = {
    note: null,
    claims: [{
      topic: 'overtime_surcharge', condition: 'saturday', country: 'BE', client_scope: 'specific_client', client_name: 'Janssens NV', value: '60%', unit: 'percent',
      effective_from: '2026-07-01', effective_to: null, excerpt: 'Saturday overtime for Janssens NV staff in Belgium is paid with a 60% surcharge',
      exception_claimed: true, exception_description: 'Agreement JA-2026-02', referenced_agreement: 'JA-2026-02',
    }, {
      topic: 'overtime_surcharge', condition: 'sunday', country: 'unknown', client_scope: 'unknown', client_name: null, value: '90%', unit: 'percent',
      effective_from: null, effective_to: null, excerpt: 'This sentence is not in the memo', exception_claimed: false, exception_description: null, referenced_agreement: null,
    }],
  }
})
afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function waitForStatus(s: Awaited<ReturnType<typeof login>>, docId: string, status: string) {
  for (let i = 0; i < 50; i++) {
    const r = await s.get(`/api/documents/${docId}`)
    if (r.body.versions?.[0]?.status === status) return r.body.versions[0]
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error(`document ${docId} never reached ${status}`)
}

async function askSaturday(s: Awaited<ReturnType<typeof login>>, client = 'janssens') {
  const r = await s.post('/api/questions', { question: 'How much extra do we pay for Saturday overtime?', country: 'BE', client })
  expect(r.status).toBe(200)
  return r.body
}

describe('sessions and permissions', () => {
  it('rejects bad passwords, unauthenticated API use, and cross-origin mutations', async () => {
    const app = makeApp()
    expect((await request(app).post('/api/session').set('Origin', ORIGIN).set('X-Vouch-CSRF', '1').send({ username: 'anna', password: 'nope' })).status).toBe(401)
    expect((await request(app).get('/api/dashboard')).status).toBe(401)
    const s = await login(app, 'sophie', PW.consultant)
    expect((await s.agent.post('/api/questions').set('Origin', 'https://evil.example').set('X-Vouch-CSRF', '1').send({})).status).toBe(403)
    expect((await s.agent.post('/api/questions').set('Origin', ORIGIN).send({})).status).toBe(403)
  })

  it('only the assigned expert can view or resolve; the browser cannot choose the resolver', async () => {
    const app = makeApp()
    const sophie = await login(app, 'sophie', PW.consultant)
    const q = await askSaturday(sophie)
    const created = await sophie.post('/api/cases', { questionId: q.id, topic: 'overtime_surcharge', condition: 'saturday' })
    expect(created.status).toBe(201)
    const caseId = created.body.caseId

    const jan = await login(app, 'jan', PW.nlExpert)
    expect((await jan.get(`/api/cases/${caseId}`)).status).toBe(404)
    expect((await jan.post(`/api/cases/${caseId}/resolve`, { rowVersion: 1, value: '50%', reason: 'x', expertStatement: 'y', outdatedClaimIds: [] })).status).toBe(403)
    expect((await sophie.post(`/api/cases/${caseId}/resolve`, { rowVersion: 1, value: '50%', reason: 'x', expertStatement: 'y' })).status).toBe(403)

    const anna = await login(app, 'anna', PW.expert)
    const res = await anna.post(`/api/cases/${caseId}/resolve`, { rowVersion: 1, value: '50%', reason: 'Agreement expired (fictional)', supportingDocumentId: 'S1', outdatedClaimIds: ['C4'], resolvedBy: 'jan' })
    expect(res.status).toBe(200)
    const row = db.prepare('SELECT resolved_by FROM resolutions WHERE id = ?').get(res.body.resolutionId) as { resolved_by: string }
    expect(row.resolved_by).toBe('anna')
  })
})

describe('expert cases, email outbox and scoped resolution', () => {
  it('creates one case and one email for repeated clicks, resolves, and leaves another client unaffected', async () => {
    const app = makeApp()
    const sophie = await login(app, 'sophie', PW.consultant)
    const q = await askSaturday(sophie)
    const surcharge = q.answer.claims.find((c: { key: { topic: string } }) => c.key.topic === 'overtime_surcharge')
    expect(surcharge.status).toBe('Conflicting')

    const [a, b] = await Promise.all([
      sophie.post('/api/cases', { questionId: q.id, topic: 'overtime_surcharge', condition: 'saturday' }),
      sophie.post('/api/cases', { questionId: q.id, topic: 'overtime_surcharge', condition: 'saturday' }),
    ])
    expect(a.body.caseId).toBe(b.body.caseId)
    expect((db.prepare('SELECT COUNT(*) n FROM cases').get() as { n: number }).n).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('expert-inbox@example.test')
    expect(a.body.email?.status ?? b.body.email?.status).toBe('accepted')

    const anna = await login(app, 'anna', PW.expert)
    const notes = await anna.get('/api/notifications')
    expect(notes.body.notifications.some((n: { case_id: string }) => n.case_id === a.body.caseId)).toBe(true)

    // Missing reason/support is rejected.
    expect((await anna.post(`/api/cases/${a.body.caseId}/resolve`, { rowVersion: 1, value: '50%', reason: '', supportingDocumentId: 'S1' })).status).toBe(400)
    expect((await anna.post(`/api/cases/${a.body.caseId}/resolve`, { rowVersion: 1, value: '50%', reason: 'why' })).status).toBe(400)
    const ok = await anna.post(`/api/cases/${a.body.caseId}/resolve`, { rowVersion: 1, value: '50%', reason: 'Agreement expired (fictional)', expertStatement: 'Confirmed with client file CF-JAN-2025-114 (fictional)', outdatedClaimIds: ['C4'] })
    expect(ok.status).toBe(200)
    // A concurrent / stale second submission is rejected.
    expect((await anna.post(`/api/cases/${a.body.caseId}/resolve`, { rowVersion: 1, value: '35%', reason: 'x', expertStatement: 'y' })).status).toBe(409)

    const again = await askSaturday(sophie)
    const s2 = again.answer.claims.find((c: { key: { topic: string } }) => c.key.topic === 'overtime_surcharge')
    expect(s2.status).toBe('Supported')
    expect(s2.expertConfirmed).toBe(true)
    expect(s2.resolution.resolvedByName).toBe('Anna Peeters')

    const maes = await askSaturday(sophie, 'maes')
    expect(maes.answer.claims.find((c: { key: { topic: string } }) => c.key.topic === 'overtime_surcharge').status).toBe('Conflicting')

    const sophieNotes = await sophie.get('/api/notifications')
    expect(sophieNotes.body.notifications.some((n: { kind: string }) => n.kind === 'resolved')).toBe(true)
  })

  it('reports a provider failure honestly and allows a retry', async () => {
    emailMode = 'fail'
    const app = makeApp()
    const sophie = await login(app, 'sophie', PW.consultant)
    const q = await askSaturday(sophie)
    const r = await sophie.post('/api/cases', { questionId: q.id, topic: 'overtime_surcharge', condition: 'saturday' })
    expect(r.body.email.status).toBe('failed')
    expect(r.body.email.last_error).toMatch(/Resend 500/)
    emailMode = 'ok'
    const retry = await sophie.post(`/api/cases/${r.body.caseId}/emails/${r.body.email.id}/retry`)
    expect(retry.body.email.status).toBe('accepted')
    expect(sent).toHaveLength(1)
    expect((await sophie.post(`/api/cases/${r.body.caseId}/emails/${r.body.email.id}/retry`)).status).toBe(409)
  })

  it('reports a Claude failure as an error, not an answer', async () => {
    const app = createApp({ db, config, llm: { ...fakeLlm, interpretQuestion: async () => { throw new LlmError('Claude API error 500', 'api') } }, sendEmail: fakeSender })
    const sophie = await login(app, 'sophie', PW.consultant)
    const r = await sophie.post('/api/questions', { question: 'Saturday overtime surcharge?', country: 'BE', client: 'janssens' })
    expect(r.status).toBe(502)
    expect(r.body.error).toMatch(/no answer was produced/)
  })
})

describe('document ingestion, review and re-review', () => {
  it('extracts, rejects untraceable excerpts, requires review, and new evidence triggers re-review', async () => {
    const app = makeApp()
    const sophie = await login(app, 'sophie', PW.consultant)
    const anna = await login(app, 'anna', PW.expert)

    // Resolve the Janssens conflict first.
    const q = await askSaturday(sophie)
    const c = await sophie.post('/api/cases', { questionId: q.id, topic: 'overtime_surcharge', condition: 'saturday' })
    await anna.post(`/api/cases/${c.body.caseId}/resolve`, { rowVersion: 1, value: '50%', reason: 'Agreement expired', supportingDocumentId: 'S1', outdatedClaimIds: ['C4'] })

    const up = await sophie.post('/api/documents', { title: 'Janssens HR memo 2026', sourceType: 'Other', ownerName: 'Pieter Claes', country: 'unknown', client: 'unknown', text: memo })
    expect(up.status).toBe(202)
    const v = await waitForStatus(sophie, up.body.documentId, 'needs_review')
    expect(v.claims).toHaveLength(2)
    const good = v.claims.find((x: { value: string }) => x.value === '60%')
    const bad = v.claims.find((x: { value: string }) => x.value === '90%')
    expect(good.status).toBe('proposed')
    expect(good.client).toBe('janssens')
    expect(good.location).toMatch(/line 1/)
    expect(bad.status).toBe('invalid')
    expect(bad.country).toBe('unknown') // unknown scope was not widened
    expect(v.quality.checks.find((x: { key: string }) => x.key === 'human_review').passed).toBe(false)

    // Not active yet: the answer still uses the resolution.
    expect((await askSaturday(sophie)).answer.claims[1].expertConfirmed).toBe(true)
    expect((await sophie.post(`/api/versions/${v.id}/activate`, { currencyReviewed: true })).status).toBe(400)
    expect((await sophie.patch(`/api/claims/${bad.id}`, { status: 'confirmed' })).status).toBe(400)
    await sophie.patch(`/api/claims/${bad.id}`, { status: 'rejected' })
    await sophie.patch(`/api/claims/${good.id}`, { status: 'confirmed' })
    const act = await sophie.post(`/api/versions/${v.id}/activate`, { currencyReviewed: true })
    expect(act.status).toBe(200)
    expect(act.body.rereviewCases).toHaveLength(1)

    // The old approval no longer applies to evidence it never considered.
    const after = await askSaturday(sophie)
    const s = after.answer.claims.find((x: { key: { topic: string } }) => x.key.topic === 'overtime_surcharge')
    expect(s.status).toBe('Conflicting')
    expect(s.evidence.some((e: { claim: { value: string } }) => e.claim.value === '60%')).toBe(true)
    const res = db.prepare(`SELECT status FROM resolutions`).get() as { status: string }
    expect(res.status).toBe('needs_rereview')
    const rr = await anna.get(`/api/cases/${act.body.rereviewCases[0]}`)
    expect(rr.status).toBe(200)
    expect(rr.body.openedReason).toBe('rereview')

    // Identical content cannot be added again as independent evidence.
    const dup = await sophie.post('/api/documents', { title: 'Copy', sourceType: 'Email', country: 'BE', client: 'janssens', text: memo })
    expect(dup.status).toBe(409)
  })

  it('failed extraction is an explicit failed state and is not assessed', async () => {
    nextExtraction = new LlmError('Claude API error 529: overloaded', 'api')
    const app = makeApp()
    const sophie = await login(app, 'sophie', PW.consultant)
    const up = await sophie.post('/api/documents', { title: 'Memo', sourceType: 'Other', country: 'BE', client: '*', text: memo })
    const v = await waitForStatus(sophie, up.body.documentId, 'failed')
    expect(v.failureReason).toMatch(/529/)
    expect(v.quality.assessed).toBe(false)
  })

  it('rejects unsupported uploads', async () => {
    const app = makeApp()
    const sophie = await login(app, 'sophie', PW.consultant)
    const r = await sophie.agent.post('/api/documents').set('Origin', ORIGIN).set('X-Vouch-CSRF', '1')
      .field('title', 'Image').field('sourceType', 'Other').attach('file', Buffer.from('GIF89a'), 'x.gif')
    expect(r.status).toBe(415)
  })
})

describe('persistence', () => {
  it('documents and resolutions survive reopening the database file', async () => {
    const app = makeApp()
    const sophie = await login(app, 'sophie', PW.consultant)
    const anna = await login(app, 'anna', PW.expert)
    const q = await askSaturday(sophie)
    const c = await sophie.post('/api/cases', { questionId: q.id, topic: 'overtime_surcharge', condition: 'saturday' })
    await anna.post(`/api/cases/${c.body.caseId}/resolve`, { rowVersion: 1, value: '50%', reason: 'Agreement expired', supportingDocumentId: 'S1', outdatedClaimIds: ['C4'] })
    db.close()

    db = openDb(dbFile) // simulate a restart
    const app2 = makeApp()
    const s2 = await login(app2, 'sophie', PW.consultant)
    const again = await askSaturday(s2)
    expect(again.answer.claims[1].expertConfirmed).toBe(true)
    expect((await s2.get('/api/documents')).body.documents.length).toBe(7)
  })
})

describe('zero-cost mode: no LLM connected and no email provider', () => {
  it('keyword rules interpret paraphrases and refuse unrelated questions', async () => {
    const { interpretByRules } = await import('./services/rules')
    expect(interpretByRules('How much extra do we pay for working Saturdays?').requests).toContainEqual({ topic: 'overtime_surcharge', condition: 'saturday' })
    expect(interpretByRules('What is the weekend premium?').requests.map((r) => r.condition).sort()).toEqual(['saturday', 'sunday'])
    expect(interpretByRules('Does Saturday work count as overtime?').requests).toEqual([{ topic: 'overtime_eligibility', condition: 'saturday' }])
    expect(interpretByRules('What is the holiday allowance for students?').in_domain).toBe(false)
  })

  it('runs the full loop with manual claims and in-app notifications only', async () => {
    config = { ...config, resendApiKey: null }
    const app = createApp({ db, config, llm: null, sendEmail: fakeSender })
    const sophie = await login(app, 'sophie', PW.consultant)
    const anna = await login(app, 'anna', PW.expert)

    const up = await sophie.post('/api/documents', { title: 'Maes memo', sourceType: 'Other', ownerName: 'Lies Vermeulen', country: 'BE', client: 'maes', text: 'Maes BVBA memo (fictional). Saturday overtime at Maes BVBA is paid at 55% from 1 July 2026.' })
    const v = await waitForStatus(sophie, up.body.documentId, 'needs_review')
    expect(v.claims).toHaveLength(0)
    expect(v.failureReason).toMatch(/No LLM connected/)
    const bad = await sophie.post(`/api/versions/${v.id}/claims`, { topic: 'overtime_surcharge', condition: 'saturday', country: 'BE', client: 'maes', value: '55%', excerpt: 'not in the text' })
    expect(bad.status).toBe(400)
    const good = await sophie.post(`/api/versions/${v.id}/claims`, { topic: 'overtime_surcharge', condition: 'saturday', country: 'BE', client: 'maes', value: '55%', excerpt: 'Saturday overtime at Maes BVBA is paid at 55%' })
    expect(good.status).toBe(201)
    expect((await sophie.post(`/api/versions/${v.id}/activate`, { currencyReviewed: true })).status).toBe(200)

    const q = await sophie.post('/api/questions', { question: 'How much extra do we pay for Saturday overtime?', country: 'BE', client: 'maes' })
    expect(q.body.interpreter.kind).toBe('rules')
    const s = q.body.answer.claims.find((c: { key: { topic: string } }) => c.key.topic === 'overtime_surcharge')
    expect(s.status).toBe('Conflicting')
    expect(s.evidence.some((e: { claim: { value: string } }) => e.claim.value === '55%')).toBe(true)

    const created = await sophie.post('/api/cases', { questionId: q.body.id, topic: 'overtime_surcharge', condition: 'saturday' })
    expect(created.status).toBe(201)
    expect(created.body.email).toBeNull()
    expect(sent).toHaveLength(0)
    expect((db.prepare('SELECT COUNT(*) n FROM email_outbox').get() as { n: number }).n).toBe(0)
    const notes = await anna.get('/api/notifications')
    expect(notes.body.awaitingAction).toBe(1)
    expect((await anna.post(`/api/cases/${created.body.caseId}/resolve`, { rowVersion: 1, value: '50%', reason: 'Sector arrangement not applicable (fictional)', expertStatement: 'Checked with policy owner records (fictional)', outdatedClaimIds: [] })).status).toBe(200)
    const sn = await sophie.get('/api/notifications')
    expect(sn.body.notifications[0].kind).toBe('resolved')
  })
})
