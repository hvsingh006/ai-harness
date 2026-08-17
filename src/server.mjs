import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openDatabase, rows, row, run, storageForDatabase, ensureWorkspaceProjectRoot, attachWorkspaceFolder, registerWorkspaceRoot, workspaceRoots } from './db.mjs';
import { archiveFile, sha256File } from './archive.mjs';
import { setCaptureStages, importChatGPTExport, importProviderArchive } from './importers.mjs';
import { HARNESS_VERSION, COMPANION_PROTOCOL_VERSION, COMPANION_PROTOCOL_MIN_VERSION } from './version.mjs';
import { indexWorkspaceFile, scanWorkspaceFiles, projectFileDestination, storageSummary } from './project-space.mjs';
import { captureBrowserSession as captureVerifiedBrowserSession, resolveSessionByRefs as resolveCapturedSession, validateProviderAssetUrl, workspaceHistoryCoverage } from './chat-capture.mjs';
import { prepareManagedSend, markContextRunSent, markContextRunFailed } from './outgoing-context.mjs';
import { workspaceIntegrity, markWorkspaceStale } from './freshness.mjs';
import { currentWorkspaceResources, reconcileWorkspaceResources, reprocessResourceVersion, ingestProviderArtifactResource, saveResourceCopyToProjectFolder, updateResourceContextPolicy } from './resources.mjs';
import { createPairingChallenge, completePairing, authenticateCompanionRequest, ensureInstallCredential, isSameOriginDashboardRequest, pairedCompanionStatus } from './security/companion-auth.mjs';
import { pendingManagedWorkspaceMigrations, migrateManagedWorkspaceProject } from './workspace-migration.mjs';
import { isPathWithin, resolveApprovedTarget } from './security/paths.mjs';
import { inspectSafeUpdate } from './update-safety.mjs';
import { agentCapabilities, launchRegisteredAgent } from './agent-launcher.mjs';
import { representationCoverage, completePdfBackground } from './multimodal.mjs';
import { multimodalToolStatus } from './tooling.mjs';
import { surfaceRegistry, browserSurfaceForProvider, publicSurfaceStatus } from './surface-registry.mjs';
import { activeProjectInstructions, activePersonalization, saveProjectInstructions, savePersonalization, instructionContext, instructionHistory } from './instructions.mjs';
import { authenticateAgentContext, agentContextStatus, agentContextQuery, agentContextSources, agentContextResource, agentContextVisual, revokeAgentContextSession } from './agent-context.mjs';
import { backgroundQueueStatus, cancelBackgroundJob, createBackgroundJob, recoverBackgroundJobs, startBackgroundJob } from './jobs.mjs';
import { createDatabaseBackup } from './backup.mjs';
import { prepareSpeculativeDraft } from './context-cache.mjs';
import { refreshWorkspaceRepositories } from './repository.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const port = Number(process.env.HARNESS_PORT || 4317);
const db = process.env.HARNESS_DB ? openDatabase(path.resolve(process.env.HARNESS_DB)) : openDatabase();
const storage = storageForDatabase(db);
const companionCredential = ensureInstallCredential(storage.runtimeDir);

const stagingRoot = path.join(storage.stagingDir, 'imports');
fs.mkdirSync(stagingRoot, { recursive: true });

const rootWatchers = new Map();
const indexingTimers = new Map();

function backgroundJobHandler(job) {
  return async progress => {
    const workspaceId = job.workspace_id;
    const targetId = String(job.target_id || '');
    if (job.job_type === 'verify_sources') {
      progress({ phase: 'verifying changed source candidates' });
      const resources = reconcileWorkspaceResources(db, workspaceId);
      progress({ phase: 'refreshing repository state' });
      const repository = refreshWorkspaceRepositories(db, workspaceId);
      return { resources, repository };
    }
    if (job.job_type === 'full_integrity_verify') {
      progress({ phase: 'hashing all approved source bytes' });
      const resources = reconcileWorkspaceResources(db, workspaceId, { fullIntegrity: true });
      progress({ phase: 'refreshing repository state' });
      return { resources, repository: refreshWorkspaceRepositories(db, workspaceId) };
    }
    if (job.job_type === 'reprocess_resource') {
      if (!targetId) throw Object.assign(new Error('resource target required'), { code: 'JOB_TARGET_REQUIRED' });
      progress({ current: 0, total: 1, phase: 'reprocessing current version' });
      const result = reprocessResourceVersion(db, targetId);
      progress({ current: 1, total: 1, phase: 'reprocessed' });
      return { resource_id: result.resource.id, version_id: result.version.id, representation_coverage: result.version.representation_coverage };
    }
    if (job.job_type === 'rebuild_derived') {
      const resources = rows(db, `SELECT r.id FROM workspace_resources r JOIN resource_versions v ON v.id=r.current_version_id
        WHERE r.workspace_id=? AND r.status='active' AND (v.indexing_status='failed' OR v.representation_coverage NOT IN ('complete','not_applicable')) ORDER BY r.relative_path`, workspaceId);
      const results = [];
      for (let index = 0; index < resources.length; index++) {
        progress({ current: index, total: resources.length, phase: `reprocessing ${index + 1} of ${resources.length}` });
        results.push(reprocessResourceVersion(db, resources[index].id));
      }
      progress({ current: resources.length, total: resources.length, phase: 'rebuild complete' });
      return { resource_count: results.length, coverage: representationCoverage(db, workspaceId) };
    }
    if (job.job_type === 'complete_pdf') {
      if (!targetId) throw Object.assign(new Error('resource target required'), { code: 'JOB_TARGET_REQUIRED' });
      progress({ current: 0, total: 1, phase: 'completing PDF background processing' });
      const result = await completePdfBackground(db, targetId, progress);
      return result;
    }
    if (job.job_type === 'create_backup') return createDatabaseBackup(db);
    if (job.job_type === 'run_diagnostics') return { tools: multimodalToolStatus(), integrity: workspaceIntegrity(db, workspaceId), surfaces: surfaceRegistry.list().map(item => ({ id: item.id, capabilities: item.capabilities })) };
    throw Object.assign(new Error('unsupported job type'), { code: 'JOB_TYPE_UNSUPPORTED' });
  };
}

function scheduleBackgroundIndex(workspaceId) {
  markWorkspaceStale(db, workspaceId, 'filesystem_change_observed');
  clearTimeout(indexingTimers.get(workspaceId));
  indexingTimers.set(workspaceId, setTimeout(() => {
    try {
      const existing = row(db, `SELECT id FROM background_jobs WHERE workspace_id=? AND job_type='verify_sources' AND status IN ('queued','running') LIMIT 1`, workspaceId);
      if (!existing) {
        const job = createBackgroundJob(db, { workspaceId, jobType: 'verify_sources', targetType: 'workspace', targetId: workspaceId });
        startBackgroundJob(db, job.id, backgroundJobHandler(job));
      }
    } catch {}
    finally { indexingTimers.delete(workspaceId); }
  }, 700));
}

function refreshRootWatchers() {
  const activeIds = new Set();
  for (const root of rows(db, `SELECT id,workspace_id,root_path FROM workspace_roots WHERE indexing_enabled=1`)) {
    activeIds.add(root.id);
    if (rootWatchers.has(root.id) || !fs.existsSync(root.root_path)) continue;
    try {
      const watcher = fs.watch(root.root_path, { recursive: true }, () => scheduleBackgroundIndex(root.workspace_id));
      watcher.on('error', () => {
        try { watcher.close(); } catch {}
        rootWatchers.delete(root.id);
        markWorkspaceStale(db, root.workspace_id, 'filesystem_watcher_error');
      });
      rootWatchers.set(root.id, watcher);
    } catch {
      markWorkspaceStale(db, root.workspace_id, 'filesystem_watcher_unavailable');
    }
  }
  for (const [rootId, watcher] of rootWatchers) {
    if (activeIds.has(rootId)) continue;
    try { watcher.close(); } catch {}
    rootWatchers.delete(rootId);
  }
}

refreshRootWatchers();
recoverBackgroundJobs(db, backgroundJobHandler);
const watcherRecoveryTimer = setInterval(() => {
  refreshRootWatchers();
  const affected = new Set(rows(db, `SELECT workspace_id,id FROM workspace_roots WHERE indexing_enabled=1`).filter(root => !rootWatchers.has(root.id)).map(root => root.workspace_id));
  for (const workspaceId of affected) scheduleBackgroundIndex(workspaceId);
}, 15000);
watcherRecoveryTimer.unref?.();

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

