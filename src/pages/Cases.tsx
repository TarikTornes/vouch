import { useCallback, useEffect, useState } from 'react'
import { api, type CaseDetail, type CaseRow, type EmailStatus, type Me } from '../api'
import type { Route } from '../App'
import { go } from '../App'
import { AnswerBadge, Badge, CaseStatusBadge, EmailStatusLine, Empty, ErrorBox, EvidenceCard, fmtDateTime, PageHeader, ReasonList, useSourceModal } from '../components/common'

const FILTERS = [{ id: 'awaiting', label: 'Awaiting action' }, { id: 'resolved', label: 'Resolved' }, { id: 'unresolved', label: 'Unresolved' }, { id: '', label: 'All' }]

export function CasesPage({ route, tick }: { route: Route; tick: number }) {
  const status = route.query.get('status') ?? 'awaiting'
  const [rows, setRows] = useState<CaseRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api<{ cases: CaseRow[] }>(`/cases${status ? `?status=${status}` : ''}`).then((r) => setRows(r.cases)).catch((e) => setError(e.message)) }, [status, tick])
  return (
    <section>
      <PageHeader title="Expert requests" subtitle="Cases you requested or that are assigned to you. Access is checked on the server for every case." />
      <div className="filters" role="group" aria-label="Filter">
        {FILTERS.map((f) => <a key={f.id} href={`#/cases?status=${f.id}`} className={`chip ${status === f.id ? 'chip-active' : ''}`}>{f.label}</a>)}
      </div>
      <ErrorBox error={error} />
      {rows && !rows.length && <Empty>No cases here.</Empty>}
      {rows && rows.length > 0 && (
        <table className="table">
          <thead><tr><th>Case</th><th>Status</th><th>Question</th><th>Email</th><th>Updated</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => go(`#/cases/${c.id}`)}>
                <td><a href={`#/cases/${c.id}`}><strong>{c.id}</strong></a><div className="meta">{c.label} · {c.clientName}{c.openedReason === 'rereview' ? ' · re-review' : ''}</div></td>
                <td><CaseStatusBadge status={c.status} /><div className="meta">{c.mine === 'assigned' ? 'Assigned to you' : 'You requested'}</div></td>
                <td>{c.question}</td>
                <td className="meta">{c.emailStatus === 'accepted' ? '✉ accepted by provider' : c.emailStatus === 'failed' ? '✕ failed' : c.emailStatus ?? '—'}</td>
                <td className="meta">{fmtDateTime(c.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export function CaseDetailPage({ id, me, tick, onChanged }: { id: string; me: Me; tick: number; onChanged: () => void }) {
  const [c, setC] = useState<CaseDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const { onOpenSource, modal } = useSourceModal()
  const load = useCallback(() => api<CaseDetail>(`/cases/${id}`).then((x) => { setC(x); setError(null) }).catch((e) => setError(e.message)), [id])
  useEffect(() => { load() }, [load, tick])
  if (error) return <section><PageHeader title={`Case ${id}`} /><ErrorBox error={error} /></section>
  if (!c) return <section><p>Loading…</p></section>

  const isExpert = me.role === 'expert' && c.assignedToId === me.id
  const isRequester = c.requestedById === me.id
  const openForAction = c.status === 'open' || c.status === 'info_requested'
  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null)
    try {
      await fn()
      await load()
      onChanged()
    } catch (e) {
      setActionError((e as Error).message)
      await load()
    }
  }
  const retry = (email: EmailStatus) => run(() => api(`/cases/${c.id}/emails/${email.id}/retry`, { body: {} }))

  return (
    <section>
      <PageHeader title={`${c.id}: ${c.label}`} subtitle={<>{c.countryName} / {c.clientName} · {c.openedReason === 'rereview' ? `re-review of ${c.rereviewOf}` : `requested by ${c.requestedBy}`} · assigned to {c.assignedTo} · opened {fmtDateTime(c.createdAt)}</>}
        action={<CaseStatusBadge status={c.status} />} />
      <div className="panel">
        <h2>Question</h2>
        <p className="lead">“{c.question}”</p>
        {c.emails.map((e) => <EmailStatusLine key={e.id} email={e} onRetry={isExpert || isRequester ? () => retry(e) : undefined} />)}
        {!c.emails.length && <p className="meta"><span className="badge badge-ok"><span aria-hidden="true">🔔</span> In-app notification sent to {c.assignedTo}</span> External email: not configured in this demo — pending; no email was sent.</p>}
      </div>

      {c.resolution && (
        <div className="panel panel-ok">
          <h2>Resolution {c.resolution.id}: {c.resolution.value}</h2>
          <dl className="kv">
            <dt>Resolved by</dt><dd>{c.resolution.resolvedByName} · {fmtDateTime(c.resolution.resolvedAt)}</dd>
            <dt>Status</dt><dd>{c.resolution.status === 'active' ? '✓ Active' : c.resolution.status === 'needs_rereview' ? `⟲ Needs re-review — ${c.resolution.rereviewReason}` : 'Superseded'}</dd>
            <dt>Why</dt><dd>{c.resolution.reason}</dd>
            <dt>Support</dt><dd>{c.resolution.reference}</dd>
            <dt>Scope</dt><dd>{c.label} for {c.clientName} in {c.countryName} only</dd>
            <dt>Evidence considered</dt><dd>{c.resolution.considered.map((x) => `${x.claimId} (${x.sourceId}, hash ${x.contentHash.slice(0, 8)}…)`).join(', ')}</dd>
            <dt>Marked outdated</dt><dd>{c.resolution.outdatedClaimIds.join(', ') || 'None'}</dd>
          </dl>
        </div>
      )}

      <div className="panel">
        <div className="claim-head"><h2>Current evidence</h2><AnswerBadge status={c.current.status} expertConfirmed={c.current.expertConfirmed} /></div>
        <p className="lead">{c.current.headline}</p>
        <ReasonList reasons={c.current.explanation} />
        <div className="evidence-grid">
          {c.current.evidence.map((item) => <EvidenceCard key={item.claim.id} item={item} onOpenSource={onOpenSource} />)}
        </div>
        <details className="evidence-block">
          <summary>Snapshot at request time ({c.evidenceVersions.length} claims)</summary>
          <ul className="meta">{c.evidenceVersions.map((e) => <li key={e.claimId}>{e.claimId}: {e.value} from {e.documentId} v{e.version} (hash {e.contentHash.slice(0, 10)}…) — {e.status}</li>)}</ul>
        </details>
      </div>

      <div className="panel">
        <h2>Activity</h2>
        <ol className="timeline">
          {c.events.map((e, i) => <li key={i}><strong>{eventLabel(e.kind)}</strong> {e.actor ? `by ${e.actor}` : ''} · <span className="meta">{fmtDateTime(e.created_at)}</span>{e.message && <div>{e.message}</div>}</li>)}
        </ol>
      </div>

      <ErrorBox error={actionError} />
      {isExpert && openForAction && <ExpertActions key={`${c.id}-${c.rowVersion}`} c={c} run={run} />}
      {!isExpert && me.role === 'expert' && openForAction && <p className="notice">Only the assigned expert ({c.assignedTo}) can act on this case.</p>}
      {isRequester && c.status === 'info_requested' && <ReplyForm c={c} run={run} />}
      {modal}
    </section>
  )
}

const eventLabel = (k: string) => ({ created: 'Case created', rereview_opened: 'Re-review opened', info_requested: 'More information requested', info_provided: 'Information provided', resolved: 'Resolved', unresolved: 'Left unresolved' }[k] ?? k)

function ExpertActions({ c, run }: { c: CaseDetail; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const applicable = c.current.evidence.filter((e) => e.status === 'Applicable')
  const tooOld = c.current.evidence.filter((e) => e.status === 'Too old')
  const values = [...new Set(applicable.map((e) => e.claim.value))]
  // No current evidence: the expert answers from their own knowledge, and that answer becomes the source.
  const ownAnswer = values.length === 0
  const [value, setValue] = useState(values[0] ?? tooOld[0]?.claim.value ?? '')
  const [outdated, setOutdated] = useState<Record<string, boolean>>({})
  const [reason, setReason] = useState('')
  const [supportMode, setSupportMode] = useState<'document' | 'statement'>(ownAnswer ? 'statement' : 'document')
  const [supportDoc, setSupportDoc] = useState('')
  const [statement, setStatement] = useState('')
  const [infoMsg, setInfoMsg] = useState('')
  const [unresolvedReason, setUnresolvedReason] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const others = [...applicable, ...tooOld].filter((e) => e.claim.value !== value)
  const isOutdated = (id: string) => outdated[id] ?? true

  return (
    <div className="panel">
      <h2>Expert decision</h2>
      <p className="meta">Signed in as the assigned expert. Your identity and the timestamp are recorded by the server.</p>
      {(
        <form className="resolution-form" onSubmit={(e) => {
          e.preventDefault()
          setFormError(null)
          if (!reason.trim()) return setFormError('A reason is required.')
          if (supportMode === 'document' ? !supportDoc : !statement.trim()) return setFormError('Link a supporting document or record an expert statement.')
          run(() => api(`/cases/${c.id}/resolve`, { body: {
            rowVersion: c.rowVersion, value, reason,
            outdatedClaimIds: others.filter((o) => isOutdated(o.claim.id)).map((o) => o.claim.id),
            supportingDocumentId: supportMode === 'document' ? supportDoc : null, expertStatement: supportMode === 'statement' ? statement : null,
          } }))
        }}>
          <h3>{ownAnswer ? 'Answer from your expertise' : 'Resolve with a supported answer'}</h3>
          {ownAnswer ? (
            <>
              <p className="notice">No current source covers this{tooOld.length ? ` — the only evidence is too old: ${tooOld.map((e) => `${e.claim.value} from “${e.source.title}”, ${e.freshness?.label}`).join('; ')}` : ''}. Your answer and statement are stored as a verified source and reused for similar questions.</p>
              <label>Correct value for {c.clientName}
                <input value={value} onChange={(e) => setValue(e.target.value)} aria-label="Correct value"
                  placeholder={c.key.topic === 'overtime_surcharge' ? 'e.g. 100%' : 'qualifies / does not qualify'} maxLength={20} />
              </label>
            </>
          ) : (
            <label>Correct value for {c.clientName}
              <select value={value} onChange={(e) => setValue(e.target.value)}>
                {values.map((v) => <option key={v} value={v}>{v} (from {applicable.filter((e) => e.claim.value === v).map((e) => e.source.documentId).join(', ')})</option>)}
              </select>
            </label>
          )}
          {others.length > 0 && (
            <fieldset>
              <legend>Mark as outdated (the original evidence is kept)</legend>
              {others.map((o) => (
                <label key={o.claim.id} className="check">
                  <input type="checkbox" checked={isOutdated(o.claim.id)} onChange={(e) => setOutdated({ ...outdated, [o.claim.id]: e.target.checked })} />
                  {o.claim.id} — {o.claim.value} from {o.source.title} ({o.source.documentId} v{o.source.version}){o.status === 'Too old' ? ` · ${o.freshness?.label}` : ''}
                </label>
              ))}
            </fieldset>
          )}
          <label><span>Reason <span className="req">(required)</span></span><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <fieldset>
            <legend>Supporting evidence <span className="req">(required)</span></legend>
            <label className="check"><input type="radio" checked={supportMode === 'document'} onChange={() => setSupportMode('document')} /> Link an active document</label>
            {supportMode === 'document' && (
              <select value={supportDoc} onChange={(e) => setSupportDoc(e.target.value)} aria-label="Supporting document">
                <option value="">Choose a document…</option>
                {c.activeDocuments.map((d) => <option key={d.documentId} value={d.documentId}>{d.documentId} · {d.title}</option>)}
              </select>
            )}
            <label className="check"><input type="radio" checked={supportMode === 'statement'} onChange={() => setSupportMode('statement')} /> Record an expert statement</label>
            {supportMode === 'statement' && <textarea rows={2} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="e.g. Confirmed against client file CF-… (fictional)" aria-label="Expert statement" />}
          </fieldset>
          <ErrorBox error={formError} />
          <button type="submit" className="btn btn-primary">Save resolution</button>
        </form>
      )}

      <div className="two-col">
        {c.status === 'open' && (
          <form className="resolution-form" onSubmit={(e) => { e.preventDefault(); if (infoMsg.trim()) run(() => api(`/cases/${c.id}/request-info`, { body: { rowVersion: c.rowVersion, message: infoMsg } })) }}>
            <h3>Request more information</h3>
            <textarea rows={2} value={infoMsg} onChange={(e) => setInfoMsg(e.target.value)} placeholder="What do you need from the consultant?" aria-label="Information request" />
            <button type="submit" className="btn">Send request</button>
          </form>
        )}
        <form className="resolution-form" onSubmit={(e) => { e.preventDefault(); if (unresolvedReason.trim()) run(() => api(`/cases/${c.id}/unresolved`, { body: { rowVersion: c.rowVersion, reason: unresolvedReason } })) }}>
          <h3>Leave unresolved</h3>
          <textarea rows={2} value={unresolvedReason} onChange={(e) => setUnresolvedReason(e.target.value)} placeholder="Why is the evidence insufficient?" aria-label="Reason for leaving unresolved" />
          <button type="submit" className="btn">Leave unresolved</button>
        </form>
      </div>
      <Badge tone="muted" icon="i">Case version {c.rowVersion} — a stale or concurrent submission is rejected</Badge>
    </div>
  )
}

function ReplyForm({ c, run }: { c: CaseDetail; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [msg, setMsg] = useState('')
  return (
    <form className="panel resolution-form" onSubmit={(e) => { e.preventDefault(); if (msg.trim()) run(() => api(`/cases/${c.id}/respond`, { body: { rowVersion: c.rowVersion, message: msg } })) }}>
      <h2>The expert asked for more information</h2>
      <textarea rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="Your reply" />
      <button type="submit" className="btn btn-primary">Send reply</button>
    </form>
  )
}
