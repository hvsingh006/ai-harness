import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, storageForDatabase } from '../src/db.mjs';
import { HARNESS_VERSION } from '../src/version.mjs';

const db = process.env.HARNESS_DB ? openDatabase(path.resolve(process.env.HARNESS_DB)) : openDatabase();
const storage = storageForDatabase(db);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(storage.backupsDir, `harness-${stamp}.db`);
const escaped = backupPath.replaceAll("'", "''");

try {
  db.exec('PRAGMA wal_checkpoint(FULL);');
  db.exec(`VACUUM INTO '${escaped}'`);
  const manifest = {
    created_at: new Date().toISOString(),
    harness_version: HARNESS_VERSION,
    database_backup: backupPath,
    workspace_root: storage.workspaceRoot,
    note: 'Project files are not duplicated here because they already live outside the application checkout. This backup protects Harness metadata, archive indexes, chat history metadata, and derived state.'
  };
  fs.writeFileSync(`${backupPath}.json`, JSON.stringify(manifest, null, 2));
  console.log(`AI Harness backup created:\n${backupPath}`);
} finally {
  db.close();
}
