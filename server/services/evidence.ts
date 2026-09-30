// Loads the knowledge base from SQLite and runs the shared (deterministic) engine.
import type { Claim, Client, Expert, KnowledgeBase, Resolution, Source, SourceType, Topic } from '../../shared/types'
import { todayIso } from '../../shared/freshness'
import { json, type DB } from '../db'

type Row = Record<string, unknown>

export function rowToClaim(r: Row): Claim {
  return {
    id: r.id as string,
    sourceId: r.version_id as string,
    country: r.country as Claim['country'],
    client: r.client as string,
    topic: r.topic as Claim['topic'],
    condition: r.condition as Claim['condition'],
    value: r.value as string,
    unit: (r.unit as string) ?? undefined,
    effectiveFrom: (r.effective_from as string) ?? null,
    effectiveTo: (r.effective_to as string) ?? null,
    excerpt: r.excerpt as string,
    location: (r.location as string) ?? undefined,
    exception: r.exception_label
      ? { label: r.exception_label as string, agreementRef: (r.exception_agreement_ref as string) ?? null, documentedBy: (r.exception_documented_by as string) ?? null }
      : undefined,
    duplicateOf: (r.duplicate_of as string) ?? undefined,
  }
}

export function rowToResolution(r: Row): Resolution {
  return {
    id: r.id as string,
    caseId: r.case_id as string,
    key: { topic: r.topic as Topic, condition: r.condition as Resolution['key']['condition'], country: r.country as 'BE' | 'NL', client: r.client as string },
    value: r.value as string,
    acceptedClaimIds: json(r.accepted_claim_ids as string, []),
    outdatedClaimIds: json(r.outdated_claim_ids as string, []),
    considered: json(r.considered as string, []),
    reason: r.reason as string,
    reference: r.supporting_version_id
      ? `Document ${r.supporting_title ?? r.supporting_version_id} (${r.supporting_version_id})${r.expert_statement ? ` — expert statement: ${r.expert_statement}` : ''}`
      : `Recorded expert statement: ${r.expert_statement}`,
    resolvedBy: r.resolved_by as string,
    resolvedByName: (r.resolver_name as string) ?? (r.resolved_by as string),
    resolvedAt: r.resolved_at as string,
    status: r.status as Resolution['status'],
    rereviewReason: (r.rereview_reason as string) ?? null,
  }
}

export function loadKB(db: DB): KnowledgeBase {
  const sources: Source[] = (db.prepare(`
    SELECT v.id, v.document_id, v.version, v.text, v.content_hash, v.source_updated, d.title, d.source_type, d.owner_name, d.country, d.client, d.link
    FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.status = 'active'`).all() as Row[]).map((r) => ({
    id: r.id as string,
    documentId: r.document_id as string,
    version: r.version as number,
    title: r.title as string,
    type: r.source_type as SourceType,
    text: r.text as string,
    updated: (r.source_updated as string) ?? null,
    ownerName: (r.owner_name as string) || null,
    country: r.country as Source['country'],
    client: r.client as string,
    link: (r.link as string) ?? '',
    contentHash: r.content_hash as string,
  }))
  const claims = (db.prepare(`
    SELECT c.* FROM claims c JOIN document_versions v ON v.id = c.version_id
    WHERE v.status = 'active' AND c.status = 'confirmed'`).all() as Row[]).map(rowToClaim)
  const clients = db.prepare('SELECT id, name, country FROM clients ORDER BY name').all() as unknown as Client[]
  const experts: Expert[] = (db.prepare(`SELECT * FROM users WHERE role = 'expert'`).all() as Row[]).map((r) => ({
    id: r.id as string,
    name: r.display_name as string,
    role: r.role_title as string,
    country: (r.country as Expert['country']) ?? null,
    ownsTopics: json(r.owns_topics as string, []),
  }))
  // VOUCH_AS_OF pins "today" for reproducible demos; otherwise freshness is measured against the real date.
  return { sources, claims, clients, experts, resolutions: loadResolutions(db), asOf: process.env.VOUCH_AS_OF || todayIso() }
}

export function loadResolutions(db: DB, where = '1=1', ...params: (string | number)[]): Resolution[] {
  return (db.prepare(`
    SELECT r.*, u.display_name AS resolver_name, d.title AS supporting_title
    FROM resolutions r JOIN users u ON u.id = r.resolved_by
    LEFT JOIN document_versions v ON v.id = r.supporting_version_id LEFT JOIN documents d ON d.id = v.document_id
    WHERE ${where} ORDER BY r.resolved_at DESC`).all(...params) as Row[]).map(rowToResolution)
}
