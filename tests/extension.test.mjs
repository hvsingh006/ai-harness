import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('extension manifest is limited to Harness localhost, ChatGPT, and Gemini and loads isolated provider adapters', () => {
  const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
  assert.deepEqual(new Set(manifest.host_permissions), new Set([
    'http://127.0.0.1:4317/*',
    'https://chatgpt.com/*',
    'https://gemini.google.com/*'
  ]));
  const providerScript = manifest.content_scripts.find(script => script.matches.includes('https://chatgpt.com/*'));
  assert.deepEqual(providerScript.js, ['provider-adapters.js', 'content.js']);
});

test('companion background allowlists operations and never exposes a generic filesystem API', () => {
  const source = fs.readFileSync('extension/background.js', 'utf8');
  assert.match(source, /ALLOWED_PATHS/);
  assert.match(source, /prepare-send/);
  assert.match(source, /resource-versions/);
  assert.doesNotMatch(source, /read-file/);
  assert.match(source, /X-AIH-Companion-Token/);
});

test('native send interception has explicit preparing/replaying/error states and blocks replay on prepare failure', () => {
  const source = fs.readFileSync('extension/content.js', 'utf8');
  for (const state of ["'idle'", "'preparing'", "'replaying'", "'error'"]) assert.match(source, new RegExp(state));
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /event\.stopImmediatePropagation\(\)/);
  assert.match(source, /replayButton\.click\(\)/);
  assert.match(source, /Context blocked:/);
  assert.match(source, /if \(sendState === 'replaying'\)/);
});

test('provider selectors and adapter versions stay isolated from the send coordinator', () => {
  const adapters = fs.readFileSync('extension/provider-adapters.js', 'utf8');
  const coordinator = fs.readFileSync('extension/content.js', 'utf8');
  assert.match(adapters, /chatgpt-2026-08-16\.1/);
  assert.match(adapters, /gemini-2026-08-16\.1/);
  assert.match(adapters, /data-testid="send-button"/);
  assert.match(adapters, /user-query, model-response/);
  assert.doesNotMatch(coordinator, /data-testid="send-button"/);
  assert.doesNotMatch(coordinator, /user-query, model-response/);
});
