import { useEffect, useState } from 'react'
import { countryName } from '../../shared/evidence'
import { api, type VersionView } from '../api'
import type { Freshness } from '../../shared/freshness'
import { Empty, ErrorBox, fmtDate, fmtDateTime, FreshnessBadge, PageHeader, QualityMeter } from '../components/common'

interface Health {
  openConflicts: { label: string; key: { country: string; client: string }; clientName: string; expert: string | null; values: string[] }[]
  outdatedClaims: { claimId: string; value: string; documentId: string; title: string; duplicateOf: string | null; resolutionId: string; resolvedBy: string; resolvedAt: string }[]
  ownerlessSources: { documentId: string; title: string; updated: string | null }[]
  staleSources: { documentId: string; title: string; updated: string | null; freshness: Freshness }[]
  staleResolutions: { id: string; value: string; reason: string | null; clientName: string }[]
  documents: VersionView[]
}

export function HealthPage() {
  const [h, setH] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api<Health>('/health-report').then(setH).catch((e) => setError(e.message)) }, [])
  return (
    <section>
      <PageHeader title="Knowledge health" subtitle="Computed from the current database: conflicts, source freshness, outdated claims, stale approvals, ownership and document checks." />
      <ErrorBox error={error} />
      {h && (
        <>
          <div className="card-grid">
            <div className="stat-card static"><span className="stat-icon" aria-hidden="true">⚠</span><span className="stat-value">{h.openConflicts.length}</span><span className="stat-label">Open conflicts</span></div>
            <div className="stat-card static"><span className="stat-icon" aria-hidden="true">⟲</span><span className="stat-value">{h.staleResolutions.length}</span><span className="stat-label">Resolutions needing re-review</span></div>
            <div className="stat-card static"><span className="stat-icon" aria-hidden="true">⊘</span><span className="stat-value">{h.outdatedClaims.length}</span><span className="stat-label">Claims marked outdated</span></div>
            <div className="stat-card static"><span className="stat-icon" aria-hidden="true">∅</span><span className="stat-value">{h.ownerlessSources.length}</span><span className="stat-label">Ownerless sources</span></div>
            <div className="stat-card static"><span className="stat-icon" aria-hidden="true">🕓</span><span className="stat-value">{h.staleSources.filter((x) => x.freshness.level === 'stale' || x.freshness.level === 'expired').length}</span><span className="stat-label">Sources too old to decide</span></div>
          </div>
          <div className="panel">
            <h2>Freshness: sources due for review or too old</h2>
            <p className="meta">Current ≤ 12 months · due for review 12–24 months · older than 24 months is shown for context but never decides an answer.</p>
            {!h.staleSources.length ? <Empty>All sources are current.</Empty> : (
              <ul className="list plain">{h.staleSources.map((s) => <li key={s.documentId}><FreshnessBadge freshness={s.freshness} /> <a href={`#/documents/${s.documentId}`}>{s.documentId} · {s.title}</a> — updated {fmtDate(s.updated)}</li>)}</ul>
            )}
          </div>
          <div className="panel">
            <h2>Open conflicts</h2>
            {!h.openConflicts.length ? <Empty>None.</Empty> : (
              <ul className="list plain">{h.openConflicts.map((c, i) => <li key={i}><strong>{countryName(c.key.country)} / {c.clientName}</strong> — {c.label}: {c.values.join(' vs ')}{c.expert && <span className="meta"> · owner {c.expert}</span>}</li>)}</ul>
            )}
          </div>
          <div className="panel">
            <h2>Resolutions needing re-review</h2>
            {!h.staleResolutions.length ? <Empty>None.</Empty> : (
              <ul className="list plain">{h.staleResolutions.map((r) => <li key={r.id}><strong>{r.id}</strong> ({r.value}, {r.clientName}) — {r.reason}</li>)}</ul>
            )}
          </div>
          <div className="panel">
            <h2>Claims marked outdated by an expert</h2>
            {!h.outdatedClaims.length ? <Empty>None.</Empty> : (
              <ul className="list plain">{h.outdatedClaims.map((o) => <li key={o.claimId}>{o.claimId} ({o.value}) in <a href={`#/documents/${o.documentId}`}>{o.documentId} · {o.title}</a>{o.duplicateOf && ` — copy of ${o.duplicateOf}`} · {o.resolutionId} by {o.resolvedBy}, {fmtDateTime(o.resolvedAt)}</li>)}</ul>
            )}
          </div>
          <div className="panel">
            <h2>Ownerless sources</h2>
            {!h.ownerlessSources.length ? <Empty>None.</Empty> : (
              <ul className="list plain">{h.ownerlessSources.map((s) => <li key={s.documentId}><a href={`#/documents/${s.documentId}`}>{s.documentId} · {s.title}</a> — updated {fmtDate(s.updated)}. Nobody is accountable for keeping it current.</li>)}</ul>
            )}
          </div>
          <div className="panel">
            <h2>Document quality checks (active documents)</h2>
            <table className="table">
              <thead><tr><th>Document</th><th>Checks</th></tr></thead>
              <tbody>{h.documents.map((d) => <tr key={d.id}><td><a href={`#/documents/${d.documentId}`}>{d.title}</a><div className="meta">{d.documentId} v{d.version}</div></td><td style={{ minWidth: 220 }}><QualityMeter quality={d.quality} compact /><div className="meta">{d.quality.checks.filter((c) => !c.passed).map((c) => `missing: ${c.label}`).join(' · ') || 'all checks complete'}</div></td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
