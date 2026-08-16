import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';

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
      protocol_version: 3,
      capabilities: { ok: true, established_conversation: false, composer: true, send: true, messages: messages.length, failures: [] },
      reason_if_partial: ''
    }
  };
}

function prepareBody(provider, prompt, captured, attemptId = `attempt-${crypto.randomUUID()}`) {
  return { provider, user_prompt: prompt, capture: captured, attempt_id: attemptId,
    prompt_hash: crypto.createHash('sha256').update(prompt).digest('hex'), route: captured.native_url, protocol_version: 3 };
}

function putWithDeclaredLength(target, headers, length) {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'PUT', headers: { ...headers, 'Content-Length': String(length) } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: body ? JSON.parse(body) : {} }));
    });
    request.on('error', reject);
    request.end();
  });
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
    method: 'POST', headers: paired.headers, body: JSON.stringify({ version: '0.8.0', protocol_version: 3, provider: 'chatgpt', metadata: { capabilities: { ok: true } } })
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

  const incompatible = prepareBody('chatgpt', 'protocol check', capture(workspace.id, 'chatgpt', 'protocol-chat', []));
  incompatible.protocol_version = 2;
  const incompatibleResponse = await fetch(`${base}/companion/workspaces/${workspace.id}/prepare-send`, { method: 'POST', headers: paired.headers, body: JSON.stringify(incompatible) });
  assert.equal(incompatibleResponse.status, 409);
  assert.equal((await incompatibleResponse.json()).reasons[0].code, 'COMPANION_PROTOCOL_MISMATCH');

  const emptyEstablished = prepareBody('chatgpt', 'empty extraction check', capture(workspace.id, 'chatgpt', 'empty-established', []));
  emptyEstablished.capture.capture_evidence.capabilities = { ok: false, established_conversation: true, messages: 0, failures: [{ code: 'PROVIDER_MESSAGE_EXTRACTION_EMPTY', capability: 'messages' }] };
  const emptyResponse = await fetch(`${base}/companion/workspaces/${workspace.id}/prepare-send`, { method: 'POST', headers: paired.headers, body: JSON.stringify(emptyEstablished) });
  assert.equal(emptyResponse.status, 412);
  assert.equal((await emptyResponse.json()).reasons[0].code, 'PROVIDER_MESSAGE_EXTRACTION_EMPTY');

  const assetCaptureBody = capture(workspace.id, 'chatgpt', 'asset-chat', [{ role: 'assistant', content: 'generated file' }]);
  assetCaptureBody.assets = [{ asset_type: 'image', name: 'generated.png', url: 'https://files.oaiusercontent.com/generated.png', native_id: 'asset-native-1', mime_type: 'image/png' }];
  const assetCaptureResponse = await fetch(`${base}/companion/capture`, { method: 'POST', headers: paired.headers, body: JSON.stringify(assetCaptureBody) });
  assert.equal(assetCaptureResponse.status, 201);
  const assetCapture = await assetCaptureResponse.json();
  const discoveredAsset = assetCapture.asset_refs.find(item => item.native_id === 'asset-native-1');
  assert.equal(discoveredAsset.mirror_status, 'DISCOVERED');
  const descriptorResponse = await fetch(`${base}/companion/session-assets/${discoveredAsset.id}/source`, { headers: paired.headers });
  assert.equal(descriptorResponse.status, 200);
  const descriptor = await descriptorResponse.json();
  assert.equal(descriptor.source_url, discoveredAsset.source_url);
  assert.equal(descriptor.capture_strategy, 'background_https');
  const duplicateCapture = await (await fetch(`${base}/companion/capture`, { method: 'POST', headers: paired.headers, body: JSON.stringify(assetCaptureBody) })).json();
  assert.equal(duplicateCapture.asset_refs.filter(item => item.native_id === 'asset-native-1').length, 1);
  assert.equal(duplicateCapture.asset_refs.find(item => item.native_id === 'asset-native-1').id, discoveredAsset.id);
  const unauthMirror = await fetch(`${base}/companion/session-assets/${discoveredAsset.id}/content`, { method: 'PUT', body: Buffer.from('image') });
  assert.equal(unauthMirror.status, 401);
  const wrongSourceMirror = await fetch(`${base}/companion/session-assets/${discoveredAsset.id}/content`, { method: 'PUT', headers: { ...paired.headers, 'Content-Type': 'image/png', 'X-AIH-Asset-Source-Url': 'https://evil.example/generated.png', 'X-AIH-Asset-Capture-Strategy': 'background_https' }, body: Buffer.from('image') });
  assert.equal(wrongSourceMirror.status, 403);
  const mimeMismatch = await fetch(`${base}/companion/session-assets/${discoveredAsset.id}/content`, { method: 'PUT', headers: { ...paired.headers, 'Content-Type': 'application/pdf', 'X-AIH-Asset-Source-Url': discoveredAsset.source_url, 'X-AIH-Asset-Capture-Strategy': 'background_https' }, body: Buffer.from('not a png') });
  assert.equal(mimeMismatch.status, 415);
  const failedSession = await (await fetch(`${base}/sessions/${assetCapture.session.id}`)).json();
  assert.equal(failedSession.assets.find(item => item.id === discoveredAsset.id).mirror_status, 'FAILED');
  assert.equal(failedSession.capture_stages.find(item => item.stage === 'attachments').status, 'pending');
  const retriedAfterMime = await (await fetch(`${base}/companion/capture`, { method: 'POST', headers: paired.headers, body: JSON.stringify(assetCaptureBody) })).json();
  assert.equal(retriedAfterMime.asset_refs.find(item => item.id === discoveredAsset.id).mirror_status, 'DISCOVERED');
  const oversized = await putWithDeclaredLength(`${base}/companion/session-assets/${discoveredAsset.id}/content`, { ...paired.headers, 'Content-Type': 'image/png', 'X-AIH-Asset-Source-Url': discoveredAsset.source_url, 'X-AIH-Asset-Capture-Strategy': 'background_https' }, 100 * 1024 * 1024 + 1);
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, 'ASSET_TOO_LARGE');
  await fetch(`${base}/companion/capture`, { method: 'POST', headers: paired.headers, body: JSON.stringify(assetCaptureBody) });
  const expired = await fetch(`${base}/companion/session-assets/${discoveredAsset.id}/status`, { method: 'POST', headers: paired.headers, body: JSON.stringify({ status: 'EXPIRED', message: 'signed URL expired' }) });
  assert.equal(expired.status, 200);
  assert.equal((await fetch(`${base}/companion/session-assets/${discoveredAsset.id}/source`, { headers: paired.headers })).status, 409);
  await fetch(`${base}/companion/capture`, { method: 'POST', headers: paired.headers, body: JSON.stringify(assetCaptureBody) });
  const mirrored = await fetch(`${base}/companion/session-assets/${discoveredAsset.id}/content`, { method: 'PUT', headers: { ...paired.headers, 'Content-Type': 'image/png', 'X-AIH-Asset-Source-Url': discoveredAsset.source_url, 'X-AIH-Asset-Capture-Strategy': 'background_https' }, body: Buffer.from('image') });
  assert.equal(mirrored.status, 201);
  assert.equal((await mirrored.json()).attachments_complete, true);

  fs.writeFileSync(path.join(workspace.root_path, 'requirements.md'), 'Use the immediately updated implementation');
  const preparedResponse = await fetch(`${base}/companion/workspaces/${workspace.id}/prepare-send`, {
    method: 'POST', headers: paired.headers,
    body: JSON.stringify(prepareBody('chatgpt', 'What should we implement now?', capture(workspace.id, 'chatgpt', 'new-chat', [])))
  });
  assert.equal(preparedResponse.status, 200);
  const prepared = await preparedResponse.json();
  assert.equal(prepared.freshness, 'current');
  assert.match(prepared.provider_text, /immediately updated implementation/);
  assert.match(prepared.provider_text, /Gemini found a reset race/);
  assert.ok(prepared.provenance.some(source => source.provenance.path === 'requirements.md'));

  const sent = await fetch(`${base}/companion/outgoing-context/${prepared.run_id}/sent`, { method: 'POST', headers: paired.headers,
    body: JSON.stringify({ attempt_id: prepared.attempt_id, prompt_hash: prepared.prompt_hash, route: prepared.provider_route, protocol_version: 3, acceptance: { accepted: true, certainty: 'strong', signals: { message_count_increased: true } } }) });
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
    body: JSON.stringify(prepareBody('chatgpt', 'Inspect the visual layout in diagram.png', capture(workspace.id, 'chatgpt', 'visual-chat', [])))
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
  const firstCapture = capture(workspace.id, 'chatgpt', 'blocked-chat', []);
  const first = await fetch(`${base}/companion/workspaces/${workspace.id}/prepare-send`, { method: 'POST', headers: paired.headers, body: JSON.stringify(prepareBody('chatgpt', 'Use needed.md', firstCapture)) });
  assert.equal(first.status, 200);
  fs.renameSync(linked, offline);
  const blockedCapture = capture(workspace.id, 'chatgpt', 'blocked-chat', []);
  const blocked = await fetch(`${base}/companion/workspaces/${workspace.id}/prepare-send`, { method: 'POST', headers: paired.headers, body: JSON.stringify(prepareBody('chatgpt', 'Use needed.md again', blockedCapture)) });
  assert.equal(blocked.status, 412);
  const payload = await blocked.json();
  assert.equal(payload.ok, false);
  assert.ok(payload.reasons.some(reason => reason.code === 'ROOT_UNAVAILABLE'));
  assert.equal('provider_text' in payload, false);
  const roots = await (await fetch(`${base}/workspaces/${workspace.id}/roots`)).json();
  const linkedRoot = roots.find(item => path.resolve(item.root_path) === path.resolve(linked));
  const archivedBeforeRemoval = (await (await fetch(`${base}/workspaces/${workspace.id}`)).json()).archive.artifacts;
  const removed = await fetch(`${base}/workspace-roots/${linkedRoot.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).archive_preserved, true);
  assert.equal((await (await fetch(`${base}/workspaces/${workspace.id}/roots`)).json()).some(item => item.id === linkedRoot.id), false);
  assert.equal((await (await fetch(`${base}/workspaces/${workspace.id}`)).json()).archive.artifacts, archivedBeforeRemoval);
});
