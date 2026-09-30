// SYNTHETIC DEMONSTRATION DATA. Every person, client, document, agreement and
// percentage below is fictional and exists only for this hackathon prototype.
// Used by the database seed command and by the engine tests.
import { GENERAL, type Claim, type Client, type KnowledgeBase, type Source, type SourceType } from './types'

export const EXAMPLE_QUESTION = 'What surcharge applies to Saturday overtime?'

export const CLIENTS: Client[] = [
  { id: 'janssens', name: 'Janssens NV', country: 'BE' },
  { id: 'maes', name: 'Maes BVBA', country: 'BE' },
  { id: 'devries', name: 'De Vries BV', country: 'NL' },
]

export interface SeedDocument {
  id: string
  title: string
  type: SourceType
  text: string
  updated: string
  ownerName: string | null
  country: 'BE' | 'NL'
  client: string
  link: string
}

export const SEED_DOCUMENTS: SeedDocument[] = [
  {
    id: 'S1',
    title: 'BE Payroll Policy — Overtime & Weekend Work (v4)',
    type: 'Policy document',
    text:
      'Section 3.2 — Saturday work. Hours worked on a Saturday outside the employee’s regular schedule qualify as overtime. ' +
      'Section 3.4 — Surcharge. Saturday overtime is paid with a surcharge of 50% on the gross hourly wage, unless a documented client agreement stipulates otherwise.',
    updated: '2026-05-12',
    ownerName: 'Anna Peeters',
    country: 'BE',
    client: GENERAL,
    link: 'demo://sharepoint/policies/be-overtime-v4',
  },
  {
    id: 'S2',
    title: 'Janssens NV — Client payroll conditions',
    type: 'Client conditions sheet',
    text:
      'Working week: 38 hours, Monday to Friday. Hours performed on Saturday are registered as overtime and processed in the overtime payroll run. ' +
      'Surcharge rates follow the applicable policy or agreement.',
    updated: '2026-02-03',
    ownerName: 'Pieter Claes',
    country: 'BE',
    client: 'janssens',
    link: 'demo://sharepoint/clients/janssens/conditions',
  },
  {
    id: 'S3',
    title: 'Teams — #payroll-be-consultants',
    type: 'Teams message',
    text:
      'Tom Wouters: Heads-up for Janssens: Saturday overtime goes at 35%, not the standard rate — they have a client agreement for that. ' +
      'I don’t have the agreement file, ask the account team.',
    updated: '2026-03-18',
    ownerName: 'Tom Wouters',
    country: 'BE',
    client: 'janssens',
    link: 'demo://teams/payroll-be-consultants/msg-8812',
  },
  {
    id: 'S4',
    title: 'Teams — #payroll-onboarding (forwarded message)',
    type: 'Teams message',
    text:
      'Lies Vermeulen: Forwarding for the new joiners — "Heads-up for Janssens: Saturday overtime goes at 35%, not the standard rate — they have a client agreement for that."',
    updated: '2026-04-02',
    ownerName: 'Lies Vermeulen',
    country: 'BE',
    client: 'janssens',
    link: 'demo://teams/payroll-onboarding/msg-9120',
  },
  {
    id: 'S5',
    title: 'NL Payroll Manual — Overwerk',
    type: 'Manual',
    text:
      'Hoofdstuk 5 — Weekendwerk. Overwerk op zaterdag wordt vergoed met een toeslag van 40%. (Saturday overtime is paid with a 40% surcharge.)',
    updated: '2026-04-20',
    ownerName: 'Jan Visser',
    country: 'NL',
    client: GENERAL,
    link: 'demo://sharepoint/nl/manual-overwerk',
  },
  {
    id: 'S6',
    title: 'Legacy wiki — Weekend work FAQ',
    type: 'Wiki page',
    text: 'Sunday work is paid at a 100% surcharge. For Saturday, check the current policy.',
    updated: '2023-11-08',
    ownerName: null,
    country: 'BE',
    client: GENERAL,
    link: 'demo://wiki/weekend-faq',
  },
  {
    id: 'S7',
    title: 'Email — Maes BVBA onboarding notes',
    type: 'Email',
    text:
      'Maes mentioned a sector arrangement that sets Saturday overtime at 45%. The arrangement document is still to be received.',
    updated: '2026-01-22',
    ownerName: 'Lies Vermeulen',
    country: 'BE',
    client: 'maes',
    link: 'demo://mail/maes-onboarding',
  },
]

