import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { row } from './db.mjs';
import { canonicalizeExistingPath } from './security/paths.mjs';
import { inspectRepositoryRoot } from './repository.mjs';
import { createAgentContextSession, revokeAgentContextSession } from './agent-context.mjs';

const AGENTS = Object.freeze({
  codex: { command: 'codex', display: 'Codex' },
  antigravity: { command: 'agy', display: 'Antigravity' }
});
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function findAgentExecutable(agent) {
  const definition = AGENTS[agent];
  if (!definition) return null;
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const candidates = execFileSync(locator, [definition.command], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    return candidates.find(candidate => fs.existsSync(candidate)) || null;
  } catch { return null; }
}

export function agentCapabilities() {
  return Object.fromEntries(Object.entries(AGENTS).map(([id, definition]) => {
    const executable = findAgentExecutable(id);
    return [id, { id, display: definition.display, available: Boolean(executable), executable: executable ? path.basename(executable) : '', code: executable ? 'AVAILABLE' : 'TOOL_NOT_INSTALLED' }];
  }));
}

export function resolveRegisteredRepositoryForAgent(db, { workspaceId, rootId }) {
  const root = row(db, 'SELECT * FROM workspace_roots WHERE id=? AND workspace_id=?', rootId, workspaceId);
  if (!root) throw Object.assign(new Error('registered Project Space root not found'), { code: 'AGENT_ROOT_NOT_REGISTERED' });
  if (root.root_kind !== 'repository') throw Object.assign(new Error('selected root is not registered as a repository'), { code: 'AGENT_ROOT_NOT_REPOSITORY' });
  const canonical = canonicalizeExistingPath(root.root_path);
  if (!root.canonical_path || comparable(root.canonical_path) !== comparable(canonical)) throw Object.assign(new Error('registered repository canonical identity changed'), { code: 'AGENT_ROOT_IDENTITY_CHANGED' });
  const state = inspectRepositoryRoot(canonical);
  return { root, canonical, state };
}

export function launchRegisteredAgent(db, { workspaceId, rootId, agent }) {
  const definition = AGENTS[agent];
  if (!definition) throw Object.assign(new Error('unsupported local coding agent'), { code: 'AGENT_UNSUPPORTED' });
  const selected = resolveRegisteredRepositoryForAgent(db, { workspaceId, rootId });
  const executable = findAgentExecutable(agent);
  if (!executable) throw Object.assign(new Error(`${definition.display} is not installed or is not on PATH`), { code: 'TOOL_NOT_INSTALLED' });
  const context = createAgentContextSession(db, { workspaceId, rootId, agent });
  const childEnvironment = {
    ...process.env,
    AIH_CONTEXT_URL: `http://127.0.0.1:${Number(process.env.HARNESS_PORT || 4317)}/api/agent-context`,
    AIH_CONTEXT_TOKEN: context.token,
    AIH_CONTEXT_SESSION_ID: context.id,
    AIH_CONTEXT_HELPER: path.join(appRoot, 'scripts', 'aih-context.mjs')
  };
  let child;
  try {
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
      let terminal = null;
      try { terminal = execFileSync('where.exe', ['wt.exe'], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).find(Boolean)?.trim(); } catch {}
      if (!terminal) throw Object.assign(new Error('Windows Terminal is required to launch this command shim without a shell'), { code: 'AGENT_TERMINAL_UNAVAILABLE' });
      child = spawn(terminal, ['-d', selected.canonical, executable], { cwd: selected.canonical, detached: true, windowsHide: false, stdio: 'ignore', env: childEnvironment });
    } else {
      child = spawn(executable, [], { cwd: selected.canonical, detached: true, windowsHide: false, stdio: 'ignore', env: childEnvironment });
    }
  } catch (error) {
    revokeAgentContextSession(db, context.id);
    throw error;
  }
  child.unref();
  return { ok: true, agent, workspace_id: workspaceId, root_id: rootId, repository: selected.canonical, pid: child.pid, branch: selected.state.branch, head: selected.state.head, context_session_id: context.id, context_expires_at: context.expires_at, context_capabilities: context.capabilities };
}
