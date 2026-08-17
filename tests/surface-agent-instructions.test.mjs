import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase, ensureWorkspaceProjectRoot, registerWorkspaceRoot, row, rows, run } from '../src/db.mjs';
import { reconcileWorkspaceResources, updateResourceContextPolicy } from '../src/resources.mjs';
import { SurfaceRegistry, surfaceRegistry } from '../src/surface-registry.mjs';
import { planContextDelivery } from '../src/delivery-planner.mjs';
import { saveProjectInstructions, savePersonalization, instructionContext, instructionHistory } from '../src/instructions.mjs';
import { markContextRunSent, prepareManagedSend } from '../src/outgoing-context.mjs';
import { prepareSpeculativeDraft, reuseSpeculativeDraft } from '../src/context-cache.mjs';
import { captureBrowserSession } from '../src/chat-capture.mjs';
import { retrieveWorkspaceEvidence, SemanticRetriever } from '../src/retrieval.mjs';
import { createAgentContextSession, authenticateAgentContext, agentContextStatus, agentContextQuery, agentContextSources, agentContextResource, agentContextVisual, revokeAgentContextSession } from '../src/agent-context.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-surface-'));
  const db = openDatabase(path.join(dir, 'harness.db'));
  const root = ensureWorkspaceProjectRoot(db, 'ws-harness');
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, root };
}

function capture(messages = [], chatId = 'instructions') {
  return {
    workspace_id: 'ws-harness', provider: 'chatgpt', title: 'Instruction test', native_url: `https://chatgpt.com/c/${chatId}`,
    provider_refs: [{ ref_type: 'chat_id', ref_value: chatId, source: 'test' }], messages, assets: [],
    capture_evidence: { synchronized_visible: true, reached_top: true, stable_rounds: 2, visible_message_count: messages.length, first_message_fingerprint: 'first', last_message_fingerprint: 'last', capture_started_at: new Date().toISOString(), capture_completed_at: new Date().toISOString(), provider_adapter_version: 'test', reason_if_partial: '' }
  };
}

test('surface registry separates provider families from delivery surfaces and fails unknown adapters closed', () => {
  assert.equal(surfaceRegistry.resolve('chatgpt.web').provider_family, 'openai');
  assert.equal(surfaceRegistry.resolve('codex.local').provider_family, 'openai');
  assert.equal(surfaceRegistry.resolve('chatgpt.web').channel, 'browser_companion');
  assert.equal(surfaceRegistry.resolve('codex.local').channel, 'local_agent');
  assert.throws(() => surfaceRegistry.resolve('future.unknown'), error => error.code === 'SURFACE_UNSUPPORTED');

  const future = new SurfaceRegistry([]);
  const registered = future.register({ id: 'future.readonly', provider_family: 'example', display_name: 'Future read-only', channel: 'browser_companion', adapter_version: '0.1.0', capabilities: { text_context: true, image_attachment: false, filesystem: false, shell: false } });
  assert.equal(future.resolve('future.readonly'), registered);
  assert.throws(() => future.register(registered), error => error.code === 'SURFACE_ALREADY_REGISTERED');
  assert.throws(() => future.register({ id: 'future.unsafe', provider_family: 'example', channel: 'browser_companion', capabilities: { text_context: true, filesystem: true, shell: false } }), error => error.code === 'SURFACE_BROWSER_PRIVILEGE_REJECTED');
});

