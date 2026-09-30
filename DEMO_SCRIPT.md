# Vouch: demo script (under 3 minutes, zero-cost build)

## Setup (before recording)

- Run `npm run db:reset`, then `npm start`.
- **Browser profile A** (Sophie): open http://localhost:8787 and sign in as `sophie`.
- **Browser profile B** (Anna, a separate Chrome profile or a guest window): sign in as `anna`.
- Keep `demo/janssens-sunday-addendum.txt` ready.
- Say at the start: *all data is fictional; this build has no LLM and no external email connected.* The sidebar box shows the same thing.

---

**0:00 — Dashboard (Sophie).** "The counts come from the shared database: 7 active documents and 2 open conflicts. Each card opens its working list."

**0:15 — Upload.** Go to **Documents → Add document** → *Upload file* and pick `janssens-sunday-addendum.txt`.
- Fill in: Title *Janssens NV — Sunday work addendum*, type *Agreement*, owner *Pieter Claes*, *Belgium*, *Janssens NV*, and a source date.
- Click **Upload document**.
- "No LLM is connected, so Vouch says plainly that no automatic extraction ran."

**0:35 — Claim entry and review.**
- Select the sentence about the 80% surcharge in the original text, then click **Use selected text**.
- Set condition *Sunday*, value *80%*, and click **Add and confirm claim**.
- "The server checks that the excerpt really appears in the document. That proves traceability, not truth."
- Tick the currency check and click **Activate version**.
- Point to the quality meter: "Five checks, 20 points each, and each one shows its evidence. 100% means the checks are done. It doesn't mean the answer is right."

**1:00 — Ask.** Go to **Ask Vouch**, choose Belgium / Janssens, and ask *"What extra pay applies when someone works overtime on a Sunday?"*
- "The keyword rules recognised the paraphrase."
- Result: **Conflicting**, the new addendum at 80% against an ownerless 2023 wiki page at 100%.
- "Vouch won't choose between them just because one is newer."

**1:20 — Ask an expert.** Click **Ask an expert**.
- "This creates a real case in the database and an in-app notification for Anna. External email is not configured, and the screen says so. Nothing claims an email was sent."

**1:35 — Anna's session (profile B).** A red badge appears on **Expert requests** within about 8 seconds (the app polls the server). Open the notification and the case.
- Show the evidence side by side and the options *request information* / *leave unresolved*.
- Choose 80%, keep the wiki claim ticked as outdated, type a reason, and link document S8 as support. Click **Save resolution**.
- "The server records Anna's identity and the time. Only the assigned expert can do this; another expert gets 'not found or no access'."

**2:05 — Back to Sophie.** The notification bell shows *Anna Peeters resolved…*. Ask again.
- Result: **80% — expert-confirmed**, with provenance (who, when, which evidence versions, scope).
- Switch the client to *Maes BVBA* and ask: "still the general 100%. The resolution applies only to Janssens."

**2:30 — Changed source (optional, if time allows).** On S8, click **Upload new version** and use `janssens-sunday-addendum-v2.txt` (75%). Add the claim and activate.
- "Vouch sends Anna's approval back for re-review. An old approval can't override evidence it never saw."

**2:45 — Close on the dashboard.**
"Vouch makes uncertainty actionable. When sources disagree, it shows the conflict, connects the question to its owner, and preserves the resolution so the next colleague can reuse it."