/** Seed claims: hand-written for the synthetic seed documents (uploaded documents are extracted live by Claude). */
export const CLAIMS: Claim[] = [
  {
    id: 'C1', sourceId: 'S1-v1', country: 'BE', client: GENERAL,
    topic: 'overtime_eligibility', condition: 'saturday', value: 'qualifies',
    excerpt: 'Hours worked on a Saturday outside the employee’s regular schedule qualify as overtime.',
  },
  {
    id: 'C2', sourceId: 'S1-v1', country: 'BE', client: GENERAL,
    topic: 'overtime_surcharge', condition: 'saturday', value: '50%',
    excerpt: 'Saturday overtime is paid with a surcharge of 50% on the gross hourly wage, unless a documented client agreement stipulates otherwise.',
  },
  {
    id: 'C3', sourceId: 'S2-v1', country: 'BE', client: 'janssens',
    topic: 'overtime_eligibility', condition: 'saturday', value: 'qualifies',
    excerpt: 'Hours performed on Saturday are registered as overtime and processed in the overtime payroll run.',
  },
  {
    id: 'C4', sourceId: 'S3-v1', country: 'BE', client: 'janssens',
    topic: 'overtime_surcharge', condition: 'saturday', value: '35%',
    excerpt: 'Saturday overtime goes at 35%, not the standard rate — they have a client agreement for that.',
    exception: { label: 'Janssens client agreement', documentedBy: null },
  },
  {
    id: 'C5', sourceId: 'S4-v1', country: 'BE', client: 'janssens',
    topic: 'overtime_surcharge', condition: 'saturday', value: '35%',
    excerpt: 'Saturday overtime goes at 35%, not the standard rate — they have a client agreement for that.',
    exception: { label: 'Janssens client agreement', documentedBy: null },
    duplicateOf: 'C4',
  },
  {
    id: 'C6', sourceId: 'S5-v1', country: 'NL', client: GENERAL,
    topic: 'overtime_surcharge', condition: 'saturday', value: '40%',
    excerpt: 'Overwerk op zaterdag wordt vergoed met een toeslag van 40%. (Saturday overtime is paid with a 40% surcharge.)',
  },
  {
    id: 'C7', sourceId: 'S6-v1', country: 'BE', client: GENERAL,
    topic: 'overtime_surcharge', condition: 'sunday', value: '100%',
    excerpt: 'Sunday work is paid at a 100% surcharge.',
  },
  {
    id: 'C8', sourceId: 'S7-v1', country: 'BE', client: 'maes',
    topic: 'overtime_surcharge', condition: 'saturday', value: '45%',
    excerpt: 'Maes mentioned a sector arrangement that sets Saturday overtime at 45%.',
    exception: { label: 'Maes sector arrangement', documentedBy: null },
  },
]


export const versionId = (docId: string, version = 1) => `${docId}-v${version}`

/** In-memory knowledge base built from the seed data (tests only; the app reads the database). */
export function fixtureKB(): KnowledgeBase {
  const sources: Source[] = SEED_DOCUMENTS.map((d) => ({
    id: versionId(d.id), documentId: d.id, version: 1, title: d.title, type: d.type, text: d.text,
    updated: d.updated, ownerName: d.ownerName, country: d.country, client: d.client, link: d.link, contentHash: `seed-${d.id}`,
  }))
  return {
    sources,
    claims: CLAIMS.map((c) => ({ ...c })),
    clients: CLIENTS,
    experts: [
      { id: 'anna', name: 'Anna Peeters', role: 'Payroll policy owner — Belgium', country: 'BE', ownsTopics: ['overtime_eligibility', 'overtime_surcharge'] },
      { id: 'jan', name: 'Jan Visser', role: 'Payroll policy owner — Netherlands', country: 'NL', ownsTopics: ['overtime_eligibility', 'overtime_surcharge'] },
    ],
    resolutions: [],
  }
}