test('a future provider text-and-image adapter uses the core planner and inherits visual security without core changes', t => {
  const { db, root } = fixture(t);
  const png = Buffer.alloc(24);
  png.writeUInt8(0x89, 0); png.write('PNG', 1, 'ascii'); png.writeUInt32BE(640, 16); png.writeUInt32BE(360, 20);
  fs.writeFileSync(path.join(root, 'future-diagram.png'), png);
  reconcileWorkspaceResources(db, 'ws-harness');
  const resource = row(db, `SELECT id,current_version_id FROM workspace_resources WHERE relative_path='future-diagram.png'`);
  run(db, `UPDATE resource_representations SET security_status='clear' WHERE resource_id=? AND representation_kind='original_visual'`, resource.id);
  run(db, `UPDATE resource_versions SET representation_coverage='complete',security_status='clear' WHERE id=?`, resource.current_version_id);
  const registry = new SurfaceRegistry([]);
  registry.register({ id: 'test-provider.web', provider_family: 'test-provider', display_name: 'Test provider', channel: 'browser_companion', adapter_version: '1.0.0', capabilities: { text_context: true, image_attachment: true, pdf_attachment: true, file_attachment: true, filesystem: false, shell: false, max_attachments: 4, max_attachment_bytes: 8 * 1024 * 1024 } });

  const ready = await planContextDelivery(db, { workspaceId: 'ws-harness', query: 'Inspect future-diagram.png visually', surfaceId: 'test-provider.web', retrieval: { selected: [] }, registry });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.provider_family, 'test-provider');
  assert.equal(ready.visual_attachments[0].resource_id, resource.id);

  run(db, `UPDATE resource_versions SET security_status='local_only:content-secret' WHERE id=?`, resource.current_version_id);
  run(db, 'UPDATE workspace_resources SET provider_transmission_allowed=0 WHERE id=?', resource.id);
  const blocked = await planContextDelivery(db, { workspaceId: 'ws-harness', query: 'Inspect future-diagram.png visually', surfaceId: 'test-provider.web', retrieval: { selected: [] }, registry });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reasons.some(reason => reason.code === 'VISUAL_EVIDENCE_NOT_READY'), true);
});

test('delivery capability matrix selects current visuals for browser surfaces and blocks unsupported visual-only local delivery', t => {
  const { db, root } = fixture(t);
  const png = Buffer.alloc(24);
  png.writeUInt8(0x89, 0); png.write('PNG', 1, 'ascii'); png.writeUInt32BE(640, 16); png.writeUInt32BE(360, 20);
  fs.writeFileSync(path.join(root, 'diagram.png'), png);
  reconcileWorkspaceResources(db, 'ws-harness');
  run(db, `UPDATE resource_representations SET security_status='clear' WHERE resource_id=(SELECT id FROM workspace_resources WHERE relative_path='diagram.png') AND representation_kind='original_visual'`);
  run(db, `UPDATE resource_versions SET representation_coverage='complete' WHERE id=(SELECT current_version_id FROM workspace_resources WHERE relative_path='diagram.png')`);
  const browser = await planContextDelivery(db, { workspaceId: 'ws-harness', query: 'Inspect diagram.png visually', surfaceId: 'chatgpt.web', retrieval: { selected: [] } });
  assert.equal(browser.status, 'ready');
  assert.equal(browser.visual_attachments.length, 1);
  assert.equal(browser.visual_attachments[0].name.startsWith('diagram.png'), true);
  assert.equal(browser.visual_attachments[0].download_path.includes('resource-versions'), true);
  const diagram = row(db, `SELECT id,current_version_id FROM workspace_resources WHERE relative_path='diagram.png'`);
  const ocrRetrieval = { selected: [{ source_type: 'ocr_text', source_id: diagram.id, resource_version_id: diagram.current_version_id, content: 'FIFO DEPTH 32', provenance: { path: 'diagram.png', page_start: 1 } }] };
  const ocrMatchedBrowser = await planContextDelivery(db, { workspaceId: 'ws-harness', query: 'What is the FIFO depth?', surfaceId: 'gemini.web', retrieval: ocrRetrieval });
  assert.equal(ocrMatchedBrowser.visual_attachments[0].resource_id, diagram.id, 'matching OCR should pull the current original visual into an image-capable plan');
  const ocrMatchedLocal = await planContextDelivery(db, { workspaceId: 'ws-harness', query: 'What is the FIFO depth?', surfaceId: 'codex.local', retrieval: ocrRetrieval });
  assert.equal(ocrMatchedLocal.status, 'text_fallback');
  const local = await planContextDelivery(db, { workspaceId: 'ws-harness', query: 'Inspect diagram.png visually', surfaceId: 'codex.local', retrieval: { selected: [] } });
  assert.equal(local.status, 'blocked');
  assert.equal(local.reasons[0].code, 'SURFACE_VISUAL_UNSUPPORTED');
});

