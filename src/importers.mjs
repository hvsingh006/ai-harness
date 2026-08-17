import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { archiveDirectory, sha256Text } from './archive.mjs';
import { row, run, upsertSessionExternalRef } from './db.mjs';

function isoFromEpoch(value) {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return new Date(n > 10_000_000_000 ? n : n * 1000).toISOString();
}

function flattenChatGPTMessage(message) {
  if (!message) return '';
  const content = message.content || {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const strings = [];
  for (const part of parts) {
    if (typeof part === 'string') strings.push(part);
    else if (part && typeof part === 'object') strings.push(part.text || part.content || JSON.stringify(part));
  }
  if (!strings.length && typeof content.text === 'string') strings.push(content.text);
  return strings.join('\n').trim();
}

function orderedChatGPTMessages(conversation) {
  const mapping = conversation.mapping || {};
  const nodes = Object.entries(mapping).map(([nodeId, node]) => ({ nodeId, ...node })).filter(node => node.message);
  nodes.sort((a, b) => {
    const at = Number(a.message?.create_time || 0);
    const bt = Number(b.message?.create_time || 0);
    if (at !== bt) return at - bt;
    return String(a.nodeId).localeCompare(String(b.nodeId));
  });
  return nodes;
}

function upsertFts(db, session, message) {
  try {
    run(db, `INSERT INTO message_fts (message_id,session_id,workspace_id,provider,title,role,content) VALUES (?,?,?,?,?,?,?)`,
      message.id, session.id, session.workspace_id, session.provider, session.title, message.role, message.content_text);
  } catch {
    // Optional index.
  }
}

export function importChatGPTExport(db, { directory, workspaceId }) {
  const candidates = fs.readdirSync(directory).filter(name => /^conversations(?:-\d+)?\.json$/i.test(name) || name === 'conversations.json');
  if (!candidates.length) throw new Error('No conversations.json file found in the extracted ChatGPT export directory.');
  const createdAt = new Date().toISOString();
  const importId = `import-${randomUUID()}`;
  run(db, `INSERT INTO imports (id,workspace_id,provider,import_type,source_path,status,created_at) VALUES (?,?,?,?,?,'running',?)`,
    importId, workspaceId, 'chatgpt', 'chatgpt_export', directory, createdAt);

  const artifacts = archiveDirectory(db, { directory, workspaceId, importId, provider: 'chatgpt', ignore: [path.join(directory, '.aih-upload.json')] });
  let sessionCount = 0;
  let messageCount = 0;
  const warnings = [];

  try {
    for (const filename of candidates) {
      const raw = fs.readFileSync(path.join(directory, filename), 'utf8');
      const conversations = JSON.parse(raw);
      if (!Array.isArray(conversations)) continue;
      for (const conversation of conversations) {
        const externalId = String(conversation.id || conversation.conversation_id || sha256Text(JSON.stringify(conversation)).slice(0, 24));
        let session = row(db, 'SELECT * FROM sessions WHERE provider = ? AND external_id = ?', 'chatgpt', externalId);
        const start = isoFromEpoch(conversation.create_time) || createdAt;
        const end = isoFromEpoch(conversation.update_time);
        if (!session) {
          const id = `session-${randomUUID()}`;
          run(db, `INSERT INTO sessions (id,workspace_id,provider,title,native_url,summary,capture_status,started_at,ended_at,message_count,external_id,import_id,raw_complete,attachments_complete,derived_complete,last_captured_at,history_coverage,capture_evidence_json)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            id, workspaceId, 'chatgpt', conversation.title || 'Imported ChatGPT conversation', '', '', 'raw_archived', start, end, 0, externalId, importId, 1, 1, 0, createdAt, 'complete', JSON.stringify({ source: 'chatgpt_export', raw_export_complete: true }));
          session = row(db, 'SELECT * FROM sessions WHERE id = ?', id);
          sessionCount += 1;
        }
        upsertSessionExternalRef(db, { sessionId: session.id, provider: 'chatgpt', refType: 'chat_id', refValue: externalId, source: 'chatgpt_export' });
        if (!session.display_label) {
          const workspaceName = row(db, 'SELECT name FROM workspaces WHERE id=?', session.workspace_id)?.name || 'Workspace';
          const short = String(session.id).replace(/^session-/, '').slice(0, 8);
          run(db, 'UPDATE sessions SET display_label=? WHERE id=?', `AIH · ${workspaceName} · ${short}`, session.id);
          session.display_label = `AIH · ${workspaceName} · ${short}`;
        }
        const nodes = orderedChatGPTMessages(conversation);
        let ordinal = row(db, 'SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal FROM messages WHERE session_id = ?', session.id).max_ordinal + 1;
        for (const node of nodes) {
          const providerMessageId = String(node.message?.id || node.nodeId || '');
          if (providerMessageId && row(db, 'SELECT id FROM messages WHERE session_id = ? AND provider_message_id = ?', session.id, providerMessageId)) continue;
          const contentText = flattenChatGPTMessage(node.message);
          const role = node.message?.author?.role || 'unknown';
          const id = `msg-${randomUUID()}`;
          const message = {
            id,
            role,
            content_text: contentText
          };
          run(db, `INSERT INTO messages (id,session_id,provider_message_id,parent_provider_message_id,ordinal,role,content_text,clean_content_text,content_json,raw_json,content_hash,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            id, session.id, providerMessageId, String(node.parent || ''), ordinal++, role, contentText, contentText,
            JSON.stringify(node.message?.content || {}), JSON.stringify(node.message || {}), sha256Text(contentText), isoFromEpoch(node.message?.create_time));
          upsertFts(db, session, message);
          messageCount += 1;
        }
        run(db, 'UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?), last_captured_at = ? WHERE id = ?', session.id, createdAt, session.id);
        run(db, `UPDATE sessions SET history_coverage='complete' WHERE id=?`, session.id);
        setCaptureStages(db, session.id, { raw: true, attachments: true, derived: false, search: true });
      }
    }
    run(db, `UPDATE imports SET status='complete', raw_file_count=?, parsed_session_count=?, parsed_message_count=?, artifact_count=?, warnings_json=?, completed_at=? WHERE id=?`,
      artifacts.length, sessionCount, messageCount, artifacts.length, JSON.stringify(warnings), new Date().toISOString(), importId);
  } catch (error) {
    warnings.push(error.message);
    run(db, `UPDATE imports SET status='failed', raw_file_count=?, parsed_session_count=?, parsed_message_count=?, artifact_count=?, warnings_json=?, completed_at=? WHERE id=?`,
      artifacts.length, sessionCount, messageCount, artifacts.length, JSON.stringify(warnings), new Date().toISOString(), importId);
    throw error;
  }
  return row(db, 'SELECT * FROM imports WHERE id = ?', importId);
}

export function importProviderArchive(db, { directory, workspaceId, provider = 'unknown' }) {
  const createdAt = new Date().toISOString();
  const importId = `import-${randomUUID()}`;
  run(db, `INSERT INTO imports (id,workspace_id,provider,import_type,source_path,status,created_at) VALUES (?,?,?,?,?,'running',?)`,
    importId, workspaceId, provider, 'lossless_archive', directory, createdAt);
  try {
    const artifacts = archiveDirectory(db, { directory, workspaceId, importId, provider, ignore: [path.join(directory, '.aih-upload.json')] });
    run(db, `UPDATE imports SET status='complete', raw_file_count=?, artifact_count=?, completed_at=? WHERE id=?`, artifacts.length, artifacts.length, new Date().toISOString(), importId);
    return row(db, 'SELECT * FROM imports WHERE id = ?', importId);
  } catch (error) {
    run(db, `UPDATE imports SET status='failed', warnings_json=?, completed_at=? WHERE id=?`, JSON.stringify([error.message]), new Date().toISOString(), importId);
    throw error;
  }
}

export function setCaptureStages(db, sessionId, stages) {
  const now = new Date().toISOString();
  const labels = {
    raw: 'raw_transcript',
    userInputs: 'user_input_attachments',
    providerOutputs: 'provider_generated_assets',
    derived: 'derived_state',
    search: 'search_index'
  };
  const normalized = { ...stages };
  // Compatibility for lossless archive importers that already proved all asset
  // classes complete. Live browser capture uses the two explicit stages.
  if (Object.hasOwn(normalized, 'attachments')) {
    normalized.userInputs ??= normalized.attachments;
    normalized.providerOutputs ??= normalized.attachments;
    delete normalized.attachments;
  }
  for (const [key, value] of Object.entries(normalized)) {
    if (!(key in labels)) continue;
    const complete = typeof value === 'object' ? Boolean(value.complete) : Boolean(value);
    const details = typeof value === 'object' ? String(value.details || '').slice(0, 1000) : '';
    const id = `stage-${sessionId}-${labels[key]}`;
    run(db, `INSERT INTO capture_stages (id,session_id,stage,status,details,updated_at) VALUES (?,?,?,?,?,?)
             ON CONFLICT(session_id,stage) DO UPDATE SET status=excluded.status,details=excluded.details,updated_at=excluded.updated_at`,
      id, sessionId, labels[key], complete ? 'complete' : 'pending', details, now);
  }
  const required = ['raw_transcript','user_input_attachments','provider_generated_assets','derived_state','search_index'];
  const stageRows = db.prepare(`SELECT stage,status FROM capture_stages WHERE session_id=?`).all(sessionId);
  const state = Object.fromEntries(stageRows.map(r => [r.stage, r.status]));
  const completed = required.filter(stage => state[stage] === 'complete').length;
  const status = completed === required.length ? 'safe_to_delete' : 'captured_incomplete';
  const userInputsComplete = state.user_input_attachments === 'complete';
  const providerOutputsComplete = state.provider_generated_assets === 'complete';
  run(db, `UPDATE sessions SET capture_status=?,raw_complete=?,attachments_complete=?,user_input_assets_complete=?,provider_output_assets_complete=?,derived_complete=? WHERE id=?`,
    status, state.raw_transcript === 'complete' ? 1 : 0, userInputsComplete && providerOutputsComplete ? 1 : 0,
    userInputsComplete ? 1 : 0, providerOutputsComplete ? 1 : 0, state.derived_state === 'complete' ? 1 : 0, sessionId);
}
