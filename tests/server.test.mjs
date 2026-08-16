import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function waitFor(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`service did not become ready: ${url}`);
}

test('server supports first-run project and native continuity smoke flow', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-'));
  const dbPath = path.join(dir, 'test.db');
  const port = 45000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: path.resolve('.'),
    env: { ...process.env, HARNESS_DB: dbPath, HARNESS_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}/api`;
  const healthResponse = await waitFor(`${base}/health`);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.version, '0.5.0');

  const createResponse = await fetch(`${base}/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke project', kind: 'mixed', active_focus: 'Validate continuity' })
  });
  assert.equal(createResponse.status, 201);
  const workspace = await createResponse.json();
  assert.equal(workspace.name, 'Smoke project');
  assert.deepEqual(new Set(workspace.providers.map(item => item.provider)), new Set(['chatgpt', 'gemini', 'notebooklm']));

  const heartbeat = await fetch(`${base}/companion/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'test-client', version: '0.5.0', provider: 'chatgpt' })
  });
  assert.equal(heartbeat.status, 200);
  assert.equal((await heartbeat.json()).ready_for_native_workflow, true);

  const captureResponse = await fetch(`${base}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspace_id: workspace.id,
      provider: 'chatgpt',
      title: 'Smoke chat',
      native_url: 'https://chatgpt.com/c/test-chat-123',
      provider_refs: [{ ref_type: 'chat_id', ref_value: 'test-chat-123', source: 'test' }],
      messages: [
        { role: 'user', content: 'Remember the smoke project focus.' },
        { role: 'assistant', content: 'The focus is validating continuity.' }
      ]
    })
  });
  assert.equal(captureResponse.status, 201);
  const captured = await captureResponse.json();
  assert.equal(captured.session.message_count, 2);

  const resolvedResponse = await fetch(`${base}/provider-session?provider=chatgpt&chat_id=test-chat-123`);
  assert.equal(resolvedResponse.status, 200);
  const resolved = await resolvedResponse.json();
  assert.equal(resolved.id, captured.session.id);
  assert.equal(resolved.workspace.id, workspace.id);
});
