import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { openDatabase, ensureWorkspaceProjectRoot, row, rows, run, registerWorkspaceRoot, storageForDatabase } from '../src/db.mjs';
import { reconcileWorkspaceResources, currentWorkspaceResources } from '../src/resources.mjs';
import { inspectRepositoryRoot, refreshWorkspaceRepositories } from '../src/repository.mjs';
import { migrateManagedWorkspaceProject } from '../src/workspace-migration.mjs';
import { classifyResource, extractFile } from '../src/resource-extractors.mjs';

function fixture(t, prefix = 'aih-resources-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = openDatabase(path.join(dir, 'harness.db'));
  const root = ensureWorkspaceProjectRoot(db, 'ws-harness');
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, root };
}

test('resource reconciliation creates one immutable version, avoids duplicates, and advances current version after modification', t => {
  const { db, root } = fixture(t);
  const file = path.join(root, 'requirements.md');
  fs.writeFileSync(file, 'Use architecture A\n');
  const first = reconcileWorkspaceResources(db, 'ws-harness');
  assert.equal(first.ok, true);
  assert.equal(first.changed_count, 1);
  const resource = row(db, `SELECT * FROM workspace_resources WHERE relative_path='requirements.md'`);
  const version1 = row(db, 'SELECT * FROM resource_versions WHERE id=?', resource.current_version_id);
  assert.ok(fs.existsSync(row(db, 'SELECT vault_path FROM artifacts WHERE id=?', version1.archive_artifact_id).vault_path));

  const unchanged = reconcileWorkspaceResources(db, 'ws-harness');
  assert.equal(unchanged.changed_count, 0);
  assert.equal(row(db, 'SELECT COUNT(*) AS n FROM resource_versions WHERE resource_id=?', resource.id).n, 1);

  fs.writeFileSync(file, 'Use architecture C\n');
  const changed = reconcileWorkspaceResources(db, 'ws-harness');
  assert.equal(changed.changed_count, 1);
  const current = row(db, 'SELECT * FROM workspace_resources WHERE id=?', resource.id);
  assert.notEqual(current.current_version_id, version1.id);
  assert.equal(row(db, 'SELECT COUNT(*) AS n FROM resource_versions WHERE resource_id=?', resource.id).n, 2);
  assert.equal(row(db, 'SELECT * FROM resource_versions WHERE id=?', version1.id).sha256, version1.sha256);
  const chunks = rows(db, 'SELECT content FROM resource_chunks WHERE resource_version_id=?', current.current_version_id);
  assert.equal(chunks.some(chunk => chunk.content.includes('architecture C')), true);

  fs.writeFileSync(file, 'Use architecture A\n');
  const reverted = reconcileWorkspaceResources(db, 'ws-harness');
  assert.equal(reverted.changed_count, 1);
  assert.equal(row(db, 'SELECT current_version_id FROM workspace_resources WHERE id=?', resource.id).current_version_id, version1.id);
  assert.equal(row(db, 'SELECT COUNT(*) AS n FROM resource_versions WHERE resource_id=?', resource.id).n, 2);
});

test('resource reconciliation discovers new files and preserves deleted resources as historical identities', t => {
  const { db, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'one.txt'), 'one');
  reconcileWorkspaceResources(db, 'ws-harness');
  fs.writeFileSync(path.join(root, 'two.txt'), 'two');
  const added = reconcileWorkspaceResources(db, 'ws-harness');
  assert.equal(added.changed_count, 1);
  assert.ok(row(db, `SELECT id FROM workspace_resources WHERE relative_path='two.txt' AND status='active'`));
  fs.unlinkSync(path.join(root, 'one.txt'));
  const removed = reconcileWorkspaceResources(db, 'ws-harness');
  assert.equal(removed.deleted_count, 1);
  assert.equal(row(db, `SELECT status FROM workspace_resources WHERE relative_path='one.txt'`).status, 'deleted');
  assert.equal(row(db, `SELECT COUNT(*) AS n FROM resource_versions v JOIN workspace_resources r ON r.id=v.resource_id WHERE r.relative_path='one.txt'`).n, 1);
});

