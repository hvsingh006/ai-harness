import fs from 'node:fs';
import path from 'node:path';

export const PATH_POLICY_VERSION = '2026-08-16.1';

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.git', 'node_modules', '.next', '.nuxt', '.cache', 'coverage', 'dist', 'build',
  'target', '__pycache__', '.pytest_cache', '.mypy_cache', '.venv', 'venv'
]);

function comparisonPath(value) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isPathWithin(candidate, approvedRoot) {
  const child = comparisonPath(candidate);
  const root = comparisonPath(approvedRoot);
  const relative = path.relative(root, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function canonicalizeExistingPath(target) {
  const absolute = path.resolve(String(target || '').trim());
  if (!absolute || !fs.existsSync(absolute)) throw Object.assign(new Error('path does not exist'), { code: 'ROOT_UNAVAILABLE' });
  return fs.realpathSync.native(absolute);
}

export function normalizeRelativePath(value) {
  const input = String(value || '');
  if (!input || input.includes('\0') || /%2f|%5c|%2e/i.test(input)) {
    throw Object.assign(new Error('invalid relative path'), { code: 'ROOT_SECURITY_FAILURE' });
  }
  // Browser-facing relative paths use one separator convention. Rejecting the
  // alternate form avoids platform-dependent traversal interpretation.
  if (input.includes('\\') || path.isAbsolute(input) || /^[a-zA-Z]:/.test(input)) {
    throw Object.assign(new Error('absolute or alternate-separator path rejected'), { code: 'ROOT_SECURITY_FAILURE' });
  }
  const parts = input.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw Object.assign(new Error('path traversal rejected'), { code: 'ROOT_SECURITY_FAILURE' });
  }
  return parts.join('/');
}

export function resolveApprovedTarget(root, relativePath, { mustExist = true, expectedType = null } = {}) {
  if (!root?.root_path) throw Object.assign(new Error('approved root unavailable'), { code: 'ROOT_SECURITY_FAILURE' });
  const canonicalRoot = canonicalizeExistingPath(root.root_path);
  if (root.canonical_path && comparisonPath(root.canonical_path) !== comparisonPath(canonicalRoot)) {
    throw Object.assign(new Error('approved root canonical path changed'), { code: 'ROOT_SECURITY_FAILURE' });
  }
  const normalized = normalizeRelativePath(relativePath);
  const candidate = path.resolve(canonicalRoot, ...normalized.split('/'));
  if (!isPathWithin(candidate, canonicalRoot)) throw Object.assign(new Error('path escapes approved root'), { code: 'ROOT_SECURITY_FAILURE' });
  if (!mustExist) return { absolutePath: candidate, canonicalRoot, relativePath: normalized };
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) throw Object.assign(new Error('symbolic links are not followed'), { code: 'ROOT_SECURITY_FAILURE' });
  const real = fs.realpathSync.native(candidate);
  if (!isPathWithin(real, canonicalRoot)) throw Object.assign(new Error('canonical path escapes approved root'), { code: 'ROOT_SECURITY_FAILURE' });
  if (expectedType === 'file' && !stat.isFile()) throw Object.assign(new Error('approved target is not a file'), { code: 'ROOT_SECURITY_FAILURE' });
  if (expectedType === 'directory' && !stat.isDirectory()) throw Object.assign(new Error('approved target is not a directory'), { code: 'ROOT_SECURITY_FAILURE' });
  return { absolutePath: real, canonicalRoot, relativePath: normalized, stat };
}

export function verifyRegisteredRoot(root) {
  try {
    const canonical = canonicalizeExistingPath(root.root_path);
    const stat = fs.statSync(canonical);
    if (!stat.isDirectory()) throw Object.assign(new Error('approved root is not a directory'), { code: 'ROOT_UNAVAILABLE' });
    if (root.canonical_path && comparisonPath(root.canonical_path) !== comparisonPath(canonical)) {
      throw Object.assign(new Error('approved root canonical identity changed'), { code: 'ROOT_SECURITY_FAILURE' });
    }
    return { ok: true, canonicalPath: canonical, stat };
  } catch (error) {
    return { ok: false, code: error.code || 'ROOT_UNAVAILABLE', message: error.message };
  }
}

export function walkApprovedRoot(root, {
  maxFiles = 20000,
  maxDepth = 80,
  ignoredDirectories = DEFAULT_IGNORED_DIRECTORIES
} = {}) {
  const verified = verifyRegisteredRoot(root);
  if (!verified.ok) return { ...verified, files: [], skippedSymlinks: [], ignoredDirectories: [], truncated: false };
  const files = [];
  const skippedSymlinks = [];
  const ignored = [];
  let truncated = false;

  const walk = (directory, depth) => {
    if (truncated) return;
    if (depth > maxDepth) throw Object.assign(new Error('approved root exceeds safe traversal depth'), { code: 'ROOT_SECURITY_FAILURE' });
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(verified.canonicalPath, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        skippedSymlinks.push(relative);
        continue;
      }
      if (stat.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) {
          ignored.push(relative);
          continue;
        }
        const realDirectory = fs.realpathSync.native(absolute);
        if (!isPathWithin(realDirectory, verified.canonicalPath)) {
          throw Object.assign(new Error(`directory escapes approved root: ${relative}`), { code: 'ROOT_SECURITY_FAILURE' });
        }
        walk(realDirectory, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      const realFile = fs.realpathSync.native(absolute);
      if (!isPathWithin(realFile, verified.canonicalPath)) {
        throw Object.assign(new Error(`file escapes approved root: ${relative}`), { code: 'ROOT_SECURITY_FAILURE' });
      }
      files.push({ absolutePath: realFile, relativePath: relative, stat });
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
    }
  };

  try {
    walk(verified.canonicalPath, 0);
    return { ok: !truncated, code: truncated ? 'ROOT_SCAN_LIMIT' : '', message: truncated ? `root exceeds ${maxFiles} indexed files` : '', canonicalPath: verified.canonicalPath, files, skippedSymlinks, ignoredDirectories: ignored, truncated };
  } catch (error) {
    return { ok: false, code: error.code || 'ROOT_SECURITY_FAILURE', message: error.message, canonicalPath: verified.canonicalPath, files: [], skippedSymlinks, ignoredDirectories: ignored, truncated: false };
  }
}
