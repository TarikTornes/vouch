import { useCallback, useEffect, useState } from 'react'
import { CONDITION_LABEL, countryName } from '../../shared/evidence'
import { CONDITIONS, SOURCE_TYPES, TOPICS } from '../../shared/types'
import { api, type ClaimRow, type Me, type Meta, type VersionView } from '../api'
import type { Route } from '../App'
import { go } from '../App'
import { Badge, Empty, ErrorBox, fmtDate, fmtDateTime, LifecycleBadge, PageHeader, QualityMeter } from '../components/common'

const STATUS_FILTERS = [
  { id: '', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'needs_review', label: 'Needs review' },
  { id: 'processing', label: 'Processing' }, { id: 'failed', label: 'Failed' }, { id: 'rejected', label: 'Rejected' },
]

const scopeLabel = (client: string, meta: Meta | null) =>
  client === '*' ? 'General (all clients)' : client === 'unknown' ? 'Unknown client scope' : meta?.clients.find((c) => c.id === client)?.name ?? client

export function DocumentsPage({ route, me }: { route: Route; me: Me }) {
  const status = route.query.get('status') ?? ''
  const [docs, setDocs] = useState<VersionView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api<{ documents: VersionView[] }>(`/documents${status ? `?status=${status}` : ''}`).then((r) => setDocs(r.documents)).catch((e) => setError(e.message)) }, [status])
  return (
    <section>
      <PageHeader title="Documents" subtitle="Sources Vouch can cite. New documents are extracted live by Claude and activated only after human review."
        action={me.role === 'consultant' && <a className="btn btn-primary" href="#/documents/new">Add document</a>} />
      <div className="filters" role="group" aria-label="Filter by status">
        {STATUS_FILTERS.map((f) => <a key={f.id} href={`#/documents${f.id ? `?status=${f.id}` : ''}`} className={`chip ${status === f.id ? 'chip-active' : ''}`} aria-current={status === f.id ? 'true' : undefined}>{f.label}</a>)}
      </div>
      <ErrorBox error={error} />
      {docs && !docs.length && <Empty>No documents with this status.</Empty>}
      {docs && docs.length > 0 && (
        <table className="table">
          <thead><tr><th>Document</th><th>Status</th><th>Scope</th><th>Claims</th><th>Quality checks</th><th>Added</th></tr></thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} onClick={() => go(`#/documents/${d.documentId}`)} className="clickable">
                <td><a href={`#/documents/${d.documentId}`}><strong>{d.title}</strong></a><div className="meta">{d.documentId} v{d.version} · {d.sourceType} · owner {d.ownerName ?? '—'}</div></td>
                <td><LifecycleBadge status={d.status} /></td>
                <td className="meta">{countryName(d.country)}<br />{d.client === '*' ? 'All clients' : d.client === 'unknown' ? 'Unknown client' : d.client}</td>
                <td className="meta">{d.claimCounts.confirmed} confirmed{d.claimCounts.proposed ? ` · ${d.claimCounts.proposed} to review` : ''}{d.claimCounts.invalid ? ` · ${d.claimCounts.invalid} rejected (untraceable)` : ''}</td>
                <td style={{ minWidth: 170 }}><QualityMeter quality={d.quality} compact /></td>
                <td className="meta">{fmtDate(d.uploadedAt)}<br />{d.uploadedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export function NewDocumentPage({ meta, route }: { meta: Meta | null; route: Route }) {
  const existingId = route.query.get('version-of')
  const [existing, setExisting] = useState<VersionView | null>(null)
  const [mode, setMode] = useState<'upload' | 'paste'>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [f, setF] = useState({ title: '', sourceType: 'Other', ownerName: '', country: 'unknown', client: 'unknown', link: '', sourceUpdated: '', effectiveFrom: '', effectiveTo: '', text: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!existingId) return
    api<{ versions: VersionView[] }>(`/documents/${existingId}`).then((r) => {
      const v = r.versions[0]
      setExisting(v)
      setF((x) => ({ ...x, title: v.title, sourceType: v.sourceType, ownerName: v.ownerName ?? '', country: v.country, client: v.client, link: v.link ?? '' }))
    })
  }, [existingId])
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (mode === 'upload' && !file) return setError('Choose a file, or switch to “Paste text”.')
    const form = new FormData()
    Object.entries(f).forEach(([k, v]) => { if (k !== 'text' && v) form.append(k, v) })
    if (mode === 'upload' && file) form.append('file', file)
    else form.append('text', f.text)
    setBusy(true)
    try {
      const r = await api<{ documentId: string }>(existingId ? `/documents/${existingId}/versions` : '/documents', { form })
      go(`#/documents/${r.documentId}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <PageHeader title={existing ? `New version of ${existing.documentId}` : 'Add document'} subtitle="Use fictional content only. Unknown scope stays unknown — it never silently becomes “all countries” or “all clients”." />
      <form className="panel form-grid" onSubmit={submit}>
        <div className="segmented" role="tablist" aria-label="Input method">
          <button type="button" role="tab" aria-selected={mode === 'upload'} className={mode === 'upload' ? 'seg-active' : ''} onClick={() => setMode('upload')}>Upload file</button>
          <button type="button" role="tab" aria-selected={mode === 'paste'} className={mode === 'paste' ? 'seg-active' : ''} onClick={() => setMode('paste')}>Paste text</button>
        </div>
        {mode === 'upload' ? (
          <label className="span-2">File (.txt, .md or text-based .pdf, max 1 MB)
            <input type="file" accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <span className="meta">Scanned PDFs cannot be read (no OCR) — paste their text instead.</span>
          </label>
        ) : (
          <label className="span-2">Document text (max 30,000 characters)
            <textarea rows={10} value={f.text} onChange={set('text')} required={mode === 'paste'} />
          </label>
        )}
        <label className="span-2">Title<input value={f.title} onChange={set('title')} required maxLength={200} /></label>
        <label>Source type
          <select value={f.sourceType} onChange={set('sourceType')}>{SOURCE_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
        </label>
        <label>Owner (responsible person)<input value={f.ownerName} onChange={set('ownerName')} placeholder="Leave empty if nobody owns it" /></label>
        <label>Country
          <select value={f.country} onChange={set('country')}>
            <option value="unknown">Unknown</option><option value="BE">Belgium</option><option value="NL">Netherlands</option>
          </select>
        </label>
        <label>Client scope
          <select value={f.client} onChange={set('client')}>
            <option value="unknown">Unknown</option><option value="*">General (all clients)</option>
            {meta?.clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.country})</option>)}
          </select>
        </label>
        <label>Source date (last updated)<input type="date" value={f.sourceUpdated} onChange={set('sourceUpdated')} /></label>
        <label>Location / link (optional)<input value={f.link} onChange={set('link')} placeholder="e.g. demo://sharepoint/…" /></label>
        <label>Effective from<input type="date" value={f.effectiveFrom} onChange={set('effectiveFrom')} /></label>
        <label>Effective to<input type="date" value={f.effectiveTo} onChange={set('effectiveTo')} /></label>
        <div className="span-2 form-actions">
          <ErrorBox error={error} />
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Uploading…' : meta?.interpreter.kind === 'claude' ? 'Upload and extract claims' : 'Upload document'}</button>
          <span className="meta">{meta?.interpreter.kind === 'claude'
            ? 'The text is sent to Claude for claim extraction. Claude treats it as data, not instructions.'
            : 'No LLM connected: after upload you enter the claims yourself, each tied to an exact excerpt of the text.'}</span>
        </div>
      </form>
    </section>
  )
}

const STEPS = ['uploaded', 'processing', 'needs_review', 'active']
function Lifecycle({ status, extractionSkipped }: { status: string; extractionSkipped: boolean }) {
  const failed = status === 'failed' || status === 'rejected'
  const idx = STEPS.indexOf(status === 'superseded' ? 'active' : status)
  return (
    <ol className="steps" aria-label="Processing lifecycle">
      {STEPS.map((s, i) => (
        <li key={s} className={i < idx || (i === idx && s === 'active') ? 'step-done' : i === idx ? 'step-current' : ''} aria-current={i === idx ? 'step' : undefined}>
          <span aria-hidden="true">{i < idx || (i === idx && s === 'active') ? '✓' : i + 1}</span> {{ uploaded: 'Uploaded', processing: extractionSkipped ? 'Processing (skipped — no LLM)' : 'Processing', needs_review: 'Needs review', active: 'Active' }[s]}
        </li>
      ))}
      {failed && <li className="step-failed"><span aria-hidden="true">✕</span> {status === 'failed' ? 'Failed' : 'Rejected'}</li>}
    </ol>
  )
}

export function DocumentDetailPage({ id, me, meta, onChanged }: { id: string; me: Me; meta: Meta | null; onChanged: () => void }) {
  const [versions, setVersions] = useState<VersionView[] | null>(null)
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [currency, setCurrency] = useState(false)
  const [selection, setSelection] = useState('')
  const load = useCallback(() => api<{ versions: VersionView[] }>(`/documents/${id}`).then((r) => setVersions(r.versions)).catch((e) => setError(e.message)), [id])
  useEffect(() => { load() }, [load])
  const v = versions?.[selected]
  useEffect(() => {
    if (v && (v.status === 'processing' || v.status === 'uploaded')) {
      const t = setInterval(load, 1500)
      return () => clearInterval(t)
    }
  }, [v, load])
  if (!versions || !v) return <section><ErrorBox error={error} />{!error && <p>Loading…</p>}</section>

  const act = async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    setError(null)
    setNotice(null)
    try {
      await fn()
      if (ok) setNotice(ok)
      await load()
      onChanged()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    }
  }
  const canEdit = me.role === 'consultant' && v.status === 'needs_review'
  const claims = v.claims ?? []

  return (
    <section>
      <PageHeader
        title={v.title}
        subtitle={<>{v.documentId} · version {v.version} · {v.sourceType} · owner {v.ownerName ?? <span className="warn-text">none</span>} · {countryName(v.country)} · {scopeLabel(v.client, meta)}</>}
        action={me.role === 'consultant' && v.status !== 'processing' && <a className="btn" href={`#/documents/new?version-of=${v.documentId}`}>Upload new version</a>}
      />
      {versions.length > 1 && (
        <div className="filters" role="group" aria-label="Versions">
          {versions.map((x, i) => <button key={x.id} type="button" className={`chip ${i === selected ? 'chip-active' : ''}`} onClick={() => setSelected(i)}>v{x.version} · {x.status}</button>)}
        </div>
      )}
      <Lifecycle status={v.status} extractionSkipped={!v.llmModel && !!v.failureReason?.startsWith('No LLM')} />
      <ErrorBox error={error} />
      {notice && <p className="notice" role="status">{notice}</p>}

      {v.status === 'processing' && <p className="notice" role="status">Claude ({v.llmModel}) is extracting claims… started {fmtDateTime(v.processingStartedAt)}.</p>}
      {v.status === 'failed' && (
        <div className="panel panel-error">
          <strong>Processing failed:</strong> {v.failureReason}
          {me.role === 'consultant' && (
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => act(() => api(`/versions/${v.id}/reprocess`, { body: {} }))}>Retry extraction</button>
              <button type="button" className="btn" onClick={() => act(() => api(`/versions/${v.id}/reject`, { body: { reason: 'Rejected after failed processing' } }))}>Reject version</button>
            </div>
          )}
        </div>
      )}
      {v.failureReason && v.status === 'needs_review' && <p className="notice">{v.failureReason}</p>}

      <div className="doc-layout">
        <div>
          <div className="panel">
            <h2>Claims</h2>
            <p className="meta">
              {v.llmModel ? <>Extracted by Claude ({v.llmModel}){v.processingFinishedAt ? ` in ${Math.max(1, Math.round((+new Date(v.processingFinishedAt) - +new Date(v.processingStartedAt!)) / 1000))} s` : ''}. </> : claims.some((c) => c.origin === 'seed') ? 'Seed claims (hand-written synthetic data). ' : 'Entered manually by a consultant (no LLM connected). '}
              Excerpts are checked against the stored text: this proves traceability, not truth.
            </p>
            {!claims.length && v.status !== 'processing' && <Empty>No claims.</Empty>}
            {claims.map((c) => <ClaimEditor key={c.id + c.status + (c.reviewedAt ?? '')} claim={c} meta={meta} canEdit={canEdit} onSave={(body) => act(() => api(`/claims/${c.id}`, { method: 'PATCH', body }))} />)}
          </div>
          {canEdit && <ManualClaimForm meta={meta} selection={selection} defaults={{ country: v.country, client: v.client }} onAdd={(body) => act(() => api(`/versions/${v.id}/claims`, { body }), 'Claim added and confirmed.')} />}

          {canEdit && (
            <div className="panel">
              <h2>Activate this version</h2>
              <p className="meta">Every claim must be confirmed or rejected. Activation makes confirmed claims available to answers and may send earlier expert resolutions back for re-review.</p>
              <label className="check"><input type="checkbox" checked={currency} onChange={(e) => setCurrency(e.target.checked)} /> I reviewed the source date and effective dates (currency check)</label>
              <div className="form-actions">
                <button type="button" className="btn btn-primary" onClick={() => act(async () => {
                  const r = await api<{ rereviewCases: string[]; emails: { status: string }[] }>(`/versions/${v.id}/activate`, { body: { currencyReviewed: currency } })
                  if (r.rereviewCases.length) setTimeout(() => setNotice(`Activated. New evidence affects an earlier expert resolution: re-review case ${r.rereviewCases.join(', ')} opened (email ${r.emails.map((e) => e.status).join(', ') || 'not sent'}).`), 0)
                }, 'Activated. Confirmed claims now count as evidence.')}>Activate version</button>
                <button type="button" className="btn" onClick={() => act(() => api(`/versions/${v.id}/reject`, { body: { reason: 'Rejected during review' } }))}>Reject version</button>
              </div>
            </div>
          )}
        </div>

        <aside>
          <div className="panel"><QualityMeter quality={v.quality} /></div>
          <div className="panel">
            <h2>Original text</h2>
            {canEdit && <p className="meta">Tip: select a passage below, then use “Use selected text” in the claim form.</p>}
            <div onMouseUp={() => { const s = window.getSelection()?.toString().trim(); if (s) setSelection(s) }}>
              <Highlighted text={v.text ?? ''} excerpts={claims.filter((c) => c.status !== 'invalid' && c.status !== 'rejected').map((c) => c.excerpt)} />
            </div>
            <dl className="kv small">
              <dt>File</dt><dd>{v.originalFilename ?? (v.mimeType === 'text/plain (pasted)' ? 'Pasted text' : '—')}{v.sizeBytes ? ` · ${v.sizeBytes} bytes` : ''}</dd>
              <dt>SHA-256</dt><dd><code>{v.contentHash.slice(0, 20)}…</code></dd>
              <dt>Added</dt><dd>{v.uploadedBy} · {fmtDateTime(v.uploadedAt)}</dd>
              <dt>Reviewed</dt><dd>{v.reviewedBy ? `${v.reviewedBy} · ${fmtDateTime(v.reviewedAt)}` : 'Not yet'}</dd>
              <dt>Dates</dt><dd>updated {v.sourceUpdated ?? '—'} · effective {v.effectiveFrom ?? '—'} → {v.effectiveTo ?? '—'}</dd>
            </dl>
          </div>
        </aside>
      </div>
    </section>
  )
}

function Highlighted({ text, excerpts }: { text: string; excerpts: string[] }) {
  const ranges = excerpts.map((e) => { const i = text.indexOf(e); return i >= 0 ? [i, i + e.length] as const : null }).filter(Boolean) as (readonly [number, number])[]
  ranges.sort((a, b) => a[0] - b[0])
  const parts: React.ReactNode[] = []
  let pos = 0
  ranges.forEach(([s, e], i) => {
    if (s < pos) return
    parts.push(text.slice(pos, s), <mark key={i}>{text.slice(s, e)}</mark>)
    pos = e
  })
  parts.push(text.slice(pos))
  return <div className="fulltext">{parts}</div>
}

function ClaimEditor({ claim, meta, canEdit, onSave }: { claim: ClaimRow; meta: Meta | null; canEdit: boolean; onSave: (body: object) => void }) {
  const [c, setC] = useState({ topic: claim.topic, condition: claim.condition, country: claim.country, client: claim.client, value: claim.value, excerpt: claim.excerpt, effectiveFrom: claim.effectiveFrom ?? '', exceptionLabel: claim.exceptionLabel ?? '', exceptionDocumentedBy: claim.exceptionDocumentedBy ?? '' })
  const set = (k: keyof typeof c) => (e: { target: { value: string } }) => setC((x) => ({ ...x, [k]: e.target.value }))
  const body = (status: string) => ({ status, ...c, effectiveFrom: c.effectiveFrom || null, exceptionLabel: c.exceptionLabel || null, exceptionDocumentedBy: c.exceptionDocumentedBy || null })
  const tone = claim.status === 'confirmed' ? 'ok' : claim.status === 'rejected' ? 'muted' : claim.status === 'invalid' ? 'no' : 'warn'
  const statusText = { confirmed: '✓ Confirmed', rejected: '⊘ Rejected', invalid: '✕ Untraceable — rejected', proposed: '✎ Proposed by Claude — needs review' }[claim.status]
  return (
    <article className={`claim-edit claim-edit-${claim.status}`}>
      <header className="evidence-head">
        <span className="value">{claim.value}</span>
        <span className={`badge badge-${tone}`}>{statusText}</span>
      </header>
      <blockquote className="excerpt">“{claim.excerpt}”<footer>Claim {claim.id}{claim.location ? ` · ${claim.location}` : ''} · origin {claim.origin === 'llm' ? 'Claude extraction' : claim.origin}{claim.reviewedBy ? ` · reviewed by ${claim.reviewedBy}` : ''}</footer></blockquote>
      {claim.invalidReason && <p className="error-text">{claim.invalidReason}</p>}
      {claim.duplicateOf && <Badge tone="info" icon="⧉">Copy of {claim.duplicateOf} — not independent corroboration</Badge>}
      {!canEdit ? (
        <p className="meta">
          {claim.topic === 'overtime_surcharge' ? 'Surcharge' : 'Eligibility'} · {CONDITION_LABEL[claim.condition]} · {countryName(claim.country)} · {scopeLabel(claim.client, meta)}
          {claim.effectiveFrom ? ` · effective from ${claim.effectiveFrom}` : ''}{claim.exceptionLabel ? ` · exception: ${claim.exceptionLabel}${claim.exceptionAgreementRef ? ` (${claim.exceptionAgreementRef})` : ''}${claim.exceptionDocumentedBy ? `, documented in ${claim.exceptionDocumentedBy}` : ', not documented'}` : ''}
          {claim.scopeSource ? <><br />Scope source: {claim.scopeSource}</> : null}
        </p>
      ) : (
        <div className="claim-form">
          <label>Topic<select value={c.topic} onChange={set('topic')}>{TOPICS.map((t) => <option key={t} value={t}>{t === 'overtime_surcharge' ? 'Overtime surcharge' : 'Overtime eligibility'}</option>)}</select></label>
          <label>Condition<select value={c.condition} onChange={set('condition')}>{CONDITIONS.map((t) => <option key={t} value={t}>{CONDITION_LABEL[t]}</option>)}</select></label>
          <label>Value<input value={c.value} onChange={set('value')} /></label>
          <label>Country<select value={c.country} onChange={set('country')}><option value="unknown">Unknown</option><option value="BE">Belgium</option><option value="NL">Netherlands</option></select></label>
          <label>Client scope<select value={c.client} onChange={set('client')}><option value="unknown">Unknown</option><option value="*">General (all clients)</option>{meta?.clients.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          <label>Effective from<input type="date" value={c.effectiveFrom} onChange={set('effectiveFrom')} /></label>
          <label className="span-2">Claimed exception<input value={c.exceptionLabel} onChange={set('exceptionLabel')} placeholder="None" /></label>
          <label>Exception documented by (document id)<input value={c.exceptionDocumentedBy} onChange={set('exceptionDocumentedBy')} placeholder="Leave empty if not supplied" /></label>
          <label className="span-3">Excerpt (must appear verbatim in the text)<textarea rows={2} value={c.excerpt} onChange={set('excerpt')} /></label>
          <p className="meta span-3">Scope source: {claim.scopeSource ?? '—'}. {claim.exceptionAgreementRef ? `Referenced agreement: ${claim.exceptionAgreementRef}.` : ''}</p>
          <div className="form-actions span-3">
            <button type="button" className="btn btn-primary btn-small" onClick={() => onSave(body('confirmed'))}>Confirm claim</button>
            <button type="button" className="btn btn-small" onClick={() => onSave(body('rejected'))}>Reject claim</button>
          </div>
        </div>
      )}
    </article>
  )
}

function ManualClaimForm({ meta, selection, defaults, onAdd }: { meta: Meta | null; selection: string; defaults: { country: string; client: string }; onAdd: (body: object) => Promise<boolean> }) {
  const empty = { topic: 'overtime_surcharge', condition: 'saturday', country: defaults.country, client: defaults.client, value: '', excerpt: '', effectiveFrom: '', exceptionLabel: '', exceptionAgreementRef: '', exceptionDocumentedBy: '' }
  const [c, setC] = useState(empty)
  const set = (k: keyof typeof c) => (e: { target: { value: string } }) => setC((x) => ({ ...x, [k]: e.target.value }))
  return (
    <form className="panel" onSubmit={async (e) => {
      e.preventDefault()
      // Keep the entered values when the server rejects the claim, so it can be corrected.
      if (await onAdd({ ...c, effectiveFrom: c.effectiveFrom || null, exceptionLabel: c.exceptionLabel || null, exceptionAgreementRef: c.exceptionAgreementRef || null, exceptionDocumentedBy: c.exceptionDocumentedBy || null })) setC(empty)
    }}>
      <h2>Add a claim manually</h2>
      <p className="meta">No LLM extraction is used. You state the claim and quote the exact passage that supports it; the server rejects excerpts that are not in the text. Unknown scope stays unknown.</p>
      <div className="claim-form">
        <label>Topic<select value={c.topic} onChange={set('topic')}>{TOPICS.map((t) => <option key={t} value={t}>{t === 'overtime_surcharge' ? 'Overtime surcharge' : 'Overtime eligibility'}</option>)}</select></label>
        <label>Condition<select value={c.condition} onChange={set('condition')}>{CONDITIONS.map((t) => <option key={t} value={t}>{CONDITION_LABEL[t]}</option>)}</select></label>
        <label>Value<input value={c.value} onChange={set('value')} placeholder={c.topic === 'overtime_surcharge' ? 'e.g. 60%' : 'qualifies / does_not_qualify'} required /></label>
        <label>Country<select value={c.country} onChange={set('country')}><option value="unknown">Unknown</option><option value="BE">Belgium</option><option value="NL">Netherlands</option></select></label>
        <label>Client scope<select value={c.client} onChange={set('client')}><option value="unknown">Unknown</option><option value="*">General (all clients)</option>{meta?.clients.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Effective from<input type="date" value={c.effectiveFrom} onChange={set('effectiveFrom')} /></label>
        <label className="span-3">Supporting excerpt (exact text)
          <textarea rows={2} value={c.excerpt} onChange={set('excerpt')} required />
        </label>
        <div className="span-3 form-actions">
          <button type="button" className="btn btn-small" disabled={!selection} onClick={() => setC((x) => ({ ...x, excerpt: selection }))}>Use selected text</button>
          {selection && <span className="meta">Selected: “{selection.length > 80 ? selection.slice(0, 80) + '…' : selection}”</span>}
        </div>
        <label>Claimed exception (if any)<input value={c.exceptionLabel} onChange={set('exceptionLabel')} placeholder="e.g. client agreement" /></label>
        <label>Referenced agreement<input value={c.exceptionAgreementRef} onChange={set('exceptionAgreementRef')} placeholder="e.g. JA-2026-02" /></label>
        <label>Exception documented by (document id)<input value={c.exceptionDocumentedBy} onChange={set('exceptionDocumentedBy')} placeholder="Leave empty if not supplied" /></label>
      </div>
      <div className="form-actions"><button type="submit" className="btn btn-primary">Add and confirm claim</button></div>
    </form>
  )
}
