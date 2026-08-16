import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, row, rows, run, storageForDatabase, ensureWorkspaceProjectRoot } from '../src/db.mjs';
import { archiveFile } from '../src/archive.mjs';

test('database migrates and seeds core prototype data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  assert.equal(row(db, 'SELECT COUNT(*) AS n FROM workspaces').n, 1);
  assert.ok(row(db, `SELECT value FROM settings WHERE key = 'active_workspace_id'`).value);
  assert.equal(rows(db, `SELECT * FROM provider_links WHERE provider = 'notebooklm'`).length, 0);
  const harnessRoot = ensureWorkspaceProjectRoot(db, 'ws-harness');
  assert.equal(fs.existsSync(harnessRoot), true);
  db.close();
});

test('provider-neutral memories can be added independently of sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const ts = new Date().toISOString();
  run(db, `INSERT INTO memories (id,workspace_id,scope,category,content,confidence,source_type,source_ref,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    'test-memory', 'ws-harness', 'workspace', 'misconception', 'Confuses phase shift sign convention.', 0.9, 'session_extract', 'session-x', 'active', ts, ts);
  const memory = row(db, 'SELECT * FROM memories WHERE id = ?', 'test-memory');
  assert.equal(memory.category, 'misconception');
  assert.equal(memory.workspace_id, 'ws-harness');
  db.close();
});

import { importChatGPTExport } from '../src/importers.mjs';

test('ChatGPT export import preserves raw files and parses messages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-export-'));
  const exportDir = path.join(dir, 'export');
  fs.mkdirSync(exportDir);
  const conversations = [{
    id: 'conv-1',
    title: 'Test learning chat',
    create_time: 1700000000,
    update_time: 1700000060,
    mapping: {
      a: { parent: null, message: { id: 'm1', create_time: 1700000001, author: { role: 'user' }, content: { parts: ['Explain setup time'] } } },
      b: { parent: 'a', message: { id: 'm2', create_time: 1700000002, author: { role: 'assistant' }, content: { parts: ['Setup time is...'] } } }
    }
  }];
  fs.writeFileSync(path.join(exportDir, 'conversations.json'), JSON.stringify(conversations));
  fs.writeFileSync(path.join(exportDir, 'lecture.pdf'), Buffer.from('%PDF-test'));

  const db = openDatabase(path.join(dir, 'test.db'));
  const result = importChatGPTExport(db, { directory: exportDir, workspaceId: 'ws-harness' });
  assert.equal(result.status, 'complete');
  assert.equal(row(db, `SELECT COUNT(*) AS n FROM messages`).n, 2);
  assert.equal(row(db, `SELECT COUNT(*) AS n FROM artifacts`).n, 2);
  const session = row(db, `SELECT * FROM sessions WHERE external_id='conv-1'`);
  assert.equal(session.message_count, 2);
  assert.equal(session.capture_status, 'captured_incomplete');
  const ref = row(db, `SELECT * FROM session_external_refs WHERE session_id=? AND ref_type='chat_id'`, session.id);
  assert.equal(ref.ref_value, 'conv-1');
  assert.ok(session.display_label.startsWith('AIH ·'));
  db.close();
});

test('archive schema keeps complete source and derived state separate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-archive-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const tables = rows(db, `SELECT name FROM sqlite_master WHERE type='table'`).map(r => r.name);
  assert.ok(tables.includes('messages'));
  assert.ok(tables.includes('artifacts'));
  assert.ok(tables.includes('imports'));
  assert.ok(tables.includes('capture_stages'));
  assert.ok(tables.includes('learning_attempts'));
  assert.ok(tables.includes('workspace_tasks'));
  db.close();
});


test('chat identity schema preserves provider references separately from sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-identity-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const tables = rows(db, `SELECT name FROM sqlite_master WHERE type='table'`).map(r => r.name);
  assert.ok(tables.includes('session_external_refs'));
  assert.ok(tables.includes('companion_clients'));
  const columns = rows(db, `PRAGMA table_info(sessions)`).map(r => r.name);
  assert.ok(columns.includes('display_label'));
  db.close();
});


test('project resources are vaulted and associated with the workspace independently of sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-project-space-'));
  const source = path.join(dir, 'lecture-notes.txt');
  fs.writeFileSync(source, 'timing analysis notes');
  const db = openDatabase(path.join(dir, 'test.db'));
  const artifact = archiveFile(db, {
    filePath: source,
    workspaceId: 'ws-harness',
    provider: 'local',
    artifactType: 'file',
    sourcePathOverride: `test-project-space:${dir}`,
    metadata: { added_via: 'project_space' }
  });
  assert.equal(artifact.workspace_id, 'ws-harness');
  assert.equal(artifact.session_id, null);
  assert.ok(fs.existsSync(artifact.vault_path));
  assert.equal(fs.readFileSync(artifact.vault_path, 'utf8'), 'timing analysis notes');
  try { fs.unlinkSync(artifact.vault_path); } catch {}
  db.close();
});


test('persistent workspace storage stays outside application code and owns project folders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-storage-'));
  const dbPath = path.join(dir, 'harness.db');
  const db = openDatabase(dbPath);
  const storage = storageForDatabase(db);
  assert.equal(path.resolve(storage.workspaceRoot), path.resolve(dir));
  assert.equal(path.resolve(storage.dbPath), path.resolve(dbPath));
  assert.ok(fs.existsSync(storage.projectsDir));
  assert.ok(fs.existsSync(storage.archiveDir));
  assert.ok(fs.existsSync(storage.backupsDir));
  const projectRoot = ensureWorkspaceProjectRoot(db, 'ws-harness');
  assert.ok(path.resolve(projectRoot).startsWith(path.resolve(storage.projectsDir)));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('additive migration preserves an older 0.7-style workspace, session, and artifact while adding integrity tables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-old-db-'));
  const dbPath = path.join(dir, 'harness.db');
  const oldVault = path.join(dir, 'old-artifact.txt');
  fs.writeFileSync(oldVault, 'preserved artifact');
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'general',description TEXT NOT NULL DEFAULT '',active_focus TEXT NOT NULL DEFAULT '',color TEXT NOT NULL DEFAULT 'slate',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,root_path TEXT NOT NULL DEFAULT '',path_mode TEXT NOT NULL DEFAULT 'managed');
    CREATE TABLE sessions (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,provider TEXT NOT NULL,title TEXT NOT NULL,native_url TEXT NOT NULL DEFAULT '',summary TEXT NOT NULL DEFAULT '',capture_status TEXT NOT NULL DEFAULT 'captured',started_at TEXT NOT NULL,ended_at TEXT,message_count INTEGER NOT NULL DEFAULT 0,external_id TEXT NOT NULL DEFAULT '',import_id TEXT,raw_complete INTEGER NOT NULL DEFAULT 0,attachments_complete INTEGER NOT NULL DEFAULT 0,derived_complete INTEGER NOT NULL DEFAULT 0,last_captured_at TEXT,display_label TEXT NOT NULL DEFAULT '');
    CREATE TABLE artifacts (id TEXT PRIMARY KEY,workspace_id TEXT,session_id TEXT,import_id TEXT,provider TEXT NOT NULL DEFAULT 'local',artifact_type TEXT NOT NULL DEFAULT 'file',name TEXT NOT NULL,mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',size_bytes INTEGER NOT NULL DEFAULT 0,sha256 TEXT NOT NULL,vault_path TEXT NOT NULL,source_path TEXT NOT NULL DEFAULT '',source_url TEXT NOT NULL DEFAULT '',native_id TEXT NOT NULL DEFAULT '',metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,UNIQUE(sha256,source_path));
  `);
  const ts = new Date().toISOString();
  old.prepare(`INSERT INTO workspaces VALUES (?,?,?,?,?,?,?,?,?,?)`).run('ws-old', 'Old project', 'general', 'preserve', 'continue', 'slate', ts, ts, path.join(dir, 'Projects', 'Old project'), 'managed');
  old.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('session-old', 'ws-old', 'chatgpt', 'Old chat', '', '', 'captured_incomplete', ts, null, 1, 'old-chat-id', null, 1, 1, 0, ts, 'AIH old');
  old.prepare(`INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('artifact-old', 'ws-old', 'session-old', null, 'chatgpt', 'file', 'old-artifact.txt', 'text/plain', 18, 'b5d450bc7fc6d53b975740d4d7d0d5d96a49a354c8fef8386d4b6c39bd40a0b6', oldVault, 'old-source', '', '', '{}', ts);
  old.close();

  const db = openDatabase(dbPath);
  assert.equal(row(db, `SELECT name FROM workspaces WHERE id='ws-old'`).name, 'Old project');
  assert.equal(row(db, `SELECT title FROM sessions WHERE id='session-old'`).title, 'Old chat');
  assert.equal(row(db, `SELECT name FROM artifacts WHERE id='artifact-old'`).name, 'old-artifact.txt');
  const tables = new Set(rows(db, `SELECT name FROM sqlite_master WHERE type IN ('table','view')`).map(item => item.name));
  for (const name of ['workspace_roots','workspace_resources','resource_versions','resource_chunks','project_snapshots','outgoing_context_runs','outgoing_context_sources','companion_pairings']) assert.ok(tables.has(name), name);
  assert.ok(row(db, `SELECT id FROM workspace_roots WHERE workspace_id='ws-old'`));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
