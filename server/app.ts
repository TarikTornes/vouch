import fs from 'node:fs'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import { csrfGuard, loadUser, rateLimit } from './auth'
import type { Deps } from './routes/context'
import { caseRoutes } from './routes/cases'
import { dashboardRoutes } from './routes/dashboard'
import { documentRoutes } from './routes/documents'
import { questionRoutes } from './routes/questions'
import { sessionRoutes } from './routes/sessions'

export function createApp(deps: Deps, opts: { staticDir?: string } = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', false)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    next()
  })

  const api = express.Router()
  api.use(express.json({ limit: '100kb' }))
  api.use(loadUser(deps.db))
  api.use(csrfGuard(deps.config))
  api.use(rateLimit({ windowMs: 60_000, max: 300, key: (req) => `api:${req.user?.id ?? req.ip}` }))
  // Tighter limit on the endpoints that trigger Claude calls.
  const llmLimit = rateLimit({ windowMs: 60_000, max: 20, key: (req) => `llm:${req.user?.id ?? req.ip}`, message: 'Too many Claude-backed requests — wait a minute.' })
  api.post(['/questions', '/documents', '/documents/:id/versions', '/versions/:vid/reprocess'], llmLimit)
  api.use(sessionRoutes(deps))
  api.use(questionRoutes(deps))
  api.use(documentRoutes(deps))
  api.use(caseRoutes(deps))
  api.use(dashboardRoutes(deps))
  api.use((_req, res) => res.status(404).json({ error: 'Not found' }))
  api.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err)
    res.status(500).json({ error: 'Internal error' })
  })
  app.use('/api', api)

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir, { index: false }))
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(opts.staticDir!, 'index.html')))
  }
  return app
}