test('linked roots require explicit registration and local-only roots never become transmissible', t => {
  const { db } = fixture(t);
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-linked-'));
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  fs.writeFileSync(path.join(linked, 'reference.md'), 'linked evidence');
  assert.equal(rows(db, `SELECT * FROM workspace_resources WHERE relative_path='reference.md'`).length, 0);
  registerWorkspaceRoot(db, 'ws-harness', { rootPath: linked, rootKind: 'linked_folder', providerTransmissionAllowed: false });
  reconcileWorkspaceResources(db, 'ws-harness');
  const resource = row(db, `SELECT * FROM workspace_resources WHERE relative_path='reference.md'`);
  assert.ok(resource);
  assert.equal(resource.provider_transmission_allowed, 0);
  assert.equal(currentWorkspaceResources(db, 'ws-harness', { transmissionOnly: true }).some(item => item.id === resource.id), false);
});

test('repository service captures branch, HEAD, dirty/staged/unstaged/untracked paths and excludes .git internals', t => {
  const { db } = fixture(t, 'aih-repo-');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-linked-repo-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'AI Harness Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# current\n');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', ['-C', repo, 'commit', '-m', 'initial']);
  fs.appendFileSync(path.join(repo, 'README.md'), 'dirty\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new');
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged');
  execFileSync('git', ['-C', repo, 'add', 'staged.txt']);
  const state = inspectRepositoryRoot(repo);
  assert.equal(state.branch, 'main');
  assert.equal(state.head.length, 40);
  assert.equal(state.dirty, true);
  assert.ok(state.unstaged.includes('README.md'));
  assert.ok(state.staged.includes('staged.txt'));
  assert.ok(state.untracked.includes('untracked.txt'));
  assert.equal(state.repository_tree.some(item => item.startsWith('.git/')), false);

  registerWorkspaceRoot(db, 'ws-harness', { rootPath: repo, rootKind: 'repository' });
  const refreshed = refreshWorkspaceRepositories(db, 'ws-harness');
  assert.equal(refreshed.ok, true);
  assert.ok(refreshed.states.some(item => item.head === state.head));
});

test('managed-project migration copies and verifies into the live projects root while retaining the source', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-migration-'));
  const privateRoot = path.join(base, 'private');
  const projectsRoot = path.join(base, 'live-projects');
  const previous = process.env.HARNESS_PROJECTS_ROOT;
  process.env.HARNESS_PROJECTS_ROOT = projectsRoot;
  const db = openDatabase(path.join(privateRoot, 'harness.db'));
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.HARNESS_PROJECTS_ROOT; else process.env.HARNESS_PROJECTS_ROOT = previous;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const storage = storageForDatabase(db);
  const legacy = path.join(storage.legacyProjectsDir, 'Legacy Project');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'requirements.md'), 'retain me');
  run(db, 'DELETE FROM workspace_roots WHERE workspace_id=?', 'ws-harness');
  run(db, `UPDATE workspaces SET root_path=?,path_mode='managed' WHERE id=?`, legacy, 'ws-harness');

  const result = migrateManagedWorkspaceProject(db, 'ws-harness');
  assert.equal(result.migrated, true);
  assert.equal(fs.existsSync(legacy), true);
  assert.equal(fs.readFileSync(path.join(result.target, 'requirements.md'), 'utf8'), 'retain me');
  assert.equal(row(db, 'SELECT root_path FROM workspaces WHERE id=?', 'ws-harness').root_path, result.target);
  assert.equal(row(db, 'SELECT status FROM migration_records WHERE id=?', result.migration_id).status, 'complete');
});

test('managed-project migration never overwrites a conflicting target and attached folders are not migrated', t => {
  const { dir, db, root } = fixture(t, 'aih-migration-conflict-');
  const attached = path.join(dir, 'external');
  fs.mkdirSync(attached);
  run(db, `UPDATE workspaces SET root_path=?,path_mode='attached' WHERE id='ws-harness'`, attached);
  assert.equal(migrateManagedWorkspaceProject(db, 'ws-harness').status, 'not_legacy_managed');
  assert.equal(fs.existsSync(root), true);
});