test('an explicit unrendered PDF page delivers the verified current PDF or fails closed without substituting another page', t => {
  const { db, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'handbook.pdf'), '%PDF-1.4\n%%EOF\n');
  const png = Buffer.alloc(24);
  png.writeUInt8(0x89, 0); png.write('PNG', 1, 'ascii'); png.writeUInt32BE(640, 16); png.writeUInt32BE(360, 20);
  fs.writeFileSync(path.join(root, 'unrelated-page-one.png'), png);
  reconcileWorkspaceResources(db, 'ws-harness');
  run(db, `UPDATE resource_representations SET security_status='clear' WHERE resource_id=(SELECT id FROM workspace_resources WHERE relative_path='unrelated-page-one.png') AND representation_kind='original_visual'`);
  const handbook = row(db, `SELECT id,current_version_id FROM workspace_resources WHERE relative_path='handbook.pdf'`);
  run(db, `UPDATE resource_versions SET indexing_status='complete',extraction_status='complete',security_status='clear',representation_coverage='complete' WHERE id=?`, handbook.current_version_id);

  const browser = await planContextDelivery(db, { workspaceId: 'ws-harness', query: 'Inspect page 81 of handbook.pdf', surfaceId: 'chatgpt.web', retrieval: { selected: [] } });
  assert.equal(browser.status, 'ready');
  assert.equal(browser.intents.requested_page, 81);
  assert.equal(browser.visual_attachments.length, 0, 'a different current image must never stand in for the requested PDF page');
  assert.equal(browser.file_attachments.length, 1);
  assert.equal(browser.file_attachments[0].resource_id, handbook.id);
  assert.equal(browser.file_attachments[0].sha256, row(db, 'SELECT sha256 FROM resource_versions WHERE id=?', handbook.current_version_id).sha256);

  const local = await planContextDelivery(db, { workspaceId: 'ws-harness', query: 'Inspect page 81 of handbook.pdf', surfaceId: 'codex.local', retrieval: { selected: [] } });
  assert.equal(local.status, 'blocked');
  assert.equal(local.reasons.some(reason => reason.code === 'VISUAL_PAGE_NOT_READY'), true);
});

test('project instructions and personalization are immutable, versioned, and injected in explicit trust order', t => {
  const { db, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'evidence.md'), 'Retrieved evidence says a prior AI preferred option B.');
  reconcileWorkspaceResources(db, 'ws-harness');
  const first = saveProjectInstructions(db, 'ws-harness', 'Use option A unless the current user explicitly overrides it.');
  const second = saveProjectInstructions(db, 'ws-harness', 'Use option C unless the current user explicitly overrides it.');
  assert.equal(first.status, 'active');
  assert.equal(second.version_number, first.version_number + 1);
  assert.equal(row(db, 'SELECT status FROM instruction_versions WHERE id=?', first.id).status, 'superseded');
  savePersonalization(db, { scope: 'global', profile: { detail_level: 'thorough', response_style: 'direct' }, notes: 'Prefer practical explanations.' });
  savePersonalization(db, { scope: 'workspace', workspaceId: 'ws-harness', profile: { detail_level: 'concise for routine steps' }, notes: 'Use project terminology.' });
  const context = instructionContext(db, 'ws-harness');
  assert.equal(context.project_instructions.id, second.id);
  assert.equal(context.global_personalization.profile.detail_level, 'thorough');
  assert.equal(context.workspace_personalization.profile.detail_level, 'concise for routine steps');
  assert.equal(instructionHistory(db, 'ws-harness').instructions.length, 2);

  const prepared = await prepareManagedSend(db, { workspaceId: 'ws-harness', provider: 'chatgpt', surfaceId: 'chatgpt.web', userPrompt: 'What should we do next?', capture: capture([]), attemptId: 'instructions-attempt', protocolVersion: 4 });
  assert.equal(prepared.ok, true);
  const securityIndex = prepared.context_envelope.indexOf('Trust order: Harness security policy');
  const instructionsIndex = prepared.context_envelope.indexOf('Use option C');
  const personalizationIndex = prepared.context_envelope.indexOf('concise for routine steps');
  const evidenceIndex = prepared.context_envelope.indexOf('Retrieved evidence says');
  assert.ok(securityIndex >= 0 && securityIndex < instructionsIndex && instructionsIndex < personalizationIndex && personalizationIndex < evidenceIndex);
  const audit = row(db, 'SELECT metadata_json,surface_id,delivery_plan_json FROM outgoing_context_runs WHERE id=?', prepared.run_id);
  const metadata = JSON.parse(audit.metadata_json);
  assert.equal(audit.surface_id, 'chatgpt.web');
  assert.deepEqual(metadata.instruction_versions.project, { id: second.id, version: second.version_number, hash: second.content_hash });
  assert.equal(metadata.instruction_versions.global_personalization.hash, context.global_personalization.hash);
  assert.equal(metadata.instruction_versions.workspace_personalization.hash, context.workspace_personalization.hash);
  assert.equal(JSON.parse(audit.delivery_plan_json).surface_id, 'chatgpt.web');
});

