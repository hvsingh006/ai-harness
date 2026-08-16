import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertSeparatedRoots, inspectRepository, isWithin } from '../src/dev-workspace.mjs';

test('development and private roots enforce separation', () => {
  const root = path.join(os.tmpdir(), 'aih-root');
  assert.equal(isWithin(path.join(root, 'child'), root), true);
  assert.equal(isWithin(path.join(os.tmpdir(), 'other'), root), false);
  assert.equal(assertSeparatedRoots({
    developmentRoot: path.join(root, 'dev'),
    privateRoot: path.join(root, 'private')
  }), true);
  assert.throws(() => assertSeparatedRoots({
    developmentRoot: root,
    privateRoot: path.join(root, 'private')
  }), /must be separate directory trees/);
});

test('repository inspection reports branch, commit, dirty state and origin safely', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'AI Harness Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'test\n');
  execFileSync('git', ['-C', dir, 'add', 'README.md']);
  execFileSync('git', ['-C', dir, 'commit', '-m', 'initial']);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git']);

  let status = inspectRepository(dir);
  assert.equal(status.is_git, true);
  assert.equal(status.branch, 'main');
  assert.equal(status.dirty, false);
  assert.equal(status.origin, 'https://example.invalid/repo.git');
  assert.equal(status.head.length, 40);

  fs.appendFileSync(path.join(dir, 'README.md'), 'changed\n');
  status = inspectRepository(dir);
  assert.equal(status.dirty, true);
  assert.equal(status.changed_paths, 1);
});