async function applicationUpdateStatus({ fetch = false } = {}) {
  try {
    const status = inspectSafeUpdate(rootDir, { fetch });
    let remoteVersion = null;
    if (status.supported && status.remote_commit) try {
      const versionSource = await gitOutput(['show', 'origin/main:src/version.mjs']);
      remoteVersion = versionSource.match(/HARNESS_VERSION\s*=\s*['\"]([^'\"]+)/)?.[1] || null;
    } catch {}
    return {
      ...status,
      current_version: HARNESS_VERSION,
      remote_version: remoteVersion,
      current_commit: status.head,
      message: status.code === 'SAFE_TO_UPDATE' ? 'A safe fast-forward update is available.' : status.code === 'UP_TO_DATE' ? 'AI Harness is up to date.' : `Automatic update blocked: ${status.code}`
    };
  } catch (error) {
    return { supported: true, eligible: false, update_available: false, current_version: HARNESS_VERSION, code: error.code || 'UPDATE_STATUS_FAILED', error: error.message, message: 'Could not check GitHub. The installed version is unchanged.' };
  }
}

function selectSourceFolder() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(Object.assign(new Error('native folder selection is currently available on Windows'), { code: 'SOURCE_PICKER_UNAVAILABLE' }));
    const script = path.join(rootDir, 'scripts', 'select-source.ps1');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd: rootDir, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error('folder selection timed out'), { code: 'SOURCE_PICKER_TIMEOUT' })); }, 5 * 60 * 1000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 3) return resolve(null);
      if (code !== 0) return reject(Object.assign(new Error(stderr.trim() || 'folder selection failed'), { code: 'SOURCE_PICKER_FAILED' }));
      try { resolve(JSON.parse(stdout.trim())); }
      catch { reject(Object.assign(new Error('folder selection returned invalid data'), { code: 'SOURCE_PICKER_INVALID' })); }
    });
  });
}

function safeRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '..')) throw new Error('invalid relative path');
  return parts.join(path.sep);
}

function providerAssetMimeCompatible(expected, received) {
  const expectedType = String(expected || '').split(';')[0].trim().toLowerCase();
  const receivedType = String(received || '').split(';')[0].trim().toLowerCase();
  if (!receivedType || receivedType.includes('*')) return false;
  if (!expectedType || expectedType === 'application/octet-stream') return true;
  if (expectedType.endsWith('/*')) return receivedType.startsWith(expectedType.slice(0, -1));
  return expectedType === receivedType;
}

function recomputeSessionAssetStages(sessionId) {
  const incompleteInputs = Number(row(db, `SELECT COUNT(*) AS n FROM session_assets WHERE session_id=? AND origin_kind='user_input' AND UPPER(mirror_status)!='CAPTURED'`, sessionId)?.n || 0);
  const incompleteOutputs = Number(row(db, `SELECT COUNT(*) AS n FROM session_assets WHERE session_id=? AND origin_kind!='user_input' AND UPPER(mirror_status)!='CAPTURED'`, sessionId)?.n || 0);
  const incompleteDerived = Number(row(db, `SELECT COUNT(*) AS n FROM session_assets sa LEFT JOIN resource_versions v ON v.id=sa.resource_version_id
    WHERE sa.session_id=? AND (UPPER(sa.mirror_status)!='CAPTURED' OR v.id IS NULL OR v.indexing_status IN ('pending','processing','failed') OR v.representation_coverage IN ('blocked','partial','unknown'))`, sessionId)?.n || 0);
  setCaptureStages(db, sessionId, {
    userInputs: { complete: incompleteInputs === 0, details: incompleteInputs ? `${incompleteInputs} observed user input asset(s) still require durable bytes` : '' },
    providerOutputs: { complete: incompleteOutputs === 0, details: incompleteOutputs ? `${incompleteOutputs} observed provider-generated asset(s) still require durable bytes` : '' },
    derived: { complete: incompleteDerived === 0, details: incompleteDerived ? `${incompleteDerived} captured asset representation(s) remain incomplete` : '' },
    search: { complete: incompleteDerived === 0, details: incompleteDerived ? 'captured asset search representation is incomplete' : '' }
  });
  const session = row(db, 'SELECT workspace_id FROM sessions WHERE id=?', sessionId);
  if (session) run(db, 'UPDATE workspaces SET history_coverage=?,updated_at=? WHERE id=?', workspaceHistoryCoverage(db, session.workspace_id), new Date().toISOString(), session.workspace_id);
  return { user_inputs_complete: incompleteInputs === 0, provider_outputs_complete: incompleteOutputs === 0, derived_complete: incompleteDerived === 0, search_complete: incompleteDerived === 0, attachments_complete: incompleteInputs === 0 && incompleteOutputs === 0 };
}

function sniffAssetMime(filePath, declaredType, name = '') {
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(16);
  const length = fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  const bytes = head.subarray(0, length);
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50,0x4b,0x03,0x04]))) return String(declaredType || '').includes('vnd.') ? String(declaredType).split(';')[0].trim().toLowerCase() : 'application/zip';
  const extension = path.extname(String(name || '')).toLowerCase();
  if (['.txt','.md','.csv','.json','.js','.mjs','.ts','.tsx','.py','.c','.h','.sv','.v'].includes(extension)) return String(declaredType || 'text/plain').split(';')[0].trim().toLowerCase() || 'text/plain';
  const normalizedDeclared = String(declaredType || '').split(';')[0].trim().toLowerCase();
  if (['application/pdf','image/png','image/jpeg','image/webp'].includes(normalizedDeclared)) return 'application/octet-stream';
  return normalizedDeclared || 'application/octet-stream';
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
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req, maxBytes = 1024 * 1024) {
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
  const workspace = row(db, `SELECT * FROM workspaces WHERE id=? AND lifecycle_status='active'`, id);
  if (!workspace) return null;
  const projectFiles = rows(db, 'SELECT * FROM workspace_files WHERE workspace_id = ? ORDER BY relative_path', id);
  return {
    ...workspace,
    roots: workspaceRoots(db, id),
    integrity: workspaceIntegrity(db, id),
    representation_coverage: representationCoverage(db, id),
    instruction_context: instructionContext(db, id),
    resources: currentWorkspaceResources(db, id),
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
    archive: archiveStats(id),
    jobs: rows(db, 'SELECT * FROM background_jobs WHERE workspace_id=? ORDER BY created_at DESC LIMIT 50', id),
    processing_queue: backgroundQueueStatus()
  };
}

function archiveStats(workspaceId = null) {
  const whereSession = workspaceId ? 'WHERE workspace_id = ?' : '';
  const whereArtifact = workspaceId ? 'WHERE workspace_id = ?' : '';
  const params = workspaceId ? [workspaceId] : [];
  const derivedTypes = "'derived_representation','pdf_page_image','pdf_embedded_image'";
  let backupBytes = 0;
  try {
    for (const entry of fs.readdirSync(storage.backupsDir, { withFileTypes: true })) {
      if (entry.isFile()) backupBytes += fs.statSync(path.join(storage.backupsDir, entry.name)).size;
    }
  } catch {}
  const projectResourceBytes = workspaceId
    ? Number(row(db, `SELECT COALESCE(SUM(v.size_bytes),0) AS n FROM workspace_resources r JOIN resource_versions v ON v.id=r.current_version_id WHERE r.workspace_id=? AND r.status='active'`, workspaceId)?.n || 0)
    : 0;
  const derivedBytes = Number(row(db, `SELECT COALESCE(SUM(size_bytes),0) AS n FROM artifacts ${workspaceId ? `WHERE workspace_id=? AND artifact_type IN (${derivedTypes})` : `WHERE artifact_type IN (${derivedTypes})`}`, ...params)?.n || 0);
  const originalArchiveBytes = Number(row(db, `SELECT COALESCE(SUM(size_bytes),0) AS n FROM artifacts ${workspaceId ? `WHERE workspace_id=? AND artifact_type NOT IN (${derivedTypes})` : `WHERE artifact_type NOT IN (${derivedTypes})`}`, ...params)?.n || 0);
  return {
    sessions: Number(row(db, `SELECT COUNT(*) AS n FROM sessions ${whereSession}`, ...params)?.n || 0),
    messages: Number(row(db, workspaceId
      ? `SELECT COUNT(*) AS n FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.workspace_id=?`
      : `SELECT COUNT(*) AS n FROM messages`, ...params)?.n || 0),
    artifacts: Number(row(db, `SELECT COUNT(*) AS n FROM artifacts ${whereArtifact}`, ...params)?.n || 0),
    artifact_bytes: Number(row(db, `SELECT COALESCE(SUM(size_bytes),0) AS n FROM artifacts ${whereArtifact}`, ...params)?.n || 0),
    project_resource_bytes: projectResourceBytes,
    original_archive_bytes: originalArchiveBytes,
    derived_bytes: derivedBytes,
    backup_bytes: backupBytes,
    total_known_bytes: projectResourceBytes + originalArchiveBytes + derivedBytes + backupBytes,
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
  const pairing = pairedCompanionStatus(db);
  const metadata = client ? JSON.parse(client.metadata_json || '{}') : {};
  const protocolCompatible = Number(metadata.protocol_version || 0) >= COMPANION_PROTOCOL_MIN_VERSION && Number(metadata.protocol_version || 0) <= COMPANION_PROTOCOL_VERSION;
  const adapterHealthy = metadata.capabilities?.ok === true;
  return {
    service_ready: true,
    database_ready: true,
    browser_companion_seen: Boolean(client && pairing),
    browser_companion_paired: Boolean(pairing),
    paired_extension_id: pairing?.extension_id || null,
    browser_companion_last_seen: client?.last_seen_at || null,
    browser_companion_version: client?.version || null,
    protocol_version: COMPANION_PROTOCOL_VERSION,
    companion_protocol_version: Number(metadata.protocol_version || 0),
    protocol_compatible: protocolCompatible,
    adapter_health: metadata.capabilities || null,
    ready_for_native_workflow: Boolean(client && pairing && protocolCompatible && adapterHealthy),
    indicator: client && pairing && protocolCompatible && adapterHealthy ? 'bright_red' : 'setup_required',
    reload_required: Boolean(client && (!protocolCompatible || !adapterHealthy))
  };
}

function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] || '';
}

