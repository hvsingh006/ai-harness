import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { storageForDatabase, row, run } from './db.mjs';

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function mimeFromName(name) {
  const ext = path.extname(name).toLowerCase();
  return ({
    '.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif',
    '.json':'application/json','.html':'text/html','.htm':'text/html','.txt':'text/plain','.md':'text/markdown','.csv':'text/csv',
    '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip':'application/zip'
  })[ext] || 'application/octet-stream';
}

export function archiveFile(db, { filePath, workspaceId = null, sessionId = null, importId = null, provider = 'local', artifactType = 'file', sourceUrl = '', nativeId = '', metadata = {}, sourcePathOverride = '' }) {
  const { vaultDir } = storageForDatabase(db);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return null;
  const sha256 = sha256File(filePath);
  const shard = sha256.slice(0, 2);
  const shardDir = path.join(vaultDir, 'blobs', shard);
  fs.mkdirSync(shardDir, { recursive: true });
  const dest = path.join(shardDir, sha256);
  if (!fs.existsSync(dest)) fs.copyFileSync(filePath, dest);

  const sourcePath = sourcePathOverride || filePath;
  const existing = row(db, 'SELECT * FROM artifacts WHERE sha256 = ? AND source_path = ?', sha256, sourcePath);
  if (existing) return existing;
  const id = `artifact-${randomUUID()}`;
  const createdAt = new Date(stat.mtimeMs || Date.now()).toISOString();
  run(db, `INSERT INTO artifacts (id,workspace_id,session_id,import_id,provider,artifact_type,name,mime_type,size_bytes,sha256,vault_path,source_path,source_url,native_id,metadata_json,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, workspaceId, sessionId, importId, provider, artifactType, path.basename(filePath), mimeFromName(filePath), stat.size, sha256, dest, sourcePath, sourceUrl, nativeId, JSON.stringify(metadata), createdAt);
  return row(db, 'SELECT * FROM artifacts WHERE id = ?', id);
}

export function archiveDirectory(db, { directory, workspaceId = null, importId = null, provider = 'local', ignore = [] }) {
  const results = [];
  const ignored = new Set(ignore.map(p => path.resolve(p)));
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (ignored.has(path.resolve(full))) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) results.push(archiveFile(db, { filePath: full, workspaceId, importId, provider, artifactType: classifyArtifact(full) }));
    }
  };
  walk(directory);
  return results.filter(Boolean);
}

function classifyArtifact(filePath) {
  const mime = mimeFromName(filePath);
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (/json|html|text|csv/.test(mime)) return 'source_record';
  return 'file';
}
