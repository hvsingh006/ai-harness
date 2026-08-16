import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openDatabase, rows, row, run, storageForDatabase, ensureWorkspaceProjectRoot, attachWorkspaceFolder, upsertSessionExternalRef } from './db.mjs';
import { sha256Text, archiveFile } from './archive.mjs';
import { setCaptureStages, importChatGPTExport, importProviderArchive } from './importers.mjs';
import { HARNESS_VERSION } from './version.mjs';
import { indexWorkspaceFile, scanWorkspaceFiles, projectFileDestination, storageSummary } from './project-space.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const port = Number(process.env.HARNESS_PORT || 4317);
const db = process.env.HARNESS_DB ? openDatabase(path.resolve(process.env.HARNESS_DB)) : openDatabase();
const storage = storageForDatabase(db);

const stagingRoot = path.join(storage.stagingDir, 'imports');
fs.mkdirSync(stagingRoot, { recursive: true });

function gitOutput(args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: rootDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('git command timed out'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `git exited with code ${code}`));
    });
  });
}

async function applicationUpdateStatus() {
  if (!fs.existsSync(path.join(rootDir, '.git'))) {
    return { supported: false, update_available: false, current_version: HARNESS_VERSION, message: 'This installation is not a Git checkout.' };
  }
  const currentCommit = await gitOutput(['rev-parse', 'HEAD']);
  try {
    await gitOutput(['fetch', '--quiet', 'origin', 'main'], 12000);
    const remoteCommit = await gitOutput(['rev-parse', 'origin/main']);
    const counts = (await gitOutput(['rev-list', '--left-right', '--count', `${currentCommit}...${remoteCommit}`])).split(/\s+/).map(Number);
    let remoteVersion = null;
    try {
      const versionSource = await gitOutput(['show', 'origin/main:src/version.mjs']);
      remoteVersion = versionSource.match(/HARNESS_VERSION\s*=\s*['\"]([^'\"]+)/)?.[1] || null;
    } catch {}
    return {
      supported: true,
      current_version: HARNESS_VERSION,
      remote_version: remoteVersion,
      current_commit: currentCommit,
      remote_commit: remoteCommit,
      ahead: counts[0] || 0,
      behind: counts[1] || 0,
      update_available: (counts[1] || 0) > 0,
      message: (counts[1] || 0) > 0 ? 'A newer version is available.' : 'AI Harness is up to date.'
    };
  } catch (error) {
    return { supported: true, update_available: false, current_version: HARNESS_VERSION, current_commit: currentCommit, error: error.message, message: 'Could not check GitHub. The installed version is unchanged.' };
  }
}

function safeRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '..')) throw new Error('invalid relative path');
  return parts.join(path.sep);
}

async function streamRequestToFile(req, filePath, maxBytes = 1024 * 1024 * 1024) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const out = fs.createWriteStream(filePath, { flags: 'w' });
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('file too large');
      if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
    return size;
  } catch (error) {
    out.destroy();
    try { fs.unlinkSync(filePath); } catch {}
    throw error;
  }
}

function uploadMeta(uploadId) {
  const dir = path.join(stagingRoot, uploadId);
  const metaPath = path.join(dir, '.aih-upload.json');
  if (!fs.existsSync(metaPath)) return null;
  return { dir, metaPath, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) };
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req, maxBytes = 25 * 1024 * 1024) {
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('request too large');
    body += chunk;
  }
  if (!body) return {};
  return JSON.parse(body);
}

function getSettings() {
  const result = {};
  for (const item of rows(db, 'SELECT key, value FROM settings')) result[item.key] = item.value;
  result.storage = storageSummary(db);
  return result;
}

function workspaceSummary(id) {
  const workspace = row(db, 'SELECT * FROM workspaces WHERE id = ?', id);
  if (!workspace) return null;
  let projectFiles = [];
  try { projectFiles = scanWorkspaceFiles(db, id, { maxFiles: 5000 }); }
  catch { projectFiles = rows(db, 'SELECT * FROM workspace_files WHERE workspace_id = ? ORDER BY relative_path', id); }
  return {
    ...workspace,
    providers: rows(db, 'SELECT * FROM provider_links WHERE workspace_id = ? ORDER BY provider', id),
    sessions: rows(db, 'SELECT * FROM sessions WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 100', id),
    memories: rows(db, `SELECT * FROM memories WHERE (workspace_id = ? OR scope = 'global') AND status = 'active' ORDER BY scope, updated_at DESC`, id),
    files: projectFiles,
    artifacts: rows(db, 'SELECT id,name,mime_type,size_bytes,sha256,artifact_type,provider,source_url,created_at FROM artifacts WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 300', id),
    learning: rows(db, 'SELECT * FROM learning_items WHERE workspace_id = ? ORDER BY updated_at DESC', id),
    development: rows(db, 'SELECT * FROM development_items WHERE workspace_id = ? ORDER BY updated_at DESC', id),
    decisions: rows(db, 'SELECT * FROM decisions WHERE workspace_id = ? ORDER BY created_at DESC', id),
    tasks: rows(db, `SELECT * FROM workspace_tasks WHERE workspace_id = ? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, priority, updated_at DESC`, id),
    imports: rows(db, 'SELECT * FROM imports WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50', id),
    archive: archiveStats(id)
  };
}

