import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { row, run, storageForDatabase, ensureWorkspaceProjectRoot } from './db.mjs';
import { mimeFromName, sha256File } from './archive.mjs';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.idea', '.vscode', '.next', 'dist', 'build', '__pycache__']);

function relPath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

export function indexWorkspaceFile(db, workspaceId, filePath) {
  const workspace = row(db, 'SELECT * FROM workspaces WHERE id=?', workspaceId);
  if (!workspace) throw new Error('workspace not found');
  const rootPath = ensureWorkspaceProjectRoot(db, workspaceId);
  const absolute = path.resolve(filePath);
  const rel = relPath(rootPath, absolute);
  if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) throw new Error('file is outside workspace root');
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) return null;
  const existing = row(db, 'SELECT * FROM workspace_files WHERE workspace_id=? AND local_path=? ORDER BY created_at LIMIT 1', workspaceId, absolute);
  const ts = new Date().toISOString();
  const sha256 = sha256File(absolute);
  if (existing) {
    run(db, `UPDATE workspace_files SET name=?,mime_type=?,relative_path=?,sha256=?,size_bytes=?,modified_at=?,updated_at=? WHERE id=?`,
      path.basename(absolute), mimeFromName(absolute), rel, sha256, stat.size, new Date(stat.mtimeMs).toISOString(), ts, existing.id);
    return row(db, 'SELECT * FROM workspace_files WHERE id=?', existing.id);
  }
  const id = `file-${crypto.randomUUID()}`;
  run(db, `INSERT INTO workspace_files (id,workspace_id,name,mime_type,local_path,source_provider,source_url,notes,created_at,sha256,size_bytes,relative_path,modified_at,updated_at)
           VALUES (?,?,?,?,?,'local','','',?,?,?,?,?,?)`,
    id, workspaceId, path.basename(absolute), mimeFromName(absolute), absolute, ts, sha256, stat.size, rel, new Date(stat.mtimeMs).toISOString(), ts);
  return row(db, 'SELECT * FROM workspace_files WHERE id=?', id);
}

export function scanWorkspaceFiles(db, workspaceId, { maxFiles = 5000 } = {}) {
  const workspace = row(db, 'SELECT * FROM workspaces WHERE id=?', workspaceId);
  if (!workspace) return [];
  const rootPath = ensureWorkspaceProjectRoot(db, workspaceId);
  const seen = new Set();
  let count = 0;

  function walk(dir) {
    if (count >= maxFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (count >= maxFiles) break;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        count += 1;
        seen.add(path.resolve(full));
        const stat = fs.statSync(full);
        const existing = row(db, 'SELECT * FROM workspace_files WHERE workspace_id=? AND local_path=? ORDER BY created_at LIMIT 1', workspaceId, path.resolve(full));
        const modifiedAt = new Date(stat.mtimeMs).toISOString();
        if (!existing || existing.size_bytes !== stat.size || existing.modified_at !== modifiedAt) indexWorkspaceFile(db, workspaceId, full);
      }
    }
  }
  walk(rootPath);

  for (const item of db.prepare('SELECT id,local_path FROM workspace_files WHERE workspace_id=?').all(workspaceId)) {
    if (!seen.has(path.resolve(item.local_path)) && !fs.existsSync(item.local_path)) db.prepare('DELETE FROM workspace_files WHERE id=?').run(item.id);
  }
  return db.prepare('SELECT * FROM workspace_files WHERE workspace_id=? ORDER BY relative_path').all(workspaceId);
}

export function projectFileDestination(db, workspaceId, relativePath) {
  const rootPath = ensureWorkspaceProjectRoot(db, workspaceId);
  const normalized = String(relativePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '..')) throw new Error('invalid project relative path');
  const destination = path.resolve(rootPath, ...parts);
  const rel = path.relative(rootPath, destination);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('project path escapes workspace root');
  return destination;
}

export function storageSummary(db) {
  const storage = storageForDatabase(db);
  return {
    workspace_root: storage.workspaceRoot,
    projects_dir: storage.projectsDir,
    library_dir: storage.libraryDir,
    archive_dir: storage.archiveDir,
    backups_dir: storage.backupsDir,
    database_path: storage.dbPath,
    vault_dir: storage.vaultDir
  };
}
