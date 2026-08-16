import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, row, rows, run, storageForDatabase, ensureWorkspaceProjectRoot } from '../src/db.mjs';
import { archiveFile } from '../src/archive.mjs';

test('database migrates and seeds core prototype data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  assert.equal(row(db, 'SELECT COUNT(*) AS n FROM workspaces').n, 3);
  assert.ok(row(db, `SELECT value FROM settings WHERE key = 'active_workspace_id'`).value);
  assert.ok(rows(db, `SELECT * FROM provider_links WHERE provider = 'notebooklm'`).length >= 1);
  db.close();
});

test('provider-neutral memories can be added independently of sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const ts = new Date().toISOString();
  run(db, `INSERT INTO memories (id,workspace_id,scope,category,content,confidence,source_type,source_ref,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    'test-memory', 'ws-course', 'workspace', 'misconception', 'Confuses phase shift sign convention.', 0.9, 'session_extract', 'session-x', 'active', ts, ts);
  const memory = row(db, 'SELECT * FROM memories WHERE id = ?', 'test-memory');
  assert.equal(memory.category, 'misconception');
  assert.equal(memory.workspace_id, 'ws-course');
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
    workspaceId: 'ws-course',
    provider: 'local',
    artifactType: 'file',
    sourcePathOverride: `test-project-space:${dir}`,
    metadata: { added_via: 'project_space' }
  });
  assert.equal(artifact.workspace_id, 'ws-course');
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
  const projectRoot = ensureWorkspaceProjectRoot(db, 'ws-course');
  assert.ok(path.resolve(projectRoot).startsWith(path.resolve(storage.projectsDir)));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
