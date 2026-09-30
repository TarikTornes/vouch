// Repeatable synthetic seed. Users come from environment configuration (passwords
// are never committed). Documents are the fictional Janssens scenario.
import crypto from 'node:crypto'
import { CLAIMS, CLIENTS, SEED_DOCUMENTS, versionId } from '../../shared/fixtures'
import { hashPassword } from '../auth'
import type { Config } from '../config'
import { nowIso, tx, type DB } from './index'

const OWNS = JSON.stringify(['overtime_eligibility', 'overtime_surcharge'])

/** Documents whose seed record includes a completed currency review (for varied quality scores). */
const CURRENCY_REVIEWED = new Set(['S1', 'S2', 'S5'])
const HUMAN_REVIEWED = new Set(['S1', 'S2', 'S3', 'S4', 'S5', 'S7'])

export function seed(db: DB, config: Config): { users: string[]; documents: number } {
  const { consultant, expert, nlExpert } = config.passwords
  if (!consultant || !expert) throw new Error('DEMO_CONSULTANT_PASSWORD and DEMO_EXPERT_PASSWORD must be set in .env')
  const now = nowIso()
  const users: string[] = []
  return tx(db, () => {
    const upsert = db.prepare(`
      INSERT INTO users (id, username, display_name, role, role_title, email, password_hash, country, owns_topics, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, email = excluded.email`)
    upsert.run('sophie', 'sophie', 'Sophie Dubois', 'consultant', 'Payroll consultant — Belgium', null, hashPassword(consultant), 'BE', '[]', now)
    users.push('sophie')
    // Only the team-provided demo inbox is ever used as an email recipient.
    upsert.run('anna', 'anna', 'Anna Peeters', 'expert', 'Payroll policy owner — Belgium', config.demoExpertEmail, hashPassword(expert), 'BE', OWNS, now)
    users.push('anna')
    // Jan exists to prove an unassigned expert cannot act on Belgian cases; he has no email address.
    upsert.run('jan', 'jan', 'Jan Visser', 'expert', 'Payroll policy owner — Netherlands', null, hashPassword(nlExpert ?? crypto.randomBytes(18).toString('base64url')), 'NL', OWNS, now)
    users.push('jan')

    for (const c of CLIENTS) db.prepare('INSERT OR IGNORE INTO clients (id, name, country) VALUES (?, ?, ?)').run(c.id, c.name, c.country)

    const existing = (db.prepare('SELECT COUNT(*) n FROM documents').get() as { n: number }).n
    if (existing === 0) {
      for (const d of SEED_DOCUMENTS) {
        db.prepare('INSERT INTO documents (id, title, source_type, owner_name, country, client, link, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(d.id, d.title, d.type, d.ownerName, d.country, d.client, d.link, 'sophie', now)
        const reviewed = HUMAN_REVIEWED.has(d.id)
        db.prepare(`INSERT INTO document_versions (id, document_id, version, status, text, content_hash, source_updated, uploaded_by, uploaded_at,
            reviewed_by, reviewed_at, currency_reviewed) VALUES (?, ?, 1, 'active', ?, ?, ?, 'sophie', ?, ?, ?, ?)`)
          .run(versionId(d.id), d.id, d.text, crypto.createHash('sha256').update(d.text).digest('hex'), d.updated, now,
            reviewed ? 'sophie' : null, reviewed ? now : null, CURRENCY_REVIEWED.has(d.id) ? 1 : 0)
      }
      for (const c of CLAIMS) {
        const reviewed = HUMAN_REVIEWED.has(c.sourceId.split('-')[0])
        db.prepare(`INSERT INTO claims (id, version_id, topic, condition, country, client, scope_source, value, unit, excerpt, location,
            exception_label, exception_agreement_ref, exception_documented_by, duplicate_of, origin, status, created_at, reviewed_by, reviewed_at)
            VALUES (?, ?, ?, ?, ?, ?, 'seed', ?, ?, ?, ?, ?, ?, ?, ?, 'seed', 'confirmed', ?, ?, ?)`)
          .run(c.id, c.sourceId, c.topic, c.condition, c.country, c.client, c.value, c.value.endsWith('%') ? 'percent' : 'boolean',
            c.excerpt, null, c.exception?.label ?? null, c.exception?.agreementRef ?? null, c.exception?.documentedBy ?? null,
            c.duplicateOf ?? null, now, reviewed ? 'sophie' : null, reviewed ? now : null)
      }
    }
    return { users, documents: SEED_DOCUMENTS.length }
  })
}