test('managed-project migration reports a target conflict without overwriting either tree', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-migration-target-conflict-'));
  const privateRoot = path.join(base, 'private');
  const projectsRoot = path.join(base, 'live');
  const previous = process.env.HARNESS_PROJECTS_ROOT;
  process.env.HARNESS_PROJECTS_ROOT = projectsRoot;
  const db = openDatabase(path.join(privateRoot, 'harness.db'));
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.HARNESS_PROJECTS_ROOT; else process.env.HARNESS_PROJECTS_ROOT = previous;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const storage = storageForDatabase(db);
  const legacy = path.join(storage.legacyProjectsDir, 'Conflict Project');
  const target = path.join(projectsRoot, 'Conflict Project');
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'source.txt'), 'source survives');
  fs.writeFileSync(path.join(target, 'target.txt'), 'target survives');
  run(db, 'DELETE FROM workspace_roots WHERE workspace_id=?', 'ws-harness');
  run(db, `UPDATE workspaces SET root_path=?,path_mode='managed' WHERE id='ws-harness'`, legacy);
  const result = migrateManagedWorkspaceProject(db, 'ws-harness');
  assert.equal(result.status, 'conflict');
  assert.equal(fs.readFileSync(path.join(legacy, 'source.txt'), 'utf8'), 'source survives');
  assert.equal(fs.readFileSync(path.join(target, 'target.txt'), 'utf8'), 'target survives');
  assert.equal(fs.existsSync(path.join(target, 'source.txt')), false);
});

test('unchanged failed PDF versions are retried after the extractor becomes available without re-adding the file', t => {
  const available = spawnSync('pdftotext', ['-v'], { windowsHide: true });
  if (available.error) { t.skip('pdftotext is not installed in this test environment'); return; }
  const { db, root, dir } = fixture(t);
  const pdf = path.join(root, 'retry.pdf');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '5 0 obj\n<< /Length 55 >>\nstream\nBT /F1 12 Tf 72 720 Td (extracted retried pdf) Tj ET\nendstream\nendobj\n'
  ];
  let pdfText = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) { offsets.push(Buffer.byteLength(pdfText)); pdfText += object; }
  const xref = Buffer.byteLength(pdfText);
  pdfText += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(pdf, pdfText);
  const originalPath = process.env.PATH;
  const emptyTools = path.join(dir, 'empty-tools');
  fs.mkdirSync(emptyTools);
  try {
    process.env.PATH = emptyTools;
    const first = reconcileWorkspaceResources(db, 'ws-harness');
    assert.equal(first.ok, false);
    assert.equal(row(db, `SELECT indexing_status FROM resource_versions v JOIN workspace_resources r ON r.current_version_id=v.id WHERE r.relative_path='retry.pdf'`).indexing_status, 'failed');
    process.env.PATH = originalPath;
    const retried = reconcileWorkspaceResources(db, 'ws-harness');
    assert.equal(retried.ok, true, JSON.stringify(retried.reasons));
    assert.equal(row(db, `SELECT indexing_status FROM resource_versions v JOIN workspace_resources r ON r.current_version_id=v.id WHERE r.relative_path='retry.pdf'`).indexing_status, 'complete');
    assert.equal(row(db, `SELECT COUNT(*) AS n FROM resource_versions v JOIN workspace_resources r ON r.id=v.resource_id WHERE r.relative_path='retry.pdf'`).n, 1);
  } finally { process.env.PATH = originalPath; }
});

test('Office formats are explicit immutable attachment-only resources instead of silently pretending extraction', t => {
  const { db, root } = fixture(t);
  const office = path.join(root, 'design.docx');
  fs.writeFileSync(office, Buffer.from('synthetic office binary'));
  const classification = classifyResource(office);
  assert.equal(classification.resourceType, 'office');
  assert.equal(classification.attachmentOnly, true);
  assert.equal(extractFile(office).status, 'not_extractable');
  const result = reconcileWorkspaceResources(db, 'ws-harness');
  assert.equal(result.ok, true);
  const resource = row(db, `SELECT r.resource_type,v.indexing_status FROM workspace_resources r JOIN resource_versions v ON v.id=r.current_version_id WHERE r.relative_path='design.docx'`);
  assert.equal(resource.resource_type, 'office');
  assert.equal(resource.indexing_status, 'not_applicable');
});

test('PDF extraction rejects oversized input before invoking the external extractor', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-pdf-bound-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pdf = path.join(dir, 'oversized.pdf');
  fs.closeSync(fs.openSync(pdf, 'w'));
  fs.truncateSync(pdf, 100 * 1024 * 1024 + 1);
  const result = extractFile(pdf);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /exceeds/);
  assert.equal(result.metadata.size_bytes, 100 * 1024 * 1024 + 1);
});
