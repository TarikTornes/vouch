import { useState, type ReactNode } from 'react'
import { countryName } from '../../shared/evidence'
import { QUALITY_STOPS, qualityColor, type QualityResult } from '../../shared/quality'
import type { AnswerStatus, EvidenceItem, EvidenceStatus, Reason, Source } from '../../shared/types'
import type { EmailStatus } from '../api'

type Tone = 'ok' | 'warn' | 'no' | 'info' | 'muted' | 'brand'

export function Badge({ tone, icon, children }: { tone: Tone; icon?: string; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      {icon && <span aria-hidden="true">{icon}</span>} {children}
    </span>
  )
}

const STATUS_META: Record<AnswerStatus | EvidenceStatus, { icon: string; tone: Tone; text?: string }> = {
  Supported: { icon: '✓', tone: 'ok', text: 'Supported by sources' },
  Conflicting: { icon: '⚠', tone: 'warn' },
  Unsupported: { icon: '?', tone: 'muted' },
  Applicable: { icon: '✓', tone: 'ok' },
  Excluded: { icon: '⊘', tone: 'muted' },
  'Marked outdated by expert': { icon: '⟲', tone: 'no' },
  Copy: { icon: '⧉', tone: 'info', text: 'Copy — not counted' },
}

export function StatusBadge({ status, text }: { status: AnswerStatus | EvidenceStatus; text?: string }) {
  const m = STATUS_META[status]
  return <Badge tone={m.tone} icon={m.icon}>{text ?? m.text ?? status}</Badge>
}

export function AnswerBadge({ status, expertConfirmed }: { status: AnswerStatus; expertConfirmed?: boolean }) {
  if (expertConfirmed) return <Badge tone="ok" icon="★">Expert-confirmed</Badge>
  return <StatusBadge status={status} />
}

const LIFECYCLE: Record<string, { tone: Tone; icon: string; text: string }> = {
  uploaded: { tone: 'info', icon: '↑', text: 'Uploaded' },
  processing: { tone: 'info', icon: '⋯', text: 'Processing' },
  needs_review: { tone: 'warn', icon: '✎', text: 'Needs review' },
  active: { tone: 'ok', icon: '✓', text: 'Active' },
  superseded: { tone: 'muted', icon: '⤓', text: 'Superseded' },
  failed: { tone: 'no', icon: '✕', text: 'Processing failed' },
  rejected: { tone: 'muted', icon: '⊘', text: 'Rejected' },
}
export const LifecycleBadge = ({ status }: { status: string }) => {
  const m = LIFECYCLE[status] ?? { tone: 'muted' as Tone, icon: '•', text: status }
  return <Badge tone={m.tone} icon={m.icon}>{m.text}</Badge>
}

const CASE_STATUS: Record<string, { tone: Tone; icon: string; text: string }> = {
  open: { tone: 'warn', icon: '●', text: 'Awaiting expert' },
  info_requested: { tone: 'info', icon: '?', text: 'Information requested' },
  resolved: { tone: 'ok', icon: '✓', text: 'Resolved' },
  unresolved: { tone: 'muted', icon: '⊘', text: 'Left unresolved' },
}
export const CaseStatusBadge = ({ status }: { status: string }) => {
  const m = CASE_STATUS[status] ?? { tone: 'muted' as Tone, icon: '•', text: status }
  return <Badge tone={m.tone} icon={m.icon}>{m.text}</Badge>
}

const REASON_ICON = { ok: '✓', no: '✕', warn: '!', info: 'i' } as const

export function ReasonList({ reasons }: { reasons: Reason[] }) {
  return (
    <ul className="reasons">
      {reasons.map((r, i) => (
        <li key={i} className={`reason reason-${r.kind}`}>
          <span className="reason-icon" aria-hidden="true">{REASON_ICON[r.kind]}</span>
          <span>{r.text}</span>
        </li>
      ))}
    </ul>
  )
}

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
export const fmtDateTime = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export function EvidenceCard({ item, onOpenSource }: { item: EvidenceItem; onOpenSource: (s: Source) => void }) {
  const { claim, source, status, reasons } = item
  return (
    <article className={`evidence evidence-${status === 'Applicable' ? 'applicable' : status === 'Copy' ? 'copy' : 'dim'}`}>
      <header className="evidence-head">
        <span className="value">{claim.value}</span>
        <StatusBadge status={status} />
      </header>
      <div className="evidence-title">
        <span className="eyebrow">{source.type}</span>
        <strong>{source.title}</strong>
      </div>
      <div className="meta">
        {countryName(source.country)} · updated {fmtDate(source.updated)} · {source.documentId} v{source.version}
        <br />
        Owner: {source.ownerName ?? <span className="warn-text">No owner</span>}
      </div>
      <blockquote className="excerpt">
        “{claim.excerpt}”
        <footer>
          Claim {claim.id}{claim.location ? ` · ${claim.location}` : ''} ·{' '}
          <button type="button" className="linkish" onClick={() => onOpenSource(source)}>view source</button>
        </footer>
      </blockquote>
      <ReasonList reasons={reasons} />
    </article>
  )
}

