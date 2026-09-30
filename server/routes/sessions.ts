import { Router } from 'express'
import { createSession, destroySession, rateLimit, rowToUser, verifyPassword } from '../auth'
import { handle, str, type Deps } from './context'

export function sessionRoutes({ db, config }: Deps) {
  const r = Router()
  const loginLimit = rateLimit({ windowMs: 5 * 60_000, max: 10, key: (req) => `login:${req.ip}`, message: 'Too many sign-in attempts. Wait a few minutes.' })

  r.post('/session', loginLimit, handle((req, res) => {
    const username = str(req.body?.username, 64).trim().toLowerCase()
    const password = str(req.body?.password, 256)
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Record<string, unknown> | undefined
    if (!row || !verifyPassword(password, row.password_hash as string)) return res.status(401).json({ error: 'Wrong username or password' })
    createSession(db, res, row.id as string, config.appBaseUrl.startsWith('https://'))
    res.json({ user: publicUser(rowToUser(row)) })
  }))

  r.get('/session', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' })
    res.json({ user: publicUser(req.user) })
  })

  r.delete('/session', (req, res) => {
    destroySession(db, req, res)
    res.json({ ok: true })
  })
  return r
}

const publicUser = (u: ReturnType<typeof rowToUser>) => ({ id: u.id, displayName: u.displayName, role: u.role, roleTitle: u.roleTitle, country: u.country })
