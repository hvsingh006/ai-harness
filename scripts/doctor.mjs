import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDatabase, row, storageForDatabase } from '../src/db.mjs';
import { workspaceStatus, isWithin } from '../src/dev-workspace.mjs';
import { HARNESS_VERSION } from '../src/version.mjs';

const checks = [];
function check(name, ok, detail = '') { checks.push({ name, ok: Boolean(ok), detail }); }

const [major, minor] = process.versions.node.split('.').map(Number);
check('Node.js', major > 22 || (major === 22 && minor >= 5), `v${process.versions.node} (requires >=22.5)`);

const development = workspaceStatus();
check('Development/private root separation', development.separation_ok,
  development.separation_ok ? `${development.development_root} | private: ${development.private_harness_root}` : development.separation_error);
if (development.repository.is_git) {
  check('Git repository', true, `${development.repository.root} · ${development.repository.branch} · ${development.repository.short_head}`);
  check('Runtime source matches Git checkout', development.repository.runtime_matches_repo, development.repository.root);
  check('Canonical repository path', development.repository.canonical,
    development.repository.canonical ? development.canonical_repo : `Current: ${development.repository.root} · canonical: ${development.canonical_repo}`);
} else {
  check('Git repository', false, `No .git checkout at runtime source ${development.repository.repo}`);
  check('Runtime source matches Git checkout', false, 'Runtime source is not a Git checkout.');
  check('Canonical repository path', false, development.canonical_repo);
}

let db = null;
let storage = null;
try {
  db = process.env.HARNESS_DB ? openDatabase(path.resolve(process.env.HARNESS_DB)) : openDatabase();
  storage = storageForDatabase(db);
  const workspaces = Number(row(db, 'SELECT COUNT(*) AS n FROM workspaces')?.n || 0);
  check('SQLite database', true, `${workspaces} workspace(s) · ${storage.dbPath}`);
  const requiredTables = ['workspace_roots','workspace_resources','resource_versions','resource_chunks','project_snapshots','outgoing_context_runs','companion_pairings'];
  const missing = requiredTables.filter(table => !row(db, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table));
  check('Context-integrity schema', missing.length === 0, missing.length ? `Missing: ${missing.join(', ')}` : 'roots, versions, chunks, snapshots, audit, and pairing tables present');
} catch (error) {
  check('SQLite database', false, error.message);
}

if (storage) {
  for (const [name, dir] of [
    ['Persistent workspace root', storage.workspaceRoot],
    ['Live Projects directory', storage.projectsDir],
    ['Archive directory', storage.archiveDir],
    ['Backups directory', storage.backupsDir],
    ['Vault directory', storage.vaultDir]
  ]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.doctor-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      check(name, true, dir);
    } catch (error) { check(name, false, error.message); }
  }
  const portableDatabase = Boolean(process.env.HARNESS_DB);
  check('Live/private project separation', portableDatabase || !isWithin(storage.projectsDir, storage.workspaceRoot),
    portableDatabase ? 'Explicit database keeps a portable project root.' : `${storage.projectsDir} | private: ${storage.workspaceRoot}`);
}

const pdfTool = spawnSync('pdftotext', ['-v'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
check('PDF text extractor', !pdfTool.error && [0, 1].includes(pdfTool.status), !pdfTool.error ? 'pdftotext available' : 'Not installed; required PDF indexing will fail closed.');

try {
  const response = await fetch('http://127.0.0.1:4317/api/health', { signal: AbortSignal.timeout(1200) });
  const health = response.ok ? await response.json() : null;
  check('Running Harness service', Boolean(response.ok), health ? `v${health.version}` : `HTTP ${response.status}`);
  if (response.ok) {
    const readyResponse = await fetch('http://127.0.0.1:4317/api/readiness', { signal: AbortSignal.timeout(1200) });
    const ready = readyResponse.ok ? await readyResponse.json() : null;
    check('Browser companion detected', Boolean(ready?.browser_companion_seen), ready?.browser_companion_seen ? `v${ready.browser_companion_version || 'unknown'}` : 'Open/refresh ChatGPT or Gemini after loading the extension');
  }
} catch {
  check('Running Harness service', false, 'Not running. This is normal before npm start.');
  check('Browser companion detected', false, 'Cannot be checked until the service is running.');
}

try { db?.close(); } catch {}

console.log(`\nAI Harness doctor v${HARNESS_VERSION}\n`);
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'WAIT'}  ${item.name}${item.detail ? ` - ${item.detail}` : ''}`);
const nonBlocking = new Set(['Running Harness service', 'Browser companion detected', 'PDF text extractor']);
const transitional = new Set(['Canonical repository path']);
const hardFailures = checks.filter(c => !c.ok && !nonBlocking.has(c.name) && !transitional.has(c.name));
console.log(hardFailures.length ? `\n${hardFailures.length} blocking check(s) failed.` : '\nCore installation checks passed.');
process.exitCode = hardFailures.length ? 1 : 0;
