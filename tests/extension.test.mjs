import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('extension manifest is limited to Harness localhost, ChatGPT, and Gemini and loads isolated provider adapters', () => {
  const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const sourceVersion = fs.readFileSync('src/version.mjs', 'utf8').match(/HARNESS_VERSION = '([^']+)'/)?.[1];
  assert.equal(manifest.version, '0.8.0');
  assert.equal(pkg.version, manifest.version);
  assert.equal(sourceVersion, manifest.version);
  assert.match(fs.readFileSync('src/version.mjs', 'utf8'), /COMPANION_PROTOCOL_VERSION = 4/);
  assert.match(fs.readFileSync('extension/content.js', 'utf8'), /PROTOCOL_VERSION = 4/);
  assert.deepEqual(new Set(manifest.host_permissions), new Set(['http://127.0.0.1:4317/*', 'https://chatgpt.com/*', 'https://gemini.google.com/*']));
  const providerScript = manifest.content_scripts.find(script => script.matches.includes('https://chatgpt.com/*'));
  assert.deepEqual(providerScript.js, ['provider-adapters.js', 'send-transaction.js', 'content.js']);
});

test('companion background allowlists bounded operations, provider asset origins, and reconnect backoff without a generic filesystem API', () => {
  const source = fs.readFileSync('extension/background.js', 'utf8');
  assert.match(source, /ALLOWED_PATHS/);
  assert.match(source, /prepare-send/);
  assert.match(source, /resource-versions/);
  assert.match(source, /session-assets/);
  assert.match(source, /PROVIDER_ASSET_HOSTS/);
  assert.match(source, /discoveredAssetDescriptor/);
  assert.match(source, /aih-mirror-asset-bytes/);
  assert.match(source, /aih-mirror-input-bytes/);
  assert.match(source, /direct_input/);
  assert.match(source, /draft-context/);
  assert.match(source, /prewarm/);
  assert.match(source, /attempt < 4/);
  assert.doesNotMatch(source, /read-file/);
  assert.match(source, /X-AIH-Companion-Token/);
});

async function runBackgroundRequest(fetchImpl) {
  let listener;
  const chrome = { runtime: { id: 'a'.repeat(32), onMessage: { addListener(value) { listener = value; } } }, storage: { local: { async get() { return { aih_companion_token: 'paired-token' }; }, async set() {} } } };
  const context = { chrome, fetch: fetchImpl, URL, Uint8Array, String, Error, Promise, setTimeout: callback => { callback(); return 1; }, btoa: value => Buffer.from(value, 'binary').toString('base64') };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync('extension/background.js', 'utf8'), context);
  return new Promise(resolve => listener({ type: 'aih-api-request', path: '/companion/heartbeat', options: { method: 'POST', body: '{}' } }, {}, resolve));
}

test('mocked companion reconnect retries boundedly and recovers when the local service returns', async () => {
  let failedAttempts = 0;
  const failed = await runBackgroundRequest(async () => { failedAttempts += 1; throw new Error('service unavailable'); });
  assert.equal(failedAttempts, 4);
  assert.match(failed.error, /service unavailable/);

  let recoveryAttempts = 0;
  const recovered = await runBackgroundRequest(async () => {
    recoveryAttempts += 1;
    if (recoveryAttempts < 3) throw new Error('temporarily unavailable');
    return { ok: true, status: 200, async text() { return '{"ok":true}'; } };
  });
  assert.equal(recoveryAttempts, 3);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.status, 200);
});

