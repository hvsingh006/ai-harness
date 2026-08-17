import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, ensureWorkspaceProjectRoot, row } from '../src/db.mjs';
import { captureBrowserSession } from '../src/chat-capture.mjs';
import { reconcileWorkspaceResources } from '../src/resources.mjs';
import { retrieveWorkspaceEvidence } from '../src/retrieval.mjs';
import { prepareManagedSend } from '../src/outgoing-context.mjs';

function completeCapture(chatId, messages = []) {
  return {
    workspace_id: 'ws-harness', provider: 'chatgpt', title: `Scale ${chatId}`, native_url: `https://chatgpt.com/c/${chatId}`,
    provider_refs: [{ ref_type: 'chat_id', ref_value: chatId, source: 'scale-test' }], messages, assets: [],
    capture_evidence: { synchronized_visible: true, reached_top: true, stable_rounds: 2, visible_message_count: messages.length, first_message_fingerprint: 'first', last_message_fingerprint: 'last', capture_started_at: new Date().toISOString(), capture_completed_at: new Date().toISOString(), provider_adapter_version: 'scale-test', reason_if_partial: '' }
  };
}

test('large cold corpus retrieval and warm prompt kickoff stay bounded and avoid heavy resource processing', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-scale-'));
  const db = openDatabase(path.join(directory, 'harness.db'));
  const root = ensureWorkspaceProjectRoot(db, 'ws-harness');
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  fs.writeFileSync(path.join(root, 'scale.md'), 'Current scale source seed.');
  reconcileWorkspaceResources(db, 'ws-harness');
  const resource = row(db, `SELECT * FROM workspace_resources WHERE relative_path='scale.md'`);
  const version = row(db, 'SELECT * FROM resource_versions WHERE id=?', resource.current_version_id);
  const captured = captureBrowserSession(db, completeCapture('cold-archive', [{ role: 'user', content: 'Scale archive seed.', provider_message_id: 'scale-message-0' }]));
  const sessionId = captured.session.id;

  const insertMessage = db.prepare(`INSERT INTO messages (id,session_id,provider_message_id,ordinal,role,content_text,clean_content_text,content_json,raw_json,content_hash,created_at,path_status)
    VALUES (?,?,?,?,?,?,?,'{}','{}',?,?, 'unknown')`);
  const insertMessageFts = db.prepare(`INSERT INTO message_fts (message_id,session_id,workspace_id,provider,title,role,content) VALUES (?,?,?,?,?,?,?)`);
  const insertChunk = db.prepare(`INSERT INTO resource_chunks (id,workspace_id,resource_id,resource_version_id,ordinal,content,content_hash,line_start,line_end,metadata_json,created_at,source_kind,authority,confidence,region_json)
    VALUES (?,?,?,?,?,?,?,?,?,'{}',?,'digital_text','source_derived',1,'{}')`);
  const insertChunkFts = db.prepare(`INSERT INTO resource_chunk_fts (chunk_id,workspace_id,resource_id,version_id,path,content) VALUES (?,?,?,?,?,?)`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 1; index < 2500; index++) {
      const id = `scale-message-${index}`;
      const role = index % 9 === 0 ? 'user' : 'assistant';
      const content = index === 2377 ? 'Cold user reasoning: NEEDLE_SCALE_2377 selects the retained reset plan.' : `Cold archive message ${index} with ordinary historical discussion.`;
      insertMessage.run(id, sessionId, id, index, role, content, content, `hash-${index}`, new Date(1700000000000 + index * 1000).toISOString());
      insertMessageFts.run(id, sessionId, 'ws-harness', 'chatgpt', 'Large cold archive', role, content);
    }
    db.prepare('DELETE FROM resource_chunk_fts WHERE version_id=?').run(version.id);
    db.prepare('DELETE FROM resource_chunks WHERE resource_version_id=?').run(version.id);
    for (let index = 0; index < 1200; index++) {
      const id = `scale-chunk-${index}`;
      const content = index === 1111 ? 'Current authoritative source: SCALE_RESOURCE_TARGET is controller.sv.' : `Current source chunk ${index} with bounded generated scale data.`;
      insertChunk.run(id, 'ws-harness', resource.id, version.id, index, content, `chunk-hash-${index}`, index + 1, index + 1, new Date().toISOString());
      insertChunkFts.run(id, 'ws-harness', resource.id, version.id, 'scale.md', content);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const retrieval = retrieveWorkspaceEvidence(db, { workspaceId: 'ws-harness', provider: 'gemini', query: 'Find NEEDLE_SCALE_2377 and SCALE_RESOURCE_TARGET', characterBudget: 18000 });
  assert.equal(retrieval.selected.some(item => item.content.includes('NEEDLE_SCALE_2377')), true);
  assert.equal(retrieval.selected.some(item => item.content.includes('SCALE_RESOURCE_TARGET')), true);
  assert.ok(retrieval.candidate_count < 400, `candidate generation should remain bounded, got ${retrieval.candidate_count}`);
  assert.ok(retrieval.used_characters <= 18000);

  const prepared = await prepareManagedSend(db, {
    workspaceId: 'ws-harness', provider: 'chatgpt', surfaceId: 'chatgpt.web', userPrompt: 'What should I work on next? Include NEEDLE_SCALE_2377.',
    capture: completeCapture('scale-live'), attemptId: 'scale-kickoff', providerRoute: 'https://chatgpt.com/c/scale-live', protocolVersion: 4
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.diagnostics.files_hashed, 0);
  assert.equal(prepared.diagnostics.files_processed, 0);
  assert.equal(prepared.diagnostics.fast_path, true);
  assert.match(prepared.context_envelope, /NEEDLE_SCALE_2377/);
});