function archiveStats(workspaceId = null) {
  const whereSession = workspaceId ? 'WHERE workspace_id = ?' : '';
  const whereArtifact = workspaceId ? 'WHERE workspace_id = ?' : '';
  const params = workspaceId ? [workspaceId] : [];
  return {
    sessions: Number(row(db, `SELECT COUNT(*) AS n FROM sessions ${whereSession}`, ...params)?.n || 0),
    messages: Number(row(db, workspaceId
      ? `SELECT COUNT(*) AS n FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.workspace_id=?`
      : `SELECT COUNT(*) AS n FROM messages`, ...params)?.n || 0),
    artifacts: Number(row(db, `SELECT COUNT(*) AS n FROM artifacts ${whereArtifact}`, ...params)?.n || 0),
    artifact_bytes: Number(row(db, `SELECT COALESCE(SUM(size_bytes),0) AS n FROM artifacts ${whereArtifact}`, ...params)?.n || 0),
    imports: Number(row(db, workspaceId ? `SELECT COUNT(*) AS n FROM imports WHERE workspace_id=?` : `SELECT COUNT(*) AS n FROM imports`, ...params)?.n || 0),
    safe_sessions: Number(row(db, workspaceId
      ? `SELECT COUNT(*) AS n FROM sessions WHERE workspace_id=? AND capture_status='safe_to_delete'`
      : `SELECT COUNT(*) AS n FROM sessions WHERE capture_status='safe_to_delete'`, ...params)?.n || 0),
    incomplete_sessions: Number(row(db, workspaceId
      ? `SELECT COUNT(*) AS n FROM sessions WHERE workspace_id=? AND capture_status!='safe_to_delete'`
      : `SELECT COUNT(*) AS n FROM sessions WHERE capture_status!='safe_to_delete'`, ...params)?.n || 0)
  };
}

function resourceUsePolicy() {
  return {
    principle: 'Use the full workspace corpus when relevant, but scale context deliberately rather than flooding the model.',
    resources: [
      'User prompts and prior user reasoning.',
      'Prior AI responses across providers, while treating them as fallible working material rather than authority.',
      'Archived raw chat history and exact wording when provenance or detailed reasoning matters.',
      'Workspace files, PDFs, images, generated media, notebook sources, code, and linked artifacts.',
      'Native provider tools and current web research when the task benefits from them.'
    ],
    scaling: [
      'If everything fits, use the relevant originals directly.',
      'If the corpus is too large, inspect the workspace/archive manifest first, retrieve the most relevant subsets, then expand retrieval iteratively as needed.',
      'Never discard older source material merely because a summary exists.',
      'Preserve provenance and identify material limitations when a relevant source could not be loaded.'
    ]
  };
}

function collaborationPolicy() {
  return {
    principle: 'Use project context to improve continuity, productivity, and understanding without replacing the user\'s judgment or critical thinking.',
    continuity: [
      'Do not ask the user to restate information already available in the project context or retained chat history.',
      'Use prior user prompts and prior AI responses as working context, while treating AI responses as fallible.',
      'Use relevant project files and original archived material when details or provenance matter.',
      'Treat newer explicit user statements as superseding older derived state.'
    ]
  };
}