test('native send interception uses every explicit transaction state and waits for provider acceptance', () => {
  const source = fs.readFileSync('extension/content.js', 'utf8');
  const transactionSource = fs.readFileSync('extension/send-transaction.js', 'utf8');
  for (const state of ['IDLE','PREPARING','PREPARED','ATTACHING','REPLAYING','WAITING_FOR_PROVIDER_ACCEPT','DONE','ERROR']) assert.match(transactionSource, new RegExp(`\\b${state}\\b`));
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /event\.stopImmediatePropagation\(\)/);
  assert.match(transactionSource, /event\.repeat/);
  assert.match(source, /observeProviderAcceptance/);
  assert.match(fs.readFileSync('extension/provider-adapters.js', 'utf8'), /PROVIDER_ACCEPTANCE_UNCERTAIN/);
  assert.match(source, /PREPARED_CONTEXT_INVALIDATED/);
  assert.match(source, /replayBypass/);
  assert.match(source, /association required/);
  assert.match(source, /attachmentMode: 'fallback'/);
  assert.match(source, /fallback_from_run_id/);
  assert.match(source, /deliveries_reconciled|Reverify current project source/);
  assert.match(source, /preservePendingNativeInputs/);
  assert.match(source, /USER_INPUT_ASSET_CAPTURE_INCOMPLETE/);
  assert.match(source, /clipboard_image/);
  assert.match(source, /drag_drop/);
  assert.match(source, /scheduleDraftRetrieval/);
  assert.match(source, /prewarmProject/);
  assert.match(source, /associationConfirmed/);
  assert.match(source, /providerAcceptanceTransition/);
  assert.match(source, /originating_provider_message_id/);
  assert.match(fs.readFileSync('extension/provider-adapters.js', 'utf8'), /messageContext/);
});

test('native send transaction model enforces legal transitions, one replay, invalidation, and keyboard gating', () => {
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync('extension/send-transaction.js', 'utf8'), context);
  const model = context.AIH_SEND_TRANSACTION;
  const attempt = model.createAttempt({ attempt_id: 'attempt-1', prompt_hash: 'hash-1', route: 'https://chatgpt.com/c/one' });
  assert.equal(attempt.state, model.STATES.IDLE);
  for (const state of ['PREPARING','PREPARED','ATTACHING','REPLAYING']) attempt.transition(model.STATES[state]);
  assert.equal(attempt.armReplay(), true);
  assert.equal(attempt.armReplay(), false);
  assert.equal(attempt.consumeReplay(), true);
  assert.equal(attempt.consumeReplay(), false);
  attempt.transition(model.STATES.WAITING_FOR_PROVIDER_ACCEPT);
  attempt.transition(model.STATES.DONE);
  attempt.transition(model.STATES.IDLE);
  assert.throws(() => attempt.transition(model.STATES.DONE), /invalid send transition/);

  const edited = model.createAttempt({ attempt_id: 'attempt-2' });
  edited.transition(model.STATES.PREPARING);
  edited.invalidate();
  assert.equal(edited.invalidated, true);
  assert.throws(() => edited.transition(model.STATES.PREPARING), /invalid send transition/);
  edited.transition(model.STATES.ERROR);
  edited.transition(model.STATES.IDLE);

  const enter = { key: 'Enter', repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false };
  assert.equal(model.shouldManageEnter(enter, true), true);
  for (const changed of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }, { key: 'x' }]) {
    assert.equal(model.shouldManageEnter({ ...enter, ...changed }, true), false);
  }
  assert.equal(model.shouldManageEnter(enter, false), false);
});

function fakeNode({ tagName = 'DIV', text = '', attrs = {}, visible = true, disabled = false, editable = false } = {}) {
  return { tagName, innerText: text, textContent: text, outerHTML: `<${tagName}>${text}</${tagName}>`, disabled, hidden: false,
    isConnected: true, isContentEditable: editable, parentElement: null, scrollHeight: 0, clientHeight: 0,
    getAttribute: name => attrs[name] ?? null, closest: () => null, contains: () => false,
    getBoundingClientRect: () => visible ? ({ width: 100, height: 20 }) : ({ width: 0, height: 0 }), focus() {}, dispatchEvent() {} };
}

function loadAdapters({ pathname, selectorMap }) {
  const document = { activeElement: null, scrollingElement: fakeNode(), querySelectorAll: selector => selectorMap.get(selector) || [] };
  const context = { document, location: { pathname, search: '', href: `https://example.test${pathname}` },
    getComputedStyle: node => ({ display: node.getBoundingClientRect().width ? 'block' : 'none', visibility: 'visible', opacity: '1', overflowY: 'visible' }),
    Event: class {}, InputEvent: class {}, console, setTimeout, clearTimeout };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync('extension/provider-adapters.js', 'utf8'), context);
  return context;
}

