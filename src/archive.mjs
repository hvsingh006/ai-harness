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
    '.zip':'application/zip','.yaml':'application/yaml','.yml':'application/yaml','.xml':'application/xml','.css':'text/css',
    '.js':'text/javascript','.mjs':'text/javascript','.cjs':'text/javascript','.ts':'text/typescript','.tsx':'text/typescript',
    '.py':'text/x-python','.c':'text/x-c','.h':'text/x-c','.cpp':'text/x-c++','.hpp':'text/x-c++','.java':'text/x-java',
    '.go':'text/x-go','.rs':'text/x-rust','.sv':'text/x-systemverilog','.v':'text/x-verilog','.vhd':'text/x-vhdl','.vhdl':'text/x-vhdl',
    '.tcl':'text/x-tcl','.sh':'text/x-shellscript','.ps1':'text/x-powershell','.cmd':'text/x-batch','.bat':'text/x-batch',
    '.svg':'image/svg+xml'
  })[ext] || 'application/octet-stream';
}

export function archiveFile(db, { filePath, workspaceId = null, sessionId = null, importId = null, provider = 'local', artifactType = 'file', sourceUrl = '', nativeId = '', metadata = {}, sourcePathOverride = '' }) {
  const { vaultDir } = storageForDatabase(db);
  const sourceStat = fs.statSync(filePath);
  if (!sourceStat.isFile()) return null;
  fs.mkdirSync(vaultDir, { recursive: true });
  const capturePath = path.join(vaultDir, `.capture-${randomUUID()}.tmp`);
  let sha256;
  let snapshotStat;
  let dest;
  try {
    fs.copyFileSync(filePath, capturePath);
    snapshotStat = fs.statSync(capturePath);
    sha256 = sha256File(capturePath);
    const shardDir = path.join(vaultDir, 'blobs', sha256.slice(0, 2));
    fs.mkdirSync(shardDir, { recursive: true });
    dest = path.join(shardDir, sha256);
    if (fs.existsSync(dest)) {
      if (sha256File(dest) !== sha256) throw new Error('content-addressed vault integrity check failed');
      fs.unlinkSync(capturePath);
    } else {
      fs.renameSync(capturePath, dest);
    }
  } finally {
    try { if (fs.existsSync(capturePath)) fs.unlinkSync(capturePath); } catch {}
  }

  const sourcePath = sourcePathOverride || filePath;
  const existing = row(db, 'SELECT * FROM artifacts WHERE sha256 = ? AND source_path = ?', sha256, sourcePath);
  if (existing) return existing;
  const id = `artifact-${randomUUID()}`;
  const createdAt = new Date(sourceStat.mtimeMs || Date.now()).toISOString();
  run(db, `INSERT INTO artifacts (id,workspace_id,session_id,import_id,provider,artifact_type,name,mime_type,size_bytes,sha256,vault_path,source_path,source_url,native_id,metadata_json,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, workspaceId, sessionId, importId, provider, artifactType, path.basename(filePath), mimeFromName(filePath), snapshotStat.size, sha256, dest, sourcePath, sourceUrl, nativeId, JSON.stringify(metadata), createdAt);
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
