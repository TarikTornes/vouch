import type { NextFunction, Request, Response } from 'express'
import type { Config } from '../config'
import type { DB } from '../db'
import { UserError } from '../services/documents'
import type { LlmClient } from '../services/llm'
import type { EmailSender } from '../services/notifications'

export interface Deps {
  db: DB
  config: Config
  llm: LlmClient | null // null = no LLM connected (keyword rules + manual claims)
  sendEmail: EmailSender
}

/** Wrap a handler so UserErrors become JSON responses with their status. */
export const handle = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    await fn(req, res)
  } catch (e) {
    if (e instanceof UserError) return res.status(e.status).json({ error: e.message })
    next(e)
  }
}

export const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '')
export const optStr = (v: unknown, max = 2000): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
export const isoDate = (v: unknown): string | null => {
  const s = optStr(v, 10)
  if (!s) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new UserError(`Invalid date “${s}” (use YYYY-MM-DD).`)
  return s
}
