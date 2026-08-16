import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(__dirname, '..');
export const legacyDataDir = path.join(appRoot, 'data');

function normalizeAbsolute(value) {
  return path.resolve(String(value || '').trim());
}

export function defaultWorkspaceRoot() {
  if (process.env.HARNESS_WORKSPACE_ROOT?.trim()) return normalizeAbsolute(process.env.HARNESS_WORKSPACE_ROOT);
  const home = os.homedir();
  return path.join(home, 'Documents', 'AI Harness');
}

export function defaultProjectsRoot() {
  if (process.env.HARNESS_PROJECTS_ROOT?.trim()) return normalizeAbsolute(process.env.HARNESS_PROJECTS_ROOT);
  const home = os.homedir();
  return path.join(home, 'Documents', 'AI Workspace', 'Projects');
}

export function resolveWorkspaceRoot({ dbPath = null } = {}) {
  if (dbPath) return path.dirname(normalizeAbsolute(dbPath));
  if (process.env.HARNESS_WORKSPACE_ROOT?.trim()) return normalizeAbsolute(process.env.HARNESS_WORKSPACE_ROOT);
  return defaultWorkspaceRoot();
}

export function resolveProjectsRoot({ workspaceRoot = defaultWorkspaceRoot(), dbPath = null } = {}) {
  if (process.env.HARNESS_PROJECTS_ROOT?.trim()) return normalizeAbsolute(process.env.HARNESS_PROJECTS_ROOT);
  // An explicit database is normally a test, portable, or recovery instance. Keep
  // its live projects beside that database instead of touching the user's default.
  if (dbPath) return path.join(normalizeAbsolute(workspaceRoot), 'Projects');
  return defaultProjectsRoot();
}

export function buildStoragePaths(workspaceRoot = defaultWorkspaceRoot(), projectsRoot = null) {
  const root = normalizeAbsolute(workspaceRoot);
  const liveProjectsRoot = normalizeAbsolute(projectsRoot || defaultProjectsRoot());
  return {
    workspaceRoot: root,
    projectsDir: liveProjectsRoot,
    legacyProjectsDir: path.join(root, 'Projects'),
    libraryDir: path.join(root, 'Library'),
    archiveDir: path.join(root, 'Archive'),
    backupsDir: path.join(root, 'Backups'),
    runtimeDir: path.join(root, '.harness'),
    importsDir: path.join(root, 'Archive', 'Imports'),
    stagingDir: path.join(root, '.harness', 'staging'),
    vaultDir: path.join(root, 'Archive', 'Vault'),
    dbPath: path.join(root, 'harness.db')
  };
}

function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function assertSafeWorkspaceRoot(workspaceRoot) {
  const root = normalizeAbsolute(workspaceRoot);
  if (isWithin(root, appRoot)) {
    throw new Error(`Unsafe workspace root: ${root}. Persistent AI Harness data must live outside the application checkout (${appRoot}) so updates cannot overwrite projects or history.`);
  }
  return root;
}

export function assertSafeProjectsRoot(projectsRoot, workspaceRoot = defaultWorkspaceRoot()) {
  const root = normalizeAbsolute(projectsRoot);
  const privateRoot = normalizeAbsolute(workspaceRoot);
  if (isWithin(root, privateRoot) && root !== path.join(privateRoot, 'Projects')) {
    throw new Error(`Unsafe projects root: ${root}. Live Project Space material must use a dedicated project parent, not a private Harness state subdirectory.`);
  }
  return root;
}

export function ensureStorageLayout(paths) {
  assertSafeWorkspaceRoot(paths.workspaceRoot);
  assertSafeProjectsRoot(paths.projectsDir, paths.workspaceRoot);
  for (const dir of [
    paths.workspaceRoot,
    paths.projectsDir,
    paths.libraryDir,
    paths.archiveDir,
    paths.backupsDir,
    paths.runtimeDir,
    paths.importsDir,
    paths.stagingDir,
    paths.vaultDir
  ]) fs.mkdirSync(dir, { recursive: true });
  return paths;
}

function copyTree(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: false });
}

export function migrateLegacyData(paths) {
  const oldDb = path.join(legacyDataDir, 'harness.db');
  if (fs.existsSync(paths.dbPath) || !fs.existsSync(oldDb)) return { migrated: false };

  ensureStorageLayout(paths);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(paths.backupsDir, `legacy-app-data-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${oldDb}${suffix}`;
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, `${paths.dbPath}${suffix}`);
      fs.copyFileSync(source, path.join(backupDir, `harness.db${suffix}`));
    }
  }

  const oldVault = path.join(legacyDataDir, 'vault');
  const oldImports = path.join(legacyDataDir, 'imports');
  if (fs.existsSync(oldVault)) {
    copyTree(oldVault, paths.vaultDir);
    copyTree(oldVault, path.join(backupDir, 'vault'));
  }
  if (fs.existsSync(oldImports)) copyTree(oldImports, path.join(backupDir, 'imports'));

  fs.writeFileSync(path.join(paths.runtimeDir, 'legacy-migration.json'), JSON.stringify({
    migrated_at: new Date().toISOString(),
    from: legacyDataDir,
    to: paths.workspaceRoot,
    backup: backupDir
  }, null, 2));

  return { migrated: true, from: legacyDataDir, to: paths.workspaceRoot, backup: backupDir };
}

export function safeFolderName(name, fallback = 'Project') {
  let value = String(name || '').trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  if (!value) value = fallback;
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (reserved.test(value)) value = `${value}-project`;
  return value;
}
