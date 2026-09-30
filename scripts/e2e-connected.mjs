// End-to-end proof in real browser sessions against the real server + SQLite.
// Usage: npm run db:reset && npm run build && node scripts/e2e-connected.mjs <screenshot-dir>
// Requires: npm i --no-save playwright-core, and Chrome (CHROME_PATH to override).
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
const BASE = 'http://localhost:8787/'
const shots = process.argv[2] || os.tmpdir()
let failures = 0
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++ }

let server
async function startServer() {
  server = spawn('npx', ['tsx', 'server/index.ts'], { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + 'api/session')).status === 401) return } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('server did not start')
}
function stopServer() {
  try { execSync(`taskkill /F /T /PID ${server.pid}`, { stdio: 'ignore' }) } catch { server.kill() }
}

process.on('exit', () => { try { stopServer() } catch {} })
await startServer()
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
const errors = []
async function session(user, pw) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }) // separate cookie jar = separate browser profile
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`${user}: ${e.message}`))
  await page.goto(BASE)
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password').fill(pw)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor()
  return page
}
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true })
const main = (page) => page.locator('main').innerText()
// Click Ask and wait until a NEW answer (new question id) is rendered.
async function ask(page) {
  const before = await page.locator('.asked').innerText().catch(() => '')
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
  await page.waitForFunction((b) => { const el = document.querySelector('.asked'); return !!el && el.innerText !== b }, before)
}

// ---- 1. Sophie uploads a new fictional document (file upload)
const sophie = await session('sophie', env.DEMO_CONSULTANT_PASSWORD)
await sophie.getByText('No LLM connected').first().waitFor()
check(true, 'sidebar states that no LLM is connected')
const docFile = path.join(os.tmpdir(), 'janssens-sunday-addendum.txt')
fs.writeFileSync(docFile, 'Janssens NV — Sunday work addendum (FICTIONAL DEMO DOCUMENT)\n\nApplies to Janssens NV employees in Belgium.\nSunday overtime for Janssens NV staff is paid with an 80% surcharge from 1 July 2026.\nOwner: Pieter Claes, account manager.\n')
await sophie.goto(BASE + '#/documents/new')
await sophie.locator('input[type=file]').setInputFiles(docFile)
await sophie.getByLabel('Title').fill('Janssens NV — Sunday work addendum')
await sophie.getByLabel('Source type').selectOption('Agreement')
await sophie.getByLabel('Owner (responsible person)').fill('Pieter Claes')
await sophie.getByLabel('Country').selectOption('BE')
await sophie.getByLabel('Client scope').selectOption('janssens')
await sophie.getByLabel('Source date (last updated)').fill('2026-06-20')
await sophie.getByRole('button', { name: 'Upload document' }).click()
await sophie.getByText('No LLM connected: no automatic extraction was run').waitFor()
check(true, 'upload -> Needs review, honest "no automatic extraction" notice')
const docId = decodeURIComponent(sophie.url().split('#/documents/')[1])

// ---- 2/3. Manual claim entry (via text selection) + review + activation
await sophie.locator('.fulltext').getByText('Sunday overtime for Janssens NV staff is paid with an 80% surcharge').selectText().catch(() => {})
await sophie.locator('.fulltext').dispatchEvent('mouseup')
const form = sophie.locator('form', { hasText: 'Add a claim manually' })
await form.getByLabel('Condition').selectOption('sunday')
await form.getByLabel('Value').fill('80%')
await form.getByRole('button', { name: 'Use selected text' }).click().catch(() => {})
const excerpt = await form.getByLabel('Supporting excerpt (exact text)').inputValue()
if (!excerpt.includes('80%')) await form.getByLabel('Supporting excerpt (exact text)').fill('Sunday overtime for Janssens NV staff is paid with an 80% surcharge')
await form.getByLabel('Supporting excerpt (exact text)').fill('This passage does not exist')
await form.getByRole('button', { name: 'Add and confirm claim' }).click()
await sophie.locator('.error').waitFor()
check((await sophie.locator('.error').innerText()).includes('not found in the document text'), 'untraceable excerpt rejected by server')
await form.getByLabel('Supporting excerpt (exact text)').fill('Sunday overtime for Janssens NV staff is paid with an 80% surcharge')
await form.getByRole('button', { name: 'Add and confirm claim' }).click()
await sophie.getByText('Claim added and confirmed.').waitFor()
await sophie.getByLabel('I reviewed the source date and effective dates (currency check)').check()
await shot(sophie, 'p1-document-review')
await sophie.getByRole('button', { name: 'Activate version' }).click()
await sophie.getByText('Activated.').waitFor()
check((await main(sophie)).includes('100%'), 'activated document shows quality checks 100%')
await shot(sophie, 'p2-document-active')

