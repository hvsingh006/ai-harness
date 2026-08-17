import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { storageForDatabase } from './db.mjs';
import { HARNESS_VERSION } from './version.mjs';

export function createDatabaseBackup(db) {
  const storage = storageForDatabase(db);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(storage.backupsDir, `harness-${stamp}.db`);
  const escaped = backupPath.replaceAll("'", "''");
  db.exec('PRAGMA wal_checkpoint(FULL);');
  const sourceIntegrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
  if (sourceIntegrity !== 'ok') throw Object.assign(new Error(`source SQLite integrity check failed: ${sourceIntegrity || 'unknown result'}`), { code: 'BACKUP_SOURCE_INTEGRITY_FAILED' });
  db.exec(`VACUUM INTO '${escaped}'`);
  const backupDb = new DatabaseSync(backupPath, { readOnly: true });
  const backupIntegrity = backupDb.prepare('PRAGMA integrity_check').get()?.integrity_check;
  backupDb.close();
  if (backupIntegrity !== 'ok') throw Object.assign(new Error(`backup SQLite integrity check failed: ${backupIntegrity || 'unknown result'}`), { code: 'BACKUP_INTEGRITY_FAILED' });
  const databaseSha256 = crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
  const manifest = { created_at: new Date().toISOString(), harness_version: HARNESS_VERSION, database_backup: backupPath, database_sha256: databaseSha256, sqlite_integrity: backupIntegrity, workspace_root: storage.workspaceRoot, note: 'This integrity-checked backup protects Harness metadata, retained history metadata, audit records, and rebuildable derived-state references. Original Project Space files remain in their approved roots.' };
  fs.writeFileSync(`${backupPath}.json`, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return manifest;
}
