import crypto from 'node:crypto';
import { row, run } from './db.mjs';
import { instructionContext } from './instructions.mjs';
import { retrieveWorkspaceEvidence } from './retrieval.mjs';
import { surfaceRegistry } from './surface-registry.mjs';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function identity(db, { workspaceId, sessionId, surfaceId, query }) {
  const workspace = row(db, 'SELECT * FROM workspaces WHERE id=?', workspaceId);
  if (!workspace) throw Object.assign(new Error('workspace not found'), { code: 'WORKSPACE_NOT_FOUND' });
  const session = sessionId ? row(db, 'SELECT * FROM sessions WHERE id=? AND workspace_id=?', sessionId, workspaceId) : null;
  if (sessionId && !session) throw Object.assign(new Error('session does not belong to this Project Space'), { code: 'SESSION_WORKSPACE_MISMATCH' });
  const surface = surfaceRegistry.resolve(surfaceId);
  const instructions = instructionContext(db, workspaceId);
  const instructionHash = instructions.project_instructions?.hash || '';
  const personalizationHash = sha256([
    instructions.global_personalization?.hash || '',
    instructions.workspace_personalization?.hash || ''
  ].join(':'));
  const queryHash = sha256(query);
  const cacheKey = sha256([
    workspaceId, session?.id || '', surface.id, surface.adapter_version,
    queryHash, workspace.corpus_generation, workspace.index_generation, workspace.chat_generation,
    instructionHash, personalizationHash
  ].join('\0'));
  return { workspace, session, surface, queryHash, instructionHash, personalizationHash, cacheKey };
}

export function prepareSpeculativeDraft(db, { workspaceId, sessionId = '', surfaceId, provider, query }) {
  const prompt = String(query || '').trim();
  if (prompt.length < 3 || prompt.length > 20_000) return { cached: false, reason: 'draft_size_out_of_range' };
  const before = identity(db, { workspaceId, sessionId, surfaceId, query: prompt });
  const blockedRequiredRoot = row(db, `SELECT id FROM workspace_roots WHERE workspace_id=? AND required_for_freshness=1 AND status!='current' LIMIT 1`, workspaceId);
  if (blockedRequiredRoot || Number(before.workspace.corpus_generation) !== Number(before.workspace.index_generation)) {
    return { cached: false, reason: 'workspace_not_warm_current' };
  }
  const started = performance.now();
  const retrieval = retrieveWorkspaceEvidence(db, { workspaceId, query: prompt, provider, currentSessionId: before.session?.id || null, characterBudget: 22000 });
  const after = identity(db, { workspaceId, sessionId, surfaceId, query: prompt });
  if (after.cacheKey !== before.cacheKey) return { cached: false, reason: 'generation_changed_during_retrieval' };
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000);
  run(db, 'DELETE FROM context_draft_cache WHERE expires_at<=?', createdAt.toISOString());
  run(db, `INSERT INTO context_draft_cache (cache_key,workspace_id,session_id,surface_id,query_hash,corpus_generation,index_generation,chat_generation,instruction_hash,personalization_hash,result_json,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET result_json=excluded.result_json,created_at=excluded.created_at,expires_at=excluded.expires_at`,
    before.cacheKey, workspaceId, before.session?.id || null, before.surface.id, before.queryHash,
    before.workspace.corpus_generation, before.workspace.index_generation, before.workspace.chat_generation, before.instructionHash, before.personalizationHash,
    JSON.stringify(retrieval), createdAt.toISOString(), expiresAt.toISOString());
  return { cached: true, query_hash: before.queryHash, candidate_count: retrieval.candidate_count, selected_count: retrieval.selected.length, retrieval_ms: Number((performance.now() - started).toFixed(2)), expires_at: expiresAt.toISOString() };
}

export function reuseSpeculativeDraft(db, { workspaceId, sessionId = '', surfaceId, query }) {
  const current = identity(db, { workspaceId, sessionId, surfaceId, query });
  const cached = row(db, 'SELECT * FROM context_draft_cache WHERE cache_key=? AND expires_at>?', current.cacheKey, new Date().toISOString());
  if (!cached) return null;
  try {
    const retrieval = JSON.parse(cached.result_json);
    return { retrieval, cache_key: cached.cache_key, created_at: cached.created_at };
  } catch {
    run(db, 'DELETE FROM context_draft_cache WHERE cache_key=?', current.cacheKey);
    return null;
  }
}