function buildContextPacket(workspaceId) {
  const ws = workspaceSummary(workspaceId);
  if (!ws) return null;
  const canonicalFileCount = Number(row(db, 'SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id=?', workspaceId)?.n || 0);
  const canonicalFileIndex = rows(db, 'SELECT name,mime_type,provider,source_url,artifact_type,sha256,size_bytes FROM artifacts WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200', workspaceId);
  return {
    version: 2,
    generated_at: new Date().toISOString(),
    workspace: {
      id: ws.id,
      name: ws.name,
      description: ws.description,
      active_focus: ws.active_focus
    },
    collaboration_policy: collaborationPolicy(),
    resource_use_policy: resourceUsePolicy(),
    next_actions: ws.tasks.filter(t => t.status === 'open').slice(0, 8).map(({ title, details, priority, task_type }) => ({ title, details, priority, task_type })),
    durable_context: ws.memories.map(({ scope, category, content, confidence, source_type, source_ref }) => ({
      scope, category, content, confidence, source_type, source_ref
    })),
    recent_sessions: ws.sessions.slice(0, 10).map(({ id, provider, title, summary, message_count, started_at, capture_status, native_url, display_label }) => ({
      id, provider, title, summary, message_count, started_at, capture_status, native_url, display_label,
      provider_refs: rows(db, 'SELECT ref_type,ref_value,source FROM session_external_refs WHERE session_id=? ORDER BY ref_type', id)
    })),
    decisions: ws.decisions.map(({ title, decision, rationale, source_ref }) => ({ title, decision, rationale, source_ref })),
    file_index: [
      ...ws.files.map(({ name, mime_type, source_provider, source_url, notes }) => ({ name, mime_type, source_provider, source_url, notes, canonical: false })),
      ...canonicalFileIndex.map(a => ({ ...a, canonical: true }))
    ],
    file_index_manifest: { total_canonical_artifacts: canonicalFileCount, included_canonical_artifacts: canonicalFileIndex.length, truncated: canonicalFileIndex.length < canonicalFileCount },
    archive_manifest: ws.archive,
    handoff_instruction: 'Continue from this Project Space without requiring restatement. Use relevant prior user prompts, prior ChatGPT/Gemini responses, project files, PDFs, images, archive search, native tools, and current web information when useful. If the retained corpus is too large, retrieve progressively relevant subsets rather than ignoring older material or flooding the prompt. Preserve the user\'s critical thinking and judgment.'
  };
}

function searchArchive(query, workspaceId = null, limit = 50) {
  const clean = String(query || '').trim();
  if (!clean) return [];
  try {
    const sql = workspaceId
      ? `SELECT message_id,session_id,workspace_id,provider,title,role,content, bm25(message_fts) AS rank FROM message_fts WHERE message_fts MATCH ? AND workspace_id=? ORDER BY rank LIMIT ?`
      : `SELECT message_id,session_id,workspace_id,provider,title,role,content, bm25(message_fts) AS rank FROM message_fts WHERE message_fts MATCH ? ORDER BY rank LIMIT ?`;
    return workspaceId ? rows(db, sql, clean, workspaceId, limit) : rows(db, sql, clean, limit);
  } catch {
    const like = `%${clean}%`;
    return workspaceId
      ? rows(db, `SELECT m.id AS message_id,m.session_id,s.workspace_id,s.provider,s.title,m.role,m.content_text AS content FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.workspace_id=? AND m.content_text LIKE ? ORDER BY s.started_at DESC LIMIT ?`, workspaceId, like, limit)
      : rows(db, `SELECT m.id AS message_id,m.session_id,s.workspace_id,s.provider,s.title,m.role,m.content_text AS content FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.content_text LIKE ? ORDER BY s.started_at DESC LIMIT ?`, like, limit);
  }
}

function sessionLabel(session, workspaceName = '') {
  if (session.display_label) return session.display_label;
  const short = String(session.id || '').replace(/^session-/, '').slice(0, 8);
  return `AIH · ${workspaceName || 'Workspace'} · ${short}`;
}

function resolveSessionByRefs(provider, refs = []) {
  for (const ref of refs) {
    const type = String(ref.ref_type || '').trim();
    const value = String(ref.ref_value || '').trim();
    if (!type || !value) continue;
    const found = row(db, `SELECT s.* FROM session_external_refs r JOIN sessions s ON s.id=r.session_id WHERE r.provider=? AND r.ref_type=? AND r.ref_value=?`, provider, type, value);
    if (found) return found;
  }
  return null;
}

function buildSessionContextPacket(sessionId, maxChars = 60000) {
  const session = row(db, 'SELECT * FROM sessions WHERE id=?', sessionId);
  if (!session) return null;
  const workspace = row(db, 'SELECT * FROM workspaces WHERE id=?', session.workspace_id);
  const all = rows(db, 'SELECT ordinal,role,content_text,provider_message_id,created_at FROM messages WHERE session_id=? ORDER BY ordinal', sessionId);
  const refs = rows(db, 'SELECT ref_type,ref_value,source FROM session_external_refs WHERE session_id=? ORDER BY ref_type', sessionId);
  const assets = rows(db, 'SELECT asset_type,name,source_url,mime_type,mirror_status FROM session_assets WHERE session_id=? ORDER BY created_at', sessionId);
  let used = 0;
  const selected = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    const cost = String(m.content_text || '').length + 80;
    if (selected.length && used + cost > maxChars) break;
    selected.push(m);
    used += cost;
  }
  selected.reverse();
  if (all.length > selected.length && all.length) {
    const first = all[0];
    if (!selected.some(m => m.ordinal === first.ordinal)) selected.unshift(first);
  }
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    workspace: workspace ? { id: workspace.id, name: workspace.name, active_focus: workspace.active_focus } : null,
    session: { ...session, display_label: sessionLabel(session, workspace?.name), provider_refs: refs },
    transcript: selected,
    transcript_manifest: { total_messages: all.length, included_messages: selected.length, truncated: selected.length < all.length, max_chars: maxChars },
    assets,
    instruction: 'Use this archived session as source context. It may contain both user reasoning and fallible AI responses. Preserve provenance. If it is truncated, use the harness archive/search for omitted details rather than assuming they are irrelevant.'
  };
}

