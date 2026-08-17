import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { createDatabaseBackup } from '../src/backup.mjs';

const db = process.env.HARNESS_DB ? openDatabase(path.resolve(process.env.HARNESS_DB)) : openDatabase();
try {
  const manifest = createDatabaseBackup(db);
  console.log(`AI Harness backup created:\n${manifest.database_backup}`);
} finally {
  db.close();
}