test('speculative retrieval is generation-bound and the native-session ledger switches safely from bootstrap to delta', t => {
  const { db, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'timing.md'), 'Current timing decision: CLOCK = 250 MHz.\n');
  reconcileWorkspaceResources(db, 'ws-harness');
  saveProjectInstructions(db, 'ws-harness', 'Use the current timing source and cite its provenance.');
  savePersonalization(db, { scope: 'global', profile: { response_style: 'direct' }, notes: 'Keep units explicit.' });

  const first = await prepareManagedSend(db, {
    workspaceId: 'ws-harness', provider: 'chatgpt', surfaceId: 'chatgpt.web', userPrompt: 'What is the clock frequency?',
    capture: capture([]), attemptId: 'bootstrap-attempt', providerRoute: 'https://chatgpt.com/c/instructions', protocolVersion: 4
  });
  assert.equal(first.ok, true);
  assert.equal(first.context_envelope.includes('Use the current timing source'), true);
  assert.equal(first.diagnostics.retrieval_cache_hit, false);
  assert.equal(markContextRunSent(db, first.run_id, {
    attemptId: 'bootstrap-attempt', promptHash: first.prompt_hash, providerRoute: 'https://chatgpt.com/c/instructions', protocolVersion: 4,
    acceptance: { accepted: true, certainty: 'strong' }
  }), true);
  const sessionId = row(db, 'SELECT session_id FROM outgoing_context_runs WHERE id=?', first.run_id).session_id;

  const draft = prepareSpeculativeDraft(db, { workspaceId: 'ws-harness', sessionId, surfaceId: 'chatgpt.web', provider: 'chatgpt', query: 'What is the clock frequency?' });
  assert.equal(draft.cached, true);
  const second = await prepareManagedSend(db, {
    workspaceId: 'ws-harness', provider: 'chatgpt', surfaceId: 'chatgpt.web', userPrompt: 'What is the clock frequency?',
    capture: capture([]), attemptId: 'delta-attempt', providerRoute: 'https://chatgpt.com/c/instructions', protocolVersion: 4
  });
  assert.equal(second.ok, true);
  assert.equal(second.diagnostics.retrieval_cache_hit, true);
  assert.equal(second.diagnostics.files_hashed, 0);
  assert.equal(second.diagnostics.files_processed, 0);
  assert.equal(second.diagnostics.fast_path, true);
  assert.match(second.context_envelope, /unchanged trusted version already supplied/);
  assert.equal(JSON.parse(row(db, 'SELECT metadata_json FROM outgoing_context_runs WHERE id=?', second.run_id).metadata_json).context_delivery_mode, 'existing_chat_delta');

  run(db, 'UPDATE session_context_ledgers SET sends_since_bootstrap=8 WHERE session_id=?', sessionId);
  const boundedRebootstrap = await prepareManagedSend(db, {
    workspaceId: 'ws-harness', provider: 'chatgpt', surfaceId: 'chatgpt.web', userPrompt: 'Confirm the clock source.',
    capture: capture([]), attemptId: 'bounded-rebootstrap', providerRoute: 'https://chatgpt.com/c/instructions', protocolVersion: 4
  });
  assert.equal(boundedRebootstrap.context_envelope.includes('Use the current timing source'), true);
  assert.equal(JSON.parse(row(db, 'SELECT metadata_json FROM outgoing_context_runs WHERE id=?', boundedRebootstrap.run_id).metadata_json).context_delivery_mode, 'fresh_chat_bootstrap');

  saveProjectInstructions(db, 'ws-harness', 'Use the revised timing rule and preserve MHz units.');
  assert.equal(reuseSpeculativeDraft(db, { workspaceId: 'ws-harness', sessionId, surfaceId: 'chatgpt.web', query: 'What is the clock frequency?' }), null);
  const changedInstructions = await prepareManagedSend(db, {
    workspaceId: 'ws-harness', provider: 'chatgpt', surfaceId: 'chatgpt.web', userPrompt: 'What is the clock frequency?',
    capture: capture([]), attemptId: 'instruction-change', providerRoute: 'https://chatgpt.com/c/instructions', protocolVersion: 4
  });
  assert.equal(changedInstructions.context_envelope.includes('Use the revised timing rule'), true);
  assert.equal(changedInstructions.diagnostics.retrieval_cache_hit, false);
  assert.equal(changedInstructions.diagnostics.files_hashed, 0);
  assert.equal(changedInstructions.diagnostics.files_processed, 0);

  prepareSpeculativeDraft(db, { workspaceId: 'ws-harness', sessionId, surfaceId: 'chatgpt.web', provider: 'chatgpt', query: 'What is the clock frequency?' });
  captureBrowserSession(db, capture([{ role: 'user', content: 'The user now cares about the revised timing margin.', provider_message_id: 'history-update-1' }]));
  assert.equal(reuseSpeculativeDraft(db, { workspaceId: 'ws-harness', sessionId, surfaceId: 'chatgpt.web', query: 'What is the clock frequency?' }), null);
  prepareSpeculativeDraft(db, { workspaceId: 'ws-harness', sessionId, surfaceId: 'chatgpt.web', provider: 'chatgpt', query: 'What is the clock frequency?' });
  updateResourceContextPolicy(db, row(db, `SELECT id FROM workspace_resources WHERE relative_path='timing.md'`).id, { priority_status: 'priority' });
  assert.equal(reuseSpeculativeDraft(db, { workspaceId: 'ws-harness', sessionId, surfaceId: 'chatgpt.web', query: 'What is the clock frequency?' }), null);
  prepareSpeculativeDraft(db, { workspaceId: 'ws-harness', sessionId, surfaceId: 'chatgpt.web', provider: 'chatgpt', query: 'What is the clock frequency?' });
  fs.writeFileSync(path.join(root, 'timing.md'), 'Current timing decision: CLOCK = 300 MHz.\n');
  reconcileWorkspaceResources(db, 'ws-harness');
  assert.equal(reuseSpeculativeDraft(db, { workspaceId: 'ws-harness', sessionId, surfaceId: 'chatgpt.web', query: 'What is the clock frequency?' }), null);
  assert.equal(reuseSpeculativeDraft(db, { workspaceId: 'ws-harness', sessionId, surfaceId: 'gemini.web', query: 'What is the clock frequency?' }), null);

  const freshChat = await prepareManagedSend(db, {
    workspaceId: 'ws-harness', provider: 'chatgpt', surfaceId: 'chatgpt.web', userPrompt: 'What is the current clock?',
    capture: capture([], 'fresh-context'), attemptId: 'fresh-attempt', providerRoute: 'https://chatgpt.com/c/fresh-context', protocolVersion: 4
  });
  assert.equal(freshChat.ok, true);
  assert.equal(freshChat.context_envelope.includes('Use the revised timing rule'), true);
  assert.equal(JSON.parse(row(db, 'SELECT metadata_json FROM outgoing_context_runs WHERE id=?', freshChat.run_id).metadata_json).context_delivery_mode, 'fresh_chat_bootstrap');
});

