import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
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
  const challengeResponse = await fetch(`${base}/companion/pairing-challenge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin }, body: '{}' });
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
      protocol_version: 4,
      capabilities: { ok: true, surface_id: `${provider}.web`, established_conversation: false, composer: true, send: true, messages: messages.length, failures: [] },
      reason_if_partial: ''
    }
  };
}

function prepareBody(provider, prompt, captured, attemptId = `attempt-${crypto.randomUUID()}`) {
  return { provider, surface_id: `${provider}.web`, user_prompt: prompt, capture: captured, attempt_id: attemptId,
    prompt_hash: crypto.createHash('sha256').update(prompt).digest('hex'), route: captured.native_url, protocol_version: 4 };
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

function createTextImage(filePath, text) {
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Drawing
    $bitmap = New-Object System.Drawing.Bitmap 1400,360
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::White)
    $font = [System.Drawing.Font]::new('Consolas',48,[System.Drawing.FontStyle]::Bold,[System.Drawing.GraphicsUnit]::Pixel)
    $graphics.DrawString($env:AIH_SERVER_IMAGE_TEXT,$font,[System.Drawing.Brushes]::Black,30,100)
    $bitmap.Save($env:AIH_SERVER_IMAGE_PATH,[System.Drawing.Imaging.ImageFormat]::Png)
    $font.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { env: { ...process.env, AIH_SERVER_IMAGE_PATH: filePath, AIH_SERVER_IMAGE_TEXT: text }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.status !== 0) throw new Error(result.stderr || 'could not create OCR fixture');
}

function createTextPdf(filePath, text) {
  const escaped = String(text).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) { offsets.push(Buffer.byteLength(pdf)); pdf += object; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(filePath, pdf);
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

  const crossOriginShutdown = await fetch(`${base}/shutdown`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}'
  });
  assert.equal(crossOriginShutdown.status, 403);
  assert.equal((await crossOriginShutdown.json()).code, 'ORIGIN_REJECTED');
  assert.equal(child.exitCode, null);

  const createResponse = await fetch(`${base}/workspaces`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin },
    body: JSON.stringify({ name: 'Smoke project', kind: 'general', active_focus: 'Validate verified continuity' })
  });
  assert.equal(createResponse.status, 201);
  const workspace = await createResponse.json();
  assert.ok(workspace.roots.length >= 1);
  assert.ok(path.resolve(workspace.root_path).startsWith(path.resolve(dir, 'Projects')));

  const uploadResponse = await fetch(`${base}/workspaces/${workspace.id}/artifacts?name=requirements.md&relative_path=requirements.md&mime_type=text%2Fmarkdown`, {
    method: 'PUT', headers: { Origin: new URL(base).origin }, body: Buffer.from('Use the newest verified implementation')
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
    method: 'POST', headers: paired.headers, body: JSON.stringify({ version: '0.8.0', protocol_version: 4, provider: 'chatgpt', surface_id: 'chatgpt.web', metadata: { surface_id: 'chatgpt.web', capabilities: { ok: true, surface_id: 'chatgpt.web' } } })
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
  assert.equal(failedSession.capture_stages.find(item => item.stage === 'provider_generated_assets').status, 'pending');
  const retriedAfterMime = await (await fetch(`${base}/companion/capture`, { method: 'POST', headers: paired.headers, body: JSON.stringify(assetCaptureBody) })).json();
  assert.equal(retriedAfterMime.asset_refs.find(item => item.id === discoveredAsset.id).mirror_status, 'DISCOVERED');
  const magicMismatch = await fetch(`${base}/companion/session-assets/${discoveredAsset.id}/content`, { method: 'PUT', headers: { ...paired.headers, 'Content-Type': 'image/png', 'X-AIH-Asset-Source-Url': discoveredAsset.source_url, 'X-AIH-Asset-Capture-Strategy': 'background_https' }, body: Buffer.from('declared png without png magic') });
  assert.equal(magicMismatch.status, 415);
  assert.equal((await magicMismatch.json()).code, 'ASSET_MIME_REJECTED');
  await fetch(`${base}/companion/capture`, { method: 'POST', headers: paired.headers, body: JSON.stringify(assetCaptureBody) });
  const oversized = await putWithDeclaredLength(`${base}/companion/session-assets/${discoveredAsset.id}/content`, { ...paired.headers, 'Content-Type': 'image/png', 'X-AIH-Asset-Source-Url': discoveredAsset.source_url, 'X-AIH-Asset-Capture-Strategy': 'background_https' }, 100 * 1024 * 1024 + 1);
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, 'ASSET_TOO_LARGE');
  await fetch(`${base}/companion/capture`, { method: 'POST', headers: paired.headers, body: JSON.stringify(assetCaptureBody) });
  const expired = await fetch(`${base}/companion/session-assets/${discoveredAsset.id}/status`, { method: 'POST', headers: paired.headers, body: JSON.stringify({ status: 'EXPIRED', message: 'signed URL expired' }) });
  assert.equal(expired.status, 200);
  assert.equal((await fetch(`${base}/companion/session-assets/${discoveredAsset.id}/source`, { headers: paired.headers })).status, 409);
  await fetch(`${base}/companion/capture`, { method: 'POST', headers: paired.headers, body: JSON.stringify(assetCaptureBody) });
  const providerImageBytes = Buffer.alloc(24);
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(providerImageBytes, 0);
  providerImageBytes.writeUInt32BE(64, 16); providerImageBytes.writeUInt32BE(32, 20);
  const mirrored = await fetch(`${base}/companion/session-assets/${discoveredAsset.id}/content`, { method: 'PUT', headers: { ...paired.headers, 'Content-Type': 'image/png', 'X-AIH-Asset-Source-Url': discoveredAsset.source_url, 'X-AIH-Asset-Capture-Strategy': 'background_https' }, body: providerImageBytes });
  assert.equal(mirrored.status, 201);
  const mirroredBody = await mirrored.json();
  assert.equal(mirroredBody.attachments_complete, true);
  assert.ok(mirroredBody.resource_id);
  assert.ok(mirroredBody.resource_version_id);
  const providerOutputWorkspace = await (await fetch(`${base}/workspaces/${workspace.id}`)).json();
  assert.ok(providerOutputWorkspace.resources.some(item => item.id === mirroredBody.resource_id && item.current_version_id === mirroredBody.resource_version_id));
  const providerOutputContent = await fetch(`${base}/companion/resource-versions/${mirroredBody.resource_version_id}/content`, { headers: paired.headers });
  assert.equal(providerOutputContent.status, 403, 'a malformed image is durably captured but cannot be retransmitted without complete OCR security coverage');
  assert.equal((await providerOutputContent.json()).code, 'RESOURCE_TRANSMISSION_BLOCKED');

  const clockImagePath = path.join(dir, 'clock-input.png');
  createTextImage(clockImagePath, 'CLOCK = 250 MHz');
  const clockBytes = fs.readFileSync(clockImagePath);
  const clockCaptureBody = capture(workspace.id, 'chatgpt', 'clock-chat', []);
  clockCaptureBody.assets = [{ asset_type: 'image', name: 'timing.png', url: '', native_id: 'clipboard-clock-1', mime_type: 'image/png', origin_kind: 'user_input', capture_method: 'clipboard_image', metadata: { captured_from_composer: true } }];
  const clockCapture = await (await fetch(`${base}/companion/capture`, { method: 'POST', headers: paired.headers, body: JSON.stringify(clockCaptureBody) })).json();
  const clockAsset = clockCapture.asset_refs.find(item => item.native_id === 'clipboard-clock-1');
  const clockDescriptor = await (await fetch(`${base}/companion/session-assets/${clockAsset.id}/source`, { headers: paired.headers })).json();
  assert.equal(clockDescriptor.capture_strategy, 'direct_input');
  assert.equal(clockDescriptor.source_url, '');
  const clockMirrorResponse = await fetch(`${base}/companion/session-assets/${clockAsset.id}/content`, {
    method: 'PUT', headers: { ...paired.headers, 'Content-Type': 'image/png', 'X-AIH-Asset-Source-Url': '', 'X-AIH-Asset-Capture-Strategy': 'direct_input' }, body: clockBytes
  });
  assert.equal(clockMirrorResponse.status, 201);
  const clockMirror = await clockMirrorResponse.json();
  assert.equal(clockMirror.user_inputs_complete, true);
  const clockAssociation = capture(workspace.id, 'chatgpt', 'clock-chat', [{ role: 'user', content: 'Please inspect the pasted timing screenshot.', provider_message_id: 'chatgpt-user-clock' }]);
  clockAssociation.assets = [{ ...clockCaptureBody.assets[0], originating_provider_message_id: 'chatgpt-user-clock' }];
  await fetch(`${base}/companion/capture`, { method: 'POST', headers: paired.headers, body: JSON.stringify(clockAssociation) });
  const capturedClockResource = (await (await fetch(`${base}/workspaces/${workspace.id}`)).json()).resources.find(item => item.id === clockMirror.resource_id);
  assert.equal(capturedClockResource.source_type, 'clipboard_image');
  assert.equal(JSON.parse(capturedClockResource.origin_json).originating_provider_message_id, 'chatgpt-user-clock');

  const geminiClockPrepare = await fetch(`${base}/companion/workspaces/${workspace.id}/prepare-send`, {
    method: 'POST', headers: paired.headers,
    body: JSON.stringify(prepareBody('gemini', 'What clock frequency was shown in the screenshot I pasted earlier?', capture(workspace.id, 'gemini', 'clock-followup', [])))
  });
  assert.equal(geminiClockPrepare.status, 200);
  const geminiClock = await geminiClockPrepare.json();
  assert.match(geminiClock.provider_text, /250\s*MHz/i);
  assert.ok(geminiClock.attachments.some(item => item.version_id === clockMirror.resource_version_id));
  assert.ok(geminiClock.provenance.some(item => item.provenance.originating_provider_message_id === 'chatgpt-user-clock'));
  const clockOriginal = await fetch(`${base}/companion/resource-versions/${clockMirror.resource_version_id}/content`, { headers: paired.headers });
  assert.equal(clockOriginal.status, 200);
  assert.deepEqual(Buffer.from(await clockOriginal.arrayBuffer()), clockBytes);

  if (!spawnSync('pdftotext', ['-v'], { windowsHide: true }).error) {
    const requirementsPdfPath = path.join(dir, 'requirements-external.pdf');
    createTextPdf(requirementsPdfPath, 'ALPHA REQUIREMENT = GUARANTEED MODE FAILS CLOSED');
    const requirementsPdfBytes = fs.readFileSync(requirementsPdfPath);
    const pdfCaptureBody = capture(workspace.id, 'gemini', 'requirements-upload', []);
    pdfCaptureBody.assets = [{ asset_type: 'file', name: 'requirements.pdf', url: '', native_id: 'gemini-pdf-input-1', mime_type: 'application/pdf', origin_kind: 'user_input', capture_method: 'direct_file_input', metadata: { captured_from_composer: true } }];
    const pdfCapture = await (await fetch(`${base}/companion/capture`, { method: 'POST', headers: paired.headers, body: JSON.stringify(pdfCaptureBody) })).json();
    const pdfAsset = pdfCapture.asset_refs.find(item => item.native_id === 'gemini-pdf-input-1');
    const pdfMirrorResponse = await fetch(`${base}/companion/session-assets/${pdfAsset.id}/content`, {
      method: 'PUT', headers: { ...paired.headers, 'Content-Type': 'application/pdf', 'X-AIH-Asset-Source-Url': '', 'X-AIH-Asset-Capture-Strategy': 'direct_input' }, body: requirementsPdfBytes
    });
    assert.equal(pdfMirrorResponse.status, 201);
    const pdfMirror = await pdfMirrorResponse.json();
    const pdfAssociation = capture(workspace.id, 'gemini', 'requirements-upload', [{ role: 'user', content: 'Use the attached external requirements PDF.', provider_message_id: 'gemini-user-requirements' }]);
    pdfAssociation.assets = [{ ...pdfCaptureBody.assets[0], originating_provider_message_id: 'gemini-user-requirements' }];
    await fetch(`${base}/companion/capture`, { method: 'POST', headers: paired.headers, body: JSON.stringify(pdfAssociation) });
    const chatgptPdfPrepare = await fetch(`${base}/companion/workspaces/${workspace.id}/prepare-send`, {
      method: 'POST', headers: paired.headers,
      body: JSON.stringify(prepareBody('chatgpt', 'What does the earlier attached requirements PDF say about ALPHA?', capture(workspace.id, 'chatgpt', 'requirements-followup', [])))
    });
    assert.equal(chatgptPdfPrepare.status, 200);
    const chatgptPdf = await chatgptPdfPrepare.json();
    assert.match(chatgptPdf.provider_text, /ALPHA REQUIREMENT\s*=\s*GUARANTEED MODE FAILS CLOSED/i);
    assert.ok(chatgptPdf.provenance.some(item => item.resource_version_id === pdfMirror.resource_version_id && item.provenance.originating_provider_message_id === 'gemini-user-requirements'));
    const requirementsOriginal = await fetch(`${base}/companion/resource-versions/${pdfMirror.resource_version_id}/content`, { headers: paired.headers });
    assert.deepEqual(Buffer.from(await requirementsOriginal.arrayBuffer()), requirementsPdfBytes);
  }

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
    body: JSON.stringify({ attempt_id: prepared.attempt_id, prompt_hash: prepared.prompt_hash, route: prepared.provider_route, protocol_version: 4, acceptance: { accepted: true, certainty: 'strong', signals: { message_count_increased: true } } }) });
  assert.equal(sent.status, 200);
  const audit = await (await fetch(`${base}/outgoing-context/${prepared.run_id}`)).json();
  assert.equal(audit.status, 'sent');
  assert.equal(audit.snapshot_id, prepared.snapshot_id);
  assert.ok(audit.sources.length > 0);

  const diagramPath = path.join(dir, 'diagram-upload.png');
  createTextImage(diagramPath, 'VALID VISUAL DELIVERY 8842');
  const png = fs.readFileSync(diagramPath);
  const imageUpload = await fetch(`${base}/workspaces/${workspace.id}/artifacts?name=diagram.png&relative_path=diagram.png&mime_type=image%2Fpng`, { method: 'PUT', headers: { Origin: new URL(base).origin }, body: png });
  assert.equal(imageUpload.status, 201);
  const visualPrepare = await fetch(`${base}/companion/workspaces/${workspace.id}/prepare-send`, {
    method: 'POST', headers: paired.headers,
    body: JSON.stringify(prepareBody('chatgpt', 'Inspect the visual layout in diagram.png', capture(workspace.id, 'chatgpt', 'visual-chat', [])))
  });
  assert.equal(visualPrepare.status, 200);
  const visual = await visualPrepare.json();
  const diagramAttachment = visual.attachments.find(item => item.name.includes('diagram.png'));
  assert.ok(diagramAttachment);
  const unauthAsset = await fetch(`${base}${diagramAttachment.download_path}`);
  assert.equal(unauthAsset.status, 401);
  const currentAsset = await fetch(`${base}${diagramAttachment.download_path}`, { headers: paired.headers });
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
  const rootResponse = await fetch(`${base}/workspaces/${workspace.id}/roots`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin }, body: JSON.stringify({ path: linked, required_for_freshness: true }) });
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
  const removed = await fetch(`${base}/workspace-roots/${linkedRoot.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin }, body: '{}' });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).archive_preserved, true);
  assert.equal((await (await fetch(`${base}/workspaces/${workspace.id}/roots`)).json()).some(item => item.id === linkedRoot.id), false);
  assert.equal((await (await fetch(`${base}/workspaces/${workspace.id}`)).json()).archive.artifacts, archivedBeforeRemoval);
});
