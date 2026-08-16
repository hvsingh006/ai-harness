import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appRoot, legacyDataDir, buildStoragePaths, resolveWorkspaceRoot, ensureStorageLayout, migrateLegacyData, safeFolderName } from './storage.mjs';

export const rootDir = appRoot;
const databaseStorage = new WeakMap();

export function storageForDatabase(db) {
  const storage = databaseStorage.get(db);
  if (!storage) throw new Error('Database storage paths are unavailable for this database handle.');
  return storage;
}

export function openDatabase(dbPath = null) {
  const explicitDbPath = dbPath ? path.resolve(dbPath) : null;
  const workspaceRoot = resolveWorkspaceRoot({ dbPath: explicitDbPath });
  const storage = ensureStorageLayout(buildStoragePaths(workspaceRoot));
  if (!explicitDbPath) migrateLegacyData(storage);
  const actualDbPath = explicitDbPath || storage.dbPath;
  const db = new DatabaseSync(actualDbPath);
  databaseStorage.set(db, { ...storage, dbPath: actualDbPath });
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  migrateStorageReferences(db, storage);
  seed(db);
  ensureWorkspaceProjectRoots(db);
  ensureHarnessProjectOverview(db);
  return db;
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function addColumn(db, table, definition) {
  const name = definition.trim().split(/\s+/)[0];
  if (!tableColumns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'general',
      description TEXT NOT NULL DEFAULT '',
      active_focus TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT 'slate',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_links (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'linked',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      title TEXT NOT NULL,
      native_url TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      capture_status TEXT NOT NULL DEFAULT 'captured',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS session_external_refs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      ref_type TEXT NOT NULL,
      ref_value TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'capture',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(provider, ref_type, ref_value)
    );

    CREATE TABLE IF NOT EXISTS companion_clients (
      client_id TEXT PRIMARY KEY,
      version TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK(scope IN ('global','workspace')),
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      source_type TEXT NOT NULL DEFAULT 'user_explicit',
      source_ref TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_files (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      local_path TEXT NOT NULL DEFAULT '',
      source_provider TEXT NOT NULL DEFAULT 'local',
      source_url TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL,
      title TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      mastery REAL NOT NULL DEFAULT 0,
      due_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS development_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL,
      title TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      source_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      decision TEXT NOT NULL,
      rationale TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS imports (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      import_type TEXT NOT NULL,
      source_path TEXT NOT NULL DEFAULT '',
      source_fingerprint TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      raw_file_count INTEGER NOT NULL DEFAULT 0,
      parsed_session_count INTEGER NOT NULL DEFAULT 0,
      parsed_message_count INTEGER NOT NULL DEFAULT 0,
      artifact_count INTEGER NOT NULL DEFAULT 0,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      provider_message_id TEXT NOT NULL DEFAULT '',
      parent_provider_message_id TEXT NOT NULL DEFAULT '',
      ordinal INTEGER NOT NULL,
      role TEXT NOT NULL,
      content_text TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL DEFAULT '{}',
      raw_json TEXT NOT NULL DEFAULT '{}',
      content_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT,
      UNIQUE(session_id, ordinal)
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      import_id TEXT REFERENCES imports(id) ON DELETE SET NULL,
      provider TEXT NOT NULL DEFAULT 'local',
      artifact_type TEXT NOT NULL DEFAULT 'file',
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL,
      vault_path TEXT NOT NULL,
      source_path TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      native_id TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(sha256, source_path)
    );

    CREATE TABLE IF NOT EXISTS capture_stages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, stage)
    );

    CREATE TABLE IF NOT EXISTS session_assets (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      asset_type TEXT NOT NULL DEFAULT 'file',
      name TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      native_id TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      mirror_status TEXT NOT NULL DEFAULT 'referenced',
      artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      task_type TEXT NOT NULL DEFAULT 'next_action',
      status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER NOT NULL DEFAULT 2,
      source_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_attempts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      learning_item_id TEXT REFERENCES learning_items(id) ON DELETE SET NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      prompt TEXT NOT NULL DEFAULT '',
      user_attempt TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT '',
      self_confidence REAL,
      demonstrated_mastery REAL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_workspace_started ON sessions(workspace_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_external_refs_session ON session_external_refs(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_external_refs_lookup ON session_external_refs(provider, ref_type, ref_value);
    CREATE INDEX IF NOT EXISTS idx_messages_session_ordinal ON messages(session_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_artifacts_workspace ON artifacts(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_sha ON artifacts(sha256);
    CREATE INDEX IF NOT EXISTS idx_session_assets_session ON session_assets(session_id, mirror_status);
    CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status ON workspace_tasks(workspace_id, status, priority);
    CREATE INDEX IF NOT EXISTS idx_workspace_files_workspace ON workspace_files(workspace_id, local_path);
  `);

  addColumn(db, 'workspaces', "root_path TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'workspaces', "path_mode TEXT NOT NULL DEFAULT 'managed'");
  addColumn(db, 'sessions', "external_id TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'sessions', "import_id TEXT REFERENCES imports(id) ON DELETE SET NULL");
  addColumn(db, 'sessions', "raw_complete INTEGER NOT NULL DEFAULT 0");
  addColumn(db, 'sessions', "attachments_complete INTEGER NOT NULL DEFAULT 0");
  addColumn(db, 'sessions', "derived_complete INTEGER NOT NULL DEFAULT 0");
  addColumn(db, 'sessions', "last_captured_at TEXT");
  addColumn(db, 'sessions', "display_label TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'workspace_files', "sha256 TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'workspace_files', "size_bytes INTEGER NOT NULL DEFAULT 0");
  addColumn(db, 'workspace_files', "relative_path TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'workspace_files', "modified_at TEXT");
  addColumn(db, 'workspace_files', "updated_at TEXT");
  addColumn(db, 'learning_items', "last_practiced_at TEXT");
  addColumn(db, 'learning_items', "next_review_at TEXT");
  addColumn(db, 'learning_items', "attempt_count INTEGER NOT NULL DEFAULT 0");

  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(message_id UNINDEXED, session_id UNINDEXED, workspace_id UNINDEXED, provider UNINDEXED, title, role, content);`);
  } catch {
    // FTS5 is optional. Search falls back to LIKE when unavailable.
  }
}


function copyFileIfNeeded(source, destination) {
  if (!source || !fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination)) fs.copyFileSync(source, destination);
  return fs.existsSync(destination);
}

function migrateStorageReferences(db, storage) {
  const legacyVault = path.join(legacyDataDir, 'vault');
  const artifacts = db.prepare('SELECT id,sha256,vault_path FROM artifacts').all();
  for (const artifact of artifacts) {
    if (!artifact.sha256) continue;
    const canonical = path.join(storage.vaultDir, 'blobs', artifact.sha256.slice(0, 2), artifact.sha256);
    const oldPath = artifact.vault_path || '';
    if (!fs.existsSync(canonical)) {
      const legacyCandidate = path.join(legacyVault, 'blobs', artifact.sha256.slice(0, 2), artifact.sha256);
      copyFileIfNeeded(oldPath, canonical) || copyFileIfNeeded(legacyCandidate, canonical);
    }
    if (fs.existsSync(canonical) && path.resolve(oldPath || canonical) !== path.resolve(canonical)) {
      db.prepare('UPDATE artifacts SET vault_path=? WHERE id=?').run(canonical, artifact.id);
    }
  }
}

function uniqueManagedProjectPath(db, storage, workspaceId, name) {
  const base = safeFolderName(name, 'Project');
  const existing = db.prepare(`SELECT root_path FROM workspaces WHERE id != ? AND root_path != ''`).all(workspaceId)
    .map(item => path.resolve(item.root_path));
  let candidate = path.join(storage.projectsDir, base);
  let suffix = 2;
  while (existing.includes(path.resolve(candidate)) || (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory())) {
    candidate = path.join(storage.projectsDir, `${base} (${suffix++})`);
  }
  return candidate;
}

export function ensureWorkspaceProjectRoot(db, workspaceId) {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId);
  if (!workspace) return null;
  const storage = storageForDatabase(db);
  let rootPath = String(workspace.root_path || '').trim();
  if (!rootPath) {
    rootPath = uniqueManagedProjectPath(db, storage, workspaceId, workspace.name);
    db.prepare(`UPDATE workspaces SET root_path=?,path_mode=COALESCE(NULLIF(path_mode,''),'managed') WHERE id=?`).run(rootPath, workspaceId);
  }
  fs.mkdirSync(rootPath, { recursive: true });
  return rootPath;
}

export function ensureWorkspaceProjectRoots(db) {
  for (const workspace of db.prepare('SELECT id FROM workspaces').all()) ensureWorkspaceProjectRoot(db, workspace.id);
}

export function attachWorkspaceFolder(db, workspaceId, folderPath) {
  const target = path.resolve(String(folderPath || '').trim());
  if (!target) throw new Error('folder path required');
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`folder not found: ${target}`);
  const storage = storageForDatabase(db);
  const appRel = path.relative(appRoot, target);
  if (appRel === '' || (!appRel.startsWith('..') && !path.isAbsolute(appRel))) throw new Error('A project folder cannot be inside the AI Harness application checkout.');
  const workspaceRootRel = path.relative(storage.workspaceRoot, target);
  // Existing folders may live outside the managed workspace root. That is intentional.
  db.prepare(`UPDATE workspaces SET root_path=?,path_mode='attached',updated_at=? WHERE id=?`).run(target, new Date().toISOString(), workspaceId);
  return db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId);
}

function ensureHarnessProjectOverview(db) {
  const workspace = db.prepare("SELECT id FROM workspaces WHERE id='ws-harness'").get();
  if (!workspace) return;
  const rootPath = ensureWorkspaceProjectRoot(db, 'ws-harness');
  const overviewPath = path.join(rootPath, 'AI_HARNESS_PROJECT.md');
  if (!fs.existsSync(overviewPath)) {
    fs.writeFileSync(overviewPath, `# AI Harness Project

## Goal
Create a simple Project Space that lets the user work in native ChatGPT and Gemini without losing context when starting a new chat or switching between the two services.

## Core functionality
- Separate Project Spaces with their own files and retained chat history.
- Open native ChatGPT and Gemini from the selected project.
- Capture and retain chats with stable provider chat IDs and native URLs.
- Reopen archived native chats and bring prior chat context into a new prompt.
- Search retained raw chat history across ChatGPT and Gemini within a project.
- Keep project files, PDFs, images, and folders available independently of individual chats.
- Preserve original source material; summaries and compact context are derived views only.
- Scale context progressively when the complete project history is too large for one prompt.
- Support light, dark, and system appearance.

## Product boundaries
- The Harness is not a replacement chat UI. ChatGPT and Gemini remain the working interfaces.
- Learning and development are important use cases, not separate project modes.
- The first UI stays deliberately simple and can expand later.
- AI should improve productivity and understanding without replacing the user's critical thinking or judgment.

## Current priority
Make continuity reliable: a fresh ChatGPT or Gemini chat should know the relevant project context and prior work without forcing the user to reconstruct it manually.
`, 'utf8');
  }
}

function now() {
  return new Date().toISOString();
}

function seed(db) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM workspaces').get().count;
  if (count === 0) {
    const ts = now();
    const insertWorkspace = db.prepare(`
      INSERT INTO workspaces (id, name, kind, description, active_focus, color, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertWorkspace.run('ws-harness', 'AI Harness', 'general', 'The AI Harness project itself.', 'Keep project context, files, and chat history continuous across new ChatGPT and Gemini chats.', 'slate', ts, ts);

    const insertMemory = db.prepare(`
      INSERT INTO memories (id, workspace_id, scope, category, content, confidence, source_type, source_ref, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `);
    insertMemory.run('mem-product-goal', null, 'global', 'product_goal', 'Use AI to become more productive and learn more without replacing critical thinking.', 1, 'user_explicit', 'product-definition', ts, ts);
    insertMemory.run('mem-continuity', null, 'global', 'continuity_requirement', 'A fresh chat or provider switch should inherit the same useful context, while the harness retains the complete source archive.', 1, 'user_explicit', 'product-definition', ts, ts);
    insertMemory.run('mem-full-archive', null, 'global', 'retention_requirement', 'Preserve all capturable ChatGPT/Gemini chat history, files, PDFs, images, and raw source data. Derived summaries never replace originals.', 1, 'user_explicit', 'product-definition', ts, ts);
    insertMemory.run('mem-native-ui', null, 'global', 'native_ui_requirement', 'Use native ChatGPT and Gemini interfaces rather than a replacement chat UI.', 1, 'user_explicit', 'product-definition', ts, ts);
  }

  const ts = now();

  const cleaned = db.prepare(`SELECT value FROM settings WHERE key='prototype_cleanup_v2'`).get();
  if (!cleaned) {
    // Remove only the fixed synthetic records created by prototype 0.1. Never pattern-delete user data.
    db.exec(`
      DELETE FROM sessions WHERE id IN ('session-1','session-2','session-3') AND native_url='' AND external_id='';
      DELETE FROM learning_items WHERE id IN ('learn-1','learn-2','learn-3');
      DELETE FROM development_items WHERE id IN ('dev-1','dev-2');
    `);
    db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('prototype_cleanup_v2','done')`).run();
  }

  const workspaceExists = db.prepare('SELECT id FROM workspaces WHERE id = ?').get('ws-harness');
  if (!workspaceExists) {
    db.prepare(`INSERT INTO workspaces (id,name,kind,description,active_focus,color,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).run(
      'ws-harness', 'AI Harness', 'general', 'The AI Harness project itself.', 'Keep project context, files, and chat history continuous across new ChatGPT and Gemini chats.', 'slate', ts, ts
    );
  }

  const ensureMemory = db.prepare(`INSERT OR IGNORE INTO memories (id,workspace_id,scope,category,content,confidence,source_type,source_ref,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  ensureMemory.run('mem-product-goal', null, 'global', 'product_goal', 'Use AI to become more productive and learn more without replacing critical thinking.', 1, 'user_explicit', 'product-definition', 'active', ts, ts);
  ensureMemory.run('mem-continuity', null, 'global', 'continuity_requirement', 'New chats and provider switches should continue from prior work without forcing restatement.', 1, 'user_explicit', 'product-definition', 'active', ts, ts);
  ensureMemory.run('mem-full-archive', null, 'global', 'retention_requirement', 'Preserve all capturable ChatGPT/Gemini chat history, files, PDFs, images, and raw source data. Derived summaries never replace originals.', 1, 'user_explicit', 'product-definition', 'active', ts, ts);
  ensureMemory.run('mem-native-ui', null, 'global', 'native_ui_requirement', 'Keep ChatGPT and Gemini as the native working surfaces.', 1, 'user_explicit', 'product-definition', 'active', ts, ts);
  ensureMemory.run('mem-resource-use', null, 'global', 'resource_use_requirement', 'AI sessions should actively use relevant prior user prompts, prior ChatGPT/Gemini responses, full archive search, files, PDFs, images, native tools, and current web information when useful. Summaries do not replace source material.', 1, 'user_explicit', 'product-definition', 'active', ts, ts);
  ensureMemory.run('mem-progressive-context', null, 'global', 'context_scaling_requirement', 'When the workspace corpus is too large for one model context window, preserve the complete archive and retrieve progressively relevant subsets with provenance instead of ignoring older material or dumping everything into one prompt.', 1, 'user_explicit', 'product-definition', 'active', ts, ts);
  ensureMemory.run('mem-chat-labels', null, 'global', 'traceability_requirement', 'Native chats should show a stable harness label tied to provider chat identifiers so archived chats can be reopened, traced to a workspace, and brought back into later prompts.', 1, 'user_explicit', 'product-definition', 'active', ts, ts);
  ensureMemory.run('mem-project-space', null, 'global', 'project_space_requirement', 'Each workspace is also a project space: users can drag or add documents, PDFs, images, datasets, code artifacts, and folders once so those resources persist independently of any individual AI chat.', 1, 'user_explicit', 'product-definition', 'active', ts, ts);

  const links = [
    ['link-gpt-harness', 'ws-harness', 'chatgpt', 'ChatGPT', 'https://chatgpt.com/'],
    ['link-gem-harness', 'ws-harness', 'gemini', 'Gemini', 'https://gemini.google.com/']
  ];
  const insertLink = db.prepare(`INSERT OR IGNORE INTO provider_links (id,workspace_id,provider,label,url,status,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,'linked','{}',?,?)`);
  for (const link of links) insertLink.run(...link, ts, ts);

  const tasks = [
    ['task-continuity', 'Make chat continuity reliable', 'A new ChatGPT/Gemini chat should continue the same Project Space without manual reconstruction.', 1],
    ['task-history', 'Retain complete chat history', 'Preserve raw ChatGPT and Gemini conversations and make them searchable/reopenable from the project.', 1],
    ['task-files', 'Keep project files available', 'Project files should remain attached to the Project Space across chats and provider switches.', 1]
  ];
  const insertTask = db.prepare(`INSERT OR IGNORE INTO workspace_tasks (id,workspace_id,title,details,task_type,status,priority,source_ref,created_at,updated_at) VALUES (?,?,?,?,'next_action','open',?,'product-definition',?,?)`);
  for (const [id,title,details,priority] of tasks) insertTask.run(id, 'ws-harness', title, details, priority, ts, ts);

  
  const simpleUiCleanup = db.prepare(`SELECT value FROM settings WHERE key='simple_ui_cleanup_v1'`).get();
  if (!simpleUiCleanup) {
    for (const id of ['ws-course','ws-dev']) {
      const counts = {
        sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE workspace_id=?').get(id)?.n || 0,
        files: db.prepare('SELECT COUNT(*) AS n FROM workspace_files WHERE workspace_id=?').get(id)?.n || 0,
        memories: db.prepare('SELECT COUNT(*) AS n FROM memories WHERE workspace_id=?').get(id)?.n || 0
      };
      if (counts.sessions === 0 && counts.files === 0 && counts.memories === 0) db.prepare('DELETE FROM workspaces WHERE id=?').run(id);
    }
    db.prepare(`DELETE FROM provider_links WHERE provider='notebooklm'`).run();
    db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('simple_ui_cleanup_v1','done')`).run();
  }

db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'system')`).run();
  const activeSetting = db.prepare(`SELECT value FROM settings WHERE key='active_workspace_id'`).get();
  if (!activeSetting || ['ws-course','ws-dev'].includes(activeSetting.value)) {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('active_workspace_id', 'ws-harness')`).run();
  }

  for (const session of db.prepare(`SELECT s.id,s.display_label,w.name AS workspace_name FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.display_label=''`).all()) {
    const short = String(session.id).replace(/^session-/, '').slice(0, 8);
    db.prepare('UPDATE sessions SET display_label=? WHERE id=?').run(`AIH · ${session.workspace_name} · ${short}`, session.id);
  }
}

export function upsertSessionExternalRef(db, { sessionId, provider, refType, refValue, source = 'capture' }) {
  const value = String(refValue || '').trim();
  if (!sessionId || !provider || !refType || !value) return null;
  const ts = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM session_external_refs WHERE provider=? AND ref_type=? AND ref_value=?').get(provider, refType, value);
  if (existing) {
    db.prepare('UPDATE session_external_refs SET last_seen_at=?, source=? WHERE id=?').run(ts, source || existing.source, existing.id);
    return db.prepare('SELECT * FROM session_external_refs WHERE id=?').get(existing.id);
  }
  const id = `ref-${crypto.randomUUID()}`;
  db.prepare(`INSERT INTO session_external_refs (id,session_id,provider,ref_type,ref_value,source,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, sessionId, provider, refType, value, source, ts, ts);
  return db.prepare('SELECT * FROM session_external_refs WHERE id=?').get(id);
}

export function rows(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function row(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}
