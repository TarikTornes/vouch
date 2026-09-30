// Server-side sessions, password hashing, permission guards, CSRF and rate limits.
import crypto from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import type { Config } from './config'
import { nowIso, type DB } from './db'

export interface User {
  id: string
  username: string
  displayName: string
  role: 'consultant' | 'expert'
  roleTitle: string
  email: string | null
  country: string | null
  ownsTopics: string[]
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: User
  }
}

const COOKIE = 'vouch_sid'
const SESSION_HOURS = 12

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 })
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$')
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false
  const expected = Buffer.from(hashB64, 'base64')
  const actual = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 })
  return crypto.timingSafeEqual(expected, actual)
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

export function rowToUser(r: Record<string, unknown>): User {
  return {
    id: r.id as string,
    username: r.username as string,
    displayName: r.display_name as string,
    role: r.role as User['role'],
    roleTitle: r.role_title as string,
    email: (r.email as string) ?? null,
    country: (r.country as string) ?? null,
    ownsTopics: JSON.parse((r.owns_topics as string) || '[]'),
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function createSession(db: DB, res: Response, userId: string, secure: boolean) {
  const token = crypto.randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000)
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, nowIso(), expires.toISOString())
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', expires })
}

export function destroySession(db: DB, req: Request, res: Response) {
  const token = parseCookies(req.headers.cookie)[COOKIE]
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
  res.clearCookie(COOKIE, { path: '/' })
}

/** Attach req.user from the session cookie. Identity is always server-derived. */
export function loadUser(db: DB) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = parseCookies(req.headers.cookie)[COOKIE]
    if (token) {
      const row = db.prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
      ).get(sha256(token), nowIso()) as Record<string, unknown> | undefined
      if (row) req.user = rowToUser(row)
    }
    next()
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' })
  next()
}

export const requireRole = (role: User['role']) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' })
  if (req.user.role !== role) return res.status(403).json({ error: `Only a ${role} can do this` })
  next()
}

/**
 * CSRF / origin protection for cookie-authenticated mutations: the Origin must be
 * ours AND a custom header must be present (cross-site forms cannot set it).
 */
export function csrfGuard(config: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
    const origin = req.headers.origin
    if (!origin || !config.allowedOrigins.includes(origin)) return res.status(403).json({ error: 'Cross-origin request rejected' })
    if (req.headers['x-vouch-csrf'] !== '1') return res.status(403).json({ error: 'Missing CSRF header' })
    next()
  }
}

/** Small fixed-window in-memory rate limiter (single-process prototype). */
export function rateLimit(opts: { windowMs: number; max: number; key: (req: Request) => string; message?: string }) {
  const hits = new Map<string, { count: number; reset: number }>()
  return (req: Request, res: Response, next: NextFunction) => {
    const k = opts.key(req)
    const now = Date.now()
    const h = hits.get(k)
    if (!h || h.reset < now) hits.set(k, { count: 1, reset: now + opts.windowMs })
    else if (++h.count > opts.max) {
      res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000))
      return res.status(429).json({ error: opts.message ?? 'Too many requests — slow down' })
    }
    next()
  }
}
