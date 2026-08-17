import crypto, { randomBytes, randomUUID } from 'node:crypto';
import { row, rows, run } from './db.mjs';
import { retrieveWorkspaceEvidence } from './retrieval.mjs';
import { representationCoverage } from './multimodal.mjs';
import { instructionContext } from './instructions.mjs';

const ALLOWED_CAPABILITIES = Object.freeze(['status','query','sources','resource','visual']);
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_TTL_MS = 8 * 60 * 60 * 1000;

function now() { return new Date().toISOString(); }
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

export function createAgentContextSession(db, { workspaceId, rootId, agent, ttlMs = DEFAULT_TTL_MS, capabilities = ALLOWED_CAPABILITIES }) {
  const root = row(db, 'SELECT * FROM workspace_roots WHERE id=? AND workspace_id=?', rootId, workspaceId);
  if (!root || root.root_kind !== 'repository') throw Object.assign(new Error('registered repository root required'), { code: 'AGENT_ROOT_NOT_REPOSITORY' });
  const selected = [...new Set(capabilities.map(String))].filter(item => ALLOWED_CAPABILITIES.includes(item));
  if (!selected.length) throw Object.assign(new Error('at least one context capability is required'), { code: 'AGENT_CONTEXT_CAPABILITY_INVALID' });
  const token = randomBytes(32).toString('base64url');
  const id = `agent-context-${randomUUID()}`;
  const createdAt = now();
  const expiresAt = new Date(Date.now() + Math.min(MAX_TTL_MS, Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS))).toISOString();
  run(db, `INSERT INTO agent_context_sessions (id,token_hash,workspace_id,root_id,agent,capabilities_json,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    id, tokenHash(token), workspaceId, rootId, String(agent || ''), JSON.stringify(selected), expiresAt, createdAt);
  return { id, token, workspace_id: workspaceId, root_id: rootId, agent, capabilities: selected, created_at: createdAt, expires_at: expiresAt };
}

export function revokeAgentContextSession(db, id) {
  const result = run(db, `UPDATE agent_context_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL`, now(), id);
  return result.changes > 0;
}

export function authenticateAgentContext(db, token, capability) {
  if (!token) return { ok: false, code: 'AGENT_CONTEXT_AUTH_REQUIRED', message: 'scoped agent context token required' };
  const session = row(db, 'SELECT * FROM agent_context_sessions WHERE token_hash=?', tokenHash(String(token)));
  if (!session || session.revoked_at) return { ok: false, code: 'AGENT_CONTEXT_AUTH_REJECTED', message: 'scoped agent context token rejected' };
  if (Date.parse(session.expires_at) <= Date.now()) return { ok: false, code: 'AGENT_CONTEXT_EXPIRED', message: 'scoped agent context session expired' };
  const capabilities = JSON.parse(session.capabilities_json || '[]');
  if (!capabilities.includes(capability)) return { ok: false, code: 'AGENT_CONTEXT_CAPABILITY_DENIED', message: `agent context capability denied: ${capability}` };
  run(db, 'UPDATE agent_context_sessions SET last_used_at=? WHERE id=?', now(), session.id);
  return { ok: true, session: { ...session, capabilities } };
}

export function agentContextStatus(db, session) {
  const workspace = row(db, 'SELECT id,name,active_focus,freshness_status,history_coverage,corpus_generation,index_generation,last_verified_at FROM workspaces WHERE id=?', session.workspace_id);
  const root = row(db, 'SELECT id,label,root_kind,status,last_verified_at FROM workspace_roots WHERE id=? AND workspace_id=?', session.root_id, session.workspace_id);
  return {
    session: { id: session.id, agent: session.agent, capabilities: session.capabilities, expires_at: session.expires_at },
    workspace,
    root,
    representation_coverage: representationCoverage(db, session.workspace_id),
    instruction_context: instructionContext(db, session.workspace_id)
  };
}

export function agentContextQuery(db, session, query, characterBudget = 24_000) {
  const retrieval = retrieveWorkspaceEvidence(db, { workspaceId: session.workspace_id, query, provider: session.agent || 'local_agent', characterBudget: Math.min(60_000, Math.max(2_000, Number(characterBudget) || 24_000)) });
  return {
    query,
    workspace_id: session.workspace_id,
    selected: retrieval.selected,
    used_characters: retrieval.used_characters,
    candidate_count: retrieval.candidate_count,
    instruction_context: instructionContext(db, session.workspace_id)
  };
}

export function agentContextSources(db, session) {
  return rows(db, `SELECT r.id,r.relative_path,r.resource_type,r.mime_type,r.current_version_id,v.sha256,v.size_bytes,v.observed_at,v.representation_coverage,v.coverage_json,wr.id AS root_id,wr.label AS root_label
    FROM workspace_resources r JOIN resource_versions v ON v.id=r.current_version_id JOIN workspace_roots wr ON wr.id=r.root_id
    WHERE r.workspace_id=? AND r.status='active' ORDER BY r.relative_path`, session.workspace_id).map(item => ({ ...item, coverage: JSON.parse(item.coverage_json || '{}') }));
}

export function agentContextResource(db, session, resourceId) {
  const resource = row(db, `SELECT r.id,r.relative_path,r.resource_type,r.mime_type,r.current_version_id,v.sha256,v.size_bytes,v.observed_at,v.representation_coverage,v.coverage_json
    FROM workspace_resources r JOIN resource_versions v ON v.id=r.current_version_id WHERE r.id=? AND r.workspace_id=? AND r.status='active'`, resourceId, session.workspace_id);
  if (!resource) throw Object.assign(new Error('current resource not found in scoped Project Space'), { code: 'AGENT_CONTEXT_RESOURCE_NOT_FOUND' });
  return {
    ...resource, coverage: JSON.parse(resource.coverage_json || '{}'),
    chunks: rows(db, `SELECT id,ordinal,content,line_start,line_end,page_start,page_end,representation_id,source_kind,authority,confidence,region_json FROM resource_chunks WHERE resource_version_id=? ORDER BY ordinal LIMIT 500`, resource.current_version_id).map(item => ({ ...item, region: JSON.parse(item.region_json || '{}') })),
    representations: rows(db, `SELECT id,representation_kind,status,page_start,page_end,extractor,extractor_version,confidence,trust_class,metadata_json FROM resource_representations WHERE resource_version_id=? ORDER BY page_start,representation_kind`, resource.current_version_id).map(item => ({ ...item, metadata: JSON.parse(item.metadata_json || '{}') }))
  };
}

export function agentContextVisual(db, session, representationId) {
  const representation = row(db, `SELECT rr.*,a.vault_path,a.mime_type,a.size_bytes,a.sha256,r.relative_path
    FROM resource_representations rr JOIN workspace_resources r ON r.id=rr.resource_id AND r.current_version_id=rr.resource_version_id
    JOIN artifacts a ON a.id=rr.artifact_id WHERE rr.id=? AND rr.workspace_id=? AND rr.representation_kind IN ('original_visual','page_image','embedded_image')`, representationId, session.workspace_id);
  if (!representation) throw Object.assign(new Error('current visual representation not found in scoped Project Space'), { code: 'AGENT_CONTEXT_VISUAL_NOT_FOUND' });
  return representation;
}
