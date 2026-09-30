// Vouch server: one origin serving the API and the built frontend.
import path from 'node:path'
import { createApp } from './app'
import { loadConfig } from './config'
import { migrate, openDb } from './db'
import { seed } from './db/seed'
import { recoverProcessing } from './services/documents'
import { createClaudeClient } from './services/llm'
import { recoverOutbox, resendSender } from './services/notifications'

const config = loadConfig()
const db = openDb(config.databasePath)
const applied = migrate(db)
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`)
const userCount = (db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n
if (userCount === 0) {
  seed(db, config)
  console.log('Seeded synthetic demo data (empty database).')
}
recoverProcessing(db)
recoverOutbox(db)

const app = createApp(
  { db, config, llm: createClaudeClient(config), sendEmail: resendSender(config.resendApiKey) },
  { staticDir: path.resolve('dist') },
)
app.listen(config.port, () => {
  console.log(`Vouch listening on ${config.appBaseUrl} (database: ${path.resolve(config.databasePath)})`)
  console.log(`LLM: ${config.anthropicApiKey ? `Claude configured, model ${config.anthropicModel}` : 'none connected - keyword rules for questions, manual claim entry for documents'}`)
  console.log(`External email: ${config.resendApiKey && config.demoExpertEmail ? `Resend configured, recipient ${config.demoExpertEmail}` : 'not configured - expert requests use in-app notifications only; no email is queued or claimed as sent'}`)
})
