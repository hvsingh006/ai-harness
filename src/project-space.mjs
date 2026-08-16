import fs from 'node:fs';
import { row, rows, storageForDatabase, ensureWorkspaceProjectRoot, workspaceRoots } from './db.mjs';
import { reconcileWorkspaceResources } from './resources.mjs';
import { canonicalizeExistingPath, isPathWithin, normalizeRelativePath, resolveApprovedTarget } from './security/paths.mjs';

export function indexWorkspaceFile(db, workspaceId, filePath) {
  const workspace = row(db, 'SELECT * FROM workspaces WHERE id=?', workspaceId);
  if (!workspace) throw new Error('workspace not found');
  const absolute = canonicalizeExistingPath(filePath);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) return null;
  const approved = workspaceRoots(db, workspaceId).find(root => {
    try { return isPathWithin(absolute, canonicalizeExistingPath(root.root_path)); }
    catch { return false; }
  });
  if (!approved) throw Object.assign(new Error('file is outside approved workspace roots'), { code: 'ROOT_SECURITY_FAILURE' });
  const result = reconcileWorkspaceResources(db, workspaceId);
  if (!result.ok) throw Object.assign(new Error(result.reasons[0]?.message || 'workspace indexing failed'), { code: result.reasons[0]?.code || 'RESOURCE_INDEX_FAILED' });
  return row(db, 'SELECT * FROM workspace_files WHERE workspace_id=? AND local_path=? ORDER BY created_at LIMIT 1', workspaceId, absolute);
}

export function scanWorkspaceFiles(db, workspaceId, { maxFiles = 20000 } = {}) {
  const workspace = row(db, 'SELECT * FROM workspaces WHERE id=?', workspaceId);
  if (!workspace) return [];
  reconcileWorkspaceResources(db, workspaceId, { maxFilesPerRoot: maxFiles });
  return rows(db, 'SELECT * FROM workspace_files WHERE workspace_id=? ORDER BY relative_path', workspaceId);
}

export function projectFileDestination(db, workspaceId, relativePath) {
  ensureWorkspaceProjectRoot(db, workspaceId);
  const roots = workspaceRoots(db, workspaceId);
  const root = roots.find(item => ['primary', 'repository'].includes(item.root_kind)) || roots[0];
  if (!root) throw new Error('workspace root unavailable');
  const normalized = normalizeRelativePath(relativePath);
  return resolveApprovedTarget(root, normalized, { mustExist: false }).absolutePath;
}

export function storageSummary(db) {
  const storage = storageForDatabase(db);
  return {
    workspace_root: storage.workspaceRoot,
    projects_dir: storage.projectsDir,
    legacy_projects_dir: storage.legacyProjectsDir,
    library_dir: storage.libraryDir,
    archive_dir: storage.archiveDir,
    backups_dir: storage.backupsDir,
    database_path: storage.dbPath,
    vault_dir: storage.vaultDir
  };
}
