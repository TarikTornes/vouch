// Database commands: `npm run db:migrate`, `npm run db:seed`, `npm run db:reset`.
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config'
import { migrate, openDb } from '../db'
import { seed } from '../db/seed'

const cmd = process.argv[2]
const config = loadConfig()
const file = path.resolve(config.databasePath)

if (cmd === 'reset') {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.rmSync(f)
  console.log(`Deleted ${file}`)
}
const db = openDb(file)
const applied = migrate(db)
console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Migrations up to date.')
if (cmd === 'seed' || cmd === 'reset') {
  const out = seed(db, config)
  console.log(`Seeded users ${out.users.join(', ')} and synthetic documents (skipped if documents already exist).`)
}
db.close()