test('always-consider sources survive recency pressure while superseded knowledge requires historical intent', t => {
  const { db, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'old-baseline.md'), 'The durable codename is OBSIDIAN and this baseline must remain available.\n');
  for (let index = 0; index < 45; index++) fs.writeFileSync(path.join(root, `recent-${index}.md`), `Recent unrelated evidence ${index}.\n`);
  reconcileWorkspaceResources(db, 'ws-harness');
  const baseline = row(db, `SELECT id FROM workspace_resources WHERE relative_path='old-baseline.md'`);
  updateResourceContextPolicy(db, baseline.id, { priority_status: 'priority' });
  const pinned = retrieveWorkspaceEvidence(db, { workspaceId: 'ws-harness', provider: 'chatgpt', query: 'Summarize the next unrelated action.' });
  assert.equal(pinned.selected.some(item => item.source_id === baseline.id), true);

  updateResourceContextPolicy(db, baseline.id, { knowledge_status: 'superseded' });
  const normal = retrieveWorkspaceEvidence(db, { workspaceId: 'ws-harness', provider: 'chatgpt', query: 'What was OBSIDIAN?' });
  assert.equal(normal.selected.some(item => item.source_id === baseline.id), false);
  const historical = retrieveWorkspaceEvidence(db, { workspaceId: 'ws-harness', provider: 'chatgpt', query: 'Historically, why was OBSIDIAN chosen?' });
  assert.equal(historical.selected.some(item => item.source_id === baseline.id), true);
});

