// SQLite access via Node's built-in node:sqlite (synchronous, file-backed).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

export type DB = DatabaseSync

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  return db
}

/** Apply pending .sql migrations in filename order, each in its own transaction. */
export function migrate(db: DB): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((r) => r.version))
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  const done: string[] = []
  for (const f of files) {
    if (applied.has(f)) continue
    tx(db, () => {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(f, new Date().toISOString())
    })
    done.push(f)
  }
  return done
}

/** Run fn inside a transaction (synchronous, so nothing else interleaves). */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export const nowIso = () => new Date().toISOString()

export const json = <T,>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback
  try { return JSON.parse(s) as T } catch { return fallback }
}

/** Next readable id with a prefix, e.g. CASE-003 (safe: single process, synchronous). */
export function nextId(db: DB, table: string, prefix: string, pad = 3): string {
  const rows = db.prepare(`SELECT id FROM ${table} WHERE id LIKE ?`).all(`${prefix}%`) as { id: string }[]
  const max = rows.reduce((m, r) => Math.max(m, parseInt(r.id.slice(prefix.length), 10) || 0), 0)
  return `${prefix}${String(max + 1).padStart(pad, '0')}`
}
