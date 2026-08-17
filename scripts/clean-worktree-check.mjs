import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const status = () => execFileSync('git', ['status', '--porcelain=v1'], { cwd: appRoot, encoding: 'utf8', windowsHide: true }).trim();
if (status()) throw Object.assign(new Error('clean-worktree acceptance must run from a committed clean checkout'), { code: 'CURRENT_WORKTREE_DIRTY' });

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-clean-check-'));
const clone = path.join(tempRoot, 'checkout');
const state = path.join(tempRoot, 'private-state', 'harness.db');
const environment = { ...process.env, HARNESS_DB: state, HARNESS_PROJECTS_ROOT: '' };
const npmCli = String(process.env.npm_execpath || '');
if (!path.isAbsolute(npmCli) || !fs.statSync(npmCli, { throwIfNoEntry: false })?.isFile()) {
  throw Object.assign(new Error('npm CLI entrypoint is unavailable; run this acceptance check through npm run test:clean'), { code: 'NPM_CLI_UNAVAILABLE' });
}
try {
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', appRoot, clone], { windowsHide: true, stdio: 'inherit' });
  execFileSync(process.execPath, [npmCli, 'install', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: clone, env: environment, windowsHide: true, stdio: 'inherit' });
  execFileSync(process.execPath, ['--test', 'tests/db.test.mjs', 'tests/resources.test.mjs'], { cwd: clone, env: environment, windowsHide: true, stdio: 'inherit' });
  const finalStatus = execFileSync('git', ['status', '--porcelain=v1'], { cwd: clone, encoding: 'utf8', windowsHide: true }).trim();
  if (finalStatus) throw Object.assign(new Error(`representative install/test workflows polluted a clean checkout:\n${finalStatus}`), { code: 'CLEAN_WORKTREE_POLLUTION' });
  console.log('Clean-worktree acceptance passed: install and representative indexing/tests left zero tracked or untracked files.');
} finally {
  const relative = path.relative(os.tmpdir(), tempRoot);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(tempRoot, { recursive: true, force: true });
}
