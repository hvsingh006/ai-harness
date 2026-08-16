import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

test('SQLite-safe backup checkpoints, integrity-checks, hashes, and manifests an independent database copy', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['scripts/backup.mjs'], { cwd: path.resolve('.'), env: { ...process.env, HARNESS_DB: path.join(dir, 'harness.db'), HARNESS_PROJECTS_ROOT: '' }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const backupDir = path.join(dir, 'Backups');
  const backupName = fs.readdirSync(backupDir).find(name => name.endsWith('.db'));
  assert.ok(backupName);
  const backupPath = path.join(backupDir, backupName);
  const manifest = JSON.parse(fs.readFileSync(`${backupPath}.json`, 'utf8'));
  assert.equal(manifest.sqlite_integrity, 'ok');
  assert.equal(manifest.database_sha256, crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex'));
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  backup.close();
});