test('retrieval exposes query-relevant current authority conflicts, class budgets, and optional workspace-scoped semantic candidates', t => {
  const { db, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'requirements.md'), 'CLOCK = 250 MHz\n');
  reconcileWorkspaceResources(db, 'ws-harness');
  saveProjectInstructions(db, 'ws-harness', 'CLOCK = 200 MHz');
  class TestSemanticRetriever extends SemanticRetriever {
    constructor() { super({ id: 'test-local', available: true }); }
    retrieve({ workspaceId }) {
      return [
        { workspace_id: workspaceId, source_type: 'semantic_evidence', source_id: 'semantic-current', content: 'Local semantic hint about the clock requirement.', score: 70 },
        { workspace_id: 'ws-other', source_type: 'semantic_evidence', source_id: 'semantic-cross-workspace', content: 'This must never cross workspaces.', score: 100 }
      ];
    }
  }
  const retrieval = retrieveWorkspaceEvidence(db, { workspaceId: 'ws-harness', provider: 'chatgpt', query: 'What clock frequency should we target?', semanticRetriever: new TestSemanticRetriever() });
  assert.equal(retrieval.conflicts.length, 1);
  assert.deepEqual(new Set(retrieval.conflicts[0].assertions.map(item => item.value)), new Set(['200 mhz','250 mhz']));
  assert.equal(retrieval.selected.some(item => item.source_id === 'semantic-current'), true);
  assert.equal(retrieval.selected.some(item => item.source_id === 'semantic-cross-workspace'), false);
  assert.equal(retrieval.diagnostics.semantic_retriever, 'test-local');
  assert.ok(Object.keys(retrieval.diagnostics.evidence_class_soft_limits).length >= 5);

  const prepared = await prepareManagedSend(db, { workspaceId: 'ws-harness', provider: 'chatgpt', surfaceId: 'chatgpt.web', userPrompt: 'What clock frequency should we target?', capture: capture([], 'conflict-chat'), attemptId: 'conflict-attempt', protocolVersion: 4 });
  assert.equal(prepared.ok, true);
  assert.match(prepared.context_envelope, /CONFLICT DETECTED/);
  assert.match(prepared.context_envelope, /CLOCK = 200 MHz/);
  assert.match(prepared.context_envelope, /CLOCK = 250 MHz/);
});

