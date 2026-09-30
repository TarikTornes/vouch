import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type Me, type Meta, type NotificationRow, type QuestionResponse } from './api'
import { ErrorBox, fmtDateTime } from './components/common'
import { AskPage } from './pages/Ask'
import { CaseDetailPage, CasesPage } from './pages/Cases'
import { DashboardPage } from './pages/Dashboard'
import { DocumentDetailPage, DocumentsPage, NewDocumentPage } from './pages/Documents'
import { HealthPage } from './pages/Health'

export interface Route { path: string[]; query: URLSearchParams }

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const [p, q] = raw.split('?')
  return { path: p ? p.split('/').map(decodeURIComponent) : ['dashboard'], query: new URLSearchParams(q ?? '') }
}
export const go = (hash: string) => { window.location.hash = hash }

function useRoute() {
  const [route, setRoute] = useState(parseHash)
  useEffect(() => {
    const on = () => setRoute(parseHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

interface Poll { notifications: NotificationRow[]; unread: number; awaitingAction: number; docsAwaitingReview: number }

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  useEffect(() => {
    api<{ user: Me }>('/session').then((r) => setMe(r.user)).catch(() => setMe(null))
  }, [])
  if (me === undefined) return <div className="boot">Loading…</div>
  if (!me) return <Login onLogin={setMe} />
  return <Workspace me={me} onLogout={() => setMe(null)} />
}

function Login({ onLogin }: { onLogin: (u: Me) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="login-page">
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            const r = await api<{ user: Me }>('/session', { body: { username, password } })
            onLogin(r.user)
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="brand-mark">Vouch</div>
        <p className="brand-sub">SD Worx challenge prototype</p>
        <p className="synthetic-note">Synthetic demonstration — all people, clients, documents and figures are fictional.</p>
        <label>Username<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <ErrorBox error={error} />
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="meta">Demo accounts are configured on the server. A case link from an email opens after sign-in.</p>
      </form>
    </div>
  )
}

function Workspace({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const route = useRoute()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [poll, setPoll] = useState<Poll | null>(null)
  const [showNotes, setShowNotes] = useState(false)
  const [lastAnswer, setLastAnswer] = useState<QuestionResponse | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(async () => {
    try {
      setPoll(await api<Poll>('/notifications'))
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onLogout()
    }
  }, [onLogout])

  useEffect(() => {
    api<Meta>('/meta').then(setMeta).catch(() => {})
    refresh()
    // Modest polling keeps case status and notifications fresh (no WebSockets needed).
    const t = setInterval(() => { refresh(); setTick((x) => x + 1) }, 8000)
    return () => clearInterval(t)
  }, [refresh])

  // Escape or navigating closes the notifications panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowNotes(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => { setShowNotes(false) }, [route])

  const page = route.path[0]
  const nav = [
    { id: 'dashboard', label: 'Dashboard', icon: '▦' },
    { id: 'ask', label: 'Ask Vouch', icon: '?' },
    { id: 'documents', label: 'Documents', icon: '▤', badge: poll?.docsAwaitingReview, badgeLabel: 'awaiting review' },
    { id: 'cases', label: 'Expert requests', icon: '✉', badge: poll?.awaitingAction, badgeLabel: 'awaiting your action' },
    { id: 'health', label: 'Knowledge health', icon: '♥' },
  ]

  let content
  if (page === 'ask') content = <AskPage meta={meta} last={lastAnswer} setLast={setLastAnswer} me={me} onChanged={refresh} />
  else if (page === 'documents' && route.path[1] === 'new') content = <NewDocumentPage meta={meta} route={route} />
  else if (page === 'documents' && route.path[1]) content = <DocumentDetailPage id={route.path[1]} me={me} meta={meta} onChanged={refresh} />
  else if (page === 'documents') content = <DocumentsPage route={route} me={me} />
  else if (page === 'cases' && route.path[1]) content = <CaseDetailPage id={route.path[1]} me={me} tick={tick} onChanged={refresh} />
  else if (page === 'cases') content = <CasesPage route={route} tick={tick} />
  else if (page === 'health') content = <HealthPage />
  else content = <DashboardPage me={me} tick={tick} />

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="sidebar-brand">
          <div className="brand-mark">Vouch</div>
          <div className="brand-sub">SD Worx challenge prototype</div>
        </div>
        <nav>
          {nav.map((n) => (
            <a key={n.id} href={`#/${n.id}`} className={`nav-item ${page === n.id || (page === undefined && n.id === 'dashboard') ? 'nav-active' : ''}`} aria-current={page === n.id ? 'page' : undefined}>
              <span className="nav-icon" aria-hidden="true">{n.icon}</span>
              <span>{n.label}</span>
              {!!n.badge && <span className="nav-badge" aria-label={`${n.badge} ${n.badgeLabel}`}>{n.badge}</span>}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          {meta && (
            <div className="mode-box" aria-label="Integration status">
              <div><span aria-hidden="true">{meta.interpreter.kind === 'claude' ? '●' : '○'}</span> {meta.interpreter.kind === 'claude' ? `LLM: Claude (${meta.interpreter.model})` : 'No LLM connected'}</div>
              <div className="mode-sub">{meta.interpreter.kind === 'claude' ? 'Claude extracts claims and interprets questions' : 'Keyword rules for questions · claims entered manually'}</div>
              <div><span aria-hidden="true">{meta.externalEmail ? '●' : '○'}</span> {meta.externalEmail ? 'External email configured' : 'External email: not configured'}</div>
              <div className="mode-sub">{meta.externalEmail ? 'Expert requests also send email' : 'Expert requests use in-app notifications'}</div>
            </div>
          )}
          <button type="button" className="notes-btn" onClick={() => setShowNotes((s) => !s)} aria-expanded={showNotes}>
            <span aria-hidden="true">🔔</span> Notifications {poll?.unread ? <span className="nav-badge">{poll.unread}</span> : <span className="meta">none new</span>}
          </button>
          <div className="user-box">
            <div className="user-avatar" aria-hidden="true">{me.displayName.split(' ').map((p) => p[0]).join('')}</div>
            <div>
              <div className="user-name">{me.displayName}</div>
              <div className="user-role">{me.roleTitle}</div>
            </div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={async () => { await api('/session', { method: 'DELETE' }).catch(() => {}); go('#/dashboard'); onLogout() }}>Sign out</button>
        </div>
      </aside>

      {showNotes && (
        <div className="notes-panel" role="dialog" aria-label="Notifications">
          <div className="notes-head">
            <strong>Notifications</strong>
            <button type="button" className="btn btn-small" onClick={async () => { await api('/notifications/read', { body: {} }); refresh() }}>Mark all read</button>
          </div>
          {!poll?.notifications.length && <p className="empty">No notifications.</p>}
          <ul>
            {poll?.notifications.map((n) => (
              <li key={n.id} className={n.read_at ? '' : 'unread'}>
                <button type="button" className="note" onClick={async () => { await api('/notifications/read', { body: { ids: [n.id] } }); setShowNotes(false); if (n.link) go(n.link); refresh() }}>
                  <span className="note-title">{!n.read_at && <span className="sr-only">Unread: </span>}{n.title}</span>
                  {n.body && <span className="note-body">{n.body}</span>}
                  <span className="meta">{fmtDateTime(n.created_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <main className="main">
        <div className="synthetic-banner" role="note">
          <span aria-hidden="true">⚠</span> Synthetic demonstration — all people, clients, documents, agreements and percentages are fictional. Not payroll advice.
        </div>
        {content}
      </main>
    </div>
  )
}
