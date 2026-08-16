import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { row, rows, run } from './db.mjs';
import { canonicalizeExistingPath } from './security/paths.mjs';

function git(root, args, { allowFailure = false, trim = true } = {}) {
  try {
    const output = execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return trim ? output.trim() : output.replace(/[\r\n]+$/, '');
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function statusDetails(porcelain) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const line of porcelain.split(/\r?\n/).filter(Boolean)) {
    const x = line[0];
    const y = line[1];
    const file = line.slice(3).replace(/^"|"$/g, '');
    if (x === '?' && y === '?') untracked.push(file);
    else {
      if (x && x !== ' ') staged.push(file);
      if (y && y !== ' ') unstaged.push(file);
    }
  }
  return { staged, unstaged, untracked, changed_paths: [...new Set([...staged, ...unstaged, ...untracked])].sort() };
}

export function inspectRepositoryRoot(rootPath) {
  const canonical = canonicalizeExistingPath(rootPath);
  const detectedRoot = canonicalizeExistingPath(git(canonical, ['rev-parse', '--show-toplevel']));
  if (process.platform === 'win32' ? detectedRoot.toLowerCase() !== canonical.toLowerCase() : detectedRoot !== canonical) {
    throw Object.assign(new Error('registered repository root does not match Git toplevel'), { code: 'REPOSITORY_REFRESH_FAILED' });
  }
  const branch = git(canonical, ['branch', '--show-current'], { allowFailure: true });
  const head = git(canonical, ['rev-parse', 'HEAD']);
  const upstream = git(canonical, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true });
  const porcelain = git(canonical, ['status', '--porcelain=v1', '--untracked-files=all'], { allowFailure: true, trim: false });
  const status = statusDetails(porcelain);
  const trackedTree = git(canonical, ['ls-files', '-co', '--exclude-standard'], { allowFailure: true }).split(/\r?\n/).filter(Boolean).filter(item => !item.startsWith('.git/'));
  const recentCommits = git(canonical, ['log', '-n', '12', '--date=iso-strict', '--pretty=format:%H%x09%ad%x09%an%x09%s'], { allowFailure: true }).split(/\r?\n/).filter(Boolean).map(line => {
    const [commit, authored_at, author, ...subject] = line.split('\t');
    return { commit, authored_at, author, subject: subject.join('\t') };
  });
  const details = {
    repo_root: canonical,
    branch,
    head,
    upstream,
    dirty: status.changed_paths.length > 0,
    ...status,
    recent_commits: recentCommits,
    repository_tree: trackedTree.sort()
  };
  return { ...details, state_hash: hash(details) };
}

export function refreshWorkspaceRepositories(db, workspaceId) {
  const roots = rows(db, `SELECT * FROM workspace_roots WHERE workspace_id=? AND indexing_enabled=1 ORDER BY created_at`, workspaceId);
  const repositoryRoots = roots.filter(root => root.root_kind === 'repository' || fs.existsSync(`${root.root_path}/.git`));
  const reasons = [];
  const states = [];
  for (const root of repositoryRoots) {
    try {
      const state = inspectRepositoryRoot(root.root_path);
      const id = `repo-state-${randomUUID()}`;
      const observedAt = new Date().toISOString();
      run(db, `INSERT INTO repository_states (id,workspace_id,root_id,branch,head_commit,upstream,dirty,state_hash,details_json,observed_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)`, id, workspaceId, root.id, state.branch, state.head, state.upstream, state.dirty ? 1 : 0, state.state_hash, JSON.stringify(state), observedAt);
      states.push({ id, root_id: root.id, observed_at: observedAt, ...state });
    } catch (error) {
      if (root.required_for_freshness) reasons.push({ code: 'REPOSITORY_REFRESH_FAILED', root_id: root.id, message: 'repository state could not be verified' });
    }
  }
  return { ok: reasons.length === 0, reasons, states, repo_state_hash: hash(states.map(state => ({ root_id: state.root_id, state_hash: state.state_hash }))) };
}

export function latestRepositoryState(db, workspaceId) {
  return row(db, 'SELECT * FROM repository_states WHERE workspace_id=? ORDER BY observed_at DESC LIMIT 1', workspaceId) || null;
}
