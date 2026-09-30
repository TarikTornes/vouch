import { useState } from 'react'
import { countryName } from '../../shared/evidence'
import { EXAMPLE_QUESTION } from '../../shared/fixtures'
import type { ClaimResult, Country } from '../../shared/types'
import { api, type EmailStatus, type Me, type Meta, type QuestionResponse } from '../api'
import { AnswerBadge, EmailStatusLine, ErrorBox, EvidenceCard, PageHeader, ReasonList, useSourceModal } from '../components/common'

interface CaseCreated { caseId: string; created: boolean; email: EmailStatus | null }

export function AskPage({ meta, last, setLast, me, onChanged }: { meta: Meta | null; last: QuestionResponse | null; setLast: (q: QuestionResponse | null) => void; me: Me; onChanged: () => void }) {
  const [country, setCountry] = useState<Country>(last?.answer.context.country ?? 'BE')
  const [client, setClient] = useState(last?.answer.context.client ?? 'janssens')
  const [question, setQuestion] = useState(last?.answer.question ?? EXAMPLE_QUESTION)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cases, setCases] = useState<Record<string, CaseCreated>>({})
  const [caseErr, setCaseErr] = useState<Record<string, string>>({})
  const [requesting, setRequesting] = useState<string | null>(null)
  const { onOpenSource, modal } = useSourceModal()
  const clients = meta?.clients.filter((c) => c.country === country) ?? []

  const ask = async (q = question) => {
    setBusy(true)
    setError(null)
    setCases({})
    setCaseErr({})
    try {
      setLast(await api<QuestionResponse>('/questions', { body: { question: q, country, client } }))
    } catch (e) {
      setLast(null)
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const keyId = (r: ClaimResult) => `${r.key.topic}|${r.key.condition}`
  const requestExpert = async (r: ClaimResult) => {
    if (!last) return
    setRequesting(keyId(r))
    try {
      const out = await api<CaseCreated>('/cases', { body: { questionId: last.id, topic: r.key.topic, condition: r.key.condition } })
      setCases((c) => ({ ...c, [keyId(r)]: out }))
      onChanged()
    } catch (e) {
      setCaseErr((c) => ({ ...c, [keyId(r)]: (e as Error).message }))
    } finally {
      setRequesting(null)
    }
  }

  const retry = async (k: string) => {
    const c = cases[k]
    if (!c?.email) return
    try {
      const r = await api<{ email: EmailStatus }>(`/cases/${c.caseId}/emails/${c.email.id}/retry`, { body: {} })
      setCases((x) => ({ ...x, [k]: { ...c, email: r.email } }))
    } catch (e) {
      setCaseErr((x) => ({ ...x, [k]: (e as Error).message }))
    }
  }

  return (
    <section>
      <PageHeader title="Ask Vouch" subtitle={meta?.interpreter.kind === 'claude'
        ? 'Claude interprets the question; Vouch’s evidence rules decide the answer from active sources.'
        : 'No LLM connected: keyword rules map the question to a supported topic (overtime surcharges and eligibility). Vouch’s evidence rules decide the answer from active sources.'} />
      <form className="panel ask-form" onSubmit={(e) => { e.preventDefault(); if (question.trim()) ask() }}>
        <div className="form-row">
          <label>Country
            <select value={country} onChange={(e) => { const c = e.target.value as Country; setCountry(c); setClient(meta?.clients.find((x) => x.country === c)?.id ?? '') }}>
              {meta?.countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>Client
            <select value={client} onChange={(e) => setClient(e.target.value)}>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>
        <label>Question
          <div className="question-row">
            <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. How much extra do we pay for Saturday overtime?" maxLength={500} />
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Asking…' : 'Ask'}</button>
          </div>
        </label>
        {busy && <p className="meta" role="status">{meta?.interpreter.kind === 'claude' ? `Claude (${meta.interpreter.model}) is interpreting the question…` : 'Matching the question…'}</p>}
      </form>
      <ErrorBox error={error} />

      {last && (
        <div className="answer">
          <p className="asked">
            <strong>“{last.answer.question}”</strong> · {countryName(last.answer.context.country)} / {meta?.clients.find((c) => c.id === last.answer.context.client)?.name}
            <br />
            <span className="meta">{last.interpreter.kind === 'claude' ? `Interpreted by Claude (${last.interpreter.model})` : 'Matched by keyword rules (no LLM connected)'} as: {last.interpretation.requested_information} · question {last.id}</span>
          </p>

          {!last.answer.recognized && (
            <div className="claim claim-unsupported">
              <div className="claim-head"><AnswerBadge status="Unsupported" /></div>
              <h3>Vouch cannot answer this from its sources.</h3>
              <p>{last.answer.unsupportedReason} Vouch currently covers overtime surcharges and eligibility (Saturday, Sunday, public holidays, night work) and it does not guess.</p>
              <button type="button" className="btn" onClick={() => { setQuestion(EXAMPLE_QUESTION); ask(EXAMPLE_QUESTION) }}>Try: “{EXAMPLE_QUESTION}”</button>
            </div>
          )}

          {last.answer.claims.map((r) => {
            const k = keyId(r)
            const c = cases[k]
            return (
              <div key={k} className={`claim claim-${r.expertConfirmed ? 'confirmed' : r.status.toLowerCase()}`}>
                <div className="claim-head">
                  <AnswerBadge status={r.status} expertConfirmed={r.expertConfirmed} />
                  <span className="claim-label">{r.label}</span>
                </div>
                <h3>{r.headline}</h3>
                <ReasonList reasons={r.explanation} />
                {r.resolution && (
                  <div className="provenance">
                    <strong>Provenance:</strong> {r.resolution.id} by {r.resolution.resolvedByName}, {new Date(r.resolution.resolvedAt).toLocaleString('en-GB')} · scope {r.key.condition} {r.key.topic.replace('overtime_', '')} for this client only ·{' '}
                    <a href={`#/cases/${r.resolution.caseId}`}>view case {r.resolution.caseId}</a> · evidence considered: {r.resolution.considered.map((x) => `${x.claimId} (${x.sourceId})`).join(', ')}
                  </div>
                )}
                {(r.status === 'Conflicting' || r.status === 'Unsupported') && me.role === 'consultant' && (
                  <div className="review-action">
                    {c ? (
                      <div className="case-created">
                        <span><strong>{c.created ? 'Case created' : 'An open case already exists'}:</strong> <a href={`#/cases/${c.caseId}`}>{c.caseId}</a> — assigned to {r.expert?.name}.</span>
                        <span className="badge badge-ok"><span aria-hidden="true">🔔</span> In-app notification delivered to {r.expert?.name}’s workspace</span>
                        {c.email ? <EmailStatusLine email={c.email} onRetry={() => retry(k)} /> : <span className="meta">External email: not configured in this demo — pending. No email was sent.</span>}
                      </div>
                    ) : (
                      <>
                        <button type="button" className="btn btn-primary" disabled={requesting === k} onClick={() => requestExpert(r)}>
                          {requesting === k ? 'Creating case…' : 'Ask an expert'}
                        </button>
                        {r.expert && <span className="meta">Routes to {r.expert.name}, {r.expert.role}. Creates a shared case and an in-app notification{meta?.externalEmail ? ' and sends an email' : ' (external email is not configured)'}.</span>}
                      </>
                    )}
                    <ErrorBox error={caseErr[k] ?? null} />
                  </div>
                )}
                <details className="evidence-block" open={r.status !== 'Supported' || !!r.expertConfirmed}>
                  <summary>Evidence ({r.evidence.length} claim{r.evidence.length === 1 ? '' : 's'} on this topic)</summary>
                  <div className="evidence-grid">
                    {r.evidence.map((item) => <EvidenceCard key={item.claim.id} item={item} onOpenSource={onOpenSource} />)}
                  </div>
                </details>
              </div>
            )
          })}
        </div>
      )}
      {modal}
    </section>
  )
}