function readiness() {
  const client = row(db, 'SELECT * FROM companion_clients ORDER BY last_seen_at DESC LIMIT 1');
  return {
    service_ready: true,
    database_ready: true,
    browser_companion_seen: Boolean(client),
    browser_companion_last_seen: client?.last_seen_at || null,
    browser_companion_version: client?.version || null,
    ready_for_native_workflow: Boolean(client),
    indicator: Boolean(client) ? 'bright_red' : 'setup_required'
  };
}

function captureBrowserSession(body) {
  const workspaceId = body.workspace_id;
  if (!row(db, 'SELECT id FROM workspaces WHERE id=?', workspaceId)) throw new Error('workspace not found');
  const provider = String(body.provider || 'unknown').toLowerCase();
  const nativeUrl = String(body.native_url || '');
  const providerRefs = Array.isArray(body.provider_refs) ? body.provider_refs.filter(r => r && r.ref_type && r.ref_value) : [];
  if (nativeUrl) providerRefs.push({ ref_type: 'native_url', ref_value: nativeUrl, source: 'browser_companion' });
  const chatRef = providerRefs.find(r => r.ref_type === 'chat_id');
  const externalId = String(chatRef?.ref_value || body.external_id || (nativeUrl ? sha256Text(nativeUrl).slice(0, 32) : randomUUID()));
  let session = resolveSessionByRefs(provider, providerRefs) || row(db, 'SELECT * FROM sessions WHERE workspace_id=? AND provider=? AND external_id=?', workspaceId, provider, externalId);
  const now = new Date().toISOString();
  if (!session) {
    const id = `session-${randomUUID()}`;
    run(db, `INSERT INTO sessions (id,workspace_id,provider,title,native_url,summary,capture_status,started_at,message_count,external_id,raw_complete,attachments_complete,derived_complete,last_captured_at)
             VALUES (?,?,?,?,?,?, 'captured_incomplete', ?,0,?,0,0,0,?)`,
      id, workspaceId, provider, body.title || `${provider} session`, nativeUrl, '', body.started_at || now, externalId, now);
    session = row(db, 'SELECT * FROM sessions WHERE id=?', id);
  } else {
    run(db, 'UPDATE sessions SET title=?, native_url=?, last_captured_at=? WHERE id=?', body.title || session.title, nativeUrl || session.native_url, now, session.id);
  }

  const sessionWorkspace = row(db, 'SELECT * FROM workspaces WHERE id=?', session.workspace_id);
  const label = sessionLabel(session, sessionWorkspace?.name);
  if (!session.display_label) run(db, 'UPDATE sessions SET display_label=? WHERE id=?', label, session.id);
  for (const ref of providerRefs) upsertSessionExternalRef(db, { sessionId: session.id, provider, refType: ref.ref_type, refValue: ref.ref_value, source: ref.source || 'browser_companion' });

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = 0; i < messages.length; i++) {
    const item = messages[i] || {};
    const content = String(item.content || item.text || '').trim();
    if (!content) continue;
    const providerMessageId = String(item.provider_message_id || sha256Text(`${item.role || 'unknown'}\0${content}\0${i}`).slice(0, 32));
    if (row(db, 'SELECT id FROM messages WHERE session_id=? AND provider_message_id=?', session.id, providerMessageId)) continue;
    const ordinal = Number(row(db, 'SELECT COALESCE(MAX(ordinal), -1) AS n FROM messages WHERE session_id=?', session.id)?.n ?? -1) + 1;
    const id = `msg-${randomUUID()}`;
    run(db, `INSERT INTO messages (id,session_id,provider_message_id,parent_provider_message_id,ordinal,role,content_text,content_json,raw_json,content_hash,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, session.id, providerMessageId, '', ordinal, item.role || 'unknown', content, JSON.stringify(item.content_json || {}), JSON.stringify(item.raw || {}), sha256Text(content), item.created_at || now);
    try {
      run(db, `INSERT INTO message_fts (message_id,session_id,workspace_id,provider,title,role,content) VALUES (?,?,?,?,?,?,?)`,
        id, session.id, session.workspace_id, provider, body.title || session.title, item.role || 'unknown', content);
    } catch {}
  }

  const assets = Array.isArray(body.assets) ? body.assets : [];
  for (const asset of assets) {
    const nativeId = String(asset.native_id || sha256Text(`${asset.url || ''}|${asset.name || ''}`).slice(0, 32));
    if (row(db, 'SELECT id FROM session_assets WHERE session_id=? AND native_id=?', session.id, nativeId)) continue;
    const id = `assetref-${randomUUID()}`;
    run(db, `INSERT INTO session_assets (id,session_id,provider,asset_type,name,source_url,native_id,mime_type,mirror_status,metadata_json,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, session.id, provider, asset.asset_type || 'file', asset.name || '', asset.url || '', nativeId, asset.mime_type || 'application/octet-stream', 'referenced', JSON.stringify(asset.metadata || {}), now, now);
  }

  const assetRefs = Number(row(db, 'SELECT COUNT(*) AS n FROM session_assets WHERE session_id=?', session.id)?.n || 0);
  const unmirrored = Number(row(db, `SELECT COUNT(*) AS n FROM session_assets WHERE session_id=? AND mirror_status!='captured'`, session.id)?.n || 0);
  setCaptureStages(db, session.id, {
    raw: body.complete === true,
    attachments: assetRefs === 0 || unmirrored === 0,
    derived: false,
    search: true
  });
  run(db, 'UPDATE sessions SET message_count=(SELECT COUNT(*) FROM messages WHERE session_id=?), last_captured_at=? WHERE id=?', session.id, now, session.id);
  return {
    session: row(db, 'SELECT * FROM sessions WHERE id=?', session.id),
    workspace: sessionWorkspace,
    workspace_mismatch: session.workspace_id !== workspaceId,
    provider_refs: rows(db, 'SELECT ref_type,ref_value,source FROM session_external_refs WHERE session_id=? ORDER BY ref_type', session.id),
    capture_stages: rows(db, 'SELECT stage,status,details,updated_at FROM capture_stages WHERE session_id=? ORDER BY stage', session.id),
    asset_refs: rows(db, 'SELECT * FROM session_assets WHERE session_id=? ORDER BY created_at', session.id)
  };
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, version: HARNESS_VERSION, pid: process.pid, database: 'sqlite', storage: storageSummary(db), archive: archiveStats() });
  if (url.pathname === '/api/update-status' && req.method === 'GET') return sendJson(res, 200, await applicationUpdateStatus());
  if (url.pathname === '/api/readiness' && req.method === 'GET') return sendJson(res, 200, readiness());
  if (url.pathname === '/api/companion/heartbeat' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.client_id) return sendJson(res, 400, { error: 'client_id required' });
    const ts = new Date().toISOString();
    run(db, `INSERT INTO companion_clients (client_id,version,provider,last_seen_at,metadata_json) VALUES (?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET version=excluded.version,provider=excluded.provider,last_seen_at=excluded.last_seen_at,metadata_json=excluded.metadata_json`, body.client_id, body.version || '', body.provider || '', ts, JSON.stringify(body.metadata || {}));
    return sendJson(res, 200, readiness());
  }
  if (url.pathname === '/api/provider-session' && req.method === 'GET') {
    const provider = String(url.searchParams.get('provider') || '').toLowerCase();
    const refs = [];
    for (const [key, value] of url.searchParams.entries()) if (key !== 'provider' && value) refs.push({ ref_type: key, ref_value: value });
    const session = resolveSessionByRefs(provider, refs);
    if (!session) return sendJson(res, 404, { error: 'session not found' });
    const ws = row(db, 'SELECT * FROM workspaces WHERE id=?', session.workspace_id);
    return sendJson(res, 200, { ...session, display_label: sessionLabel(session, ws?.name), workspace: ws, provider_refs: rows(db, 'SELECT ref_type,ref_value,source FROM session_external_refs WHERE session_id=? ORDER BY ref_type', session.id) });
  }
  if (url.pathname === '/api/archive/stats') return sendJson(res, 200, archiveStats(url.searchParams.get('workspace_id')));

  if (url.pathname === '/api/imports/start' && req.method === 'POST') {
    const body = await readJson(req);
    if (!row(db, 'SELECT id FROM workspaces WHERE id=?', body.workspace_id)) return sendJson(res, 404, { error: 'workspace not found' });
    if (!['chatgpt','gemini'].includes(body.provider)) return sendJson(res, 400, { error: 'unsupported provider' });
    const uploadId = `upload-${randomUUID()}`;
    const dir = path.join(stagingRoot, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.aih-upload.json'), JSON.stringify({ upload_id: uploadId, provider: body.provider, workspace_id: body.workspace_id, created_at: new Date().toISOString(), files: 0, bytes: 0 }, null, 2));
    return sendJson(res, 201, { upload_id: uploadId });
  }

  const uploadFileMatch = url.pathname.match(/^\/api\/imports\/([^/]+)\/file$/);
  if (uploadFileMatch && req.method === 'PUT') {
    const meta = uploadMeta(uploadFileMatch[1]);
    if (!meta) return sendJson(res, 404, { error: 'upload not found' });
    try {
      const rel = safeRelativePath(url.searchParams.get('path'));
      const destination = path.join(meta.dir, rel);
      if (!destination.startsWith(meta.dir + path.sep)) throw new Error('invalid destination');
      const size = await streamRequestToFile(req, destination);
      const next = { upload_id: meta.upload_id, provider: meta.provider, workspace_id: meta.workspace_id, created_at: meta.created_at, files: Number(meta.files || 0) + 1, bytes: Number(meta.bytes || 0) + size };
      fs.writeFileSync(meta.metaPath, JSON.stringify(next, null, 2));
      return sendJson(res, 201, { path: rel.replaceAll(path.sep, '/'), size_bytes: size, files_uploaded: next.files });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  const assetContentMatch = url.pathname.match(/^\/api\/session-assets\/([^/]+)\/content$/);
  if (assetContentMatch && req.method === 'PUT') {
    const asset = row(db, `SELECT a.*, s.workspace_id, s.provider AS session_provider FROM session_assets a JOIN sessions s ON s.id=a.session_id WHERE a.id=?`, assetContentMatch[1]);
    if (!asset) return sendJson(res, 404, { error: 'asset reference not found' });
    const tempDir = path.join(storage.runtimeDir, 'mirror');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${randomUUID()}.bin`);
    try {
      const size = await streamRequestToFile(req, tempPath);
      const artifact = archiveFile(db, {
        filePath: tempPath,
        workspaceId: asset.workspace_id,
        sessionId: asset.session_id,
        provider: asset.session_provider,
        artifactType: asset.asset_type || 'file',
        sourceUrl: asset.source_url,
        nativeId: asset.native_id,
        sourcePathOverride: `live:${asset.session_provider}:${asset.session_id}:${asset.id}`,
        metadata: { original_name: asset.name, declared_mime_type: asset.mime_type, captured_via: 'browser_companion' }
      });
      run(db, `UPDATE artifacts SET name=?, mime_type=? WHERE id=?`, asset.name || artifact.name, asset.mime_type || artifact.mime_type, artifact.id);
      run(db, `UPDATE session_assets SET mirror_status='captured',artifact_id=?,updated_at=? WHERE id=?`, artifact.id, new Date().toISOString(), asset.id);
      const unmirrored = Number(row(db, `SELECT COUNT(*) AS n FROM session_assets WHERE session_id=? AND mirror_status!='captured'`, asset.session_id)?.n || 0);
      if (unmirrored === 0) setCaptureStages(db, asset.session_id, { attachments: true });
      return sendJson(res, 201, { artifact_id: artifact.id, size_bytes: size, sha256: artifact.sha256, attachments_complete: unmirrored === 0 });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    } finally {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }

  const uploadFinishMatch = url.pathname.match(/^\/api\/imports\/([^/]+)\/finish$/);
  if (uploadFinishMatch && req.method === 'POST') {
    const meta = uploadMeta(uploadFinishMatch[1]);
    if (!meta) return sendJson(res, 404, { error: 'upload not found' });
    try {
      const result = meta.provider === 'chatgpt'
        ? importChatGPTExport(db, { directory: meta.dir, workspaceId: meta.workspace_id })
        : importProviderArchive(db, { directory: meta.dir, workspaceId: meta.workspace_id, provider: meta.provider });
      fs.rmSync(meta.dir, { recursive: true, force: true });
      return sendJson(res, 201, result);
    } catch (error) {
      return sendJson(res, 400, { error: error.message, upload_id: meta.upload_id, staging_retained: true });
    }
  }

  if (url.pathname === '/api/search' && req.method === 'GET') {
    return sendJson(res, 200, searchArchive(url.searchParams.get('q'), url.searchParams.get('workspace_id'), Number(url.searchParams.get('limit') || 50)));
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') return sendJson(res, 200, getSettings());
  if (url.pathname === '/api/settings/theme' && req.method === 'PUT') {
    const { theme } = await readJson(req);
    if (!['light', 'dark', 'system'].includes(theme)) return sendJson(res, 400, { error: 'invalid theme' });
    run(db, `INSERT INTO settings (key, value) VALUES ('theme', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, theme);
    return sendJson(res, 200, { theme });
  }

  if (url.pathname === '/api/workspaces' && req.method === 'GET') {
    const workspaces = rows(db, `
      SELECT w.*,
        (SELECT COUNT(*) FROM sessions s WHERE s.workspace_id = w.id) AS session_count,
        (SELECT COUNT(*) FROM memories m WHERE m.workspace_id = w.id AND m.status = 'active') AS memory_count,
        (SELECT COUNT(*) FROM artifacts a WHERE a.workspace_id = w.id) AS artifact_count
      FROM workspaces w ORDER BY updated_at DESC
    `);
    return sendJson(res, 200, workspaces);
  }


  const workspaceArtifactUpload = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/artifacts$/);
  if (workspaceArtifactUpload && req.method === 'PUT') {
    const workspaceId = workspaceArtifactUpload[1];
    if (!row(db, 'SELECT id FROM workspaces WHERE id=?', workspaceId)) return sendJson(res, 404, { error: 'workspace not found' });
    const originalName = String(url.searchParams.get('name') || 'upload.bin').slice(0, 1000);
    const relativePath = String(url.searchParams.get('relative_path') || originalName).slice(0, 2000);
    const declaredMime = String(url.searchParams.get('mime_type') || 'application/octet-stream').slice(0, 200);
    const tempDir = path.join(storage.runtimeDir, 'project-space');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${randomUUID()}-${path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'upload.bin'}`);
    try {
      const size = await streamRequestToFile(req, tempPath, 2 * 1024 * 1024 * 1024);
      const destination = projectFileDestination(db, workspaceId, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.existsSync(destination) && fs.statSync(destination).isFile()) {
        archiveFile(db, {
          filePath: destination,
          workspaceId,
          provider: 'local',
          artifactType: 'project_snapshot',
          metadata: { original_name: path.basename(destination), version_reason: 'before_overwrite', added_via: 'project_space' }
        });
      }
      fs.copyFileSync(tempPath, destination);
      const projectFile = indexWorkspaceFile(db, workspaceId, destination);
      const artifact = archiveFile(db, {
        filePath: destination,
        workspaceId,
        provider: 'local',
        artifactType: declaredMime === 'application/pdf' ? 'pdf' : declaredMime.startsWith('image/') ? 'image' : 'file',
        metadata: { original_name: originalName, relative_path: projectFile.relative_path, declared_mime_type: declaredMime, added_via: 'project_space' }
      });
      run(db, 'UPDATE artifacts SET name=?, mime_type=?, created_at=? WHERE id=?', path.basename(destination), declaredMime, new Date().toISOString(), artifact.id);
      run(db, 'UPDATE workspaces SET updated_at=? WHERE id=?', new Date().toISOString(), workspaceId);
      return sendJson(res, 201, { file: projectFile, artifact: row(db, 'SELECT * FROM artifacts WHERE id=?', artifact.id), uploaded_bytes: size });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    } finally {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }

  const workspaceFileContent = url.pathname.match(/^\/api\/workspace-files\/([^/]+)\/content$/);
  if (workspaceFileContent && req.method === 'GET') {
    const file = row(db, 'SELECT * FROM workspace_files WHERE id=?', workspaceFileContent[1]);
    if (!file || !file.local_path || !fs.existsSync(file.local_path)) return sendJson(res, 404, { error: 'project file not found' });
    const stat = fs.statSync(file.local_path);
    const safeName = String(file.name || 'file').replace(/[\r\n"]/g, '_');
    res.writeHead(200, {
      'Content-Type': file.mime_type || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${safeName}"`,
      'Access-Control-Allow-Origin': '*'
    });
    return fs.createReadStream(file.local_path).pipe(res);
  }

  const artifactContent = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/content$/);
  if (artifactContent && req.method === 'GET') {
    const artifact = row(db, 'SELECT * FROM artifacts WHERE id=?', artifactContent[1]);
    if (!artifact || !artifact.vault_path || !fs.existsSync(artifact.vault_path)) return sendJson(res, 404, { error: 'artifact content not found' });
    const stat = fs.statSync(artifact.vault_path);
    const safeName = String(artifact.name || 'artifact').replace(/[\r\n"]/g, '_');
    res.writeHead(200, {
      'Content-Type': artifact.mime_type || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${safeName}"`,
      'Access-Control-Allow-Origin': '*'
    });
    return fs.createReadStream(artifact.vault_path).pipe(res);
  }

  if (url.pathname === '/api/workspaces' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.name?.trim()) return sendJson(res, 400, { error: 'name required' });
    const id = `ws-${randomUUID()}`;
    const ts = new Date().toISOString();
    run(db, `INSERT INTO workspaces (id,name,kind,description,active_focus,color,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      id, body.name.trim(), body.kind || 'mixed', body.description || '', body.active_focus || '', body.color || 'slate', ts, ts);
    const defaultProviders = [
      ['chatgpt', 'ChatGPT', 'https://chatgpt.com/'],
      ['gemini', 'Gemini', 'https://gemini.google.com/']
    ];
    ensureWorkspaceProjectRoot(db, id);
    for (const [provider, label, providerUrl] of defaultProviders) {
      run(db, `INSERT INTO provider_links (id,workspace_id,provider,label,url,status,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,'linked','{}',?,?)`,
        `provider-${randomUUID()}`, id, provider, label, providerUrl, ts, ts);
    }
    return sendJson(res, 201, workspaceSummary(id));
  }

  const attachWorkspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/attach-folder$/);
  if (attachWorkspaceMatch && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const workspace = attachWorkspaceFolder(db, attachWorkspaceMatch[1], body.path);
      scanWorkspaceFiles(db, workspace.id);
      return sendJson(res, 200, workspaceSummary(workspace.id));
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
  }

  const openWorkspaceFolderMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/open-folder$/);
  if (openWorkspaceFolderMatch && req.method === 'POST') {
    const workspace = row(db, 'SELECT * FROM workspaces WHERE id=?', openWorkspaceFolderMatch[1]);
    if (!workspace) return sendJson(res, 404, { error: 'workspace not found' });
    const folder = ensureWorkspaceProjectRoot(db, workspace.id);
    try {
      const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(command, [folder], { detached: true, stdio: 'ignore' });
      child.unref();
      return sendJson(res, 200, { opened: true, path: folder });
    } catch (error) { return sendJson(res, 500, { error: error.message, path: folder }); }
  }

  if (url.pathname === '/api/active-workspace' && req.method === 'GET') {
    const id = row(db, `SELECT value FROM settings WHERE key = 'active_workspace_id'`)?.value;
    const workspace = id ? workspaceSummary(id) : null;
    return sendJson(res, 200, workspace);
  }

  if (url.pathname === '/api/active-workspace' && req.method === 'PUT') {
    const { workspace_id } = await readJson(req);
    if (!row(db, 'SELECT id FROM workspaces WHERE id = ?', workspace_id)) return sendJson(res, 404, { error: 'workspace not found' });
    run(db, `INSERT INTO settings (key, value) VALUES ('active_workspace_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, workspace_id);
    return sendJson(res, 200, workspaceSummary(workspace_id));
  }

  if (url.pathname === '/api/capture' && req.method === 'POST') {
    try { return sendJson(res, 201, captureBrowserSession(await readJson(req))); }
    catch (error) { return sendJson(res, 400, { error: error.message }); }
  }

  const wsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/);
  if (wsMatch && req.method === 'GET') {
    const ws = workspaceSummary(wsMatch[1]);
    return ws ? sendJson(res, 200, ws) : sendJson(res, 404, { error: 'workspace not found' });
  }

  const contextMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/context$/);
  if (contextMatch && req.method === 'GET') {
    const packet = buildContextPacket(contextMatch[1]);
    return packet ? sendJson(res, 200, packet) : sendJson(res, 404, { error: 'workspace not found' });
  }

  const sessionContext = url.pathname.match(/^\/api\/sessions\/([^/]+)\/context$/);
  if (sessionContext && req.method === 'GET') {
    const packet = buildSessionContextPacket(sessionContext[1], Number(url.searchParams.get('max_chars') || 60000));
    return packet ? sendJson(res, 200, packet) : sendJson(res, 404, { error: 'session not found' });
  }

  const sessionDetail = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionDetail && req.method === 'GET') {
    const session = row(db, 'SELECT * FROM sessions WHERE id=?', sessionDetail[1]);
    if (!session) return sendJson(res, 404, { error: 'session not found' });
    return sendJson(res, 200, {
      ...session,
      messages: rows(db, 'SELECT * FROM messages WHERE session_id=? ORDER BY ordinal', session.id),
      assets: rows(db, 'SELECT * FROM session_assets WHERE session_id=? ORDER BY created_at', session.id),
      capture_stages: rows(db, 'SELECT * FROM capture_stages WHERE session_id=? ORDER BY stage', session.id)
    });
  }

  const memoryMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/memories$/);
  if (memoryMatch && req.method === 'POST') {
    const body = await readJson(req);
    const workspaceId = memoryMatch[1];
    const id = `mem-${randomUUID()}`;
    const ts = new Date().toISOString();
    run(db, `INSERT INTO memories (id,workspace_id,scope,category,content,confidence,source_type,source_ref,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, body.scope === 'global' ? null : workspaceId, body.scope || 'workspace', body.category || 'note', body.content || '', Number(body.confidence ?? 1), body.source_type || 'user_explicit', body.source_ref || '', 'active', ts, ts);
    return sendJson(res, 201, row(db, 'SELECT * FROM memories WHERE id = ?', id));
  }

  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    let relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    relative = path.normalize(relative).replace(/^\.\.(\/|\\|$)/, '');
    const filePath = path.join(publicDir, relative);
    if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error(error);
    sendJson(res, error.message === 'request too large' ? 413 : 500, { error: error.message || 'internal server error' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`AI Harness running at http://127.0.0.1:${port}`);
});
