import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { row, rows, run, storageForDatabase } from './db.mjs';
import { sha256File } from './archive.mjs';
import { isPathWithin } from './security/paths.mjs';

function manifest(directory) {
  const items = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`migration refuses symbolic link: ${path.relative(directory, absolute)}`);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) items.push({ path: path.relative(directory, absolute).split(path.sep).join('/'), size: stat.size, sha256: sha256File(absolute) });
    }
  };
  walk(directory);
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

function manifestHash(items) {
  return crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

export function migrateManagedWorkspaceProject(db, workspaceId) {
  const workspace = row(db, 'SELECT * FROM workspaces WHERE id=?', workspaceId);
  if (!workspace) throw new Error('workspace not found');
  const storage = storageForDatabase(db);
  const source = path.resolve(workspace.root_path || '');
  if (workspace.path_mode !== 'managed' || !isPathWithin(source, storage.legacyProjectsDir)) {
    return { migrated: false, status: 'not_legacy_managed', source };
  }
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) return { migrated: false, status: 'source_unavailable', source };
  const target = path.join(storage.projectsDir, path.basename(source));
  const migrationId = `migration-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  if (fs.existsSync(target)) {
    run(db, `INSERT INTO migration_records (id,migration_type,workspace_id,status,source_path,target_path,details_json,created_at,completed_at)
             VALUES (?,'managed_project_layout',?,'conflict',?,?,?, ?,?)`,
      migrationId, workspaceId, source, target, JSON.stringify({ reason: 'target_exists_no_overwrite' }), createdAt, createdAt);
    return { migrated: false, status: 'conflict', source, target, migration_id: migrationId };
  }
  const staging = path.join(storage.projectsDir, `.aih-migrate-${randomUUID()}`);
  run(db, `INSERT INTO migration_records (id,migration_type,workspace_id,status,source_path,target_path,details_json,created_at)
           VALUES (?,'managed_project_layout',?,'copying',?,?,?,?)`, migrationId, workspaceId, source, target, '{}', createdAt);
  try {
    const sourceManifest = manifest(source);
    fs.cpSync(source, staging, { recursive: true, force: false, errorOnExist: true, dereference: false });
    const copiedManifest = manifest(staging);
    const sourceHash = manifestHash(sourceManifest);
    const targetHash = manifestHash(copiedManifest);
    if (sourceHash !== targetHash) throw new Error('copied project verification failed');
    if (manifestHash(manifest(source)) !== sourceHash) throw new Error('source project changed during migration; retry against the new state');
    fs.renameSync(staging, target);
    const canonicalTarget = fs.realpathSync.native(target);
    const completedAt = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      run(db, `UPDATE workspaces SET root_path=?,path_mode='managed',updated_at=? WHERE id=?`, target, completedAt, workspaceId);
      const updatedRoots = run(db, `UPDATE workspace_roots SET root_path=?,canonical_path=?,status='stale',updated_at=? WHERE workspace_id=? AND root_path=?`, target, canonicalTarget, completedAt, workspaceId, source);
      if (!updatedRoots.changes) {
        run(db, `INSERT INTO workspace_roots (id,workspace_id,root_path,canonical_path,root_kind,label,required_for_freshness,indexing_enabled,provider_transmission_allowed,status,created_at,updated_at)
                 VALUES (?,?,?,?,?,'Primary',1,1,1,'stale',?,?)`, `root-${randomUUID()}`, workspaceId, target, canonicalTarget, fs.existsSync(path.join(target, '.git')) ? 'repository' : 'primary', completedAt, completedAt);
      }
      run(db, `UPDATE migration_records SET status='complete',details_json=?,completed_at=? WHERE id=?`,
        JSON.stringify({ file_count: sourceManifest.length, manifest_sha256: sourceHash, source_retained_as_fallback: true }), completedAt, migrationId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { migrated: true, status: 'complete', source, target, source_retained: true, file_count: sourceManifest.length, manifest_sha256: sourceHash, migration_id: migrationId };
  } catch (error) {
    try { if (isPathWithin(staging, storage.projectsDir) && fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    run(db, `UPDATE migration_records SET status='failed',details_json=?,completed_at=? WHERE id=?`, JSON.stringify({ error: error.message }), new Date().toISOString(), migrationId);
    throw error;
  }
}

export function pendingManagedWorkspaceMigrations(db) {
  const storage = storageForDatabase(db);
  return rows(db, `SELECT id,name,root_path,path_mode FROM workspaces WHERE path_mode='managed'`).filter(workspace =>
    workspace.root_path && isPathWithin(path.resolve(workspace.root_path), storage.legacyProjectsDir) && !isPathWithin(path.resolve(workspace.root_path), storage.projectsDir)
  );
}
