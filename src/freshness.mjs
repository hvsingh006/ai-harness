import { randomUUID } from 'node:crypto';
import { row, rows, run } from './db.mjs';
import { reconcileWorkspaceResources } from './resources.mjs';
import { refreshWorkspaceRepositories } from './repository.mjs';
import { workspaceHistoryCoverage } from './chat-capture.mjs';
import { PATH_POLICY_VERSION } from './security/paths.mjs';
import { SECRET_POLICY_VERSION } from './security/secrets.mjs';
import { instructionContext } from './instructions.mjs';

export const SECURITY_POLICY_VERSION = `${PATH_POLICY_VERSION}+${SECRET_POLICY_VERSION}`;

function duration(start) {
  return Number((performance.now() - start).toFixed(2));
}

function updateWorkingState(db, workspaceId, snapshotId, generation) {
  const workspace = row(db, 'SELECT * FROM workspaces WHERE id=?', workspaceId);
  const repository = row(db, `SELECT rs.* FROM repository_states rs JOIN workspace_roots wr ON wr.id=rs.root_id
    WHERE rs.workspace_id=? AND wr.provider_transmission_allowed=1 AND wr.status='current' ORDER BY rs.observed_at DESC LIMIT 1`, workspaceId);
  const instructions = instructionContext(db, workspaceId);
  const state = {
    workspace: { id: workspace.id, name: workspace.name, active_focus: workspace.active_focus },
    generations: { corpus: workspace.corpus_generation, index: workspace.index_generation, chat: workspace.chat_generation },
    instructions: {
      project: instructions.project_instructions ? { id: instructions.project_instructions.id, version: instructions.project_instructions.version, hash: instructions.project_instructions.hash } : null,
      global_personalization: instructions.global_personalization ? { id: instructions.global_personalization.id, version: instructions.global_personalization.version, hash: instructions.global_personalization.hash } : null,
      workspace_personalization: instructions.workspace_personalization ? { id: instructions.workspace_personalization.id, version: instructions.workspace_personalization.version, hash: instructions.workspace_personalization.hash } : null
    },
    open_tasks: rows(db, `SELECT id,title,details,priority,task_type,updated_at FROM workspace_tasks WHERE workspace_id=? AND status='open' ORDER BY priority,updated_at DESC LIMIT 20`, workspaceId),
    decisions: rows(db, `SELECT id,title,decision,rationale,source_ref,created_at FROM decisions WHERE workspace_id=? ORDER BY created_at DESC LIMIT 20`, workspaceId),
    recently_observed_resources: rows(db, `SELECT r.id,r.relative_path,r.resource_type,v.sha256,v.observed_at
      FROM workspace_resources r JOIN resource_versions v ON v.id=r.current_version_id JOIN workspace_roots wr ON wr.id=r.root_id
      WHERE r.workspace_id=? AND r.status='active' AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1 AND wr.status='current'
      ORDER BY v.observed_at DESC LIMIT 30`, workspaceId),
    priority_resources: rows(db, `SELECT r.id,r.relative_path,r.resource_type,r.context_critical,r.priority_status,v.sha256,v.observed_at
      FROM workspace_resources r JOIN resource_versions v ON v.id=r.current_version_id JOIN workspace_roots wr ON wr.id=r.root_id
      WHERE r.workspace_id=? AND r.status='active' AND r.knowledge_status='active' AND (r.priority_status='priority' OR r.context_critical=1)
        AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1 AND wr.status='current'
      ORDER BY r.context_critical DESC,r.updated_at DESC LIMIT 30`, workspaceId),
    repository: repository ? { branch: repository.branch, head_commit: repository.head_commit, upstream: repository.upstream, dirty: Boolean(repository.dirty), observed_at: repository.observed_at } : null,
    recent_sessions: rows(db, `SELECT id,provider,title,message_count,history_coverage,last_captured_at FROM sessions WHERE workspace_id=? ORDER BY COALESCE(last_captured_at,started_at) DESC LIMIT 12`, workspaceId)
  };
  run(db, `INSERT INTO workspace_state (workspace_id,generation,snapshot_id,objective,state_json,updated_at) VALUES (?,?,?,?,?,?)
           ON CONFLICT(workspace_id) DO UPDATE SET generation=excluded.generation,snapshot_id=excluded.snapshot_id,objective=excluded.objective,state_json=excluded.state_json,updated_at=excluded.updated_at`,
    workspaceId, generation, snapshotId, workspace.active_focus || '', JSON.stringify(state), new Date().toISOString());
  return state;
}

export function markWorkspaceStale(db, workspaceId, reason = 'filesystem_change_observed') {
  run(db, `UPDATE workspaces SET freshness_status='stale',updated_at=? WHERE id=?`, new Date().toISOString(), workspaceId);
  return { workspace_id: workspaceId, freshness: 'stale', reason };
}

