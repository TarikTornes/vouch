# Vouch — SD Worx challenge prototype

> **Vouch makes uncertainty actionable.** When sources disagree, it shows the conflict, connects the question to its owner, and preserves the resolution so the next colleague can reuse it.

**Synthetic data only.** Every person, client, document, agreement and percentage is fictional. This is a hackathon prototype, **not production-ready**, and not payroll advice.

## Current configuration: zero cost

This build runs with **no paid services and no API keys**:

| Capability | Status in this build |
|---|---|
| Backend + shared persistent database | ✅ Node.js + Express + TypeScript, SQLite file on local disk (`data/vouch.sqlite`) |
| Separate authenticated accounts | ✅ Consultant (Sophie), expert (Anna), second expert (Jan); server-side sessions |
| Manual document addition | ✅ Upload .txt / .md / text-based .pdf, or paste text |
| Claim extraction | ⚠️ **No LLM connected.** A consultant enters each claim by hand, quoting an excerpt that the server checks against the stored text |
| Question interpretation | ⚠️ **No LLM connected.** Deterministic keyword rules map questions to the supported domain (overtime surcharge or eligibility on Saturday / Sunday / public holidays / nights) and report anything else as unsupported |
| Ask an expert | ✅ Real shared case plus **in-app notifications**. The expert resolves the case in her own session and the consultant is notified |
| External email | ⏸ **Pending: not configured.** No email is queued, and the UI never says one was sent |
| Claude integration code | Present (`server/services/llm.ts`, structured outputs + zod validation) but **inactive and unverified**: it switches on only if `ANTHROPIC_API_KEY` is set. No live Claude call has been made. |
| Resend email code | Present (`server/services/notifications.ts`: outbox, idempotency key, retry) but **inactive and unverified against the real provider**; it switches on only with `RESEND_API_KEY` + `DEMO_EXPERT_EMAIL` |

No local model was available: there is no Ollama, LM Studio or llama.cpp installation and no NVIDIA GPU (CPU only, 15 GB RAM). Installing a runtime and downloading a model was not viable in the time available.

## Setup and start

Requires Node.js 22.5+ (uses the built-in `node:sqlite`; tested on Node 24).

```bash
npm install
cp .env.example .env        # then set the three DEMO_*_PASSWORD values (any strings)
npm run db:reset            # create the database, run migrations, seed synthetic data
npm start                   # build the UI and serve everything on http://localhost:8787
```

`npm start` is the single command for the demo. The backend serves the built frontend from one origin.

Other commands:

| Command | What it does |
|---|---|
| `npm run dev` | Development mode: Express on :8787 plus Vite on :5173, which proxies `/api` |
| `npm run db:migrate` | Apply pending SQL migrations (`server/db/migrations/*.sql`) |
| `npm run db:seed` | Upsert demo users from `.env`; insert the synthetic documents if the database has none |
| `npm run db:reset` | Delete the database file and recreate it: migrate + seed (repeatable) |
| `npm test` | 32 tests: evidence engine + API integration (vitest + supertest) |
| `npm run build` | Type-check (frontend, shared, server) + production UI build |
| `node scripts/e2e-connected.mjs <dir>` | Browser proof with separate sessions (needs `npm i --no-save playwright-core` and Chrome; reset the DB first) |

Demo accounts are `sophie` (consultant), `anna` (Belgian overtime expert) and `jan` (Dutch expert, used to show that an unassigned expert cannot act). Passwords come from `.env`, which is gitignored; they are never committed.

## What works (verified)

- **Evidence rules**, unchanged from the first prototype and now run on the server from database inputs:
  - Country and client applicability are filtered first. Unknown scope stays unknown and is excluded.
  - Claims are compared only when topic and condition match.
  - An undocumented client exception keeps a conflict open.
  - Copies are not counted as corroboration.
  - Age and ownership do not decide correctness.
- **Scoped resolutions**:
  - A resolution applies only to its exact topic, condition, country and client, and only while it is active.
  - It never applies over evidence it did not consider. If a document gets a new version or new relevant evidence appears, the resolution goes to *needs re-review* and a re-review case opens automatically.
- **Document lifecycle**:
  - Stages are Uploaded → Processing → Needs review → Active, with explicit Failed and Rejected states. Processing is shown as *skipped* because no LLM is connected.
  - Every version is stored with its SHA-256 hash. Identical content is refused so repeated uploads cannot inflate corroboration, and a claim duplicated from another document is marked as a copy.
  - Limits: 1 MB per file, 30,000 characters of text. Unsupported file types are rejected. A scanned PDF gets "OCR not available — paste text".