test('complete native captures retain edited and regenerated message branches while preferring the visible path', t => {
  const { db } = fixture(t);
  const first = capture([
    { role: 'user', content: 'Use architecture A.', provider_message_id: 'user-1' },
    { role: 'assistant', content: 'First answer chooses A.', provider_message_id: 'assistant-1', parent_provider_message_id: 'user-1' }
  ], 'branched-chat');
  captureBrowserSession(db, first);
  const edited = capture([
    { role: 'user', content: 'Use architecture C.', provider_message_id: 'user-1' },
    { role: 'assistant', content: 'Regenerated answer chooses C.', provider_message_id: 'assistant-2', parent_provider_message_id: 'user-1' }
  ], 'branched-chat');
  captureBrowserSession(db, edited);
  const revisions = rows(db, `SELECT provider_message_id,content_text,path_status,parent_provider_message_id FROM messages WHERE session_id=(SELECT id FROM sessions WHERE external_id='branched-chat') ORDER BY ordinal`);
  assert.equal(revisions.length, 4);
  assert.equal(revisions.find(item => item.content_text.includes('architecture A')).path_status, 'alternate');
  assert.equal(revisions.find(item => item.content_text.includes('architecture C')).path_status, 'visible');
  assert.equal(revisions.find(item => item.content_text.includes('First answer')).path_status, 'alternate');
  assert.equal(revisions.find(item => item.content_text.includes('Regenerated answer')).parent_provider_message_id, 'user-1');
  const retrieval = retrieveWorkspaceEvidence(db, { workspaceId: 'ws-harness', provider: 'gemini', currentSessionId: row(db, `SELECT id FROM sessions WHERE external_id='branched-chat'`).id, query: 'Which architecture did the current visible path choose?' });
  const visible = retrieval.selected.find(item => item.content.includes('architecture C'));
  const alternate = retrieval.selected.find(item => item.content.includes('architecture A'));
  assert.equal(visible.provenance.path_status, 'visible');
  assert.ok(!alternate || visible.score > alternate.score);
});

