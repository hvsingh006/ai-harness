import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, row, dataDir, vaultDir } from '../src/db.mjs';
import { HARNESS_VERSION } from '../src/version.mjs';

const checks = [];
function check(name, ok, detail = '') { checks.push({ name, ok: Boolean(ok), detail }); }

const [major, minor] = process.versions.node.split('.').map(Number);
check('Node.js', major > 22 || (major === 22 && minor >= 5), `v${process.versions.node} (requires >=22.5)`);

try {
  fs.mkdirSync(dataDir, { recursive: true });
  const probe = path.join(dataDir, `.doctor-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  check('Data directory writable', true, dataDir);
} catch (error) { check('Data directory writable', false, error.message); }

try {
  fs.mkdirSync(vaultDir, { recursive: true });
  const probe = path.join(vaultDir, `.doctor-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  check('Vault writable', true, vaultDir);
} catch (error) { check('Vault writable', false, error.message); }

try {
  const db = openDatabase();
  const workspaces = Number(row(db, 'SELECT COUNT(*) AS n FROM workspaces')?.n || 0);
  check('SQLite database', true, `${workspaces} workspace(s)`);
  db.close();
} catch (error) { check('SQLite database', false, error.message); }

try {
  const response = await fetch('http://127.0.0.1:4317/api/health', { signal: AbortSignal.timeout(1200) });
  const health = response.ok ? await response.json() : null;
  check('Running Harness service', Boolean(response.ok), health ? `v${health.version}` : `HTTP ${response.status}`);
  if (response.ok) {
    const readyResponse = await fetch('http://127.0.0.1:4317/api/readiness', { signal: AbortSignal.timeout(1200) });
    const ready = readyResponse.ok ? await readyResponse.json() : null;
    check('Browser companion detected', Boolean(ready?.browser_companion_seen), ready?.browser_companion_seen ? `v${ready.browser_companion_version || 'unknown'}` : 'Open/refresh ChatGPT, Gemini, or NotebookLM after loading the extension');
  }
} catch {
  check('Running Harness service', false, 'Not running. This is normal before npm start.');
  check('Browser companion detected', false, 'Cannot be checked until the service is running.');
}

console.log(`\nAI Harness doctor v${HARNESS_VERSION}\n`);
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'WAIT'}  ${item.name}${item.detail ? ` - ${item.detail}` : ''}`);
const hardFailures = checks.filter(c => !c.ok && !['Running Harness service','Browser companion detected'].includes(c.name));
console.log(hardFailures.length ? `\n${hardFailures.length} blocking check(s) failed.` : '\nCore installation checks passed.');
process.exitCode = hardFailures.length ? 1 : 0;
