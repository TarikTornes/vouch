// In-app notifications and the email outbox (Resend). Provider acceptance is
// recorded as "accepted" — never as confirmed inbox delivery.
import type { Config } from '../config'
import { nowIso, tx, type DB } from '../db'

export function notify(db: DB, n: { userId: string; kind: string; title: string; body?: string; link?: string; caseId?: string }) {
  db.prepare('INSERT INTO notifications (user_id, kind, title, body, link, case_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(n.userId, n.kind, n.title, n.body ?? null, n.link ?? null, n.caseId ?? null, nowIso())
}

export interface OutboxRow {
  id: string
  case_id: string
  kind: string
  recipient: string
  subject: string
  status: 'queued' | 'sending' | 'accepted' | 'failed'
  provider_message_id: string | null
  attempts: number
  last_error: string | null
  updated_at: string
}

/** Idempotent: one outbox item per (case, kind). Returns the existing item on repeats. */
export function enqueueEmail(db: DB, e: { caseId: string; kind: string; recipient: string; subject: string; text: string; html: string }): OutboxRow {
  const id = `MAIL-${e.caseId}-${e.kind}`
  const now = nowIso()
  db.prepare(`INSERT OR IGNORE INTO email_outbox (id, case_id, kind, recipient, subject, text_body, html_body, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(id, e.caseId, e.kind, e.recipient, e.subject, e.text, e.html, now, now)
  return getOutbox(db, id)!
}

export const getOutbox = (db: DB, id: string) =>
  db.prepare('SELECT id, case_id, kind, recipient, subject, status, provider_message_id, attempts, last_error, updated_at FROM email_outbox WHERE id = ?').get(id) as OutboxRow | undefined

export type EmailSender = (msg: { idempotencyKey: string; from: string; to: string; subject: string; text: string; html: string }) =>
  Promise<{ ok: true; id: string } | { ok: false; status?: number; error: string }>

/** Real Resend API call. The idempotency key stops duplicate sends across retries. */
export function resendSender(apiKey: string | null): EmailSender {
  return async (msg) => {
    if (!apiKey) return { ok: false, error: 'RESEND_API_KEY is not configured on the server — email not sent.' }
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': msg.idempotencyKey },
        body: JSON.stringify({ from: msg.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
        signal: AbortSignal.timeout(15_000),
      })
      const body = (await r.json().catch(() => ({}))) as { id?: string; message?: string; name?: string }
      if (r.ok && body.id) return { ok: true, id: body.id }
      return { ok: false, status: r.status, error: `Resend ${r.status}: ${body.message ?? body.name ?? 'unknown error'}` }
    } catch (e) {
      return { ok: false, error: `Email provider unreachable: ${(e as Error).message}` }
    }
  }
}

/**
 * Deliver one outbox item. A conditional status update claims the item first, so
 * concurrent clicks cannot send twice; an accepted item is never re-sent.
 */
export async function deliver(db: DB, config: Config, send: EmailSender, outboxId: string): Promise<OutboxRow> {
  const claimed = db.prepare(`UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('queued', 'failed')`)
    .run(nowIso(), outboxId)
  if (claimed.changes === 0) return getOutbox(db, outboxId)!
  const row = db.prepare('SELECT * FROM email_outbox WHERE id = ?').get(outboxId) as Record<string, string>
  const result = await send({ idempotencyKey: outboxId, from: config.emailFrom, to: row.recipient, subject: row.subject, text: row.text_body, html: row.html_body })
  const now = nowIso()
  tx(db, () => {
    if (result.ok) {
      db.prepare(`UPDATE email_outbox SET status = 'accepted', provider_message_id = ?, last_error = NULL, updated_at = ? WHERE id = ?`).run(result.id, now, outboxId)
      db.prepare(`INSERT INTO email_attempts (outbox_id, attempted_at, outcome, provider_message_id) VALUES (?, ?, 'accepted', ?)`).run(outboxId, now, result.id)
    } else {
      db.prepare(`UPDATE email_outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`).run(result.error, now, outboxId)
      db.prepare(`INSERT INTO email_attempts (outbox_id, attempted_at, outcome, http_status, error) VALUES (?, ?, 'failed', ?, ?)`).run(outboxId, now, result.status ?? null, result.error)
    }
  })
  return getOutbox(db, outboxId)!
}

/** Items left in "sending" by a crash are marked failed (retryable) at startup. */
export function recoverOutbox(db: DB) {
  db.prepare(`UPDATE email_outbox SET status = 'failed', last_error = 'Interrupted by server restart — retry to send', updated_at = ? WHERE status = 'sending'`).run(nowIso())
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function caseEmail(config: Config, c: { id: string; question: string; label: string; clientName: string; countryName: string; values: string[]; requester: string; rereview?: string }) {
  const link = `${config.appBaseUrl}/#/cases/${encodeURIComponent(c.id)}`
  const subject = c.rereview ? `[Vouch demo] Re-review needed: ${c.label} — ${c.clientName}` : `[Vouch demo] Expert review requested: ${c.label} — ${c.clientName}`
  const lines = [
    c.rereview ? `A previous resolution needs re-review: ${c.rereview}` : `${c.requester} asked for an expert review.`,
    `Case: ${c.id}`,
    `Question: "${c.question}"`,
    `Context: ${c.countryName} / ${c.clientName}`,
    `Claim under review: ${c.label}`,
    c.values.length ? `Conflicting values in the sources: ${c.values.join(' vs ')}` : '',
    '',
    `Open review (sign-in required): ${link}`,
    '',
    'Synthetic demonstration — all people, clients, documents and figures are fictional. Vouch — SD Worx challenge prototype.',
  ].filter((l) => l !== '')
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1c2430">
    <p>${esc(lines[0])}</p>
    <table style="border-collapse:collapse">${lines.slice(1, c.values.length ? 6 : 5).map((l) => { const [k, ...v] = l.split(': '); return `<tr><td style="padding:2px 12px 2px 0;color:#5b6573">${esc(k)}</td><td>${esc(v.join(': '))}</td></tr>` }).join('')}</table>
    <p><a href="${esc(link)}" style="display:inline-block;background:#1c2430;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none">Open review</a> <span style="color:#5b6573">(sign-in required)</span></p>
    <p style="color:#8a4b00;font-size:12px">Synthetic demonstration — all people, clients, documents and figures are fictional. Vouch — SD Worx challenge prototype.</p></div>`
  return { subject, text: lines.join('\n'), html }
}
