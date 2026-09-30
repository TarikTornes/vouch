**Plain RAG was confidently wrong on 3/5 questions (correct 2/5). Vouch was confidently wrong on 0/5, correct on 2/5, and flagged or abstained on 3/3 unsafe cases (conflict, outdated, unanswerable).**

Model: `qwen2.5:7b` (local, Ollama) · knowledge as of 2026-09-30 · Vouch verdict matched the expected verdict on 5/5.

| # | Case | Question (context) | Ground truth | Plain RAG | Vouch |
|---|---|---|---|---|---|
| 1 | conflict | What overtime surcharge do we pay on Saturday hours? (BE, Janssens) | 50%: the Janssens agreement ended Jan 2026 | ❌ confidently wrong | 🟡 flagged / abstained — conflicting → ask Anna Peeters |
| 2 | out-of-scope | What overtime surcharge do we pay on Saturday hours? (BE, Wouters) | 50%: general BE policy; NL manual (40%) does not apply | ✅ correct | ✅ correct — verified 50% |
| 3 | outdated | What is the home-working allowance? (BE, all) | —: no current value; the 2023 procedure (€140) is superseded | ❌ confidently wrong | 🟡 flagged / abstained — possibly outdated → ask Anna Peeters |
| 4 | corroborated | Do Saturday hours count as overtime? (BE, Janssens) | yes: 3 BE sources agree | ✅ correct | ✅ correct — verified Yes |
| 5 | unanswerable | What surcharge applies to public holidays falling on a Sunday? (BE, Janssens) | —: not in the knowledge base (follows the sector agreement) | ❌ confidently wrong | 🟡 flagged / abstained — unsupported → ask Pieter Claes |

### Raw plain-RAG answers

**#1 conflict** — retrieved: procedure_be_overtime_faq_2025-11, teams_tom_2026-03-12, manual_nl_payroll_2025-11

```text
For Janssens in Belgium, the overtime surcharge for Saturday hours is 35%.
```

**#2 out-of-scope** — retrieved: procedure_be_overtime_faq_2025-11, manual_nl_payroll_2025-11, policy_be_payroll_2026-05

```text
For Wouters, based on the Belgian Payroll Policy (May 2026), the overtime surcharge for Saturday hours is 50%.
```

**#3 outdated** — retrieved: manual_nl_homework_2026-01, procedure_be_payroll_2023-03, guideline_be_travel_2024-02

```text
The home-working allowance in Belgium is €140 per month.
```

**#4 corroborated** — retrieved: email_handover_janssens_2026-09, procedure_be_overtime_faq_2025-11, teams_tom_2026-03-12

```text
Yes, Saturday hours count as overtime for Janssens. In Belgium, the overtime surcharge for Saturdays is 35%, as per the special agreement.
```

**#5 unanswerable** — retrieved: policy_be_payroll_2026-05, teams_pieter_2026-07-02, teams_tom_2026-03-12

```text
For public holidays falling on a Sunday, the surcharge is 100%.
```

Grading: plain RAG is graded by rules — a listed wrong value without hedge words is *confidently wrong* (checked first, since that is what the consultant would act on); the true value without hedging → *correct*; otherwise *flagged*. Vouch is graded from its structured verdict. `manual_override` in `questions.json` allows an honest human correction and is marked (manual).
