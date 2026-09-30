import { Router } from 'express'
import { countryName, evaluateIntents } from '../../shared/evidence'
import type { Answer, Intent } from '../../shared/types'
import { requireAuth } from '../auth'
import { json, nextId, nowIso } from '../db'
import { UserError } from '../services/documents'
import { loadKB } from '../services/evidence'
import { LlmError } from '../services/llm'
import { interpretByRules } from '../services/rules'
import { handle, str, type Deps } from './context'

export function questionRoutes({ db, llm, config }: Deps) {
  const r = Router()

  r.get('/meta', requireAuth, (_req, res) => {
    res.json({
      clients: db.prepare('SELECT id, name, country FROM clients ORDER BY name').all(),
      countries: [{ id: 'BE', name: countryName('BE') }, { id: 'NL', name: countryName('NL') }],
      interpreter: llm ? { kind: 'claude', model: llm.model } : { kind: 'rules', model: null },
      externalEmail: !!(config.resendApiKey && config.demoExpertEmail),
    })
  })

  r.post('/questions', requireAuth, handle(async (req, res) => {
    const question = str(req.body?.question, 500).trim()
    const country = str(req.body?.country, 5)
    const client = str(req.body?.client, 50)
    if (question.length < 5) throw new UserError('Ask a question.')
    const c = db.prepare('SELECT country FROM clients WHERE id = ?').get(client) as { country: string } | undefined
    if (!c || c.country !== country) throw new UserError('Choose a client in the selected country.')
    const id = nextId(db, 'questions', 'Q-')
    try {
      // Claude (if connected) or the keyword rules only interpret the question; the verdict is computed deterministically below.
      const interpretation = llm ? await llm.interpretQuestion(question) : interpretByRules(question)
      const interpreter = llm ? { kind: 'claude', model: llm.model } : { kind: 'rules', model: null }
      const intents: Intent[] = interpretation.in_domain ? interpretation.requests : []
      const kb = loadKB(db)
      const answer: Answer = evaluateIntents(question, intents, { country: country as 'BE' | 'NL', client }, kb)
      if (!answer.recognized) answer.unsupportedReason = interpretation.out_of_domain_reason ?? 'The question is outside the supported domain (overtime policies and client exceptions).'
      db.prepare('INSERT INTO questions (id, user_id, question, country, client, interpretation, answer, llm_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, req.user!.id, question, country, client, JSON.stringify(interpretation), JSON.stringify(answer), llm?.model ?? 'keyword-rules', nowIso())
      res.json({ id, interpretation, answer, interpreter })
    } catch (e) {
      if (!(e instanceof LlmError)) throw e
      db.prepare('INSERT INTO questions (id, user_id, question, country, client, error, llm_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, req.user!.id, question, country, client, e.message, llm?.model ?? 'keyword-rules', nowIso())
      res.status(e.kind === 'not_configured' ? 503 : 502).json({ error: `Question interpretation failed — no answer was produced. ${e.message}`, id })
    }
  }))

  r.get('/questions/:id', requireAuth, (req, res) => {
    const q = db.prepare('SELECT * FROM questions WHERE id = ? AND user_id = ?').get(String(req.params.id), req.user!.id) as Record<string, string> | undefined
    if (!q) return res.status(404).json({ error: 'Question not found' })
    res.json({ id: q.id, question: q.question, createdAt: q.created_at, interpretation: json(q.interpretation, null), answer: json(q.answer, null), error: q.error })
  })
  return r
}
