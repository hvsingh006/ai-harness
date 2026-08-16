import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachWorkspaceFolder, openDatabase, row, storageForDatabase } from '../src/db.mjs';
import { canonicalizeExistingPath, normalizeRelativePath, resolveApprovedTarget, walkApprovedRoot } from '../src/security/paths.mjs';
import { classifySensitivePath, scanOutgoingText } from '../src/security/secrets.mjs';
import { createPairingChallenge, completePairing, authenticateCompanionRequest } from '../src/security/companion-auth.mjs';

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('filesystem security accepts normal targets inside an approved root', t => {
  const rootPath = tempDir(t, 'aih-paths-');
  fs.mkdirSync(path.join(rootPath, 'docs'));
  fs.writeFileSync(path.join(rootPath, 'docs', 'notes.md'), 'current');
  const root = { root_path: rootPath, canonical_path: canonicalizeExistingPath(rootPath) };
  const result = resolveApprovedTarget(root, 'docs/notes.md', { expectedType: 'file' });
  assert.equal(result.relativePath, 'docs/notes.md');
  assert.equal(fs.readFileSync(result.absolutePath, 'utf8'), 'current');
});

test('filesystem security rejects traversal, alternate separators, and absolute outside paths', t => {
  const rootPath = tempDir(t, 'aih-paths-reject-');
  const root = { root_path: rootPath, canonical_path: canonicalizeExistingPath(rootPath) };
  assert.throws(() => normalizeRelativePath('../secret.txt'), /traversal/);
  assert.throws(() => normalizeRelativePath('docs\\secret.txt'), /alternate-separator/);
  assert.throws(() => normalizeRelativePath(path.join(rootPath, 'absolute.txt')), /absolute/);
  assert.throws(() => resolveApprovedTarget(root, '../outside.txt'), /traversal/);
});

test('recursive indexing skips symlinks and never follows an escape', t => {
  const base = tempDir(t, 'aih-symlink-');
  const rootPath = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(rootPath);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not approved');
  try { fs.symlinkSync(outside, path.join(rootPath, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.skip(`symlink creation unavailable: ${error.code}`); return; }
  const root = { root_path: rootPath, canonical_path: canonicalizeExistingPath(rootPath) };
  const scan = walkApprovedRoot(root);
  assert.equal(scan.ok, true);
  assert.equal(scan.files.length, 0);
  assert.deepEqual(scan.skippedSymlinks, ['escape']);
  assert.throws(() => resolveApprovedTarget(root, 'escape/secret.txt'), /symbolic|escapes/);
});

test('sensitive filename policy defaults credentials and key material to local-only', () => {
  for (const name of ['.env', '.env.production', 'id_rsa', 'private.pem', '.ssh/config', '.aws/credentials', 'service-account.json']) {
    assert.equal(classifySensitivePath(name).sensitive, true, name);
  }
  assert.equal(classifySensitivePath('src/server.mjs').sensitive, false);
});

test('outgoing secret scanner blocks high-confidence secrets without returning plaintext in findings', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
  const result = scanOutgoingText(`Authorization: Bearer ${secret}`);
  assert.equal(result.blocked, true);
  assert.ok(result.detections.length >= 1);
  assert.equal(JSON.stringify(result.detections).includes(secret), false);
  assert.match(result.detections[0].fingerprint, /^[a-f0-9]{16}$/);
});

test('outgoing secret scanner deterministically redacts lower-confidence JWT material', () => {
  const jwt = 'eyJabcdefghijklmno.abcdefghijklmno.abcdefghijklmno';
  const result = scanOutgoingText(`token ${jwt}`);
  assert.equal(result.redacted, true);
  assert.equal(result.text.includes(jwt), false);
  assert.match(result.text, /REDACTED:jwt-like-token/);
});

test('companion pairing challenges are one-use and authentication rejects missing, wrong, or foreign-origin credentials', t => {
  const dir = tempDir(t, 'aih-auth-');
  const db = openDatabase(path.join(dir, 'test.db'));
  const extensionId = 'a'.repeat(32);
  const challenge = createPairingChallenge(db);
  const pairing = completePairing(db, { challenge: challenge.challenge, extensionId });
  assert.throws(() => completePairing(db, { challenge: challenge.challenge, extensionId }), /invalid or expired/);

  const request = (token, origin = `chrome-extension://${extensionId}`) => ({ headers: {
    'x-aih-companion-token': token,
    'x-aih-extension-id': extensionId,
    origin
  } });
  assert.equal(authenticateCompanionRequest(db, { headers: {} }).ok, false);
  assert.equal(authenticateCompanionRequest(db, request('wrong')).ok, false);
  assert.equal(authenticateCompanionRequest(db, request(pairing.token, 'https://evil.example')).ok, false);
  assert.equal(authenticateCompanionRequest(db, request(pairing.token)).ok, true);
  db.close();
});

test('a rejected primary-folder change rolls back without losing the existing approved root', t => {
  const dir = tempDir(t, 'aih-attach-rollback-');
  const db = openDatabase(path.join(dir, 'test.db'));
  const beforeWorkspace = row(db, `SELECT root_path FROM workspaces WHERE id='ws-harness'`);
  const beforeRoot = row(db, `SELECT id,root_path FROM workspace_roots WHERE workspace_id='ws-harness' AND root_kind IN ('primary','repository')`);
  assert.throws(() => attachWorkspaceFolder(db, 'ws-harness', storageForDatabase(db).workspaceRoot), /too broad|private Harness state/);
  assert.equal(row(db, `SELECT root_path FROM workspaces WHERE id='ws-harness'`).root_path, beforeWorkspace.root_path);
  assert.deepEqual(row(db, `SELECT id,root_path FROM workspace_roots WHERE workspace_id='ws-harness' AND root_kind IN ('primary','repository')`), beforeRoot);
  db.close();
});