/** Shows the full stored text of the exact source version, with the claim excerpt highlighted. */
export function SourceModal({ source, highlight, onClose }: { source: Source; highlight?: string; onClose: () => void }) {
  const idx = highlight ? source.text.indexOf(highlight) : -1
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={source.title} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <span className="eyebrow">{source.type} · {source.documentId} v{source.version}</span>
            <h3>{source.title}</h3>
          </div>
          <button type="button" className="btn" onClick={onClose} autoFocus>Close</button>
        </header>
        <dl className="kv">
          <dt>Country</dt><dd>{countryName(source.country)}</dd>
          <dt>Updated</dt><dd>{fmtDate(source.updated)}</dd>
          <dt>Owner</dt><dd>{source.ownerName ?? 'No owner'}</dd>
          <dt>Content hash</dt><dd><code>{source.contentHash.slice(0, 16)}…</code></dd>
          {source.link && <><dt>Location</dt><dd><code>{source.link}</code></dd></>}
        </dl>
        <h4>Stored text</h4>
        <p className="fulltext">
          {idx >= 0 ? <>{source.text.slice(0, idx)}<mark>{highlight}</mark>{source.text.slice(idx + highlight!.length)}</> : source.text}
        </p>
        <p className="meta">Synthetic demonstration content.</p>
      </div>
    </div>
  )
}

export function useSourceModal() {
  const [open, setOpen] = useState<Source | null>(null)
  return { onOpenSource: setOpen, modal: open ? <SourceModal source={open} onClose={() => setOpen(null)} /> : null }
}

const GRADIENT = `linear-gradient(90deg, ${QUALITY_STOPS.map(([p, c]) => `${c} ${p}%`).join(', ')})`

/** Document quality checks: a checklist score, never a probability of correctness. */
export function QualityMeter({ quality, compact }: { quality: QualityResult; compact?: boolean }) {
  if (!quality.assessed || quality.score === null) {
    return <div className="quality quality-na"><span className="quality-label">Document quality checks: <strong>Not assessed</strong></span>{!compact && <p className="meta">{quality.note}</p>}</div>
  }
  const done = quality.checks.filter((c) => c.passed).length
  return (
    <div className={`quality ${compact ? 'quality-compact' : ''}`}>
      <div className="quality-label">
        {!compact && <span>Document quality checks</span>}
        <strong>{quality.score}%</strong> <span className="meta">· {done} of {quality.checks.length} checks</span>
      </div>
      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={quality.score} aria-label={`Document quality checks ${quality.score}%, ${done} of 5 checks complete`}>
        <div className="meter-track" style={{ background: GRADIENT }} />
        <div className="meter-marker" style={{ left: `${quality.score}%`, borderColor: qualityColor(quality.score) }} />
      </div>
      {!compact && (
        <>
          <ul className="checks">
            {quality.checks.map((c) => (
              <li key={c.key} className={c.passed ? 'check-ok' : 'check-no'}>
                <span className="reason-icon" aria-hidden="true">{c.passed ? '✓' : '✕'}</span>
                <div><strong>{c.label}</strong> <span className="sr-only">{c.passed ? 'complete' : 'missing'}</span>{' '}<span className="meta">+{c.passed ? 20 : 0}</span><div className="meta">{c.evidence}</div></div>
              </li>
            ))}
          </ul>
          <p className="meta">{quality.note} A high score never hides a conflict or picks which value wins.</p>
        </>
      )}
    </div>
  )
}

export function EmailStatusLine({ email, onRetry }: { email: EmailStatus; onRetry?: () => void }) {
  const map = {
    queued: { tone: 'info' as Tone, icon: '⋯', text: 'Email queued' },
    sending: { tone: 'info' as Tone, icon: '⋯', text: 'Email sending' },
    accepted: { tone: 'ok' as Tone, icon: '✉', text: 'Email accepted by provider' },
    failed: { tone: 'no' as Tone, icon: '✕', text: 'Email failed' },
  }[email.status]
  return (
    <div className="email-line">
      <Badge tone={map.tone} icon={map.icon}>{map.text}</Badge>
      <span className="meta">
        to {email.recipient} · attempt {email.attempts}{email.provider_message_id ? ` · provider id ${email.provider_message_id}` : ''} · {fmtDateTime(email.updated_at)}
        {email.status === 'accepted' && ' · acceptance is not proof of inbox delivery'}
      </span>
      {email.status === 'failed' && <span className="error-text">{email.last_error}</span>}
      {email.status === 'failed' && onRetry && <button type="button" className="btn btn-small" onClick={onRetry}>Retry email</button>}
    </div>
  )
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null
  return <p className="error" role="alert"><span aria-hidden="true">✕</span> {error}</p>
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {action && <div className="page-action">{action}</div>}
    </header>
  )
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>
