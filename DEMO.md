# Vouch — demo run sheet (≈ 2:50)

One story, one consultant, one question. Every beat below was verified against the real app and the real
local model (`qwen2.5:7b`, temperature 0 — plain RAG answers "35%" on every run).

## Pre-flight (2 minutes before recording)

1. `brew services start ollama` · `source .venv/bin/activate` · `streamlit run app.py` → http://localhost:8501
2. Sidebar shows **🟢 Local LLM running**. Warm the model: tick *Plain RAG mode*, click the first preset once, untick.
3. Log in as **lotte** → **🔄 Reset demo** (clears resolutions + gap log) → log out, log in as **sophie**.
4. Set **Client = Janssens** (country BE).
5. Browser: full screen, zoom ~110%, hide bookmarks bar. Close other tabs/notifications.
6. Accounts: `VOUCH_DEMO_MODE=true` and `VOUCH_DEMO_PASSWORD=…` in `.env`, then `python -m vouch.accounts seed-demo`.
   Log in as **sophie** for scenes 1–4, **anna** for scene 5, **sophie** again for 6–7, **lotte** (admin) for 8.

## Scenes

| # | Time | Click | On screen | Say |
|---|---|---|---|---|
| 1 | 0:00–0:20 | — (Consultant page, Janssens selected) | Sophie's context line | "Sophie is a payroll consultant at SD Worx. She just inherited the Belgian brewery Janssens from a colleague who moved teams. At 16:30 the client asks: *what overtime surcharge do we pay on Saturday hours?*" |
| 2 | 0:20–0:40 | Tick **Plain RAG mode** → click preset **"What overtime surcharge do we pay on Saturday hours?"** | *"For Janssens in Belgium, the overtime surcharge for Saturday hours is 35%."* + sources used | "A normal AI assistant answers instantly and confidently: 35%. It's wrong — the official policy says 50%, and the special agreement it's quoting ended in January. Sophie has no way to know." |
| 3 | 0:40–1:25 | Untick **Plain RAG mode** | ⚠️ *I can't give you a reliable answer…* · 50% (score 6) vs 35% (score 3) · Ignored: Dutch manual 40% · ✅ Saturday counts as overtime | "Same question, with Vouch. It refuses to guess. Two credible sources disagree: the Belgian policy — official, updated in May, owner active, score 6 — and a Teams message from Tom — a chat, score 3, and it mentions a client exception but there is *no agreement document* for Janssens." · open one **Why this score** expander → "Every score is explained, with the verbatim quote." · point at Ignored → "The Dutch manual says 40% — Vouch ignores it and says why: it applies to the Netherlands." · point at the green card → "And what *is* reliable, it confirms: Saturday counts as overtime — three sources agree." |
| 4 | 1:25–1:40 | Click **Ask Anna** | *Request sent to Anna…* | "Vouch doesn't stop at 'I don't know'. It routes the doubt to the right person: Anna owns the policy and answered six similar questions." |
| 5 | 1:40–2:05 | **Log out** → log in as **anna** → sidebar **Expert** → pick **50% — Belgian Payroll Policy** → note `agreement ended Jan 2026` → **Resolve** | Both sources side by side with scores and quotes → *Saved.* | "Anna sees both sources side by side, confirms 50%, and adds one line of context. Ten seconds of expert time." |
| 6 | 2:05–2:25 | **Log out** → log in as **sophie** → click the Saturday preset again | ✅ *50%. Based on Belgian Payroll Policy (May 2026).* · *Confirmed by Anna Peeters on 30 Sep 2026* · *Teams message (35%) marked outdated* | "The next person who asks gets a verified answer — and sees who confirmed it and when. Knowledge that lived in one person's head is now captured." |
| 7 | 2:25–2:40 | Click preset **"What surcharge applies to public holidays falling on a Sunday?"** | ❓ *No source in the knowledge base answers this. I won't guess.* → Ask Pieter | "And when nothing in the knowledge base answers the question, Vouch says so — plain RAG answered '100%' here. The gap is logged and routed to Pieter." (optionally click **Ask Pieter**) |
| 8 | 2:40–2:55 | **Log out** → log in as **lotte** (admin) → **Knowledge health**, then **Evaluation** | Counters: conflicts 0, requests, stale 2, ownerless 2, gaps 1 · eval table | "Managers see the health of the knowledge base: conflicts, outdated and ownerless documents, open gaps. On our evaluation, plain RAG was confidently wrong on 3 of 5 questions; Vouch on none." |
| — | close | — | — | "Search finds answers. **Vouch tells you which ones you can act on — and when you can't, who to ask.** It runs fully on a local model: no payroll data leaves the machine, and the model never decides trust — transparent rules do." |

## Optional beats (if time allows, or for the live pitch)

- **Plain RAG didn't learn:** after scene 6, tick Plain RAG mode again → it still says 35%. Vouch now says ✅ 50%.
- **Documented exception done right:** Client = **DeSmet** → same question → ✅ 60% "Client agreement for DeSmet
  overrides the general policy (general rule: 50%)". Shows Vouch isn't anti-exception — it's anti-*unbacked* exception.
- **Outdated:** "What is the home-working allowance?" (Client = all) → 🕓 only a superseded 2023 procedure; the Dutch
  €2.35 is ignored. Plain RAG answered "€140 per month".
- **Anti-hallucination at ingest:** the extractor proposed "Sunday hours count as overtime"; the verbatim-quote check
  rejected it (`python -m vouch.extract` prints the rejection).

## If something goes wrong

| Problem | Fix |
|---|---|
| Plain RAG slow on first click | You skipped the warm-up; wait ~5 s or cut in editing. |
| Ollama down | Plain RAG replays the recorded run (caption says "recorded run"); everything else is unaffected. |
| Scene 6 still shows ⚠️ | Anna resolved the wrong claim — log in as lotte, **🔄 Reset demo**, redo from scene 2. |
| Leftover state from a rehearsal | As lotte: **🔄 Reset demo**. Then log in as sophie and set Client = Janssens. |
