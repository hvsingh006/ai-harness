import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function stopServer(child, dir) {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'close'), new Promise(resolve => setTimeout(resolve, 2000))]);
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY'].includes(error.code) || attempt === 9) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

async function waitFor(url, attempts = 80) {
  for (let index = 0; index < attempts; index++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`service did not become ready: ${url}`);
}

async function pair(base) {
  const extensionId = 'a'.repeat(32);
  const challengeResponse = await fetch(`${base}/companion/pairing-challenge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(challengeResponse.status, 201);
  const challenge = await challengeResponse.json();
  const pairingResponse = await fetch(`${base}/companion/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AIH-Extension-Id': extensionId, Origin: `chrome-extension://${extensionId}` },
    body: JSON.stringify({ challenge: challenge.challenge, extension_id: extensionId })
  });
  assert.equal(pairingResponse.status, 201);
  const pairing = await pairingResponse.json();
  return { extensionId, token: pairing.token, headers: { 'Content-Type': 'application/json', 'X-AIH-Extension-Id': extensionId, 'X-AIH-Companion-Token': pairing.token, Origin: `chrome-extension://${extensionId}` } };
}

function capture(workspaceId, provider, chatId, messages = []) {
  return {
    workspace_id: workspaceId,
    provider,
    title: 'Server integration chat',
    native_url: provider === 'chatgpt' ? `https://chatgpt.com/c/${chatId}` : `https://gemini.google.com/app/${chatId}`,
    provider_refs: [{ ref_type: 'chat_id', ref_value: chatId, source: 'server-test' }],
    messages,
    assets: [],
    capture_evidence: {
      synchronized_visible: true,
      reached_top: true,
      stable_rounds: 2,
      visible_message_count: messages.length,
      first_message_fingerprint: 'first',
      last_message_fingerprint: 'last',
      capture_started_at: new Date().toISOString(),
      capture_completed_at: new Date().toISOString(),
      provider_adapter_version: `${provider}-server-test`,
      reason_if_partial: ''
    }
  };
}