// ---- 4. Paraphrased question finds the new evidence and the conflict
await sophie.goto(BASE + '#/ask')
await sophie.getByLabel('Question').fill('What extra pay applies when someone works overtime on a Sunday?')
await ask(sophie)
let t = await main(sophie)
check(t.includes('The applicable surcharge cannot yet be determined') && t.includes('80%') && t.includes('100%'), 'paraphrase -> Conflicting: new 80% vs legacy 100%')
await shot(sophie, 'p3-ask-conflict')

// ---- 5. Ask an expert: database case + in-app notification (no email claimed)
await sophie.locator('.claim', { hasText: 'Sunday overtime surcharge' }).getByRole('button', { name: 'Ask an expert' }).click()
await sophie.getByText('Case created').waitFor()
t = await main(sophie)
const caseId = t.match(/CASE-\d+/)[0]
check(t.includes('In-app notification delivered') && t.includes('No email was sent') && !/email accepted|email sent/i.test(t), `case ${caseId} created; email honestly "not configured"`)
await shot(sophie, 'p4-case-created')

// ---- 6/7. Anna sees it in her own session; Jan (unassigned expert) cannot
const anna = await session('anna', env.DEMO_EXPERT_PASSWORD)
await anna.waitForTimeout(300)
check(await anna.locator('.nav-badge').first().isVisible(), 'Anna sidebar shows pending-request badge')
await anna.getByRole('button', { name: /Notifications/ }).click()
await anna.getByText(`New expert request`).first().click()
await anna.getByRole('heading', { name: new RegExp(caseId) }).waitFor()
check(true, 'Anna opens the case from her in-app notification')

