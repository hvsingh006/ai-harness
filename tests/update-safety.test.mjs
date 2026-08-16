import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectSafeUpdate, executeSafeFastForward } from '../src/update-safety.mjs';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function configure(repo) {
  git(repo, 'config', 'user.email', 'tests@example.invalid');
  git(repo, 'config', 'user.name', 'AI Harness Tests');
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-update-'));
  const repo = path.join(dir, 'repo');
  const origin = path.join(dir, 'origin.git');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  configure(repo);
  fs.writeFileSync(path.join(repo, 'app.txt'), 'one');
  git(repo, 'add', 'app.txt');
  git(repo, 'commit', '-m', 'initial');
  execFileSync('git', ['init', '--bare', origin], { stdio: 'ignore', windowsHide: true });
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-u', 'origin', 'main');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, repo, origin };
}

function remoteCommit(dir, origin, content = 'remote') {
  const other = path.join(dir, `other-${Math.random().toString(16).slice(2)}`);
  execFileSync('git', ['clone', '-b', 'main', origin, other], { stdio: 'ignore', windowsHide: true });
  configure(other);
  fs.writeFileSync(path.join(other, 'app.txt'), content);
  git(other, 'add', 'app.txt');
  git(other, 'commit', '-m', content);
  git(other, 'push', 'origin', 'main');
}

test('safe update status reports an equal clean main checkout as up to date', t => {
  const { repo } = fixture(t);
  const status = inspectSafeUpdate(repo);
  assert.equal(status.code, 'UP_TO_DATE');
  assert.equal(status.eligible, false);
  assert.equal(status.ahead, 0);
  assert.equal(status.behind, 0);
});

test('safe update status allows only a clean fast-forward-behind main checkout', t => {
  const { dir, repo, origin } = fixture(t);
  remoteCommit(dir, origin);
  git(repo, 'fetch', 'origin', 'main');
  const status = inspectSafeUpdate(repo);
  assert.equal(status.code, 'SAFE_TO_UPDATE');
  assert.equal(status.eligible, true);
  assert.equal(status.behind, 1);
});

test('safe update status rejects a dirty checkout without changing private data', t => {
  const { dir, repo } = fixture(t);
  const privateSentinel = path.join(dir, 'private-harness-data.txt');
  fs.writeFileSync(privateSentinel, 'unchanged private state');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'dirty');
  const status = inspectSafeUpdate(repo);
  assert.equal(status.code, 'DIRTY_WORKTREE_BLOCKED');
  assert.equal(fs.readFileSync(privateSentinel, 'utf8'), 'unchanged private state');
});

test('safe update status rejects feature branches', t => {
  const { repo } = fixture(t);
  git(repo, 'switch', '-c', 'feature');
  assert.equal(inspectSafeUpdate(repo).code, 'FEATURE_BRANCH_BLOCKED');
});

test('safe update status rejects local-ahead main', t => {
  const { repo } = fixture(t);
  fs.writeFileSync(path.join(repo, 'local.txt'), 'local');
  git(repo, 'add', 'local.txt');
  git(repo, 'commit', '-m', 'local');
  assert.equal(inspectSafeUpdate(repo).code, 'LOCAL_AHEAD_BLOCKED');
});

test('safe update status rejects divergence', t => {
  const { dir, repo, origin } = fixture(t);
  remoteCommit(dir, origin);
  fs.writeFileSync(path.join(repo, 'local.txt'), 'local');
  git(repo, 'add', 'local.txt');
  git(repo, 'commit', '-m', 'local');
  git(repo, 'fetch', 'origin', 'main');
  const status = inspectSafeUpdate(repo);
  assert.equal(status.code, 'DIVERGED_BLOCKED');
  assert.equal(status.diverged, true);
});

test('safe update status rejects repositories with no origin/main', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-update-noremote-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  configure(repo);
  fs.writeFileSync(path.join(repo, 'app.txt'), 'one');
  git(repo, 'add', 'app.txt');
  git(repo, 'commit', '-m', 'initial');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(inspectSafeUpdate(repo).code, 'REMOTE_MAIN_UNAVAILABLE');
});

test('failed validation rolls application revision back while leaving private data unchanged', t => {
  const { dir, repo, origin } = fixture(t);
  remoteCommit(dir, origin, 'remote validation candidate');
  git(repo, 'fetch', 'origin', 'main');
  const oldHead = git(repo, 'rev-parse', 'HEAD');
  const privateSentinel = path.join(dir, 'private-state.bin');
  fs.writeFileSync(privateSentinel, 'private-state-unchanged');
  let backupCalled = false;
  assert.throws(() => executeSafeFastForward(repo, { backup: () => { backupCalled = true; }, validate: () => { throw new Error('synthetic validation failure'); } }), error => error.code === 'UPDATE_VALIDATION_FAILED_ROLLED_BACK' && error.rolled_back === true);
  assert.equal(backupCalled, true);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), oldHead);
  assert.equal(fs.readFileSync(privateSentinel, 'utf8'), 'private-state-unchanged');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('PowerShell update helper validates tests, doctor, status, backup, and avoids hard reset rollback', () => {
  const script = fs.readFileSync('update-harness.ps1', 'utf8');
  assert.match(script, /scripts\\backup\.mjs/);
  assert.match(script, /npm test/);
  assert.match(script, /scripts\\doctor\.mjs/);
  assert.match(script, /scripts\\dev-status\.mjs/);
  assert.match(script, /merge --ff-only origin\/main/);
  assert.doesNotMatch(script, /reset --hard/);
});

test('Windows launcher runs the localhost service hidden, health-checks source identity, and keeps logs outside the repository', () => {
  const launcher = fs.readFileSync('start-harness.ps1', 'utf8');
  assert.match(launcher, /-WindowStyle Hidden/);
  assert.match(launcher, /api\/health/);
  assert.match(launcher, /source_root/);
  assert.match(launcher, /AI Harness/);
  assert.match(launcher, /Runtime/);
  assert.doesNotMatch(launcher, /0\.0\.0\.0/);
});
