import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, storageForDatabase } from '../src/db.mjs';
import { HARNESS_VERSION } from '../src/version.mjs';

const db = process.env.HARNESS_DB ? openDatabase(path.resolve(process.env.HARNESS_DB)) : openDatabase();
const storage = storageForDatabase(db);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(storage.backupsDir, `harness-${stamp}.db`);
const escaped = backupPath.replaceAll("'", "''");

try {
  db.exec('PRAGMA wal_checkpoint(FULL);');
  const sourceIntegrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
  if (sourceIntegrity !== 'ok') throw new Error(`source SQLite integrity check failed: ${sourceIntegrity || 'unknown result'}`);
  db.exec(`VACUUM INTO '${escaped}'`);
  const backupDb = new DatabaseSync(backupPath, { readOnly: true });
  const backupIntegrity = backupDb.prepare('PRAGMA integrity_check').get()?.integrity_check;
  backupDb.close();
  if (backupIntegrity !== 'ok') throw new Error(`backup SQLite integrity check failed: ${backupIntegrity || 'unknown result'}`);
  const backupSha256 = crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
  const manifest = {
    created_at: new Date().toISOString(),
    harness_version: HARNESS_VERSION,
    database_backup: backupPath,
    database_sha256: backupSha256,
    sqlite_integrity: backupIntegrity,
    workspace_root: storage.workspaceRoot,
    note: 'Project files are not duplicated here because they already live outside the application checkout. This backup protects Harness metadata, archive indexes, chat history metadata, and derived state.'
  };
  fs.writeFileSync(`${backupPath}.json`, JSON.stringify(manifest, null, 2));
  console.log(`AI Harness backup created:\n${backupPath}`);
} finally {
  db.close();
}