- **Expert cases**:
  - The server recomputes the answer before creating a case. The case stores the question, context, answer snapshot and exact evidence versions.
  - At most one open case exists per claim key, so repeated clicks cannot create duplicates.
  - The expert can resolve, request more information, or leave the case unresolved.
  - A resolution needs a reason plus a linked active document or a recorded expert statement.
  - The resolution and the case transition are saved in one transaction. A stale `rowVersion` gets a 409, which rejects concurrent submissions.
  - The expert's identity and timestamp come from the server session. Any `resolvedBy` sent by the browser is ignored.
- **Permissions and security**:
  - Only the assigned expert can resolve a case. Other users get "not found or no access", so knowing a case ID grants nothing.
  - Passwords are hashed with scrypt. Session tokens are stored hashed, in HttpOnly SameSite=Lax cookies.
  - Mutations are checked for Origin and a custom CSRF header.
  - Login and API calls are rate-limited, requests are validated, and upload limits apply.
- **Knowledge health and dashboard** are computed from the database:
  - Active documents, documents awaiting review, open conflicts, requests awaiting action, and resolutions needing re-review.
  - Recent uploads and resolutions. Every card opens its filtered list.
- **Document quality checks**: five checks worth 20 points each (provenance, owner, applicability reviewed, currency reviewed, human review).
  - Each check shows its evidence. Failed processing shows *Not assessed*.
  - The meter uses a continuous gradient (#7F1D1D → #DC2626 → #EA580C → #CA8A04 → #15803D). These are application status colours, not brand colours.
  - The score never overrides a conflict or picks which value wins.

### Verification results (30 Sep 2026)

- `npm test`: **32/32 passed**. This includes integration tests for permissions, persistence across database reopen, ingestion, duplicate refusal, re-review, email outbox and retry (with a test double), concurrency and scope.
- `npm run build`: passes.
- `scripts/e2e-connected.mjs` in Chrome with separate browser contexts for Sophie, Anna and Jan: **21/21 checks passed**, covering:
  - upload, manual claim entry and activation
  - a paraphrased question that finds the new conflict
  - case creation and Anna's in-app notification
  - Jan and Sophie both refused (403) when they try to resolve
  - Anna's resolution and Sophie's notification
  - the scoped answer, with another client unaffected
  - a server restart that preserves data
  - a changed document that triggers re-review
  - an honest error on a bad upload

## Brand

The colours are taken from SD Worx's publicly served design-system stylesheet, *Ignite* v2.2.0 (`https://cdn.sdworx.com/ignite/styling/v2/2.2.0/website/system.css`). They are centralised as CSS tokens in `src/index.css`, with the original token names in comments. Body font per Ignite: Inter.

- **Not verified:** a June 2026 brand refresh. No official announcement was found, and no hackathon brand assets were supplied.
- **Not bundled:** the SD Worx logo and the proprietary display font.

## Remaining limitations and future work

- No LLM: claim extraction and question interpretation are manual or rule-based. The Claude code path exists but has never been exercised against the real API.
- No external email: Anna finds requests in the app. The Resend code path has only been tested against a test double.
- Single-process in-memory rate limiter. No password reset or account management. The SQLite file needs to live on persistent disk (do not deploy it on ephemeral storage).
- Keyword rules cover a narrow domain and some phrasings will be reported as unsupported. That is intentional: the rules don't guess.
- Not production-ready: no audit export, no accessibility audit beyond keyboard/focus/labels, no load testing.

## Code map

- `shared/`: evidence engine (`evidence.ts`), quality checks and colour interpolation (`quality.ts`), types, synthetic seed fixtures
- `server/db/`: SQLite access, migrations, seed
- `server/services/`: `evidence.ts` (loads the database into the engine), `documents.ts` (ingestion, review, activation), `cases.ts` (expert workflow, re-review), `notifications.ts` (in-app + email outbox), `rules.ts` (keyword interpreter), `llm.ts` (inactive Claude client)
- `server/routes/`: sessions, documents, questions, cases, notifications/dashboard/health
- `src/`: React UI with a left sidebar (Dashboard, Ask Vouch, Documents, Expert requests, Knowledge health)
- `demo/`: fictional documents for the live demo
