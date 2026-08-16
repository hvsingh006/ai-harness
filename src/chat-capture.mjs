import { randomUUID } from 'node:crypto';
import { row, rows, run, upsertSessionExternalRef } from './db.mjs';
import { sha256Text } from './archive.mjs';
import { setCaptureStages } from './importers.mjs';

const PROVIDERS = new Set(['chatgpt', 'gemini']);
const PROVIDER_ASSET_HOSTS = Object.freeze({
  chatgpt: ['chatgpt.com', 'oaiusercontent.com', 'oaistatic.com'],
  gemini: ['gemini.google.com', 'googleusercontent.com', 'gstatic.com']
});

function providerAssetHostAllowed(provider, hostname) {
  const host = String(hostname || '').toLowerCase();
  return (PROVIDER_ASSET_HOSTS[provider] || []).some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

export function validateProviderAssetUrl(provider, value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { return { ok: false, status: 'FAILED', code: 'ASSET_URL_INVALID' }; }
  if (parsed.protocol === 'blob:') {
    let embeddedOrigin;
    try { embeddedOrigin = new URL(parsed.origin); } catch { return { ok: false, status: 'FAILED', code: 'ASSET_BLOB_ORIGIN_REJECTED' }; }
    if (embeddedOrigin.protocol !== 'https:' || !providerAssetHostAllowed(provider, embeddedOrigin.hostname)) {
      return { ok: false, status: 'FAILED', code: 'ASSET_BLOB_ORIGIN_REJECTED' };
    }
    return { ok: true, status: 'DISCOVERED', url: parsed.href, capture_strategy: 'page_blob' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, status: 'FAILED', code: 'ASSET_URL_SCHEME_REJECTED' };
  if (!providerAssetHostAllowed(provider, parsed.hostname)) return { ok: false, status: 'FAILED', code: 'ASSET_ORIGIN_REJECTED' };
  return { ok: true, status: 'DISCOVERED', url: parsed.href, capture_strategy: 'background_https' };
}

export function cleanManagedUserText(content) {
  const text = String(content || '').trim();
  const match = text.match(/\[USER MESSAGE\]\s*\n([\s\S]*?)\n\[\/USER MESSAGE\]/i);
  return match ? match[1].trim() : text;
}

export function resolveSessionByRefs(db, provider, refs = []) {
  for (const ref of refs) {
    const type = String(ref.ref_type || '').trim();
    const value = String(ref.ref_value || '').trim();
    if (!type || !value) continue;
    const found = row(db, `SELECT s.* FROM session_external_refs r JOIN sessions s ON s.id=r.session_id WHERE r.provider=? AND r.ref_type=? AND r.ref_value=?`, provider, type, value);
    if (found) return found;
  }
  return null;
}

function sessionLabel(session, workspaceName = '') {
  if (session.display_label) return session.display_label;
  const short = String(session.id || '').replace(/^session-/, '').slice(0, 8);
  return `AIH · ${workspaceName || 'Workspace'} · ${short}`;
}

function captureComplete(evidence) {
  return evidence?.reached_top === true && Number(evidence?.stable_rounds || 0) >= 2 && !evidence?.reason_if_partial;
}

export function captureBrowserSession(db, body) {
  const workspaceId = String(body.workspace_id || '');
  const workspace = row(db, 'SELECT * FROM workspaces WHERE id=?', workspaceId);
  if (!workspace) throw Object.assign(new Error('workspace not found'), { code: 'WORKSPACE_NOT_FOUND' });
  const provider = String(body.provider || '').toLowerCase();
  if (!PROVIDERS.has(provider)) throw Object.assign(new Error('unsupported provider'), { code: 'INVALID_PROVIDER' });
  const nativeUrl = String(body.native_url || '');
  let parsedNativeUrl = null;
  if (nativeUrl) {
    try { parsedNativeUrl = new URL(nativeUrl); } catch { throw Object.assign(new Error('invalid provider URL'), { code: 'INVALID_REQUEST' }); }
    const expectedHost = provider === 'chatgpt' ? 'chatgpt.com' : 'gemini.google.com';
    if (parsedNativeUrl.protocol !== 'https:' || parsedNativeUrl.hostname !== expectedHost) throw Object.assign(new Error('provider URL host rejected'), { code: 'INVALID_REQUEST' });
  }
  const allowedRefTypes = new Set(['chat_id', 'route', 'native_url']);
  const providerRefs = Array.isArray(body.provider_refs) ? body.provider_refs
    .filter(ref => ref && allowedRefTypes.has(String(ref.ref_type)) && String(ref.ref_value || '').length <= 4096)
    .slice(0, 12) : [];
  const chatRef = providerRefs.find(ref => ref.ref_type === 'chat_id');
  const stableNativeUrl = parsedNativeUrl && (provider === 'chatgpt' ? /^\/c\/[^/]+/.test(parsedNativeUrl.pathname) : /^\/app\/[^/]+/.test(parsedNativeUrl.pathname));
  if (nativeUrl && (chatRef || stableNativeUrl) && !providerRefs.some(ref => ref.ref_type === 'native_url' && ref.ref_value === nativeUrl)) {
    providerRefs.push({ ref_type: 'native_url', ref_value: nativeUrl, source: 'browser_companion' });
  }
  const externalId = String(chatRef?.ref_value || body.external_id || (nativeUrl ? sha256Text(nativeUrl).slice(0, 32) : randomUUID()));
  let session = resolveSessionByRefs(db, provider, providerRefs) || row(db, 'SELECT * FROM sessions WHERE provider=? AND external_id=?', provider, externalId);
  if (session && session.workspace_id !== workspaceId) {
    throw Object.assign(new Error('provider conversation belongs to another Project Space'), { code: 'SESSION_WORKSPACE_MISMATCH', sessionId: session.id });
  }
  const observedAt = new Date().toISOString();
  let sessionCreated = false;
  if (!session) {
    const id = `session-${randomUUID()}`;
    run(db, `INSERT INTO sessions (id,workspace_id,provider,title,native_url,summary,capture_status,started_at,message_count,external_id,raw_complete,attachments_complete,derived_complete,last_captured_at,history_coverage,capture_evidence_json)
             VALUES (?,?,?,?,?,?,'captured_incomplete',?,0,?,0,0,0,?,'partial',?)`,
      id, workspaceId, provider, body.title || `${provider} session`, nativeUrl, '', body.started_at || observedAt, externalId, observedAt, JSON.stringify(body.capture_evidence || {}));
    session = row(db, 'SELECT * FROM sessions WHERE id=?', id);
    sessionCreated = true;
  } else {
    run(db, 'UPDATE sessions SET title=?,native_url=?,last_captured_at=?,capture_evidence_json=? WHERE id=?',
      body.title || session.title, nativeUrl || session.native_url, observedAt, JSON.stringify(body.capture_evidence || {}), session.id);
  }

  const label = sessionLabel(session, workspace.name);
  if (!session.display_label) run(db, 'UPDATE sessions SET display_label=? WHERE id=?', label, session.id);
  for (const ref of providerRefs) upsertSessionExternalRef(db, { sessionId: session.id, provider, refType: ref.ref_type, refValue: ref.ref_value, source: ref.source || 'browser_companion' });

  let messagesAdded = 0;
  let deliveriesReconciled = 0;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = 0; index < messages.length; index++) {
    const item = messages[index] || {};
    const rawContent = String(item.content || item.text || '').trim();
    if (!rawContent) continue;
    const providerMessageId = String(item.provider_message_id || sha256Text(`${item.role || 'unknown'}\0${rawContent}\0${index}`).slice(0, 32));
    if (row(db, 'SELECT id FROM messages WHERE session_id=? AND provider_message_id=?', session.id, providerMessageId)) continue;
    const ordinal = Number(row(db, 'SELECT COALESCE(MAX(ordinal), -1) AS n FROM messages WHERE session_id=?', session.id)?.n ?? -1) + 1;
    const id = `msg-${randomUUID()}`;
    const cleanContent = item.role === 'user' ? cleanManagedUserText(rawContent) : rawContent;
    let outgoingContextRunId = item.outgoing_context_run_id || null;
    if (item.role === 'user' && !outgoingContextRunId) {
      const exactProviderTextHash = sha256Text(rawContent);
      const uncertainRun = row(db, `SELECT * FROM outgoing_context_runs
        WHERE workspace_id=? AND session_id=? AND provider=? AND final_context_hash=?
          AND status IN ('prepared','blocked') AND delivery_state IN ('PREPARED','ERROR')
        ORDER BY created_at DESC LIMIT 1`, workspaceId, session.id, provider, exactProviderTextHash);
      if (uncertainRun) {
        const acceptance = {
          accepted: true,
          certainty: 'reconciled',
          observed_at: observedAt,
          signals: { exact_provider_message_hash: true, provider_message_id: providerMessageId },
          prior_failure_code: uncertainRun.failure_code || ''
        };
        const metadata = JSON.parse(uncertainRun.metadata_json || '{}');
        metadata.delivery_recovery = { method: 'exact_provider_message_hash', observed_at: observedAt, provider_message_id: providerMessageId, prior_failure_code: uncertainRun.failure_code || '' };
        run(db, `UPDATE outgoing_context_runs SET status='sent',delivery_state='DONE',failure_code='',acceptance_json=?,metadata_json=?,sent_at=COALESCE(sent_at,?) WHERE id=?`,
          JSON.stringify(acceptance), JSON.stringify(metadata), observedAt, uncertainRun.id);
        outgoingContextRunId = uncertainRun.id;
        deliveriesReconciled += 1;
      }
    }
    const harnessManaged = cleanContent !== rawContent || Boolean(outgoingContextRunId);
    run(db, `INSERT INTO messages (id,session_id,provider_message_id,parent_provider_message_id,ordinal,role,content_text,clean_content_text,content_json,raw_json,content_hash,created_at,outgoing_context_run_id,harness_managed)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, session.id, providerMessageId, '', ordinal, item.role || 'unknown', rawContent, cleanContent,
      JSON.stringify(item.content_json || {}), JSON.stringify(item.raw || {}), sha256Text(cleanContent), item.created_at || observedAt,
      outgoingContextRunId, harnessManaged ? 1 : 0);
    try {
      run(db, `INSERT INTO message_fts (message_id,session_id,workspace_id,provider,title,role,content) VALUES (?,?,?,?,?,?,?)`,
        id, session.id, workspaceId, provider, body.title || session.title, item.role || 'unknown', cleanContent);
    } catch {}
    messagesAdded += 1;
  }

  const assets = Array.isArray(body.assets) ? body.assets : [];
  for (const asset of assets) {
    const validated = validateProviderAssetUrl(provider, asset.url);
    const nativeId = String(asset.native_id || sha256Text(`${asset.url || ''}|${asset.name || ''}`).slice(0, 32));
    const existingAsset = row(db, 'SELECT * FROM session_assets WHERE session_id=? AND native_id=?', session.id, nativeId);
    if (existingAsset) {
      if (validated.ok && ['UNAVAILABLE','AUTH_REQUIRED','CORS_BLOCKED','EXPIRED','FAILED'].includes(String(existingAsset.mirror_status).toUpperCase())) {
        run(db, `UPDATE session_assets SET source_url=?,mirror_status='DISCOVERED',updated_at=? WHERE id=?`, validated.url, observedAt, existingAsset.id);
      }
      continue;
    }
    run(db, `INSERT INTO session_assets (id,session_id,provider,asset_type,name,source_url,native_id,mime_type,mirror_status,metadata_json,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      `assetref-${randomUUID()}`, session.id, provider, asset.asset_type || 'file', asset.name || '', asset.url || '', nativeId,
      asset.mime_type || 'application/octet-stream', validated.status,
      JSON.stringify({ ...(asset.metadata || {}), discovery_code: validated.code || '', discovered_url: validated.ok ? validated.url : '', capture_strategy: validated.capture_strategy || '' }), observedAt, observedAt);
  }

  const evidence = body.capture_evidence || {};
  const rawComplete = captureComplete(evidence);
  const assetRefs = Number(row(db, 'SELECT COUNT(*) AS n FROM session_assets WHERE session_id=?', session.id)?.n || 0);
  const unmirrored = Number(row(db, `SELECT COUNT(*) AS n FROM session_assets WHERE session_id=? AND UPPER(mirror_status)!='CAPTURED'`, session.id)?.n || 0);
  setCaptureStages(db, session.id, { raw: rawComplete, attachments: assetRefs === 0 || unmirrored === 0, derived: false, search: true });
  run(db, `UPDATE sessions SET message_count=(SELECT COUNT(*) FROM messages WHERE session_id=?),last_captured_at=?,history_coverage=?,capture_evidence_json=? WHERE id=?`,
    session.id, observedAt, rawComplete ? 'complete' : 'partial', JSON.stringify(evidence), session.id);
  const coverage = workspaceHistoryCoverage(db, workspaceId);
  if (messagesAdded || sessionCreated) run(db, `UPDATE workspaces SET chat_generation=chat_generation+1,history_coverage=?,updated_at=? WHERE id=?`, coverage, observedAt, workspaceId);
  else run(db, `UPDATE workspaces SET history_coverage=? WHERE id=?`, coverage, workspaceId);

  return {
    session: row(db, 'SELECT * FROM sessions WHERE id=?', session.id),
    workspace,
    provider_refs: rows(db, 'SELECT ref_type,ref_value,source FROM session_external_refs WHERE session_id=? ORDER BY ref_type', session.id),
    capture_stages: rows(db, 'SELECT stage,status,details,updated_at FROM capture_stages WHERE session_id=? ORDER BY stage', session.id),
    asset_refs: rows(db, 'SELECT * FROM session_assets WHERE session_id=? ORDER BY created_at', session.id),
    messages_added: messagesAdded,
    deliveries_reconciled: deliveriesReconciled,
    synchronized_visible: evidence.synchronized_visible === true,
    raw_capture_complete: rawComplete
  };
}

export function workspaceHistoryCoverage(db, workspaceId) {
  const sessions = rows(db, 'SELECT history_coverage,capture_status FROM sessions WHERE workspace_id=?', workspaceId);
  if (!sessions.length) return 'unknown';
  return sessions.every(session => session.history_coverage === 'complete') ? 'complete' : 'partial';
}
