# Vouch

Prototype for the SD Worx hackathon challenge "Unlock the Knowledge Within".

A payroll consultant asks a question, for example "What surcharge applies to Saturday overtime?" for client Janssens. Instead of blending whatever documents it finds into one confident answer, Vouch checks each source and tells the consultant whether the answer can be trusted. If it can't, the question goes to the person who owns the policy, and their answer is stored so the next colleague gets it straight away.

All people, clients, documents and numbers are made up. This is not payroll advice.

## How it decides

Each claim in a source is checked for:

- **Scope**: does it apply to this country and this client?
- **Freshness**: updated in the last 12 months is current, 12 to 24 months needs review, older than 24 months (or past its end date) is too old. Too-old sources are shown but never decide an answer.
- **Independence**: a forwarded copy of a message doesn't count as a second source.
- **Exceptions**: a client-specific value only overrides the general policy if the agreement behind it is on file.

The result is one of: supported, conflicting, possibly outdated, or unsupported. For anything except supported, the consultant can ask the expert. The expert either picks the correct value from the evidence or, if there is no current source, answers from their own knowledge with a written statement. That answer becomes a source itself and is reused for later questions about the same topic, condition, country and client, however they are worded. Expert answers also expire after 24 months, and they go back for review when new evidence shows up.

No LLM is used in this version. Questions are matched with keyword rules and claims are entered by hand; the verdicts are plain code in `shared/evidence.ts` and `shared/freshness.ts`. There is inactive code for Claude (`server/services/llm.ts`) and email via Resend, which only turns on with an API key.

## Running it

Needs Node.js 22.5 or newer.

```bash
npm install
cp .env.example .env     # set the three DEMO_*_PASSWORD values
npm run db:reset         # create and seed the SQLite database
npm start                # http://localhost:8787
```

Accounts: `sophie` (consultant), `anna` (Belgian policy owner) and `jan` (Dutch expert, who can't act on Belgian cases). Set `VOUCH_AS_OF=2026-09-30` in `.env` to measure freshness against a fixed date instead of today.

`npm test` runs the tests, `npm run build` type-checks and builds the UI, `npm run dev` starts the API and Vite dev server.

## Security

Passwords are hashed with scrypt, sessions use HttpOnly cookies, and changes need a matching Origin plus a CSRF header. Only the assigned expert can resolve a case, and the server takes their identity from the session rather than the request. Login and API calls are rate-limited and uploads are size-limited.

## Limitations

- No LLM, so claim extraction is manual and the keyword rules only cover overtime surcharges and eligibility.
- No email; experts see requests in the app.
- In-memory rate limiter, no password reset, and the SQLite file needs persistent disk.

## Layout

- `shared/`: evidence rules, freshness, quality checks, types, seed data
- `server/`: Express API, SQLite migrations and seed, case workflow
- `src/`: React UI
