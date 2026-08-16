import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function git(repo, args, { optional = false, timeout = 15000 } = {}) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (optional) return '';
    throw Object.assign(new Error(String(error.stderr || error.message).trim()), { code: 'GIT_OPERATION_FAILED' });
  }
}

export function inspectSafeUpdate(repoPath, { remoteRef = 'origin/main', fetch = false } = {}) {
  const repo = path.resolve(repoPath);
  if (!fs.existsSync(path.join(repo, '.git'))) return { supported: false, eligible: false, code: 'NOT_GIT_CHECKOUT', repo };
  const root = path.resolve(git(repo, ['rev-parse', '--show-toplevel']));
  if ((process.platform === 'win32' ? root.toLowerCase() : root) !== (process.platform === 'win32' ? repo.toLowerCase() : repo)) {
    return { supported: true, eligible: false, code: 'NON_CANONICAL_REPOSITORY_ROOT', repo, root };
  }
  if (fetch) git(repo, ['fetch', '--quiet', 'origin', 'main'], { timeout: 30000 });
  const branch = git(repo, ['branch', '--show-current'], { optional: true }) || '(detached)';
  const head = git(repo, ['rev-parse', 'HEAD']);
  const remote = git(repo, ['rev-parse', '--verify', remoteRef], { optional: true });
  const porcelain = git(repo, ['status', '--porcelain=v1', '--untracked-files=all'], { optional: true });
  const dirty = Boolean(porcelain);
  if (!remote) return { supported: true, eligible: false, code: 'REMOTE_MAIN_UNAVAILABLE', repo, branch, head, dirty, remote_ref: remoteRef };
  const counts = git(repo, ['rev-list', '--left-right', '--count', `${head}...${remote}`]).split(/\s+/).map(Number);
  const ahead = counts[0] || 0;
  const behind = counts[1] || 0;
  let code = 'SAFE_TO_UPDATE';
  if (branch !== 'main') code = 'FEATURE_BRANCH_BLOCKED';
  else if (dirty) code = 'DIRTY_WORKTREE_BLOCKED';
  else if (ahead && behind) code = 'DIVERGED_BLOCKED';
  else if (ahead) code = 'LOCAL_AHEAD_BLOCKED';
  else if (!behind) code = 'UP_TO_DATE';
  return { supported: true, eligible: code === 'SAFE_TO_UPDATE', update_available: behind > 0, code, repo, root, branch, head, remote_commit: remote, remote_ref: remoteRef, dirty, changed_paths: porcelain ? porcelain.split(/\r?\n/).filter(Boolean) : [], ahead, behind, diverged: ahead > 0 && behind > 0 };
}

export function assertSafeUpdate(repoPath, options = {}) {
  const status = inspectSafeUpdate(repoPath, options);
  if (!status.eligible) throw Object.assign(new Error(`automatic update rejected: ${status.code}`), { code: status.code, status });
  return status;
}

export function executeSafeFastForward(repoPath, { remoteRef = 'origin/main', backup = () => {}, validate = () => {} } = {}) {
  const before = assertSafeUpdate(repoPath, { remoteRef });
  backup(before);
  try {
    git(before.repo, ['merge', '--ff-only', remoteRef], { timeout: 30000 });
    validate({ ...before, new_head: git(before.repo, ['rev-parse', 'HEAD']) });
    return { ok: true, previous_head: before.head, current_head: git(before.repo, ['rev-parse', 'HEAD']), rolled_back: false };
  } catch (error) {
    try { git(before.repo, ['reset', '--keep', before.head], { timeout: 30000 }); }
    catch (rollbackError) { throw Object.assign(new Error(`update failed and safe rollback was refused: ${rollbackError.message}`), { code: 'UPDATE_ROLLBACK_REFUSED', cause: error }); }
    throw Object.assign(new Error(`update validation failed; previous revision restored: ${error.message}`), { code: 'UPDATE_VALIDATION_FAILED_ROLLED_BACK', previous_head: before.head, rolled_back: true });
  }
}
