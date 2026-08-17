import crypto, { randomUUID } from 'node:crypto';
import { row, rows, run } from './db.mjs';

const PROFILE_KEYS = new Set(['response_style', 'detail_level', 'learning_preferences', 'tool_preferences']);
const MAX_INSTRUCTION_CHARS = 32_000;
const MAX_NOTES_CHARS = 16_000;

function now() { return new Date().toISOString(); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

export function activeProjectInstructions(db, workspaceId) {
  return row(db, `SELECT * FROM instruction_versions WHERE workspace_id=? AND status='active' ORDER BY version_number DESC LIMIT 1`, workspaceId) || null;
}

export function saveProjectInstructions(db, workspaceId, content) {
  if (!row(db, 'SELECT id FROM workspaces WHERE id=?', workspaceId)) throw Object.assign(new Error('workspace not found'), { code: 'WORKSPACE_NOT_FOUND' });
  const normalized = String(content || '').replace(/\r\n?/g, '\n').trim();
  if (normalized.length > MAX_INSTRUCTION_CHARS) throw Object.assign(new Error(`project instructions exceed ${MAX_INSTRUCTION_CHARS} characters`), { code: 'INSTRUCTIONS_TOO_LARGE' });
  const active = activeProjectInstructions(db, workspaceId);
  const contentHash = hash(normalized);
  if (active?.content_hash === contentHash) return active;
  const version = Number(row(db, 'SELECT COALESCE(MAX(version_number),0)+1 AS n FROM instruction_versions WHERE workspace_id=?', workspaceId)?.n || 1);
  run(db, `UPDATE instruction_versions SET status='superseded' WHERE workspace_id=? AND status='active'`, workspaceId);
  const id = `instructions-${randomUUID()}`;
  run(db, `INSERT INTO instruction_versions (id,workspace_id,version_number,content,content_hash,status,created_at) VALUES (?,?,?,?,?,'active',?)`, id, workspaceId, version, normalized, contentHash, now());
  return row(db, 'SELECT * FROM instruction_versions WHERE id=?', id);
}

function validateProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw Object.assign(new Error('personalization profile must be an object'), { code: 'PROFILE_INVALID' });
  const result = {};
  for (const [key, value] of Object.entries(profile)) {
    if (!PROFILE_KEYS.has(key)) throw Object.assign(new Error(`unsupported personalization field: ${key}`), { code: 'PROFILE_FIELD_UNSUPPORTED' });
    const normalized = String(value || '').trim().slice(0, 2000);
    if (normalized) result[key] = normalized;
  }
  return result;
}

export function activePersonalization(db, { workspaceId = null, scope = 'global' } = {}) {
  if (scope === 'global') return row(db, `SELECT * FROM personalization_versions WHERE scope='global' AND workspace_id IS NULL AND status='active' ORDER BY version_number DESC LIMIT 1`) || null;
  return row(db, `SELECT * FROM personalization_versions WHERE scope='workspace' AND workspace_id=? AND status='active' ORDER BY version_number DESC LIMIT 1`, workspaceId) || null;
}

export function savePersonalization(db, { workspaceId = null, scope = 'global', profile = {}, notes = '' }) {
  if (!['global','workspace'].includes(scope)) throw Object.assign(new Error('invalid personalization scope'), { code: 'PROFILE_SCOPE_INVALID' });
  if (scope === 'workspace' && !row(db, 'SELECT id FROM workspaces WHERE id=?', workspaceId)) throw Object.assign(new Error('workspace not found'), { code: 'WORKSPACE_NOT_FOUND' });
  const cleanProfile = validateProfile(profile);
  const cleanNotes = String(notes || '').replace(/\r\n?/g, '\n').trim();
  if (cleanNotes.length > MAX_NOTES_CHARS) throw Object.assign(new Error(`personalization notes exceed ${MAX_NOTES_CHARS} characters`), { code: 'PROFILE_NOTES_TOO_LARGE' });
  const serialized = JSON.stringify(cleanProfile);
  const contentHash = hash(`${serialized}\n${cleanNotes}`);
  const active = activePersonalization(db, { workspaceId, scope });
  if (active?.content_hash === contentHash) return active;
  const version = scope === 'global'
    ? Number(row(db, `SELECT COALESCE(MAX(version_number),0)+1 AS n FROM personalization_versions WHERE scope='global' AND workspace_id IS NULL`)?.n || 1)
    : Number(row(db, `SELECT COALESCE(MAX(version_number),0)+1 AS n FROM personalization_versions WHERE scope='workspace' AND workspace_id=?`, workspaceId)?.n || 1);
  if (scope === 'global') run(db, `UPDATE personalization_versions SET status='superseded' WHERE scope='global' AND workspace_id IS NULL AND status='active'`);
  else run(db, `UPDATE personalization_versions SET status='superseded' WHERE scope='workspace' AND workspace_id=? AND status='active'`, workspaceId);
  const id = `personalization-${randomUUID()}`;
  run(db, `INSERT INTO personalization_versions (id,workspace_id,scope,version_number,profile_json,notes,content_hash,status,created_at) VALUES (?,?,?,?,?,?,?,'active',?)`,
    id, scope === 'global' ? null : workspaceId, scope, version, serialized, cleanNotes, contentHash, now());
  return row(db, 'SELECT * FROM personalization_versions WHERE id=?', id);
}

function publicProfile(item) {
  return item ? { ...item, profile: JSON.parse(item.profile_json || '{}') } : null;
}

export function instructionContext(db, workspaceId) {
  const project = activeProjectInstructions(db, workspaceId);
  const global = activePersonalization(db, { scope: 'global' });
  const override = activePersonalization(db, { scope: 'workspace', workspaceId });
  return {
    project_instructions: project ? { id: project.id, version: project.version_number, content: project.content, hash: project.content_hash } : null,
    global_personalization: global ? { id: global.id, version: global.version_number, profile: JSON.parse(global.profile_json || '{}'), notes: global.notes, hash: global.content_hash } : null,
    workspace_personalization: override ? { id: override.id, version: override.version_number, profile: JSON.parse(override.profile_json || '{}'), notes: override.notes, hash: override.content_hash } : null,
    trust_order: ['security_policy','current_explicit_user_request','project_instructions','global_and_workspace_personalization','derived_working_state','retrieved_evidence','prior_ai_responses']
  };
}

export function instructionHistory(db, workspaceId) {
  return {
    instructions: rows(db, 'SELECT id,version_number,content,content_hash,status,created_at FROM instruction_versions WHERE workspace_id=? ORDER BY version_number DESC', workspaceId),
    personalization: rows(db, `SELECT id,scope,workspace_id,version_number,profile_json,notes,content_hash,status,created_at FROM personalization_versions WHERE workspace_id=? OR (scope='global' AND workspace_id IS NULL) ORDER BY created_at DESC`, workspaceId).map(publicProfile)
  };
}