test('server supports authenticated native continuity and verified prepare-send through real HTTP routes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-'));
  const dbPath = path.join(dir, 'test.db');
  const port = 45000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: path.resolve('.'),
    env: { ...process.env, HARNESS_DB: dbPath, HARNESS_PORT: String(port), HARNESS_PROJECTS_ROOT: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => stopServer(child, dir));

  const base = `http://127.0.0.1:${port}/api`;
  const healthResponse = await waitFor(`${base}/health`);
  assert.equal(healthResponse.headers.get('access-control-allow-origin'), null);
  const health = await healthResponse.json();
  assert.equal(health.ok, true, stderr);
  assert.equal(health.version, '0.8.0');
  assert.equal(path.resolve(health.storage.workspace_root), path.resolve(dir));
  assert.equal(path.resolve(health.storage.projects_dir), path.resolve(dir, 'Projects'));

  const createResponse = await fetch(`${base}/workspaces`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke project', kind: 'general', active_focus: 'Validate verified continuity' })
  });
  assert.equal(createResponse.status, 201);
  const workspace = await createResponse.json();
  assert.ok(workspace.roots.length >= 1);
  assert.ok(path.resolve(workspace.root_path).startsWith(path.resolve(dir, 'Projects')));

  const uploadResponse = await fetch(`${base}/workspaces/${workspace.id}/artifacts?name=requirements.md&relative_path=requirements.md&mime_type=text%2Fmarkdown`, {
    method: 'PUT', body: Buffer.from('Use the newest verified implementation')
  });
  assert.equal(uploadResponse.status, 201);

  const unauthenticated = await fetch(`${base}/companion/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauthenticated.status, 401);
  const paired = await pair(base);
  const wrongToken = await fetch(`${base}/companion/heartbeat`, { method: 'POST', headers: { ...paired.headers, 'X-AIH-Companion-Token': 'wrong' }, body: '{}' });
  assert.equal(wrongToken.status, 401);
  const wrongOrigin = await fetch(`${base}/companion/heartbeat`, { method: 'POST', headers: { ...paired.headers, Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(wrongOrigin.status, 401);

  const heartbeat = await fetch(`${base}/companion/heartbeat`, {
    method: 'POST', headers: paired.headers, body: JSON.stringify({ version: '0.8.0', provider: 'chatgpt' })
  });
  assert.equal(heartbeat.status, 200);
  assert.equal((await heartbeat.json()).ready_for_native_workflow, true);

  const captureResponse = await fetch(`${base}/companion/capture`, {
    method: 'POST', headers: paired.headers,
    body: JSON.stringify(capture(workspace.id, 'gemini', 'gemini-prior', [{ role: 'user', content: 'Gemini found a reset race in the old design.' }]))
  });
  assert.equal(captureResponse.status, 201);
  const captured = await captureResponse.json();
  assert.equal(captured.session.message_count, 1);

  const resolved = await fetch(`${base}/companion/provider-session?provider=gemini&chat_id=gemini-prior`, { headers: paired.headers });
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).id, captured.session.id);

  fs.writeFileSync(path.join(workspace.root_path, 'requirements.md'), 'Use the immediately updated implementation');
  const preparedResponse = await fetch(`${base}/companion/workspaces/${workspace.id}/prepare-send`, {
    method: 'POST', headers: paired.headers,
    body: JSON.stringify({ provider: 'chatgpt', user_prompt: 'What should we implement now?', capture: capture(workspace.id, 'chatgpt', 'new-chat', []) })
  });
  assert.equal(preparedResponse.status, 200);
  const prepared = await preparedResponse.json();
  assert.equal(prepared.freshness, 'current');
  assert.match(prepared.provider_text, /immediately updated implementation/);
  assert.match(prepared.provider_text, /Gemini found a reset race/);
  assert.ok(prepared.provenance.some(source => source.provenance.path === 'requirements.md'));

  const sent = await fetch(`${base}/companion/outgoing-context/${prepared.run_id}/sent`, { method: 'POST', headers: paired.headers, body: '{}' });
  assert.equal(sent.status, 200);
  const audit = await (await fetch(`${base}/outgoing-context/${prepared.run_id}`)).json();
  assert.equal(audit.status, 'sent');
  assert.equal(audit.snapshot_id, prepared.snapshot_id);
  assert.ok(audit.sources.length > 0);

  const png = Buffer.alloc(24);
  png.writeUInt8(0x89, 0); png.write('PNG', 1, 'ascii'); png.writeUInt32BE(64, 16); png.writeUInt32BE(32, 20);
  const imageUpload = await fetch(`${base}/workspaces/${workspace.id}/artifacts?name=diagram.png&relative_path=diagram.png&mime_type=image%2Fpng`, { method: 'PUT', body: png });
  assert.equal(imageUpload.status, 201);
  const visualPrepare = await fetch(`${base}/companion/workspaces/${workspace.id}/prepare-send`, {
    method: 'POST', headers: paired.headers,
    body: JSON.stringify({ provider: 'chatgpt', user_prompt: 'Inspect the visual layout in diagram.png', capture: capture(workspace.id, 'chatgpt', 'visual-chat', []) })
  });
  assert.equal(visualPrepare.status, 200);
  const visual = await visualPrepare.json();
  assert.equal(visual.attachments.length, 1);
  const unauthAsset = await fetch(`${base}${visual.attachments[0].download_path}`);
  assert.equal(unauthAsset.status, 401);
  const currentAsset = await fetch(`${base}${visual.attachments[0].download_path}`, { headers: paired.headers });
  assert.equal(currentAsset.status, 200);
  assert.deepEqual(Buffer.from(await currentAsset.arrayBuffer()), png);

  const arbitraryPath = await fetch(`${base}/companion/read-file?path=${encodeURIComponent('C:\\Windows\\win.ini')}`, { headers: paired.headers });
  assert.equal(arbitraryPath.status, 404);
  assert.equal((await arbitraryPath.json()).error, 'not found');
});

test('server prepare-send returns precondition failure and no cached context when a required root is unavailable', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-blocked-'));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-linked-'));
  const port = 55000 + Math.floor(Math.random() * 5000);
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: path.resolve('.'), env: { ...process.env, HARNESS_DB: path.join(dir, 'test.db'), HARNESS_PORT: String(port), HARNESS_PROJECTS_ROOT: '' }, stdio: 'ignore' });
  t.after(async () => {
    await stopServer(child, dir);
    fs.rmSync(external, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}/api`;
  await waitFor(`${base}/health`);
  const workspace = await (await fetch(`${base}/active-workspace`)).json();
  const linked = path.join(external, 'linked');
  const offline = path.join(external, 'offline');
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(linked, 'needed.md'), 'needed');
  const rootResponse = await fetch(`${base}/workspaces/${workspace.id}/roots`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: linked, required_for_freshness: true }) });
  assert.equal(rootResponse.status, 201);
  const paired = await pair(base);
  const first = await fetch(`${base}/companion/workspaces/${workspace.id}/prepare-send`, { method: 'POST', headers: paired.headers, body: JSON.stringify({ provider: 'chatgpt', user_prompt: 'Use needed.md', capture: capture(workspace.id, 'chatgpt', 'blocked-chat', []) }) });
  assert.equal(first.status, 200);
  fs.renameSync(linked, offline);
  const blocked = await fetch(`${base}/companion/workspaces/${workspace.id}/prepare-send`, { method: 'POST', headers: paired.headers, body: JSON.stringify({ provider: 'chatgpt', user_prompt: 'Use needed.md again', capture: capture(workspace.id, 'chatgpt', 'blocked-chat', []) }) });
  assert.equal(blocked.status, 412);
  const payload = await blocked.json();
  assert.equal(payload.ok, false);
  assert.ok(payload.reasons.some(reason => reason.code === 'ROOT_UNAVAILABLE'));
  assert.equal('provider_text' in payload, false);
});
