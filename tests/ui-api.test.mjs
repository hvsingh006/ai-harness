import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function waitFor(url, attempts = 100) {
  for (let index = 0; index < attempts; index++) {
    try { const response = await fetch(url); if (response.ok) return response; } catch {}
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`service did not become ready: ${url}`);
}

async function stop(child, directory) {
  if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'close'), new Promise(resolve => setTimeout(resolve, 2000))]); }
  fs.rmSync(directory, { recursive: true, force: true });
}

async function json(base, route, options = {}) {
  const mutation = options.method && !['GET','HEAD'].includes(options.method);
  const response = await fetch(`${base}${route}`, { ...options, headers: { 'Content-Type': 'application/json', ...(mutation ? { Origin: new URL(base).origin } : {}), ...(options.headers || {}) } });
  const body = await response.json();
  return { response, body };
}

async function pollJob(base, id) {
  for (let index = 0; index < 100; index++) {
    const { body } = await json(base, `/jobs/${id}`);
    if (['completed','failed'].includes(body.status)) return body;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('job did not complete');
}

test('normal control-plane workflows are exposed through narrow UI APIs with no generic shell or arbitrary path endpoint', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-ui-api-'));
  const port = 46000 + Math.floor(Math.random() * 8000);
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: path.resolve('.'), env: { ...process.env, HARNESS_DB: path.join(directory, 'harness.db'), HARNESS_PORT: String(port), HARNESS_PROJECTS_ROOT: '' }, stdio: ['ignore','pipe','pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => stop(child, directory));
  const base = `http://127.0.0.1:${port}/api`;
  await waitFor(`${base}/health`);

  const appSource = fs.readFileSync('public/app.js', 'utf8');
  const serverSource = fs.readFileSync('src/server.mjs', 'utf8');
  assert.doesNotMatch(appSource, /\bprompt\s*\(/);
  assert.doesNotMatch(serverSource, /\/api\/(?:shell|exec|command|filesystem)/);
  assert.match(appSource, /data-view="resources"|renderResources/);
  assert.match(appSource, /renderInstructions/);
  assert.match(appSource, /renderSecurity/);
  assert.match(appSource, /sourceDialog/);
  assert.match(appSource, /removeWorkspace/);
  assert.match(appSource, /viewInstructionHistory/);
  assert.match(appSource, /data-cancel-job/);
  assert.doesNotMatch(appSource, /Is this source a Git repository/);

  for (const route of ['/health','/tools','/surfaces','/security']) assert.equal((await fetch(`${base}${route}`)).status, 200, `${route}: ${stderr}`);
  const created = await json(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'UI-only project', active_focus: 'Demo the complete UI path' }) });
  assert.equal(created.response.status, 201);
  const workspace = created.body;

  const instructions1 = await json(base, `/workspaces/${workspace.id}/instructions`, { method: 'PUT', body: JSON.stringify({ content: 'Use verified current sources.' }) });
  const instructions2 = await json(base, `/workspaces/${workspace.id}/instructions`, { method: 'PUT', body: JSON.stringify({ content: 'Use verified current sources and show provenance.' }) });
  assert.equal(instructions1.response.status, 200);
  assert.equal(instructions2.body.version_number, instructions1.body.version_number + 1);
  const globalProfile = await json(base, '/personalization', { method: 'PUT', body: JSON.stringify({ profile: { response_style: 'direct' }, notes: 'UI configured' }) });
  const projectProfile = await json(base, `/workspaces/${workspace.id}/personalization`, { method: 'PUT', body: JSON.stringify({ profile: { detail_level: 'thorough' }, notes: 'Project override' }) });
  assert.equal(globalProfile.response?.status, 200);
  assert.equal(projectProfile.response.status, 200);
  const editHistory = (await json(base, `/workspaces/${workspace.id}/instruction-history`)).body;
  assert.equal(editHistory.instructions.length, 2);
  assert.equal(editHistory.instructions[0].content, 'Use verified current sources and show provenance.');

  const upload = await fetch(`${base}/workspaces/${workspace.id}/artifacts?name=demo.md&relative_path=demo.md&mime_type=text%2Fmarkdown`, { method: 'PUT', headers: { Origin: new URL(base).origin }, body: Buffer.from('UI source version one') });
  assert.equal(upload.status, 201);
  const verify = await json(base, `/workspaces/${workspace.id}/jobs`, { method: 'POST', body: JSON.stringify({ job_type: 'verify_sources' }) });
  assert.equal(verify.response.status, 202);
  const verifyResult = await pollJob(base, verify.body.id);
  assert.equal(verifyResult.status, 'completed', JSON.stringify(verifyResult));
  const summary = (await json(base, `/workspaces/${workspace.id}`)).body;
  assert.ok(summary.resources.some(item => item.relative_path === 'demo.md'));
  assert.ok(summary.representation_coverage);
  const resource = summary.resources.find(item => item.relative_path === 'demo.md');
  const detail = await json(base, `/resources/${resource.id}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.versions.length, 1);
  assert.ok(detail.body.representations.some(item => item.representation_kind === 'original_source'));

  const primaryRoot = summary.roots.find(item => item.root_kind === 'primary');
  const priorityPolicy = await json(base, `/resources/${resource.id}/policy`, { method: 'PATCH', body: JSON.stringify({ priority_status: 'priority', context_critical: true }) });
  assert.equal(priorityPolicy.response.status, 200);
  assert.equal(priorityPolicy.body.priority_status, 'priority');
  assert.equal(priorityPolicy.body.context_critical, 1);
  const supersededPolicy = await json(base, `/resources/${resource.id}/policy`, { method: 'PATCH', body: JSON.stringify({ knowledge_status: 'superseded' }) });
  assert.equal(supersededPolicy.body.knowledge_status, 'superseded');
  await json(base, `/resources/${resource.id}/policy`, { method: 'PATCH', body: JSON.stringify({ knowledge_status: 'active' }) });
  const savedCopy = await json(base, `/resources/${resource.id}/save-copy`, { method: 'POST', body: JSON.stringify({ root_id: primaryRoot.id, relative_path: 'imports/demo-copy.md' }) });
  assert.equal(savedCopy.response.status, 201);
  assert.equal(savedCopy.body.destination_relative_path, 'imports/demo-copy.md');
  const conflictCopy = await json(base, `/resources/${resource.id}/save-copy`, { method: 'POST', body: JSON.stringify({ root_id: primaryRoot.id, relative_path: 'imports/demo-copy.md' }) });
  assert.equal(conflictCopy.response.status, 409);
  assert.equal(conflictCopy.body.code, 'DESTINATION_CONFLICT');
  const localOnlyPolicy = await json(base, `/workspace-roots/${primaryRoot.id}/policy`, { method: 'PUT', body: JSON.stringify({
    required_for_freshness: true, indexing_enabled: true, transmission_policy: 'local_only'
  }) });
  assert.equal(localOnlyPolicy.response.status, 200);
  const reprocess = await json(base, `/workspaces/${workspace.id}/jobs`, { method: 'POST', body: JSON.stringify({ job_type: 'reprocess_resource', target_id: resource.id }) });
  assert.equal((await pollJob(base, reprocess.body.id)).status, 'completed');
  const reprocessed = (await json(base, `/workspaces/${workspace.id}`)).body.resources.find(item => item.id === resource.id);
  assert.equal(reprocessed.provider_transmission_allowed, 0, 'reprocessing must not weaken the root transmission policy');
  const diagnostics = await json(base, `/workspaces/${workspace.id}/jobs`, { method: 'POST', body: JSON.stringify({ job_type: 'run_diagnostics' }) });
  assert.equal((await pollJob(base, diagnostics.body.id)).status, 'completed');
  const backup = await json(base, `/workspaces/${workspace.id}/jobs`, { method: 'POST', body: JSON.stringify({ job_type: 'create_backup' }) });
  assert.equal((await pollJob(base, backup.body.id)).status, 'completed');
  const unknown = await json(base, `/workspaces/${workspace.id}/jobs`, { method: 'POST', body: JSON.stringify({ job_type: 'run_command', command: 'whoami' }) });
  assert.equal(unknown.response.status, 400);
  assert.equal(unknown.body.code, 'JOB_TYPE_UNSUPPORTED');
  assert.equal((await fetch(`${base}/agent-context/status`)).status, 401);

  const replacement = await json(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Replacement project' }) });
  assert.equal(replacement.response.status, 201);
  assert.equal((await json(base, '/active-workspace', { method: 'PUT', body: JSON.stringify({ workspace_id: workspace.id }) })).response.status, 200);
  const removed = await json(base, `/workspaces/${workspace.id}`, { method: 'DELETE', body: '{}' });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.live_files_deleted, false);
  assert.equal(removed.body.archive_preserved, true);
  assert.equal(fs.existsSync(workspace.root_path), true);
  assert.equal((await json(base, `/workspaces/${workspace.id}`)).response.status, 404);
  assert.notEqual((await json(base, '/active-workspace')).body.id, workspace.id);
  assert.equal((await json(base, '/workspaces')).body.some(item => item.id === workspace.id), false);
});