test('synthetic ChatGPT DOM variants detect alternate visible controls, hidden duplicates, messages, and established empty-history failure', () => {
  const hiddenComposer = fakeNode({ visible: false, editable: true });
  const composer = fakeNode({ editable: true });
  const send = fakeNode({ tagName: 'BUTTON' });
  const message = fakeNode({ text: 'current answer', attrs: { 'data-message-author-role': 'assistant', 'data-message-id': 'm-1' } });
  const map = new Map([['#prompt-textarea', [hiddenComposer]], ['main form [contenteditable="true"]', [composer]], ['form button[type="submit"]', [send]], ['[data-message-author-role]', [message]], ['main', [fakeNode()]]]);
  const normal = loadAdapters({ pathname: '/c/abc', selectorMap: map });
  const health = normal.AIH_PROVIDER_ADAPTERS.chatgpt.capabilities();
  assert.equal(normal.AIH_PROVIDER_ADAPTERS.chatgpt.findComposer(), composer);
  assert.equal(health.ok, true);
  assert.equal(health.messages, 1);

  map.set('[data-message-author-role]', []);
  const empty = loadAdapters({ pathname: '/c/abc', selectorMap: map }).AIH_PROVIDER_ADAPTERS.chatgpt.capabilities();
  assert.equal(empty.ok, false);
  assert.ok(empty.failures.some(item => item.code === 'PROVIDER_MESSAGE_EXTRACTION_EMPTY'));
});

test('synthetic Gemini DOM variants detect alternate composer/send/message/streaming capabilities', () => {
  const composer = fakeNode({ editable: true });
  const send = fakeNode({ tagName: 'BUTTON' });
  const user = fakeNode({ tagName: 'USER-QUERY', text: 'question' });
  const model = fakeNode({ tagName: 'MODEL-RESPONSE', text: 'answer' });
  const stream = fakeNode({ tagName: 'MAT-PROGRESS-SPINNER' });
  const map = new Map([['main [contenteditable="true"][role="textbox"]', [composer]], ['button.send-button', [send]], ['user-query', [user]], ['model-response', [model]], ['mat-progress-spinner', [stream]], ['main', [fakeNode()]]]);
  const loaded = loadAdapters({ pathname: '/app/gem-1', selectorMap: map });
  const health = loaded.AIH_PROVIDER_ADAPTERS.gemini.capabilities();
  assert.equal(health.ok, true);
  assert.equal(health.messages, 2);
  assert.equal(health.streaming, true);
  assert.equal(health.protocol_version, 4);
});

test('attachment confirmation requires new composer-scoped filename evidence and ignores old inventory', () => {
  const confirmed = loadAdapters({ pathname: '/', selectorMap: new Map() }).AIH_PROVIDER_TESTING.attachmentConfirmed;
  const before = [{ key: 'DIV:old.pdf', name: 'old.pdf' }];
  assert.equal(confirmed(before, before, 'old.pdf'), false);
  assert.equal(confirmed(before, [...before, { key: 'DIV:new.pdf', name: 'new.pdf' }], 'new.pdf'), true);
  assert.equal(confirmed(before, [...before, { key: 'DIV:unrelated', name: 'unrelated' }], 'new.pdf'), false);
});

test('provider selectors and adapter versions remain isolated from the send coordinator', () => {
  const adapters = fs.readFileSync('extension/provider-adapters.js', 'utf8');
  const coordinator = fs.readFileSync('extension/content.js', 'utf8');
  assert.match(adapters, /chatgpt-2026-08-16\.2/);
  assert.match(adapters, /gemini-2026-08-16\.2/);
  assert.match(adapters, /data-testid="send-button"/);
  assert.match(adapters, /user-query/);
  assert.doesNotMatch(coordinator, /data-testid="send-button"/);
  assert.doesNotMatch(coordinator, /user-query, model-response/);
});