test('scoped local-agent context tokens are read-only, capability-bounded, expiring, revocable, and root/workspace bound', t => {
  const { db } = fixture(t);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agent-repo-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'README.md'), 'Agent bridge evidence: scoped context only.');
  const visualBytes = Buffer.alloc(24);
  visualBytes.writeUInt8(0x89, 0); visualBytes.write('PNG', 1, 'ascii'); visualBytes.writeUInt32BE(320, 16); visualBytes.writeUInt32BE(200, 20);
  fs.writeFileSync(path.join(repo, 'agent-visual.png'), visualBytes);
  const root = registerWorkspaceRoot(db, 'ws-harness', { rootPath: repo, rootKind: 'repository' });
  reconcileWorkspaceResources(db, 'ws-harness');
  saveProjectInstructions(db, 'ws-harness', 'Preserve the scoped agent evidence.');
  savePersonalization(db, { scope: 'global', profile: { response_style: 'direct' } });
  const issued = createAgentContextSession(db, { workspaceId: 'ws-harness', rootId: root.id, agent: 'codex', ttlMs: 120_000 });
  assert.equal(issued.token.length > 30, true);
  assert.equal(row(db, 'SELECT token_hash FROM agent_context_sessions WHERE id=?', issued.id).token_hash.includes(issued.token), false);
  assert.equal(authenticateAgentContext(db, 'wrong-token', 'status').ok, false);
  const authenticated = authenticateAgentContext(db, issued.token, 'status');
  assert.equal(authenticated.ok, true);
  const status = agentContextStatus(db, authenticated.session);
  assert.equal(status.root.id, root.id);
  assert.equal(status.instruction_context.project_instructions.content, 'Preserve the scoped agent evidence.');
  assert.equal(status.instruction_context.global_personalization.profile.response_style, 'direct');
  const querySession = authenticateAgentContext(db, issued.token, 'query').session;
  const query = agentContextQuery(db, querySession, 'scoped context evidence');
  assert.ok(query.selected.some(item => item.content.includes('scoped context only')));
  assert.equal(query.instruction_context.project_instructions.content, 'Preserve the scoped agent evidence.');
  const sourceSession = authenticateAgentContext(db, issued.token, 'sources').session;
  const sources = agentContextSources(db, sourceSession);
  const resource = sources.find(item => item.relative_path === 'README.md');
  assert.ok(resource);
  assert.ok(agentContextResource(db, authenticateAgentContext(db, issued.token, 'resource').session, resource.id).chunks.length > 0);
  const visualResource = sources.find(item => item.relative_path === 'agent-visual.png');
  const visualDetail = agentContextResource(db, authenticateAgentContext(db, issued.token, 'resource').session, visualResource.id);
  const originalVisual = visualDetail.representations.find(item => item.representation_kind === 'original_visual');
  assert.equal(agentContextVisual(db, authenticateAgentContext(db, issued.token, 'visual').session, originalVisual.id).resource_version_id, visualResource.current_version_id);

  const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agent-other-'));
  t.after(() => fs.rmSync(otherRepo, { recursive: true, force: true }));
  const timestamp = new Date().toISOString();
  run(db, `INSERT INTO workspaces (id,name,kind,description,active_focus,color,created_at,updated_at) VALUES ('ws-other','Other Project','mixed','','','slate',?,?)`, timestamp, timestamp);
  fs.writeFileSync(path.join(otherRepo, 'other.md'), 'This belongs only to another Project Space.');
  const otherRoot = registerWorkspaceRoot(db, 'ws-other', { rootPath: otherRepo, rootKind: 'repository' });
  reconcileWorkspaceResources(db, 'ws-other');
  const otherResource = row(db, `SELECT id FROM workspace_resources WHERE workspace_id='ws-other' AND relative_path='other.md'`);
  assert.throws(() => createAgentContextSession(db, { workspaceId: 'ws-other', rootId: root.id, agent: 'codex' }), error => error.code === 'AGENT_ROOT_NOT_REPOSITORY');
  assert.throws(() => agentContextResource(db, authenticateAgentContext(db, issued.token, 'resource').session, otherResource.id), error => error.code === 'AGENT_CONTEXT_RESOURCE_NOT_FOUND');
  assert.throws(() => agentContextVisual(db, authenticateAgentContext(db, issued.token, 'visual').session, row(db, `SELECT id FROM resource_representations WHERE resource_id=? AND representation_kind='original_source'`, otherResource.id)?.id), error => error.code === 'AGENT_CONTEXT_VISUAL_NOT_FOUND');
  assert.equal(otherRoot.workspace_id, 'ws-other');
  assert.equal(authenticateAgentContext(db, issued.token, 'write').code, 'AGENT_CONTEXT_CAPABILITY_DENIED');
  assert.equal(revokeAgentContextSession(db, issued.id), true);
  assert.equal(authenticateAgentContext(db, issued.token, 'status').code, 'AGENT_CONTEXT_AUTH_REJECTED');

  const expiring = createAgentContextSession(db, { workspaceId: 'ws-harness', rootId: root.id, agent: 'codex', ttlMs: 60_000 });
  run(db, 'UPDATE agent_context_sessions SET expires_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), expiring.id);
  assert.equal(authenticateAgentContext(db, expiring.token, 'status').code, 'AGENT_CONTEXT_EXPIRED');
  const helperSource = fs.readFileSync('scripts/aih-context.mjs', 'utf8');
  assert.equal(helperSource.includes("from '../src/db.mjs'"), false);
  assert.equal(helperSource.includes('writeFileSync'), false);
});
