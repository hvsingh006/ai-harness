import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase, registerWorkspaceRoot } from '../src/db.mjs';
import { agentCapabilities, resolveRegisteredRepositoryForAgent } from '../src/agent-launcher.mjs';

test('local coding-agent handoff resolves only the exact registered repository root ID', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agent-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agent-repo-'));
  execFileSync('git', ['-C', repo, 'init', '-b', 'main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'tests@example.invalid']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'AI Harness Tests']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'project');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', ['-C', repo, 'commit', '-m', 'initial'], { stdio: 'ignore' });
  const db = openDatabase(path.join(dir, 'harness.db'));
  const registered = registerWorkspaceRoot(db, 'ws-harness', { rootPath: repo, rootKind: 'repository' });
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); });
  const resolved = resolveRegisteredRepositoryForAgent(db, { workspaceId: 'ws-harness', rootId: registered.id });
  assert.equal(path.resolve(resolved.canonical), path.resolve(repo));
  assert.equal(resolved.state.branch, 'main');
  assert.throws(() => resolveRegisteredRepositoryForAgent(db, { workspaceId: 'ws-harness', rootId: 'root-not-registered' }), error => error.code === 'AGENT_ROOT_NOT_REGISTERED');
});

test('local coding-agent capability report exposes only fixed Codex and Antigravity tools', () => {
  const capabilities = agentCapabilities();
  assert.deepEqual(Object.keys(capabilities).sort(), ['antigravity', 'codex']);
  for (const item of Object.values(capabilities)) assert.ok(['AVAILABLE', 'TOOL_NOT_INSTALLED'].includes(item.code));
  const source = fs.readFileSync('src/agent-launcher.mjs', 'utf8');
  assert.doesNotMatch(source, /body\.command|body\.path|shell:\s*true/);
});