function streamVaultFile(res, artifact, { disposition = 'inline', name = 'artifact' } = {}) {
  if (!artifact?.vault_path || !isPathWithin(artifact.vault_path, storage.vaultDir) || !fs.existsSync(artifact.vault_path)) return sendJson(res, 404, { ok: false, code: 'ARTIFACT_NOT_AVAILABLE' });
  const stat = fs.statSync(artifact.vault_path);
  if (!stat.isFile() || stat.size > 100 * 1024 * 1024 || (artifact.sha256 && sha256File(artifact.vault_path) !== artifact.sha256)) return sendJson(res, 409, { ok: false, code: 'ARTIFACT_INTEGRITY_FAILURE' });
  const safeName = path.basename(name).replace(/[\r\n"]/g, '_');
  res.writeHead(200, {
    'Content-Type': artifact.mime_type || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `${disposition}; filename="${safeName}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  return fs.createReadStream(artifact.vault_path).pipe(res);
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  const pairingChallengePath = url.pathname === '/api/companion/pairing-challenge';
  const pairingPath = url.pathname === '/api/companion/pair';
  const agentContextProtected = url.pathname.startsWith('/api/agent-context/');
  const companionProtected = url.pathname.startsWith('/api/companion/') && !pairingChallengePath && !pairingPath;
  if (companionProtected) {
    const authenticated = authenticateCompanionRequest(db, req, { installSecret: companionCredential.secret });
    if (!authenticated.ok) return sendJson(res, 401, { ok: false, code: authenticated.code, error: authenticated.message });
    req.aihCompanion = authenticated;
  } else if (pairingChallengePath) {
    if (!isSameOriginDashboardRequest(req, port)) return sendJson(res, 403, { ok: false, code: 'ORIGIN_REJECTED', error: 'pairing must begin from the local Harness dashboard' });
  } else if (pairingPath) {
    const extensionId = String(req.headers['x-aih-extension-id'] || '');
    if (req.headers.origin !== `chrome-extension://${extensionId}`) return sendJson(res, 403, { ok: false, code: 'ORIGIN_REJECTED', error: 'pairing origin rejected' });
  } else if (!agentContextProtected && !['GET', 'HEAD'].includes(req.method) && !isSameOriginDashboardRequest(req, port)) {
    return sendJson(res, 403, { ok: false, code: 'ORIGIN_REJECTED', error: 'request origin rejected' });
  }

  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, version: HARNESS_VERSION, protocol_version: COMPANION_PROTOCOL_VERSION, source_root: rootDir, pid: process.pid, database: 'sqlite', storage: storageSummary(db), archive: archiveStats(), pending_managed_project_migrations: pendingManagedWorkspaceMigrations(db).length });
  if (url.pathname === '/api/tools' && req.method === 'GET') return sendJson(res, 200, multimodalToolStatus());
  if (url.pathname === '/api/dialogs/select-source' && req.method === 'POST') {
    try {
      const body = await readJson(req, 16 * 1024);
      const selected = await selectSourceFolder();
      if (!selected) return sendJson(res, 200, { selected: false });
      const canonical = fs.realpathSync.native(selected);
      const gitRepository = fs.existsSync(path.join(canonical, '.git'));
      const duplicate = body.workspace_id ? row(db, 'SELECT id,label FROM workspace_roots WHERE workspace_id=? AND canonical_path=?', String(body.workspace_id), canonical) : null;
      return sendJson(res, 200, {
        selected: true,
        path: canonical,
        detected: { kind: gitRepository ? 'Git repository' : 'Folder', git_repository: gitRepository },
        duplicate: duplicate ? { root_id: duplicate.id, label: duplicate.label } : null
      });
    } catch (error) { return sendJson(res, 503, { ok: false, code: error.code || 'SOURCE_PICKER_FAILED', error: error.message }); }
  }
  if (url.pathname === '/api/surfaces' && req.method === 'GET') {
    const clients = rows(db, 'SELECT provider,last_seen_at,metadata_json FROM companion_clients ORDER BY last_seen_at DESC');
    const agents = agentCapabilities();
    const surfaces = surfaceRegistry.list().map(surface => {
      if (surface.channel === 'browser_companion') {
        const provider = surface.id.startsWith('chatgpt') ? 'chatgpt' : 'gemini';
        const live = clients.find(item => item.provider === provider && JSON.parse(item.metadata_json || '{}').surface_id === surface.id);
        return publicSurfaceStatus(surface, live ? { status: 'connected', last_seen_at: live.last_seen_at } : { status: 'not_detected', limitation: 'Open or refresh the native provider page after pairing the companion.' });
      }
      const agent = surface.id.split('.')[0];
      return publicSurfaceStatus(surface, agents[agent]?.available ? { status: 'available' } : { status: 'not_installed', limitation: agents[agent]?.code || 'TOOL_NOT_INSTALLED' });
    });
    return sendJson(res, 200, surfaces);
  }
  if (url.pathname === '/api/security' && req.method === 'GET') return sendJson(res, 200, {
    companion: pairedCompanionStatus(db),
    active_agent_context_sessions: rows(db, `SELECT id,workspace_id,root_id,agent,capabilities_json,expires_at,last_used_at,created_at FROM agent_context_sessions WHERE revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC`, new Date().toISOString()),
    boundaries: { dashboard: 'same-origin localhost mutations only', browser_companion: 'paired allowlisted continuity operations only; no filesystem or shell', local_agents: 'registered repository plus expiring read-only context session' }
  });
  if (url.pathname === '/api/security/companion/revoke' && req.method === 'POST') {
    const body = await readJson(req, 16 * 1024);
    const extensionId = String(body.extension_id || pairedCompanionStatus(db)?.extension_id || '');
    if (!extensionId) return sendJson(res, 404, { ok: false, code: 'COMPANION_NOT_PAIRED' });
    run(db, 'UPDATE companion_pairings SET revoked_at=? WHERE extension_id=? AND revoked_at IS NULL', new Date().toISOString(), extensionId);
    return sendJson(res, 200, { ok: true, extension_id: extensionId });
  }
  const revokeAgentSessionMatch = url.pathname.match(/^\/api\/security\/agent-context\/([^/]+)\/revoke$/);
  if (revokeAgentSessionMatch && req.method === 'POST') return revokeAgentContextSession(db, revokeAgentSessionMatch[1])
    ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { ok: false, code: 'AGENT_CONTEXT_NOT_ACTIVE' });

  const agentContextPath = url.pathname.match(/^\/api\/agent-context\/(status|query|sources|resource|visual)(?:\/([^/]+))?$/);
  if (agentContextPath) {
    const capability = agentContextPath[1];
    const authenticated = authenticateAgentContext(db, bearerToken(req), capability);
    if (!authenticated.ok) return sendJson(res, authenticated.code === 'AGENT_CONTEXT_EXPIRED' ? 410 : 401, authenticated);
    try {
      if (capability === 'status' && req.method === 'GET') return sendJson(res, 200, agentContextStatus(db, authenticated.session));
      if (capability === 'query' && req.method === 'POST') {
        const body = await readJson(req, 128 * 1024);
        return sendJson(res, 200, agentContextQuery(db, authenticated.session, String(body.query || ''), body.character_budget));
      }
      if (capability === 'sources' && req.method === 'GET') return sendJson(res, 200, agentContextSources(db, authenticated.session));
      if (capability === 'resource' && req.method === 'GET' && agentContextPath[2]) return sendJson(res, 200, agentContextResource(db, authenticated.session, decodeURIComponent(agentContextPath[2])));
      if (capability === 'visual' && req.method === 'GET' && agentContextPath[2]) {
        const visual = agentContextVisual(db, authenticated.session, decodeURIComponent(agentContextPath[2]));
        return streamVaultFile(res, visual, { disposition: 'inline', name: `${path.basename(visual.relative_path)}-${visual.page_start || 'visual'}` });
      }
      return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
    } catch (error) { return sendJson(res, error.code?.endsWith('_NOT_FOUND') ? 404 : 400, { ok: false, code: error.code || 'AGENT_CONTEXT_FAILED', error: error.message }); }
  }
  if (url.pathname === '/api/update-status' && req.method === 'GET') return sendJson(res, 200, await applicationUpdateStatus({ fetch: url.searchParams.get('refresh') === '1' }));
  if (url.pathname === '/api/update-and-restart' && req.method === 'POST') {
    const status = await applicationUpdateStatus({ fetch: true });
    if (!status.eligible) return sendJson(res, 409, { ok: false, code: status.code || 'UPDATE_BLOCKED', status });
    const script = path.join(rootDir, 'update-and-launch-harness.ps1');
    if (!fs.existsSync(script)) return sendJson(res, 500, { ok: false, code: 'UPDATE_HELPER_MISSING' });
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] : ['-NoProfile', '-File', script];
    const child = spawn(shell, shellArgs, { cwd: rootDir, detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    return sendJson(res, 202, { ok: true, code: 'UPDATE_STARTED', current_commit: status.current_commit, target_commit: status.remote_commit });
  }
  if (url.pathname === '/api/local-agents' && req.method === 'GET') return sendJson(res, 200, agentCapabilities());
  if (url.pathname === '/api/readiness' && req.method === 'GET') return sendJson(res, 200, readiness());
  if (url.pathname === '/api/shutdown' && req.method === 'POST') {
    sendJson(res, 202, { ok: true, code: 'SHUTDOWN_STARTED' });
    setImmediate(() => shutdown('dashboard_request'));
    return;
  }
  if (url.pathname === '/api/companion/pairing-challenge' && req.method === 'POST') {
    return sendJson(res, 201, { ok: true, ...createPairingChallenge(db, { installSecret: companionCredential.secret }) });
  }
  if (url.pathname === '/api/companion/pair' && req.method === 'POST') {
    try {
      const body = await readJson(req, 16 * 1024);
      const extensionId = String(req.headers['x-aih-extension-id'] || body.extension_id || '');
      return sendJson(res, 201, { ok: true, ...completePairing(db, { challenge: body.challenge, extensionId, installSecret: companionCredential.secret }) });
    } catch (error) {
      return sendJson(res, error.statusCode || 401, { ok: false, code: 'PAIRING_FAILED', error: error.message });
    }
  }
  if (url.pathname === '/api/companion/heartbeat' && req.method === 'POST') {
    const body = await readJson(req);
    let surface;
    try { surface = surfaceRegistry.resolve(body.surface_id || body.metadata?.surface_id); }
    catch (error) { return sendJson(res, 409, { ok: false, code: error.code || 'SURFACE_UNSUPPORTED', error: error.message }); }
    const expected = browserSurfaceForProvider(body.provider);
    if (surface.id !== expected.id || surface.channel !== 'browser_companion') return sendJson(res, 409, { ok: false, code: 'SURFACE_PROVIDER_MISMATCH' });
    const clientId = req.aihCompanion.extensionId;
    const ts = new Date().toISOString();
    const metadata = { ...(body.metadata || {}), surface_id: surface.id, protocol_version: Number(body.protocol_version || 0) };
    run(db, `INSERT INTO companion_clients (client_id,version,provider,last_seen_at,metadata_json) VALUES (?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET version=excluded.version,provider=excluded.provider,last_seen_at=excluded.last_seen_at,metadata_json=excluded.metadata_json`, clientId, body.version || '', body.provider || '', ts, JSON.stringify(metadata));
    return sendJson(res, 200, readiness());
  }
  if (url.pathname === '/api/companion/active-workspace' && req.method === 'GET') {
    const id = row(db, `SELECT value FROM settings WHERE key='active_workspace_id'`)?.value;
    const activeWorkspace = id ? row(db, 'SELECT id,name,description,active_focus,freshness_status,history_coverage FROM workspaces WHERE id=?', id) : null;
    return activeWorkspace ? sendJson(res, 200, activeWorkspace) : sendJson(res, 404, { error: 'active workspace not found' });
  }
  if (url.pathname === '/api/companion/provider-session' && req.method === 'GET') {
    const provider = String(url.searchParams.get('provider') || '').toLowerCase();
    const refs = [];
    for (const [key, value] of url.searchParams.entries()) if (key !== 'provider' && value) refs.push({ ref_type: key, ref_value: value });
    const session = resolveCapturedSession(db, provider, refs);
    if (!session) return sendJson(res, 404, { error: 'session not found' });
    const ws = row(db, 'SELECT id,name,description,active_focus,freshness_status,history_coverage FROM workspaces WHERE id=?', session.workspace_id);
    return sendJson(res, 200, { ...session, display_label: sessionLabel(session, ws?.name), workspace: ws, provider_refs: rows(db, 'SELECT ref_type,ref_value,source FROM session_external_refs WHERE session_id=? ORDER BY ref_type', session.id) });
  }
  if (url.pathname === '/api/archive/stats') return sendJson(res, 200, archiveStats(url.searchParams.get('workspace_id')));

  if (url.pathname === '/api/companion/capture' && req.method === 'POST') {
    try {
      const result = captureVerifiedBrowserSession(db, await readJson(req));
      return sendJson(res, 201, { ...result, workspace: { id: result.workspace.id, name: result.workspace.name, description: result.workspace.description, active_focus: result.workspace.active_focus, freshness_status: result.workspace.freshness_status, history_coverage: result.workspace.history_coverage } });
    }
    catch (error) { return sendJson(res, error.code === 'SESSION_WORKSPACE_MISMATCH' ? 409 : 400, { ok: false, code: error.code || 'CAPTURE_FAILED', error: error.message }); }
  }

  const prewarmMatch = url.pathname.match(/^\/api\/companion\/workspaces\/([^/]+)\/prewarm$/);
  if (prewarmMatch && req.method === 'POST') {
    const workspaceId = prewarmMatch[1];
    if (!row(db, 'SELECT id FROM workspaces WHERE id=?', workspaceId)) return sendJson(res, 404, { ok: false, code: 'WORKSPACE_NOT_FOUND' });
    const existing = row(db, `SELECT * FROM background_jobs WHERE workspace_id=? AND job_type='verify_sources' AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`, workspaceId);
    if (existing) return sendJson(res, 202, { ok: true, reused: true, job: existing });
    const job = createBackgroundJob(db, { workspaceId, jobType: 'verify_sources', targetType: 'workspace', targetId: workspaceId });
    startBackgroundJob(db, job.id, async progress => {
      progress({ phase: 'warming source manifest and current representations' });
      const resources = reconcileWorkspaceResources(db, workspaceId);
      progress({ phase: 'refreshing repository state' });
      const repository = refreshWorkspaceRepositories(db, workspaceId);
      return { resources, repository };
    });
    return sendJson(res, 202, { ok: true, reused: false, job });
  }

  const draftContextMatch = url.pathname.match(/^\/api\/companion\/workspaces\/([^/]+)\/draft-context$/);
  if (draftContextMatch && req.method === 'POST') {
    try {
      const body = await readJson(req, 64 * 1024);
      const expected = browserSurfaceForProvider(body.provider);
      if (expected.id !== body.surface_id) return sendJson(res, 409, { ok: false, code: 'SURFACE_PROVIDER_MISMATCH' });
      return sendJson(res, 200, { ok: true, ...prepareSpeculativeDraft(db, { workspaceId: draftContextMatch[1], sessionId: String(body.session_id || ''), surfaceId: body.surface_id, provider: body.provider, query: body.query }) });
    } catch (error) { return sendJson(res, 400, { ok: false, code: error.code || 'DRAFT_CONTEXT_FAILED', error: error.message }); }
  }

  const prepareSendMatch = url.pathname.match(/^\/api\/companion\/workspaces\/([^/]+)\/prepare-send$/);
  if (prepareSendMatch && req.method === 'POST') {
    try {
      const body = await readJson(req);
      if (Number(body.protocol_version || 0) !== COMPANION_PROTOCOL_VERSION) {
        return sendJson(res, 409, { ok: false, freshness: 'blocked', reasons: [{ code: 'COMPANION_PROTOCOL_MISMATCH', message: `browser companion protocol ${Number(body.protocol_version || 0)} is incompatible with service protocol ${COMPANION_PROTOCOL_VERSION}; reload the extension` }] });
      }
      const captureEvidence = body.capture?.capture_evidence;
      const capabilities = captureEvidence?.capabilities;
      if (Number(captureEvidence?.protocol_version || 0) !== COMPANION_PROTOCOL_VERSION || !capabilities) {
        return sendJson(res, 409, { ok: false, freshness: 'blocked', reasons: [{ code: 'PROVIDER_CAPABILITY_EVIDENCE_MISSING', message: 'the browser companion did not provide compatible provider capability evidence; reload the extension' }] });
      }
      if (capabilities.ok !== true) {
        return sendJson(res, 412, { ok: false, freshness: 'blocked', reasons: (capabilities.failures || []).map(item => ({ code: item.code || 'PROVIDER_CAPABILITY_FAILED', message: `required provider capability failed: ${item.capability || 'unknown'}` })) });
      }
      if (capabilities.surface_id !== body.surface_id) return sendJson(res, 409, { ok: false, freshness: 'blocked', reasons: [{ code: 'SURFACE_CAPABILITY_MISMATCH', message: 'surface identity and capability evidence do not match' }] });
      const result = prepareManagedSend(db, {
        workspaceId: prepareSendMatch[1],
        provider: body.provider,
        userPrompt: body.user_prompt,
        capture: body.capture,
        attemptId: body.attempt_id,
        promptHash: body.prompt_hash,
        providerRoute: body.route,
        surfaceId: body.surface_id,
        protocolVersion: body.protocol_version,
        attachmentMode: body.attachment_mode,
        fallbackFromRunId: body.fallback_from_run_id,
        fallbackVersionIds: body.fallback_version_ids,
        contextCharacterBudget: Math.min(60000, Math.max(8000, Number(body.context_character_budget || 30000)))
      });
      return sendJson(res, result.ok ? 200 : 412, result);
    } catch (error) {
      return sendJson(res, 400, { ok: false, freshness: 'blocked', reasons: [{ code: error.code || 'INVALID_REQUEST', message: error.message }] });
    }
  }

  const sentRunMatch = url.pathname.match(/^\/api\/companion\/outgoing-context\/([^/]+)\/sent$/);
  if (sentRunMatch && req.method === 'POST') {
    const body = await readJson(req, 32 * 1024);
    const deliveryRun = row(db, 'SELECT status FROM outgoing_context_runs WHERE id=?', sentRunMatch[1]);
    if (!deliveryRun || deliveryRun.status !== 'prepared') return sendJson(res, 409, { ok: false, code: 'RUN_NOT_PREPARED' });
    if (!body.acceptance?.accepted || !['strong','corroborated'].includes(body.acceptance?.certainty)) return sendJson(res, 409, { ok: false, code: 'PROVIDER_ACCEPTANCE_UNPROVEN' });
    return markContextRunSent(db, sentRunMatch[1], { attemptId: body.attempt_id, promptHash: body.prompt_hash, providerRoute: body.route, protocolVersion: body.protocol_version, acceptance: body.acceptance })
      ? sendJson(res, 200, { ok: true }) : sendJson(res, 409, { ok: false, code: 'PREPARED_CONTEXT_INVALIDATED' });
  }

  const failedRunMatch = url.pathname.match(/^\/api\/companion\/outgoing-context\/([^/]+)\/failed$/);
  if (failedRunMatch && req.method === 'POST') {
    const body = await readJson(req, 16 * 1024);
    return markContextRunFailed(db, failedRunMatch[1], { code: body.code, message: String(body.message || '').slice(0, 500) })
      ? sendJson(res, 200, { ok: true })
      : sendJson(res, 409, { ok: false, code: 'RUN_NOT_PREPARED' });
  }

  const resourceVersionContent = url.pathname.match(/^\/api\/companion\/resource-versions\/([^/]+)\/content$/);
  if (resourceVersionContent && req.method === 'GET') {
    const version = row(db, `SELECT v.*,r.relative_path,r.resource_type,r.mime_type,r.current_version_id,r.provider_transmission_allowed,
      wr.provider_transmission_allowed AS root_transmission_allowed,wr.status AS root_status,wr.root_path,wr.canonical_path,wr.root_kind,a.vault_path
      FROM resource_versions v
      JOIN workspace_resources r ON r.id=v.resource_id
      JOIN workspace_roots wr ON wr.id=r.root_id
      LEFT JOIN artifacts a ON a.id=v.archive_artifact_id
      WHERE v.id=?`, resourceVersionContent[1]);
    if (!version || version.current_version_id !== version.id || !version.provider_transmission_allowed || !version.root_transmission_allowed || version.root_status !== 'current' || !version.vault_path) {
      return sendJson(res, 404, { ok: false, code: 'RESOURCE_NOT_AVAILABLE' });
    }
    if (version.security_status !== 'clear' || (['pdf','image'].includes(version.resource_type) && version.representation_coverage !== 'complete') || !isPathWithin(version.vault_path, storage.vaultDir) || !fs.existsSync(version.vault_path)) {
      return sendJson(res, 403, { ok: false, code: 'RESOURCE_TRANSMISSION_BLOCKED' });
    }
    if (version.root_kind !== 'provider_archive') try {
      const live = resolveApprovedTarget(version, version.relative_path, { expectedType: 'file' });
      if (sha256File(live.absolutePath) !== version.sha256) return sendJson(res, 409, { ok: false, code: 'PREPARED_ATTACHMENT_INVALIDATED' });
    } catch (error) {
      return sendJson(res, 409, { ok: false, code: 'PREPARED_ATTACHMENT_INVALIDATED', error: error.message });
    }
    const stat = fs.statSync(version.vault_path);
    if (stat.size > 100 * 1024 * 1024) return sendJson(res, 413, { ok: false, code: 'RESOURCE_TOO_LARGE' });
    if (sha256File(version.vault_path) !== version.sha256) return sendJson(res, 409, { ok: false, code: 'RESOURCE_INTEGRITY_FAILURE' });
    const safeName = path.basename(version.relative_path).replace(/[\r\n"]/g, '_');
    res.writeHead(200, {
      'Content-Type': version.mime_type || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return fs.createReadStream(version.vault_path).pipe(res);
  }

  const representationContent = url.pathname.match(/^\/api\/companion\/representations\/([^/]+)\/content$/);
  if (representationContent && req.method === 'GET') {
    const representation = row(db, `SELECT rr.*,r.relative_path,r.current_version_id,r.provider_transmission_allowed,v.sha256 AS version_sha256,v.security_status AS version_security_status,
      wr.provider_transmission_allowed AS root_transmission_allowed,wr.status AS root_status,wr.root_path,wr.canonical_path,wr.root_kind,
      a.vault_path,a.mime_type,a.size_bytes,a.sha256,a.name
      FROM resource_representations rr JOIN workspace_resources r ON r.id=rr.resource_id
      JOIN resource_versions v ON v.id=rr.resource_version_id JOIN workspace_roots wr ON wr.id=r.root_id
      JOIN artifacts a ON a.id=rr.artifact_id WHERE rr.id=?`, representationContent[1]);
    if (!representation || representation.current_version_id !== representation.resource_version_id || !representation.provider_transmission_allowed || !representation.root_transmission_allowed || representation.root_status !== 'current') return sendJson(res, 404, { ok: false, code: 'REPRESENTATION_NOT_AVAILABLE' });
    if (representation.security_status !== 'clear' || representation.version_security_status !== 'clear') return sendJson(res, 403, { ok: false, code: 'REPRESENTATION_TRANSMISSION_BLOCKED' });
    if (representation.root_kind !== 'provider_archive') try {
      const live = resolveApprovedTarget(representation, representation.relative_path, { expectedType: 'file' });
      if (sha256File(live.absolutePath) !== representation.version_sha256) return sendJson(res, 409, { ok: false, code: 'PREPARED_REPRESENTATION_INVALIDATED' });
    } catch (error) { return sendJson(res, 409, { ok: false, code: 'PREPARED_REPRESENTATION_INVALIDATED', error: error.message }); }
    return streamVaultFile(res, representation, { disposition: 'attachment', name: `${path.parse(representation.relative_path).name}-page-${representation.page_start || 'visual'}${path.extname(representation.name || '') || '.png'}` });
  }

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

  const assetSourceMatch = url.pathname.match(/^\/api\/companion\/session-assets\/([^/]+)\/source$/);
  if (assetSourceMatch && req.method === 'GET') {
    const asset = row(db, `SELECT a.*,s.provider AS session_provider,s.workspace_id FROM session_assets a JOIN sessions s ON s.id=a.session_id WHERE a.id=?`, assetSourceMatch[1]);
    if (!asset) return sendJson(res, 404, { ok: false, code: 'ASSET_NOT_DISCOVERED' });
    let metadata = {};
    try { metadata = JSON.parse(asset.metadata_json || '{}'); } catch {}
    const directInput = asset.origin_kind === 'user_input' && metadata.capture_strategy === 'direct_input' && !asset.source_url;
    const validated = directInput
      ? { ok: true, url: '', capture_strategy: 'direct_input' }
      : validateProviderAssetUrl(asset.session_provider, asset.source_url);
    if (!validated.ok) return sendJson(res, 403, { ok: false, code: validated.code, status: validated.status });
    if (String(asset.mirror_status).toUpperCase() === 'CAPTURED') return sendJson(res, 409, { ok: false, code: 'ASSET_ALREADY_CAPTURED' });
    if (!['DISCOVERED', 'FETCHING'].includes(String(asset.mirror_status).toUpperCase())) return sendJson(res, 409, { ok: false, code: 'ASSET_STATE_REJECTED', status: asset.mirror_status });
    return sendJson(res, 200, {
      ok: true,
      asset_id: asset.id,
      session_id: asset.session_id,
      workspace_id: asset.workspace_id,
      provider: asset.session_provider,
      source_url: validated.url,
      capture_strategy: validated.capture_strategy,
      mime_type: asset.mime_type,
      max_bytes: ['page_blob','direct_input'].includes(validated.capture_strategy) ? 25 * 1024 * 1024 : 100 * 1024 * 1024
    });
  }

  const assetContentMatch = url.pathname.match(/^\/api\/companion\/session-assets\/([^/]+)\/content$/);
  if (assetContentMatch && req.method === 'PUT') {
    const asset = row(db, `SELECT a.*, s.workspace_id, s.provider AS session_provider FROM session_assets a JOIN sessions s ON s.id=a.session_id WHERE a.id=?`, assetContentMatch[1]);
    if (!asset) return sendJson(res, 404, { ok: false, code: 'ASSET_NOT_DISCOVERED', error: 'asset reference not found' });
    if (!['DISCOVERED', 'FETCHING'].includes(String(asset.mirror_status).toUpperCase())) return sendJson(res, 409, { ok: false, code: 'ASSET_STATE_REJECTED', status: asset.mirror_status });
    let assetMetadata = {};
    try { assetMetadata = JSON.parse(asset.metadata_json || '{}'); } catch {}
    const directInput = asset.origin_kind === 'user_input' && assetMetadata.capture_strategy === 'direct_input' && !asset.source_url;
    const validatedUrl = directInput
      ? { ok: true, url: '', capture_strategy: 'direct_input' }
      : validateProviderAssetUrl(asset.session_provider, asset.source_url);
    if (!validatedUrl.ok) return sendJson(res, 403, { ok: false, code: validatedUrl.code, status: validatedUrl.status });
    const suppliedSource = String(req.headers['x-aih-asset-source-url'] || '');
    if (suppliedSource !== asset.source_url) return sendJson(res, 403, { ok: false, code: 'ASSET_SOURCE_MISMATCH' });
    const captureStrategy = String(req.headers['x-aih-asset-capture-strategy'] || 'background_https');
    if (captureStrategy !== validatedUrl.capture_strategy) return sendJson(res, 403, { ok: false, code: 'ASSET_CAPTURE_STRATEGY_MISMATCH' });
    const declaredLength = Number(req.headers['content-length'] || 0);
    const assetLimit = ['page_blob','direct_input'].includes(captureStrategy) ? 25 * 1024 * 1024 : 100 * 1024 * 1024;
    if (declaredLength > assetLimit) {
      run(db, `UPDATE session_assets SET mirror_status='FAILED',metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.capture_error',?),updated_at=? WHERE id=?`, `asset exceeds ${assetLimit} byte capture limit`, new Date().toISOString(), asset.id);
      recomputeSessionAssetStages(asset.session_id);
      return sendJson(res, 413, { ok: false, code: 'ASSET_TOO_LARGE' });
    }
    const receivedType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const allowedTypes = /^(?:image\/|application\/(?:pdf|zip|octet-stream|vnd\.)|text\/)/;
    if (!allowedTypes.test(receivedType) || !providerAssetMimeCompatible(asset.mime_type, receivedType)) {
      run(db, `UPDATE session_assets SET mirror_status='FAILED',metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.capture_error',?),updated_at=? WHERE id=?`, `received MIME ${receivedType || '(missing)'} did not match ${asset.mime_type || '(unspecified)'}`, new Date().toISOString(), asset.id);
      recomputeSessionAssetStages(asset.session_id);
      return sendJson(res, 415, { ok: false, code: 'ASSET_MIME_REJECTED' });
    }
    run(db, `UPDATE session_assets SET mirror_status='FETCHING',updated_at=? WHERE id=?`, new Date().toISOString(), asset.id);
    const tempDir = path.join(storage.runtimeDir, 'mirror');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${randomUUID()}.bin`);
    try {
      const size = await streamRequestToFile(req, tempPath, assetLimit);
      if (!size) throw Object.assign(new Error('empty provider asset rejected'), { code: 'ASSET_EMPTY' });
      const detectedType = sniffAssetMime(tempPath, receivedType, asset.name);
      if (!providerAssetMimeCompatible(asset.mime_type, detectedType)) throw Object.assign(new Error(`captured bytes have MIME ${detectedType}, which conflicts with observed ${asset.mime_type}`), { code: 'ASSET_MIME_REJECTED' });
      const sourceType = asset.origin_kind === 'user_input'
        ? asset.capture_method === 'clipboard_image' ? 'clipboard_image' : 'provider_user_attachment'
        : 'provider_generated_asset';
      const provenance = {
        originating_provider_family: asset.session_provider,
        originating_surface: `${asset.session_provider}.web`,
        session_id: asset.session_id,
        provider_conversation_id: row(db, 'SELECT external_id FROM sessions WHERE id=?', asset.session_id)?.external_id || '',
        user_message_id: asset.originating_provider_message_id || '',
        attachment_native_id: asset.native_id,
        original_displayed_filename: asset.name,
        capture_method: asset.capture_method,
        origin_kind: asset.origin_kind
      };
      const artifact = archiveFile(db, {
        filePath: tempPath,
        workspaceId: asset.workspace_id,
        sessionId: asset.session_id,
        provider: asset.session_provider,
        artifactType: sourceType,
        sourceUrl: asset.source_url,
        nativeId: asset.native_id,
        sourcePathOverride: `live:${asset.session_provider}:${asset.session_id}:${asset.id}`,
        metadata: { original_name: asset.name, declared_mime_type: asset.mime_type, detected_mime_type: detectedType, captured_via: 'browser_companion', capture_strategy: captureStrategy, source_type: sourceType, provenance }
      });
      run(db, `UPDATE artifacts SET name=?,mime_type=? WHERE id=?`, asset.name || artifact.name, detectedType, artifact.id);
      const providerResource = ingestProviderArtifactResource(db, { workspaceId: asset.workspace_id, artifact: row(db, 'SELECT * FROM artifacts WHERE id=?', artifact.id), sourceId: asset.id, provider: asset.session_provider, name: asset.name, sourceType, provenance });
      run(db, `UPDATE session_assets SET mirror_status='CAPTURED',artifact_id=?,resource_id=?,resource_version_id=?,updated_at=? WHERE id=?`, artifact.id, providerResource.resource.id, providerResource.version.id, new Date().toISOString(), asset.id);
      const stageState = recomputeSessionAssetStages(asset.session_id);
      return sendJson(res, 201, { artifact_id: artifact.id, resource_id: providerResource.resource.id, resource_version_id: providerResource.version.id, reconciled_existing_resource: Boolean(providerResource.reconciled), size_bytes: size, sha256: artifact.sha256, ...stageState });
    } catch (error) {
      run(db, `UPDATE session_assets SET mirror_status='FAILED',metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.capture_error',?),updated_at=? WHERE id=?`, String(error.message || '').slice(0, 500), new Date().toISOString(), asset.id);
      recomputeSessionAssetStages(asset.session_id);
      const failureStatus = error.message === 'file too large' ? 413 : error.code === 'ASSET_MIME_REJECTED' ? 415 : 400;
      return sendJson(res, failureStatus, { ok: false, code: error.code || 'ASSET_CAPTURE_FAILED', error: error.message });
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

  if (url.pathname === '/api/personalization' && req.method === 'GET') {
    const item = activePersonalization(db, { scope: 'global' });
    return sendJson(res, 200, item ? { ...item, profile: JSON.parse(item.profile_json || '{}') } : null);
  }
  if (url.pathname === '/api/personalization' && req.method === 'PUT') {
    try {
      const body = await readJson(req, 64 * 1024);
      const item = savePersonalization(db, { scope: 'global', profile: body.profile || {}, notes: body.notes || '' });
      return sendJson(res, 200, { ...item, profile: JSON.parse(item.profile_json || '{}') });
    } catch (error) { return sendJson(res, 400, { ok: false, code: error.code || 'PROFILE_SAVE_FAILED', error: error.message }); }
  }

  const instructionsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/instructions$/);
  if (instructionsMatch && req.method === 'GET') return sendJson(res, 200, activeProjectInstructions(db, instructionsMatch[1]));
  if (instructionsMatch && req.method === 'PUT') {
    try { return sendJson(res, 200, saveProjectInstructions(db, instructionsMatch[1], (await readJson(req, 64 * 1024)).content)); }
    catch (error) { return sendJson(res, 400, { ok: false, code: error.code || 'INSTRUCTIONS_SAVE_FAILED', error: error.message }); }
  }
  const workspaceProfileMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/personalization$/);
  if (workspaceProfileMatch && req.method === 'GET') {
    const item = activePersonalization(db, { scope: 'workspace', workspaceId: workspaceProfileMatch[1] });
    return sendJson(res, 200, item ? { ...item, profile: JSON.parse(item.profile_json || '{}') } : null);
  }
  if (workspaceProfileMatch && req.method === 'PUT') {
    try {
      const body = await readJson(req, 64 * 1024);
      const item = savePersonalization(db, { scope: 'workspace', workspaceId: workspaceProfileMatch[1], profile: body.profile || {}, notes: body.notes || '' });
      return sendJson(res, 200, { ...item, profile: JSON.parse(item.profile_json || '{}') });
    } catch (error) { return sendJson(res, 400, { ok: false, code: error.code || 'PROFILE_SAVE_FAILED', error: error.message }); }
  }
  const instructionHistoryMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/instruction-history$/);
  if (instructionHistoryMatch && req.method === 'GET') return sendJson(res, 200, instructionHistory(db, instructionHistoryMatch[1]));

  const resourceDetailMatch = url.pathname.match(/^\/api\/resources\/([^/]+)$/);
  if (resourceDetailMatch && req.method === 'GET') {
    const resource = row(db, 'SELECT * FROM workspace_resources WHERE id=?', resourceDetailMatch[1]);
    if (!resource) return sendJson(res, 404, { ok: false, code: 'RESOURCE_NOT_FOUND' });
    return sendJson(res, 200, {
      ...resource,
      origin: JSON.parse(resource.origin_json || '{}'),
      versions: rows(db, 'SELECT * FROM resource_versions WHERE resource_id=? ORDER BY observed_at DESC', resource.id).map(item => ({ ...item, metadata: JSON.parse(item.metadata_json || '{}'), coverage: JSON.parse(item.coverage_json || '{}') })),
      representations: rows(db, `SELECT rr.*,a.name,a.mime_type,a.size_bytes,a.sha256 AS artifact_sha256 FROM resource_representations rr LEFT JOIN artifacts a ON a.id=rr.artifact_id WHERE rr.resource_id=? ORDER BY rr.created_at DESC,rr.page_start`, resource.id).map(item => ({ ...item, metadata: JSON.parse(item.metadata_json || '{}'), region: JSON.parse(item.region_json || '{}') })),
      relationships: rows(db, `SELECT * FROM resource_relationships WHERE workspace_id=? AND ((source_type='resource' AND source_id=?) OR (target_type='resource' AND target_id=?) OR (target_type='resource_version' AND target_id IN (SELECT id FROM resource_versions WHERE resource_id=?))) ORDER BY created_at`, resource.workspace_id, resource.id, resource.id, resource.id).map(item => ({ ...item, provenance: JSON.parse(item.provenance_json || '{}') }))
    });
  }
  const resourceContentMatch = url.pathname.match(/^\/api\/resources\/([^/]+)\/content$/);
  if (resourceContentMatch && req.method === 'GET') {
    const resource = row(db, `SELECT r.relative_path,r.mime_type,a.* FROM workspace_resources r JOIN resource_versions v ON v.id=r.current_version_id JOIN artifacts a ON a.id=v.archive_artifact_id WHERE r.id=? AND r.status='active'`, resourceContentMatch[1]);
    if (!resource) return sendJson(res, 404, { ok: false, code: 'RESOURCE_NOT_AVAILABLE' });
    return streamVaultFile(res, resource, { disposition: 'inline', name: path.basename(resource.relative_path || resource.name || 'resource') });
  }
  const resourcePolicyMatch = url.pathname.match(/^\/api\/resources\/([^/]+)\/policy$/);
  if (resourcePolicyMatch && req.method === 'PATCH') {
    try { return sendJson(res, 200, updateResourceContextPolicy(db, resourcePolicyMatch[1], await readJson(req, 16 * 1024))); }
    catch (error) { return sendJson(res, 409, { ok: false, code: error.code || 'RESOURCE_POLICY_FAILED', error: error.message }); }
  }
  const resourceSaveCopyMatch = url.pathname.match(/^\/api\/resources\/([^/]+)\/save-copy$/);
  if (resourceSaveCopyMatch && req.method === 'POST') {
    try {
      const body = await readJson(req, 16 * 1024);
      return sendJson(res, 201, saveResourceCopyToProjectFolder(db, { resourceId: resourceSaveCopyMatch[1], rootId: String(body.root_id || ''), relativePath: String(body.relative_path || '') }));
    } catch (error) { return sendJson(res, error.code === 'DESTINATION_CONFLICT' ? 409 : 400, { ok: false, code: error.code || 'RESOURCE_EXPORT_FAILED', error: error.message }); }
  }
  const openResourceMatch = url.pathname.match(/^\/api\/resources\/([^/]+)\/open$/);
  if (openResourceMatch && req.method === 'POST') {
    try {
      const resource = row(db, `SELECT r.*,wr.root_path,wr.canonical_path,wr.root_kind FROM workspace_resources r JOIN workspace_roots wr ON wr.id=r.root_id WHERE r.id=? AND r.status='active'`, openResourceMatch[1]);
      if (!resource) return sendJson(res, 404, { ok: false, code: 'RESOURCE_NOT_FOUND' });
      if (resource.root_kind === 'provider_archive') return sendJson(res, 200, { ok: true, resource_id: resource.id, content_url: `/api/resources/${encodeURIComponent(resource.id)}/content` });
      const resolved = resolveApprovedTarget(resource, resource.relative_path, { expectedType: 'file' });
      const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(opener, [resolved.absolutePath], { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
      child.unref();
      return sendJson(res, 200, { ok: true, resource_id: resource.id });
    } catch (error) { return sendJson(res, 409, { ok: false, code: error.code || 'RESOURCE_OPEN_FAILED', error: error.message }); }
  }

  const jobsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/jobs$/);
  if (jobsMatch && req.method === 'GET') return sendJson(res, 200, rows(db, 'SELECT * FROM background_jobs WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100', jobsMatch[1]));
  if (jobsMatch && req.method === 'POST') {
    const workspaceId = jobsMatch[1];
    if (!row(db, 'SELECT id FROM workspaces WHERE id=?', workspaceId)) return sendJson(res, 404, { ok: false, code: 'WORKSPACE_NOT_FOUND' });
    try {
      const body = await readJson(req, 32 * 1024);
      const targetId = String(body.target_id || '');
      const job = createBackgroundJob(db, { workspaceId, jobType: body.job_type, targetType: targetId ? 'resource' : 'workspace', targetId });
      startBackgroundJob(db, job.id, backgroundJobHandler(job));
      return sendJson(res, 202, job);
    } catch (error) { return sendJson(res, 400, { ok: false, code: error.code || 'JOB_CREATE_FAILED', error: error.message }); }
  }
  const jobDetailMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobDetailMatch && req.method === 'GET') {
    const job = row(db, 'SELECT * FROM background_jobs WHERE id=?', jobDetailMatch[1]);
    return job ? sendJson(res, 200, job) : sendJson(res, 404, { ok: false, code: 'JOB_NOT_FOUND' });
  }
  const jobCancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (jobCancelMatch && req.method === 'POST') {
    const job = cancelBackgroundJob(db, jobCancelMatch[1]);
    return job ? sendJson(res, 200, job) : sendJson(res, 404, { ok: false, code: 'JOB_NOT_FOUND' });
  }

  if (url.pathname === '/api/workspaces' && req.method === 'GET') {
    const workspaces = rows(db, `
      SELECT w.*,
        (SELECT COUNT(*) FROM sessions s WHERE s.workspace_id = w.id) AS session_count,
        (SELECT COUNT(*) FROM memories m WHERE m.workspace_id = w.id AND m.status = 'active') AS memory_count,
        (SELECT COUNT(*) FROM artifacts a WHERE a.workspace_id = w.id) AS artifact_count
      FROM workspaces w WHERE w.lifecycle_status='active' ORDER BY updated_at DESC
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
    const stat = fs.lstatSync(file.local_path);
    const realFile = stat.isSymbolicLink() ? '' : fs.realpathSync.native(file.local_path);
    const approved = realFile && workspaceRoots(db, file.workspace_id).some(root => {
      try { return isPathWithin(realFile, fs.realpathSync.native(root.root_path)); } catch { return false; }
    });
    if (!approved || !stat.isFile()) return sendJson(res, 403, { ok: false, code: 'ROOT_SECURITY_FAILURE' });
    const safeName = String(file.name || 'file').replace(/[\r\n"]/g, '_');
    res.writeHead(200, {
      'Content-Type': file.mime_type || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${safeName}"`,
      'X-Content-Type-Options': 'nosniff'
    });
    return fs.createReadStream(realFile).pipe(res);
  }

  const artifactContent = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/content$/);
  if (artifactContent && req.method === 'GET') {
    const artifact = row(db, 'SELECT * FROM artifacts WHERE id=?', artifactContent[1]);
    if (!artifact || !artifact.vault_path || !isPathWithin(artifact.vault_path, storage.vaultDir) || !fs.existsSync(artifact.vault_path)) return sendJson(res, 404, { error: 'artifact content not found' });
    const stat = fs.statSync(artifact.vault_path);
    const safeName = String(artifact.name || 'artifact').replace(/[\r\n"]/g, '_');
    res.writeHead(200, {
      'Content-Type': artifact.mime_type || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${safeName}"`,
      'X-Content-Type-Options': 'nosniff'
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
    refreshRootWatchers();
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
      refreshRootWatchers();
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
    if (!row(db, `SELECT id FROM workspaces WHERE id=? AND lifecycle_status='active'`, workspace_id)) return sendJson(res, 404, { error: 'workspace not found' });
    run(db, `INSERT INTO settings (key, value) VALUES ('active_workspace_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, workspace_id);
    return sendJson(res, 200, workspaceSummary(workspace_id));
  }

  if (url.pathname === '/api/capture' && req.method === 'POST') {
    return sendJson(res, 401, { ok: false, code: 'COMPANION_UNAUTHENTICATED', error: 'use the authenticated companion capture endpoint' });
  }

  const assetStatusMatch = url.pathname.match(/^\/api\/companion\/session-assets\/([^/]+)\/status$/);
  if (assetStatusMatch && req.method === 'POST') {
    const asset = row(db, `SELECT a.*,s.provider AS session_provider FROM session_assets a JOIN sessions s ON s.id=a.session_id WHERE a.id=?`, assetStatusMatch[1]);
    if (!asset) return sendJson(res, 404, { ok: false, code: 'ASSET_NOT_DISCOVERED' });
    const body = await readJson(req, 16 * 1024);
    const status = String(body.status || '').toUpperCase();
    if (!['UNAVAILABLE','AUTH_REQUIRED','CORS_BLOCKED','EXPIRED','FAILED'].includes(status)) return sendJson(res, 400, { ok: false, code: 'ASSET_STATUS_INVALID' });
    run(db, `UPDATE session_assets SET mirror_status=?,metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.capture_error',?),updated_at=? WHERE id=?`, status, String(body.message || '').slice(0, 500), new Date().toISOString(), asset.id);
    recomputeSessionAssetStages(asset.session_id);
    return sendJson(res, 200, { ok: true, status });
  }

  if (url.pathname === '/api/storage/managed-project-migrations' && req.method === 'GET') {
    return sendJson(res, 200, pendingManagedWorkspaceMigrations(db));
  }

  const migrateWorkspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/migrate-managed-project$/);
  if (migrateWorkspaceMatch && req.method === 'POST') {
    try { const result = migrateManagedWorkspaceProject(db, migrateWorkspaceMatch[1]); refreshRootWatchers(); return sendJson(res, 200, result); }
    catch (error) { return sendJson(res, 409, { ok: false, code: 'MIGRATION_FAILED', error: error.message }); }
  }

  const integrityMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/integrity$/);
  if (integrityMatch && req.method === 'GET') {
    const integrity = workspaceIntegrity(db, integrityMatch[1]);
    return integrity ? sendJson(res, 200, integrity) : sendJson(res, 404, { error: 'workspace not found' });
  }

  const rootsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/roots$/);
  if (rootsMatch && req.method === 'GET') return sendJson(res, 200, workspaceRoots(db, rootsMatch[1]));
  if (rootsMatch && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const root = registerWorkspaceRoot(db, rootsMatch[1], {
        rootPath: body.path,
        rootKind: ['primary', 'repository', 'linked_folder', 'resources'].includes(body.root_kind) ? body.root_kind : 'linked_folder',
        label: String(body.label || '').slice(0, 120),
        requiredForFreshness: body.required_for_freshness !== false,
        indexingEnabled: body.indexing_enabled !== false,
        providerTransmissionAllowed: body.transmission_policy !== 'local_only'
      });
      markWorkspaceStale(db, rootsMatch[1], 'approved_root_added');
      refreshRootWatchers();
      return sendJson(res, 201, root);
    } catch (error) { return sendJson(res, 400, { ok: false, code: error.code || 'ROOT_REGISTRATION_FAILED', error: error.message }); }
  }

  const rootPolicyMatch = url.pathname.match(/^\/api\/workspace-roots\/([^/]+)\/policy$/);
  if (rootPolicyMatch && req.method === 'PUT') {
    const body = await readJson(req);
    const root = row(db, 'SELECT * FROM workspace_roots WHERE id=?', rootPolicyMatch[1]);
    if (!root) return sendJson(res, 404, { error: 'workspace root not found' });
    if (root.root_kind === 'provider_archive') return sendJson(res, 409, { ok: false, code: 'INTERNAL_SOURCE_POLICY_FIXED', error: 'captured-provider archive policy is managed by Harness security' });
    run(db, `UPDATE workspace_roots SET required_for_freshness=?,indexing_enabled=?,provider_transmission_allowed=?,status='unknown',updated_at=? WHERE id=?`,
      body.required_for_freshness === false ? 0 : 1, body.indexing_enabled === false ? 0 : 1, body.transmission_policy === 'local_only' ? 0 : 1, new Date().toISOString(), root.id);
    markWorkspaceStale(db, root.workspace_id, 'root_policy_changed');
    refreshRootWatchers();
    return sendJson(res, 200, row(db, 'SELECT * FROM workspace_roots WHERE id=?', root.id));
  }

  const openRootMatch = url.pathname.match(/^\/api\/workspace-roots\/([^/]+)\/open$/);
  if (openRootMatch && req.method === 'POST') {
    const root = row(db, 'SELECT * FROM workspace_roots WHERE id=?', openRootMatch[1]);
    if (!root) return sendJson(res, 404, { ok: false, code: 'ROOT_NOT_FOUND' });
    if (root.root_kind === 'provider_archive') return sendJson(res, 409, { ok: false, code: 'INTERNAL_SOURCE_NOT_OPENABLE' });
    try {
      const verified = fs.realpathSync.native(root.root_path);
      if (path.resolve(verified) !== path.resolve(root.canonical_path)) return sendJson(res, 409, { ok: false, code: 'ROOT_IDENTITY_CHANGED' });
      const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(opener, [verified], { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
      child.unref();
      return sendJson(res, 200, { ok: true, root_id: root.id });
    } catch (error) { return sendJson(res, 409, { ok: false, code: 'ROOT_OPEN_FAILED', error: error.message }); }
  }

  const removeRootMatch = url.pathname.match(/^\/api\/workspace-roots\/([^/]+)$/);
  if (removeRootMatch && req.method === 'DELETE') {
    const root = row(db, 'SELECT * FROM workspace_roots WHERE id=?', removeRootMatch[1]);
    if (!root) return sendJson(res, 404, { ok: false, code: 'ROOT_NOT_FOUND' });
    if (root.root_kind === 'primary' || root.root_kind === 'provider_archive') return sendJson(res, 409, { ok: false, code: root.root_kind === 'primary' ? 'PRIMARY_ROOT_REMOVAL_BLOCKED' : 'INTERNAL_SOURCE_REMOVAL_BLOCKED', error: 'this durable source cannot be removed from the root policy action' });
    run(db, 'DELETE FROM workspace_roots WHERE id=?', root.id);
    markWorkspaceStale(db, root.workspace_id, 'approved_root_removed');
    refreshRootWatchers();
    return sendJson(res, 200, { ok: true, root_id: root.id, archive_preserved: true });
  }

  const retryVerificationMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/retry-verification$/);
  if (retryVerificationMatch && req.method === 'POST') {
    try {
      const resources = reconcileWorkspaceResources(db, retryVerificationMatch[1]);
      markWorkspaceStale(db, retryVerificationMatch[1], 'manual_verification_completed_pending_native_chat_sync');
      return sendJson(res, resources.ok ? 200 : 412, { ok: resources.ok, freshness: 'stale', message: 'Source verification completed. The next managed native send will re-synchronize the provider chat and create a CURRENT snapshot.', resources });
    } catch (error) { return sendJson(res, 400, { ok: false, code: error.code || 'VERIFICATION_FAILED', error: error.message }); }
  }

  const launchAgentMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/roots\/([^/]+)\/open-agent$/);
  if (launchAgentMatch && req.method === 'POST') {
    try {
      const body = await readJson(req, 16 * 1024);
      return sendJson(res, 202, launchRegisteredAgent(db, { workspaceId: launchAgentMatch[1], rootId: launchAgentMatch[2], agent: body.agent }));
    } catch (error) { return sendJson(res, 409, { ok: false, code: error.code || 'AGENT_LAUNCH_FAILED', error: error.message }); }
  }

  const outgoingRunsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/outgoing-context$/);
  if (outgoingRunsMatch && req.method === 'GET') {
    return sendJson(res, 200, rows(db, `SELECT id,session_id,provider,snapshot_id,status,final_context_hash,estimated_tokens,security_status,failure_code,created_at,sent_at,metadata_json FROM outgoing_context_runs WHERE workspace_id=? ORDER BY created_at DESC LIMIT 50`, outgoingRunsMatch[1]));
  }

  const outgoingRunDetail = url.pathname.match(/^\/api\/outgoing-context\/([^/]+)$/);
  if (outgoingRunDetail && req.method === 'GET') {
    const contextRun = row(db, 'SELECT * FROM outgoing_context_runs WHERE id=?', outgoingRunDetail[1]);
    if (!contextRun) return sendJson(res, 404, { error: 'outgoing context run not found' });
    return sendJson(res, 200, { ...contextRun, metadata: JSON.parse(contextRun.metadata_json || '{}'), sources: rows(db, 'SELECT * FROM outgoing_context_sources WHERE run_id=? ORDER BY retrieval_score DESC', contextRun.id) });
  }

  const removeWorkspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/);
  if (removeWorkspaceMatch && req.method === 'DELETE') {
    const workspace = row(db, `SELECT * FROM workspaces WHERE id=? AND lifecycle_status='active'`, removeWorkspaceMatch[1]);
    if (!workspace) return sendJson(res, 404, { ok: false, code: 'WORKSPACE_NOT_FOUND' });
    const remaining = rows(db, `SELECT id FROM workspaces WHERE lifecycle_status='active' AND id!=? ORDER BY updated_at DESC`, workspace.id);
    if (!remaining.length) return sendJson(res, 409, { ok: false, code: 'LAST_WORKSPACE_REMOVAL_BLOCKED', error: 'Create or restore another Project Space before removing the last active one.' });
    const removedAt = new Date().toISOString();
    run(db, `UPDATE workspaces SET lifecycle_status='removed',freshness_status='stale',updated_at=? WHERE id=?`, removedAt, workspace.id);
    run(db, `UPDATE workspace_roots SET indexing_enabled=0,status='removed',updated_at=? WHERE workspace_id=?`, removedAt, workspace.id);
    const activeId = row(db, `SELECT value FROM settings WHERE key='active_workspace_id'`)?.value;
    if (activeId === workspace.id) run(db, `INSERT INTO settings (key,value) VALUES ('active_workspace_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, remaining[0].id);
    refreshRootWatchers();
    return sendJson(res, 200, { ok: true, workspace_id: workspace.id, tracking_removed: true, live_files_deleted: false, archive_preserved: true, next_workspace_id: remaining[0].id });
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
    if (error.message === 'request too large') return sendJson(res, 413, { error: 'request too large' });
    if (error instanceof SyntaxError) return sendJson(res, 400, { error: 'invalid JSON request' });
    sendJson(res, 500, { error: 'internal server error' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`AI Harness running at http://127.0.0.1:${port}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(watcherRecoveryTimer);
  for (const timer of indexingTimers.values()) clearTimeout(timer);
  for (const watcher of rootWatchers.values()) try { watcher.close(); } catch {}
  server.close(() => {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
  console.log(`AI Harness shutting down (${signal})`);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`AI Harness did not start: 127.0.0.1:${port} is already in use. Check /api/health before starting another copy.`);
  else console.error(error);
  process.exitCode = 1;
});