export function verifyProjectFreshness(db, { workspaceId, captureResult }) {
  const totalStart = performance.now();
  const workspace = row(db, 'SELECT * FROM workspaces WHERE id=?', workspaceId);
  if (!workspace) throw Object.assign(new Error('workspace not found'), { code: 'WORKSPACE_NOT_FOUND' });
  run(db, `UPDATE workspaces SET freshness_status='verifying' WHERE id=?`, workspaceId);
  const reasons = [];

  const rootStart = performance.now();
  const resources = reconcileWorkspaceResources(db, workspaceId);
  const rootVerificationMs = duration(rootStart);
  reasons.push(...resources.reasons);

  const repoStart = performance.now();
  const repository = refreshWorkspaceRepositories(db, workspaceId);
  const repositoryRefreshMs = duration(repoStart);
  reasons.push(...repository.reasons);

  const currentWorkspace = row(db, 'SELECT * FROM workspaces WHERE id=?', workspaceId);
  if (Number(currentWorkspace.corpus_generation) !== Number(currentWorkspace.index_generation)) {
    reasons.push({ code: 'INDEX_GENERATION_MISMATCH', message: 'retrieval index generation does not match the verified corpus generation' });
  }
  if (!captureResult?.synchronized_visible) {
    reasons.push({ code: 'CURRENT_CHAT_SYNC_FAILED', message: 'the current native conversation was not synchronized through the latest visible message' });
  }
  if (captureResult?.session?.workspace_id !== workspaceId) {
    reasons.push({ code: 'SESSION_WORKSPACE_MISMATCH', message: 'the current native conversation is not associated with this Project Space' });
  }
  const coverage = workspaceHistoryCoverage(db, workspaceId);
  const status = reasons.length ? 'blocked' : 'current';
  const snapshotId = `snapshot-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  let captureEvidence = {};
  try { captureEvidence = JSON.parse(captureResult?.session?.capture_evidence_json || '{}'); } catch {}
  const captureStarted = Date.parse(captureEvidence.capture_started_at || '');
  const captureCompleted = Date.parse(captureEvidence.capture_completed_at || '');
  const diagnostics = {
    capture_sync_ms: Number.isFinite(captureStarted) && Number.isFinite(captureCompleted) ? Math.max(0, captureCompleted - captureStarted) : 0,
    root_inventory_ms: Number(resources.diagnostics?.root_inventory_ms || 0),
    hash_version_ms: Number(resources.diagnostics?.hash_version_ms || 0),
    extraction_index_ms: Number(resources.diagnostics?.extraction_index_ms || 0),
    inventory_verify_ms: Number(resources.diagnostics?.root_inventory_ms || 0),
    changed_hash_ms: Number(resources.diagnostics?.hash_version_ms || 0),
    processing_wait_ms: Number(resources.diagnostics?.extraction_index_ms || 0),
    files_inventory_count: Number(resources.diagnostics?.files_inventory_count || 0),
    candidate_files: Number(resources.diagnostics?.candidate_files || 0),
    files_hashed: Number(resources.diagnostics?.files_hashed || 0),
    files_processed: Number(resources.diagnostics?.files_processed || 0),
    repository_ms: repositoryRefreshMs,
    snapshot_ms: 0,
    root_verification_ms: rootVerificationMs,
    changed_resource_indexing_ms: rootVerificationMs,
    repository_refresh_ms: repositoryRefreshMs,
    total_verification_ms: duration(totalStart)
  };
  const details = {
    reasons,
    roots: resources.roots,
    changed_resources: resources.changed_count,
    deleted_resources: resources.deleted_count,
    resources_fast_path: Boolean(resources.fast_path),
    repository_states: repository.states.map(item => ({ root_id: item.root_id, branch: item.branch, head: item.head, dirty: item.dirty, state_hash: item.state_hash })),
    chat: { session_id: captureResult?.session?.id || null, synchronized_visible: Boolean(captureResult?.synchronized_visible), raw_capture_complete: Boolean(captureResult?.raw_capture_complete) },
    diagnostics
  };
  const snapshotStart = performance.now();
  run(db, `INSERT INTO project_snapshots (id,workspace_id,created_at,status,corpus_generation,index_generation,chat_generation,root_state_hash,repo_state_hash,security_policy_version,history_coverage,details_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, snapshotId, workspaceId, createdAt, status,
    currentWorkspace.corpus_generation, currentWorkspace.index_generation, currentWorkspace.chat_generation,
    resources.root_state_hash, repository.repo_state_hash, SECURITY_POLICY_VERSION, coverage, JSON.stringify(details));
  run(db, `UPDATE workspaces SET freshness_status=?,last_verified_at=?,history_coverage=?,updated_at=? WHERE id=?`, status, createdAt, coverage, createdAt, workspaceId);
  const workingState = updateWorkingState(db, workspaceId, snapshotId, currentWorkspace.corpus_generation);
  diagnostics.snapshot_ms = duration(snapshotStart);
  diagnostics.total_verification_ms = duration(totalStart);
  run(db, 'UPDATE project_snapshots SET details_json=? WHERE id=?', JSON.stringify(details), snapshotId);
  return {
    ok: status === 'current',
    freshness: status,
    reasons,
    snapshot: row(db, 'SELECT * FROM project_snapshots WHERE id=?', snapshotId),
    details,
    working_state: workingState,
    diagnostics
  };
}

export function workspaceIntegrity(db, workspaceId) {
  const workspace = row(db, 'SELECT * FROM workspaces WHERE id=?', workspaceId);
  if (!workspace) return null;
  const snapshot = row(db, 'SELECT * FROM project_snapshots WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1', workspaceId);
  return {
    workspace_id: workspaceId,
    freshness: workspace.freshness_status,
    last_verified_at: workspace.last_verified_at,
    history_coverage: workspace.history_coverage,
    corpus_generation: workspace.corpus_generation,
    index_generation: workspace.index_generation,
    latest_snapshot: snapshot ? { ...snapshot, details: JSON.parse(snapshot.details_json || '{}') } : null,
    roots: rows(db, 'SELECT id,label,root_kind,root_path,required_for_freshness,indexing_enabled,provider_transmission_allowed,status,last_verified_at FROM workspace_roots WHERE workspace_id=? ORDER BY created_at', workspaceId)
  };
}
