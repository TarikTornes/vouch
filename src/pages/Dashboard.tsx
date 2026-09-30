import { useEffect, useState } from 'react'
import { api, type Me, type VersionView } from '../api'
import { Empty, ErrorBox, fmtDateTime, LifecycleBadge, PageHeader, QualityMeter } from '../components/common'

interface Dash {
  counts: { activeDocuments: number; awaitingReview: number; failedDocuments: number; openConflicts: number; requestsAwaiting: number; staleResolutions: number; oldSources: number }
  recentUploads: VersionView[]
  recentResolutions: { id: string; caseId: string; value: string; status: string; resolvedBy: string; resolvedAt: string; label: string; clientName: string }[]
}

export function DashboardPage({ me, tick }: { me: Me; tick: number }) {
  const [d, setD] = useState<Dash | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api<Dash>('/dashboard').then(setD).catch((e) => setError(e.message)) }, [tick])

  const cards = d ? [
    { label: 'Active documents', value: d.counts.activeDocuments, href: '#/documents?status=active', icon: '▤' },
    { label: 'Documents awaiting review', value: d.counts.awaitingReview, href: '#/documents?status=needs_review', icon: '✎', attention: d.counts.awaitingReview > 0 },
    { label: 'Open conflicts', value: d.counts.openConflicts, href: '#/health', icon: '⚠', attention: d.counts.openConflicts > 0 },
    { label: me.role === 'expert' ? 'Expert requests awaiting you' : 'Your expert requests in progress', value: d.counts.requestsAwaiting, href: '#/cases?status=awaiting', icon: '✉', attention: d.counts.requestsAwaiting > 0 },
    ...(d.counts.oldSources ? [{ label: 'Sources too old to decide', value: d.counts.oldSources, href: '#/health', icon: '🕓', attention: true }] : []),
    ...(d.counts.staleResolutions ? [{ label: 'Resolutions needing re-review', value: d.counts.staleResolutions, href: '#/health', icon: '⟲', attention: true }] : []),
    ...(d.counts.failedDocuments ? [{ label: 'Documents failed processing', value: d.counts.failedDocuments, href: '#/documents?status=failed', icon: '✕', attention: true }] : []),
  ] : []

  return (
    <section>
      <PageHeader
        title="Dashboard"
        subtitle={`Signed in as ${me.displayName}, ${me.roleTitle}. All figures come from the shared database.`}
        action={me.role === 'consultant' ? <a className="btn btn-primary" href="#/ask">Ask Vouch</a> : <a className="btn btn-primary" href="#/cases?status=awaiting">Open expert requests</a>}
      />
      <ErrorBox error={error} />
      <div className="card-grid">
        {cards.map((c) => (
          <a key={c.label} href={c.href} className={`stat-card ${c.attention ? 'stat-attention' : ''}`}>
            <span className="stat-icon" aria-hidden="true">{c.icon}</span>
            <span className="stat-value">{c.value}</span>
            <span className="stat-label">{c.label}</span>
            <span className="stat-link">Open list →</span>
          </a>
        ))}
      </div>

      <div className="two-col">
        <div className="panel">
          <h2>Recent uploads</h2>
          {d && !d.recentUploads.length && <Empty>No uploads yet.</Empty>}
          <ul className="list">
            {d?.recentUploads.map((v) => (
              <li key={v.id}>
                <a href={`#/documents/${v.documentId}`} className="list-row">
                  <div>
                    <strong>{v.title}</strong> <span className="meta">{v.documentId} v{v.version}</span>
                    <div className="meta">{v.sourceType} · added by {v.uploadedBy} · {fmtDateTime(v.uploadedAt)}</div>
                  </div>
                  <div className="list-side"><LifecycleBadge status={v.status} /><QualityMeter quality={v.quality} compact /></div>
                </a>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h2>Recent resolutions</h2>
          {d && !d.recentResolutions.length && <Empty>No expert resolutions yet.</Empty>}
          <ul className="list">
            {d?.recentResolutions.map((r) => (
              <li key={r.id}>
                <a href={`#/cases/${r.caseId}`} className="list-row">
                  <div>
                    <strong>{r.value}</strong> — {r.label} · {r.clientName}
                    <div className="meta">{r.id} by {r.resolvedBy} · {fmtDateTime(r.resolvedAt)}</div>
                  </div>
                  <span className={`badge ${r.status === 'active' ? 'badge-ok' : 'badge-warn'}`}>{r.status === 'active' ? '✓ Active' : r.status === 'needs_rereview' ? '⟲ Needs re-review' : 'Superseded'}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