const jan = await session('jan', env.DEMO_NL_EXPERT_PASSWORD)
await jan.goto(BASE + `#/cases/${caseId}`)
await jan.getByText('Case not found or you do not have access').waitFor()
const janResolve = await jan.evaluate(async (id) => (await fetch(`/api/cases/${id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vouch-CSRF': '1' }, body: JSON.stringify({ rowVersion: 1, value: '100%', reason: 'x', expertStatement: 'y' }) })).status, caseId)
const sophieResolve = await sophie.evaluate(async (id) => (await fetch(`/api/cases/${id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vouch-CSRF': '1' }, body: JSON.stringify({ rowVersion: 1, value: '100%', reason: 'x', expertStatement: 'y' }) })).status, caseId)
check(janResolve === 403 && sophieResolve === 403, `unauthorised resolve rejected (Jan ${janResolve}, Sophie ${sophieResolve})`)

// ---- 8. Anna resolves with evidence
await anna.getByRole('button', { name: 'Save resolution' }).click()
await anna.getByText('A reason is required.').waitFor()
check(true, 'resolution without reason blocked')
await anna.getByLabel('Correct value for Janssens NV').selectOption('80%')
await anna.getByRole('textbox', { name: 'Reason (required)' }).fill('The Janssens Sunday addendum (fictional) is client-specific and newer; the legacy wiki page is general, ownerless and unmaintained.')
await anna.getByLabel('Supporting document').selectOption(docId)
await shot(anna, 'p5-expert-review')
await anna.getByRole('button', { name: 'Save resolution' }).click()
await anna.getByText(/Resolution RES-\d+: 80%/).waitFor()
check((await main(anna)).includes('Anna Peeters'), 'resolution recorded with server-side identity')
await shot(anna, 'p6-resolved')

// ---- 9/10. Sophie receives the update (polling) and asks again
await sophie.getByRole('button', { name: /Notifications/ }).click()
let gotIt = false
for (let i = 0; i < 12 && !gotIt; i++) {
  gotIt = await sophie.getByText(/Anna Peeters resolved/).first().isVisible().catch(() => false)
  if (!gotIt) { await sophie.waitForTimeout(1000); if (i % 3 === 2) { await sophie.getByRole('button', { name: /Notifications/ }).click(); await sophie.getByRole('button', { name: /Notifications/ }).click() } }
}
check(gotIt, 'Sophie receives the in-app resolution notification via polling')
await shot(sophie, 'p7-sophie-notified')
await sophie.keyboard.press('Escape')
await sophie.goto(BASE + '#/ask')
await ask(sophie)
t = await main(sophie)
check(t.includes('80% — expert-confirmed') && t.includes('Provenance'), 'repeat answer: 80% expert-confirmed with provenance')
await shot(sophie, 'p8-ask-confirmed')

// ---- 11. Another client unaffected
await sophie.getByLabel('Client').selectOption('maes')
await ask(sophie)
t = await main(sophie)
check(!t.includes('expert-confirmed') && t.includes('100%'), 'Maes BVBA answer unaffected by the Janssens resolution')

// ---- 12. Restart the backend: documents, sessions and resolutions persist
stopServer()
await new Promise((r) => setTimeout(r, 800))
await startServer()
await sophie.goto(BASE + '#/ask')
await sophie.getByLabel('Client').selectOption('janssens')
await ask(sophie)
check((await main(sophie)).includes('80% — expert-confirmed'), 'after server restart the resolution still applies')
const docs = await sophie.evaluate(async () => (await (await fetch('/api/documents')).json()).documents.length)
check(docs === 8, `after restart all 8 documents are present (${docs})`)

// ---- 13. A changed source triggers re-review instead of reusing stale approval
fs.writeFileSync(docFile, 'Janssens NV — Sunday work addendum (FICTIONAL DEMO DOCUMENT), revision 2\n\nApplies to Janssens NV employees in Belgium.\nSunday overtime for Janssens NV staff is paid with a 75% surcharge from 1 September 2026.\nOwner: Pieter Claes, account manager.\n')
await sophie.goto(BASE + `#/documents/new?version-of=${docId}`)
await sophie.getByLabel('Title').waitFor()
await sophie.waitForTimeout(400)
await sophie.locator('input[type=file]').setInputFiles(docFile)
await sophie.getByRole('button', { name: 'Upload document' }).click()
await sophie.getByText('No LLM connected: no automatic extraction was run').waitFor()
const form2 = sophie.locator('form', { hasText: 'Add a claim manually' })
await form2.getByLabel('Condition').selectOption('sunday')
await form2.getByLabel('Value').fill('75%')
await form2.getByLabel('Supporting excerpt (exact text)').fill('Sunday overtime for Janssens NV staff is paid with a 75% surcharge')
await form2.getByRole('button', { name: 'Add and confirm claim' }).click()
await sophie.getByText('Claim added and confirmed.').waitFor()
await sophie.getByLabel('I reviewed the source date and effective dates (currency check)').check()
await sophie.getByRole('button', { name: 'Activate version' }).click()
await sophie.getByText(/re-review case CASE-\d+ opened/).waitFor()
check(true, 'new version activation opened a re-review case')
await shot(sophie, 'p9-rereview-triggered')
await sophie.goto(BASE + '#/ask')
await ask(sophie)
t = await main(sophie)
check(!t.includes('expert-confirmed') && t.includes('awaiting re-review') && t.includes('75%'), 'answer no longer reuses the stale approval (Conflicting, awaiting re-review)')
await shot(sophie, 'p10-ask-after-change')

// ---- 14. Honest error state for a bad upload
await sophie.goto(BASE + '#/documents/new')
const gif = path.join(os.tmpdir(), 'not-a-document.gif')
fs.writeFileSync(gif, 'GIF89a')
await sophie.locator('input[type=file]').setInputFiles(gif)
await sophie.getByLabel('Title').fill('Image')
await sophie.getByRole('button', { name: 'Upload document' }).click()
await sophie.locator('.error').waitFor()
check((await sophie.locator('.error').innerText()).includes('Unsupported file type'), 'unsupported upload -> honest error')

// ---- Dashboards
await sophie.goto(BASE + '#/dashboard')
await sophie.waitForTimeout(700)
await shot(sophie, 'p11-dashboard-sophie')
await anna.goto(BASE + '#/dashboard')
await anna.waitForTimeout(700)
check((await main(anna)).includes('Expert requests awaiting you'), 'Anna dashboard lists requests awaiting her')
await shot(anna, 'p12-dashboard-anna')
await sophie.goto(BASE + '#/health')
await sophie.waitForTimeout(700)
await shot(sophie, 'p13-health')

check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
stopServer()
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))])
console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
