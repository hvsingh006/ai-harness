import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(__dirname, '..');

function normalize(value) {
  return path.resolve(String(value || '').trim());
}

export function defaultDevelopmentRoot() {
  if (process.env.AI_HARNESS_DEV_ROOT?.trim()) return normalize(process.env.AI_HARNESS_DEV_ROOT);
  return path.join(os.homedir(), 'Documents', 'AI Workspace', 'Projects');
}

export function canonicalHarnessRepo() {
  if (process.env.AI_HARNESS_REPO_ROOT?.trim()) return normalize(process.env.AI_HARNESS_REPO_ROOT);
  return path.join(defaultDevelopmentRoot(), 'ai-harness');
}

export function privateHarnessRoot() {
  if (process.env.HARNESS_WORKSPACE_ROOT?.trim()) return normalize(process.env.HARNESS_WORKSPACE_ROOT);
  return path.join(os.homedir(), 'Documents', 'AI Harness');
}

function comparable(value) {
  const resolved = normalize(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathEquals(a, b) {
  return comparable(a) === comparable(b);
}

export function isWithin(child, parent) {
  const resolvedChild = normalize(child);
  const resolvedParent = normalize(parent);
  const relative = path.relative(resolvedParent, resolvedChild);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertSeparatedRoots({ developmentRoot = defaultDevelopmentRoot(), privateRoot = privateHarnessRoot() } = {}) {
  if (isWithin(privateRoot, developmentRoot) || isWithin(developmentRoot, privateRoot)) {
    throw new Error(`AI development workspace (${developmentRoot}) and private Harness data (${privateRoot}) must be separate directory trees.`);
  }
  return true;
}

function git(repo, args, { optional = false } = {}) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000
    }).trim();
  } catch (error) {
    if (optional) return null;
    throw new Error(error.stderr?.trim() || error.message);
  }
}

export function inspectRepository(repoPath = appRoot) {
  const repo = normalize(repoPath);
  const exists = fs.existsSync(repo);
  if (!exists || !fs.existsSync(path.join(repo, '.git'))) {
    return { repo, exists, is_git: false, canonical: pathEquals(repo, canonicalHarnessRepo()) };
  }

  const root = git(repo, ['rev-parse', '--show-toplevel']);
  const branch = git(repo, ['branch', '--show-current'], { optional: true }) || '(detached)';
  const head = git(repo, ['rev-parse', 'HEAD']);
  const porcelain = git(repo, ['status', '--porcelain'], { optional: true }) || '';
  const origin = git(repo, ['remote', 'get-url', 'origin'], { optional: true });
  const upstream = git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { optional: true });
  let ahead = null;
  let behind = null;
  if (upstream) {
    const counts = git(repo, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`], { optional: true });
    if (counts) {
      const [upstreamOnly, localOnly] = counts.split(/\s+/).map(Number);
      behind = upstreamOnly;
      ahead = localOnly;
    }
  }

  return {
    repo,
    root: normalize(root),
    exists: true,
    is_git: true,
    canonical: pathEquals(root, canonicalHarnessRepo()),
    runtime_matches_repo: pathEquals(root, appRoot),
    branch,
    head,
    short_head: head.slice(0, 12),
    dirty: Boolean(porcelain),
    changed_paths: porcelain ? porcelain.split(/\r?\n/).filter(Boolean).length : 0,
    origin,
    upstream,
    ahead,
    behind
  };
}

export function workspaceStatus(repoPath = appRoot) {
  const developmentRoot = defaultDevelopmentRoot();
  const canonicalRepo = canonicalHarnessRepo();
  const privateRoot = privateHarnessRoot();
  let separationOk = true;
  let separationError = null;
  try { assertSeparatedRoots({ developmentRoot, privateRoot }); }
  catch (error) { separationOk = false; separationError = error.message; }

  return {
    development_root: developmentRoot,
    canonical_repo: canonicalRepo,
    private_harness_root: privateRoot,
    separation_ok: separationOk,
    separation_error: separationError,
    repository: inspectRepository(repoPath)
  };
}
