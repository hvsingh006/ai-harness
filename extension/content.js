(() => {
  const AUTO_CAPTURE_INTERVAL_MS = 15000;
  const COMPANION_VERSION = chrome.runtime.getManifest().version;
  const PROTOCOL_VERSION = 4;
  const transactionModel = globalThis.AIH_SEND_TRANSACTION;
  const SEND_STATES = transactionModel?.STATES;
  const provider = location.hostname === 'chatgpt.com' ? 'chatgpt' : location.hostname === 'gemini.google.com' ? 'gemini' : '';
  const adapter = globalThis.AIH_PROVIDER_ADAPTERS?.[provider];
  if (!adapter || !transactionModel || document.getElementById('aih-companion')) return;
  const pendingSessionRef = { ref_type: 'route', ref_value: `pending:${provider}:${crypto.randomUUID()}`, source: 'browser_companion' };

  let workspace = null;
  let boundSession = null;
  let lastFingerprint = '';
  let lastLocationHref = location.href;
  let captureInFlight = false;
  let autoCaptureEnabled = true;
  let sendState = SEND_STATES.IDLE;
  let sendAttempt = null;
  let cardNote = null;
  let attachmentFallbackButton = null;
  let pendingAttachmentFallback = null;
  let pendingIdentityUsed = false;
  let associationConfirmed = false;
  let harnessAttachmentInjection = false;
  const nativeInputAssets = new Map();
  const nativeInputReadTasks = new Set();
  const recentNativeFileEvents = new Map();
  let draftTimer = null;
  let lastDraftHash = '';

  function moveSendState(next) {
    if (sendAttempt?.transaction && sendAttempt.transaction.state !== next) sendAttempt.transaction.transition(next);
    sendState = next;
  }

  async function request(path, options = {}) {
    const result = await chrome.runtime.sendMessage({
      type: 'aih-api-request',
      path,
      options: {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        body: typeof options.body === 'string' ? options.body : options.body === undefined ? undefined : JSON.stringify(options.body)
      }
    });
    if (!result) throw new Error('Harness companion background unavailable');
    if (result.error) throw new Error(result.error);
    let payload = null;
    try { payload = result.text ? JSON.parse(result.text) : null; } catch {}
    if (!result.ok) {
      const error = new Error(payload?.reasons?.map(item => item.message).join('; ') || payload?.error || `Harness request failed (${result.status})`);
      error.payload = payload;
      error.code = payload?.code || payload?.reasons?.[0]?.code || 'HARNESS_REQUEST_FAILED';
      throw error;
    }
    return payload;
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function providerName() {
    return provider === 'chatgpt' ? 'ChatGPT' : 'Gemini';
  }

  function providerRefs() {
    const refs = adapter.refs();
    if (refs.some(ref => ref.ref_type === 'chat_id')) return pendingIdentityUsed ? [pendingSessionRef, ...refs] : refs;
    return [pendingSessionRef];
  }

  function uniqueMessages(items) {
    const seen = new Set();
    return items.filter(item => {
      const key = item.provider_message_id || `${item.role}\0${item.content}`;
      if (!item.content || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function captureMessages() {
    return uniqueMessages(adapter.captureMessages());
  }

  function captureAssets() {
    const assets = [...nativeInputAssets.values()].map(item => ({ ...item.descriptor }));
    const seen = new Set();
    const filePattern = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|md|zip|png|jpe?g|webp|gif)(?:[?#]|$)/i;
    for (const anchor of document.querySelectorAll('a[href]')) {
      const url = anchor.href;
      const context = adapter.messageContext(anchor);
      const providerFileEvidence = anchor.hasAttribute('download') || /file|download|attachment/i.test(anchor.getAttribute('aria-label') || '') || Boolean(anchor.closest?.('[data-testid*="file"], [data-testid*="attachment"], [class*="attachment"]'));
      if (!context || !url || seen.has(url) || !providerFileEvidence || (!filePattern.test(url) && !anchor.hasAttribute('download'))) continue;
      seen.add(url);
      assets.push({ asset_type: 'file', name: (anchor.getAttribute('download') || anchor.textContent?.trim() || 'linked asset').slice(0, 240), url,
        native_id: anchor.dataset?.id || `${context.provider_message_id}:${url}`, origin_kind: context.role === 'user' ? 'user_input' : 'provider_output',
        originating_provider_message_id: context.provider_message_id, capture_method: String(url).startsWith('blob:') ? 'page_blob' : 'history_dom' });
    }
    for (const image of document.querySelectorAll('main img[src], [role="main"] img[src]')) {
      const url = image.currentSrc || image.src;
      const context = adapter.messageContext(image);
      if (!context || !url || url.startsWith('data:') || seen.has(url) || (image.naturalWidth && image.naturalWidth < 120 && image.naturalHeight < 120)) continue;
      seen.add(url);
      assets.push({ asset_type: 'image', name: image.alt || 'conversation image', url, mime_type: 'image/*',
        native_id: `${context.provider_message_id}:${url}`, origin_kind: context.role === 'user' ? 'user_input' : 'provider_output',
        originating_provider_message_id: context.provider_message_id, capture_method: String(url).startsWith('blob:') ? 'page_blob' : 'history_dom' });
    }
    return assets;
  }

  async function stageNativeInputFile(file, captureMethod) {
    if (!file || harnessAttachmentInjection) return;
    const eventKey = `${file.name || ''}\0${file.type || ''}\0${Number(file.size || 0)}\0${Number(file.lastModified || 0)}`;
    const previousEvent = recentNativeFileEvents.get(eventKey) || 0;
    if (Date.now() - previousEvent < 2000) return;
    recentNativeFileEvents.set(eventKey, Date.now());
    const nativeId = `native-input-${crypto.randomUUID()}`;
    const item = {
      descriptor: {
        asset_type: String(file.type || '').startsWith('image/') ? 'image' : 'file',
        name: String(file.name || (captureMethod === 'clipboard_image' ? 'clipboard-image.png' : 'native-input')).slice(0, 240),
        url: '',
        native_id: nativeId,
        mime_type: String(file.type || 'application/octet-stream').slice(0, 200),
        origin_kind: 'user_input',
        capture_method: captureMethod,
        metadata: { size_bytes: Number(file.size || 0), last_modified: Number(file.lastModified || 0), captured_from_composer: true }
      },
      data_base64: '',
      state: 'reading',
      error: ''
    };
    nativeInputAssets.set(nativeId, item);
    const task = (async () => {
      if (Number(file.size || 0) > 25 * 1024 * 1024) throw new Error('native input asset exceeds the 25 MiB durable capture limit');
      item.data_base64 = encodeAssetBytes(await file.arrayBuffer());
      item.state = 'pending';
    })().catch(error => {
      item.state = 'failed';
      item.error = error.message;
      item.descriptor.metadata.capture_error = error.message;
    }).finally(() => nativeInputReadTasks.delete(task));
    nativeInputReadTasks.add(task);
    return task;
  }

  async function visibleEvidence({ complete = false } = {}) {
    const startedAt = new Date().toISOString();
    const scroller = adapter.conversationScroller();
    const previousTop = scroller?.scrollTop || 0;
    let stableRounds = 0;
    let previousFirst = '';
    let previousCount = -1;
    let reachedTop = !scroller || scroller.scrollTop <= 1;
    if (complete && scroller) {
      for (let round = 0; round < 16; round++) {
        const messages = captureMessages();
        const first = messages[0] ? await sha256(`${messages[0].role}\0${messages[0].content}`) : '';
        if (messages.length === previousCount && first === previousFirst && !adapter.loadingVisible()) stableRounds += 1;
        else stableRounds = 0;
        previousCount = messages.length;
        previousFirst = first;
        reachedTop = scroller.scrollTop <= 1;
        if (reachedTop && stableRounds >= 2) break;
        scroller.scrollTop = 0;
        await new Promise(resolve => setTimeout(resolve, 350));
      }
      try { scroller.scrollTop = previousTop; } catch {}
    }
    const messages = captureMessages();
    const firstMessageFingerprint = messages[0] ? await sha256(`${messages[0].role}\0${messages[0].content}`) : '';
    const lastMessageFingerprint = messages.at(-1) ? await sha256(`${messages.at(-1).role}\0${messages.at(-1).content}`) : '';
    if (!complete) stableRounds = 0;
    if (!messages.length && reachedTop) stableRounds = 2;
    return {
      synchronized_visible: !adapter.loadingVisible(),
      reached_top: reachedTop,
      stable_rounds: stableRounds,
      visible_message_count: messages.length,
      first_message_fingerprint: firstMessageFingerprint,
      last_message_fingerprint: lastMessageFingerprint,
      capture_started_at: startedAt,
      capture_completed_at: new Date().toISOString(),
      provider_adapter_version: adapter.version,
      reason_if_partial: reachedTop && stableRounds >= 2 ? '' : complete ? 'provider history did not reach a stable top boundary' : 'periodic visible-DOM capture'
    };
  }

  async function capturePayload({ complete = false } = {}) {
    const evidence = await visibleEvidence({ complete });
    const capabilities = adapter.capabilities();
    evidence.capabilities = capabilities;
    evidence.protocol_version = PROTOCOL_VERSION;
    if (complete && !capabilities.ok) {
      evidence.synchronized_visible = false;
      evidence.reason_if_partial = capabilities.failures.map(item => item.code).join(', ');
    }
    const refs = providerRefs();
    if (!refs.some(ref => ref.ref_type === 'chat_id')) pendingIdentityUsed = true;
    return {
      workspace_id: workspace.id,
      provider,
      title: document.title.replace(/\s*[-|]\s*(ChatGPT|Gemini).*$/i, '').trim() || `${providerName()} session`,
      native_url: location.href,
      external_id: refs.find(ref => ref.ref_type === 'chat_id')?.ref_value || pendingSessionRef.ref_value,
      provider_refs: refs,
      messages: captureMessages(),
      assets: captureAssets(),
      capture_evidence: evidence
    };
  }

  async function resolveCurrentSession() {
    const params = new URLSearchParams({ provider });
    for (const ref of providerRefs()) params.set(ref.ref_type, ref.ref_value);
    try { return await request(`/companion/provider-session?${params.toString()}`); }
    catch { return null; }
  }

  function prewarmProject() {
    if (!workspace?.id || !associationConfirmed) return Promise.resolve(null);
    return request(`/companion/workspaces/${encodeURIComponent(workspace.id)}/prewarm`, { method: 'POST', body: { provider, surface_id: adapter.surfaceId, session_id: boundSession?.id || '' } }).catch(() => null);
  }

  function scheduleDraftRetrieval() {
    clearTimeout(draftTimer);
    if (!workspace?.id || !associationConfirmed || sendState !== SEND_STATES.IDLE) return;
    draftTimer = setTimeout(async () => {
      const draft = adapter.composerText(adapter.findComposer()).trim();
      if (draft.length < 3) return;
      const draftHash = await sha256(draft);
      if (draftHash === lastDraftHash) return;
      lastDraftHash = draftHash;
      await request(`/companion/workspaces/${encodeURIComponent(workspace.id)}/draft-context`, { method: 'POST', body: { provider, surface_id: adapter.surfaceId, session_id: boundSession?.id || '', query: draft, query_hash: draftHash } }).catch(() => {});
    }, 800);
  }

  async function captureCurrent({ force = false, complete = false } = {}) {
    if (captureInFlight || !workspace || !associationConfirmed) return null;
    const messages = captureMessages();
    const assets = captureAssets();
    const fingerprint = `${location.href}|${messages.length}|${assets.length}|${[...nativeInputAssets.values()].map(item => item.state).join(',')}|${messages.slice(-3).map(item => item.content).join('|')}`;
    if (!force && (!messages.length || fingerprint === lastFingerprint)) return null;
    captureInFlight = true;
    try {
      const result = await request('/companion/capture', { method: 'POST', body: await capturePayload({ complete }) });
      for (const asset of result.asset_refs || []) {
        if (String(asset.mirror_status).toUpperCase() !== 'DISCOVERED' || !asset.source_url) continue;
        mirrorDiscoveredAsset(asset).catch(() => {});
      }
      for (const asset of result.asset_refs || []) {
        let metadata = {};
        try { metadata = JSON.parse(asset.metadata_json || '{}'); } catch {}
        if (String(asset.mirror_status).toUpperCase() !== 'DISCOVERED' || metadata.capture_strategy !== 'direct_input') continue;
        await mirrorDiscoveredAsset(asset);
      }
      lastFingerprint = fingerprint;
      boundSession = result.session;
      workspace = result.workspace || workspace;
      updateNativeLabel();
      return result;
    } finally {
      captureInFlight = false;
    }
  }

  function setStatus(message, status = '') {
    if (!cardNote) return;
    cardNote.textContent = message;
    cardNote.dataset.status = status;
  }

  function updateNativeLabel() {
    let label = document.getElementById('aih-native-label');
    if (!label) {
      label = document.createElement('button');
      label.id = 'aih-native-label';
      label.type = 'button';
      label.title = 'AI Harness Project Space association';
      label.addEventListener('click', () => window.open('http://127.0.0.1:4317/', '_blank'));
      document.body.appendChild(label);
    }
    const chatId = providerRefs().find(ref => ref.ref_type === 'chat_id')?.ref_value || '';
    const shortId = chatId ? chatId.slice(0, 8) : String(boundSession?.id || '').replace(/^session-/, '').slice(0, 8);
    label.textContent = `AIH · ${workspace?.name || 'Unassociated'}${shortId ? ` · ${shortId}` : ''}`;
  }

  function decodeAttachment(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
  }

  function encodeAssetBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const stride = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += stride) binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
    return btoa(binary);
  }

  async function mirrorDiscoveredAsset(asset) {
    let metadata = {};
    try { metadata = JSON.parse(asset.metadata_json || '{}'); } catch {}
    if (metadata.capture_strategy === 'direct_input') {
      const input = nativeInputAssets.get(asset.native_id);
      if (!input) throw new Error('native input bytes are no longer available in the composer capture buffer');
      if (input.state === 'failed' || !input.data_base64) {
        await request(`/companion/session-assets/${encodeURIComponent(asset.id)}/status`, { method: 'POST', body: { status: 'FAILED', message: input.error || 'native input bytes unavailable' } }).catch(() => {});
        throw new Error(input.error || 'native input bytes unavailable');
      }
      const result = await chrome.runtime.sendMessage({ type: 'aih-mirror-input-bytes', asset_id: asset.id, provider, mime_type: input.descriptor.mime_type, data_base64: input.data_base64 });
      if (result?.error) throw new Error(result.error);
      input.state = 'captured';
      input.data_base64 = '';
      return result;
    }
    if (!String(asset.source_url).startsWith('blob:')) {
      return chrome.runtime.sendMessage({ type: 'aih-mirror-asset', asset_id: asset.id, provider });
    }
    try {
      const source = await fetch(asset.source_url, { cache: 'no-store' });
      if (!source.ok) throw new Error(`provider blob unavailable (${source.status})`);
      const buffer = await source.arrayBuffer();
      if (buffer.byteLength > 25 * 1024 * 1024) throw new Error('provider blob exceeds the page capture limit');
      const result = await chrome.runtime.sendMessage({ type: 'aih-mirror-asset-bytes', asset_id: asset.id, provider, mime_type: source.headers.get('content-type') || asset.mime_type, data_base64: encodeAssetBytes(buffer) });
      if (result?.error) throw new Error(result.error);
      return result;
    } catch (error) {
      await request(`/companion/session-assets/${encodeURIComponent(asset.id)}/status`, { method: 'POST', body: { status: /exceeds/i.test(error.message) ? 'FAILED' : 'CORS_BLOCKED', message: error.message } }).catch(() => {});
      throw error;
    }
  }

  async function attachPreparedFiles(attachments, attempt) {
    harnessAttachmentInjection = true;
    try {
      for (const attachment of attachments || []) {
        if (attempt.invalidated) throw Object.assign(new Error('prompt or provider route changed during attachment preparation'), { code: 'PREPARED_CONTEXT_INVALIDATED' });
        const result = await chrome.runtime.sendMessage({ type: 'aih-resource-request', path: attachment.download_path });
        if (!result?.ok) throw new Error(result?.error || `Could not load current attachment ${attachment.name}`);
        const file = new File([decodeAttachment(result.data_base64, attachment.mime_type)], attachment.name, { type: attachment.mime_type, lastModified: Date.now() });
        const attached = await adapter.attachFile(file);
        if (!attached.ok) throw Object.assign(new Error(`${attachment.name}: ${attached.reason}`), { code: attached.code || 'ATTACHMENT_PREP_FAILED' });
      }
    } finally { harnessAttachmentInjection = false; }
  }

  async function preservePendingNativeInputs() {
    if (nativeInputReadTasks.size) await Promise.allSettled([...nativeInputReadTasks]);
    if (![...nativeInputAssets.values()].some(item => item.state !== 'captured')) return;
    await captureCurrent({ force: true });
    const incomplete = [...nativeInputAssets.values()].filter(item => item.state !== 'captured');
    if (incomplete.length) throw Object.assign(new Error(`durable capture failed for ${incomplete.map(item => item.descriptor.name).join(', ')}`), { code: 'USER_INPUT_ASSET_CAPTURE_INCOMPLETE' });
  }

  async function prepareAndReplay({ attachmentMode = 'automatic', fallbackFrom = null } = {}) {
    if (sendState !== SEND_STATES.IDLE) return;
    if (!associationConfirmed) {
      setStatus('Context blocked: explicitly associate this provider chat with a Project Space first.', 'blocked');
      return;
    }
    const composer = adapter.findComposer();
    const originalText = adapter.composerText(composer).trim();
    if (!composer || !originalText) return;
    const sendButton = adapter.findSendButton();
    if (!sendButton) {
      setStatus('Context blocked: provider Send control was not recognized.', 'blocked');
      return;
    }
    const capabilities = adapter.capabilities();
    if (!capabilities.ok) {
      setStatus(`Context blocked: ${capabilities.failures.map(item => item.code).join(', ')}`, 'blocked');
      return;
    }
    const attempt = sendAttempt = { id: crypto.randomUUID(), originalText, originalHash: await sha256(originalText), route: location.href, invalidated: false, replayBypass: false, prepared: null, attachmentMode, fallbackFrom };
    attempt.transaction = transactionModel.createAttempt({ attempt_id: attempt.id, prompt_hash: attempt.originalHash, route: attempt.route });
    moveSendState(SEND_STATES.PREPARING);
    setStatus('Verifying Project Space before send…', 'verifying');
    let prepared = null;
    try {
      await preservePendingNativeInputs();
      prepared = await request(`/companion/workspaces/${encodeURIComponent(workspace.id)}/prepare-send`, {
        method: 'POST',
        body: { provider, surface_id: adapter.surfaceId, user_prompt: originalText, capture: await capturePayload({ complete: true }), attempt_id: attempt.id, prompt_hash: attempt.originalHash, route: attempt.route, protocol_version: PROTOCOL_VERSION, attachment_mode: attachmentMode, fallback_from_run_id: fallbackFrom?.run_id || '', fallback_version_ids: fallbackFrom?.version_ids || [] }
      });
      attempt.prepared = prepared;
      moveSendState(SEND_STATES.PREPARED);
      if (attempt.invalidated || sendAttempt !== attempt || location.href !== attempt.route || adapter.composerText(composer).trim() !== originalText) {
        throw Object.assign(new Error('the prompt or provider route changed while context was being prepared; send again to verify the new state'), { code: 'PREPARED_CONTEXT_INVALIDATED' });
      }
      moveSendState(SEND_STATES.ATTACHING);
      const attachmentStarted = performance.now();
      await attachPreparedFiles(prepared.attachments, attempt);
      attempt.attachmentPrepareMs = Number((performance.now() - attachmentStarted).toFixed(2));
      attempt.internalComposerWrite = true;
      const composerSet = adapter.setComposerText(composer, prepared.provider_text);
      attempt.internalComposerWrite = false;
      if (!composerSet) throw new Error('provider composer could not receive verified context');
      const replayButton = adapter.findSendButton();
      if (!replayButton?.isConnected) throw new Error('provider Send control changed during context preparation');
      const acceptanceBaseline = adapter.acceptanceBaseline();
      moveSendState(SEND_STATES.REPLAYING);
      attempt.replayBypass = true;
      if (!attempt.transaction.armReplay()) throw new Error('native replay was not armed exactly once');
      setStatus(`Project Current · snapshot ${prepared.snapshot_id.slice(-8)} · sending once`, 'current');
      replayButton.click();
      attempt.replayBypass = false;
      moveSendState(SEND_STATES.WAITING_FOR_PROVIDER_ACCEPT);
      setStatus('Waiting for provider acceptance evidence…', 'verifying');
      const acceptance = await adapter.observeProviderAcceptance(acceptanceBaseline);
      acceptance.attachment_prepare_ms = attempt.attachmentPrepareMs;
      acceptance.attachment_mode = prepared.attachments?.length ? attachmentMode : 'none';
      acceptance.fallback_from_run_id = fallbackFrom?.run_id || '';
      if (!acceptance.accepted) throw Object.assign(new Error('provider acceptance could not be proven; Harness will not record this attempt as sent'), { code: acceptance.code });
      const latestUser = adapter.captureMessages().filter(item => item.role === 'user').at(-1);
      if (latestUser?.provider_message_id) {
        for (const input of nativeInputAssets.values()) input.descriptor.originating_provider_message_id ||= latestUser.provider_message_id;
        const associatedCapture = await captureCurrent({ force: true }).catch(() => null);
        if (associatedCapture) for (const [nativeId, input] of nativeInputAssets) {
          if (input.state === 'captured' && input.descriptor.originating_provider_message_id) nativeInputAssets.delete(nativeId);
        }
      }
      await request(`/companion/outgoing-context/${encodeURIComponent(prepared.run_id)}/sent`, { method: 'POST', body: { attempt_id: attempt.id, prompt_hash: attempt.originalHash, route: attempt.route, protocol_version: PROTOCOL_VERSION, acceptance } });
      moveSendState(SEND_STATES.DONE);
      pendingAttachmentFallback = null;
      setStatus(`Sent with verified provider acceptance · snapshot ${prepared.snapshot_id.slice(-8)}`, 'current');
      setTimeout(() => { if (sendAttempt === attempt && sendState === SEND_STATES.DONE) { moveSendState(SEND_STATES.IDLE); sendAttempt = null; } }, 1000);
    } catch (error) {
      if (prepared?.run_id) request(`/companion/outgoing-context/${encodeURIComponent(prepared.run_id)}/failed`, { method: 'POST', body: { code: error.code || (prepared.attachments?.length ? 'ATTACHMENT_PREP_FAILED' : 'NATIVE_SEND_PREP_FAILED'), message: error.message, attempt_id: attempt.id } }).catch(() => {});
      if (adapter.composerText(composer).includes('[AI HARNESS VERIFIED PROJECT CONTEXT]')) adapter.setComposerText(composer, originalText);
      moveSendState(SEND_STATES.ERROR);
      const reasons = error.payload?.reasons || [];
      setStatus(`Context blocked: ${reasons.map(item => item.message).join('; ') || error.message}`, 'blocked');
      if (attachmentFallbackButton && /ATTACHMENT|attachment|file input/i.test(`${error.code || ''} ${error.message || ''}`)) {
        pendingAttachmentFallback = prepared?.attachments?.length ? { run_id: prepared.run_id, version_ids: prepared.attachments.map(item => item.version_id) } : null;
        attachmentFallbackButton.hidden = false;
        attachmentFallbackButton.textContent = 'Reverify current project source, attach & send';
      }
      setTimeout(() => { if (sendAttempt === attempt && sendState === SEND_STATES.ERROR) { moveSendState(SEND_STATES.IDLE); sendAttempt = null; } }, 800);
    }
  }

  function interceptClick(event) {
    if (!adapter.matchesSendTarget(event.target)) return;
    if (sendState === SEND_STATES.REPLAYING && sendAttempt?.replayBypass) {
      if (!sendAttempt.transaction.consumeReplay()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    prepareAndReplay();
  }

  function interceptKeydown(event) {
    const composer = adapter.findComposer();
    const insideComposer = Boolean(composer && (event.target === composer || composer.contains(event.target)));
    if (!transactionModel.shouldManageEnter(event, insideComposer)) return;
    if (sendState === SEND_STATES.REPLAYING && sendAttempt?.replayBypass) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    prepareAndReplay();
  }

  async function refreshRouteBinding() {
    if (location.href === lastLocationHref) return;
    const providerAcceptanceTransition = sendAttempt && [SEND_STATES.REPLAYING, SEND_STATES.WAITING_FOR_PROVIDER_ACCEPT].includes(sendState);
    if (!providerAcceptanceTransition) {
      nativeInputAssets.clear();
      recentNativeFileEvents.clear();
    }
    lastLocationHref = location.href;
    if (sendAttempt && sendState !== SEND_STATES.IDLE && !providerAcceptanceTransition) { sendAttempt.invalidated = true; sendAttempt.transaction?.invalidate(); }
    lastFingerprint = '';
    boundSession = null;
    const resolved = await resolveCurrentSession();
    if (resolved) {
      boundSession = resolved;
      workspace = resolved.workspace || workspace;
      associationConfirmed = true;
    }
    updateNativeLabel();
    prewarmProject();
  }

  async function mount() {
    try {
      workspace = await request('/companion/active-workspace');
      await request('/companion/heartbeat', { method: 'POST', body: { version: COMPANION_VERSION, protocol_version: PROTOCOL_VERSION, provider, surface_id: adapter.surfaceId, metadata: { hostname: location.hostname, surface_id: adapter.surfaceId, adapter_version: adapter.version, capabilities: adapter.capabilities() } } });
    } catch {
      return;
    }
    const resolved = await resolveCurrentSession();
    if (resolved) {
      boundSession = resolved;
      workspace = resolved.workspace || workspace;
      associationConfirmed = true;
    }
    const stored = await chrome.storage.local.get('aih_auto_capture').catch(() => ({}));
    autoCaptureEnabled = stored.aih_auto_capture !== false;

    const root = document.createElement('div');
    root.id = 'aih-companion';
    root.innerHTML = `
      <div class="aih-card">
        <div class="aih-head"><span class="aih-dot"></span><div class="aih-title"><strong></strong><span></span></div><button class="aih-toggle" title="Collapse">−</button></div>
        <div class="aih-body">
          <button class="aih-button aih-capture">Capture & reconcile now</button>
          <button class="aih-button aih-associate">Associate this chat with active Project Space</button>
          <button class="aih-button aih-attach" hidden></button>
          <button class="aih-button aih-auto"></button>
          <button class="aih-button aih-open">Open Harness</button>
          <div class="aih-note">Managed native sends verify current files, repository state, chat synchronization, retrieval, and security before replaying Send.</div>
        </div>
      </div>`;
    root.querySelector('.aih-title strong').textContent = workspace.name;
    root.querySelector('.aih-title span').textContent = `${providerName()} · guaranteed managed send active`;
    cardNote = root.querySelector('.aih-note');
    attachmentFallbackButton = root.querySelector('.aih-attach');
    document.body.appendChild(root);
    updateNativeLabel();
    prewarmProject();

    const autoButton = root.querySelector('.aih-auto');
    const updateAuto = () => { autoButton.textContent = `Auto capture: ${autoCaptureEnabled ? 'on' : 'off'}`; };
    updateAuto();
    root.querySelector('.aih-toggle').addEventListener('click', event => {
      root.classList.toggle('aih-collapsed');
      event.currentTarget.textContent = root.classList.contains('aih-collapsed') ? '+' : '−';
    });
    root.querySelector('.aih-open').addEventListener('click', () => window.open('http://127.0.0.1:4317/', '_blank'));
    autoButton.addEventListener('click', async () => {
      autoCaptureEnabled = !autoCaptureEnabled;
      await chrome.storage.local.set({ aih_auto_capture: autoCaptureEnabled });
      updateAuto();
    });
    root.querySelector('.aih-capture').addEventListener('click', async event => {
      const original = event.currentTarget.textContent;
      event.currentTarget.textContent = 'Reconciling…';
      try {
        const result = await captureCurrent({ force: true, complete: true });
        setStatus(`Captured ${result?.session?.message_count || 0} messages · history ${result?.session?.history_coverage || 'unknown'}.`, result?.raw_capture_complete ? 'current' : 'partial');
      } catch (error) { setStatus(`Capture blocked: ${error.message}`, 'blocked'); }
      event.currentTarget.textContent = original;
    });
    const associateButton = root.querySelector('.aih-associate');
    const updateAssociation = () => {
      associateButton.hidden = associationConfirmed;
      root.querySelector('.aih-title span').textContent = associationConfirmed ? `${providerName()} · guaranteed managed send active` : `${providerName()} · association required`;
    };
    updateAssociation();
    associateButton.addEventListener('click', async () => {
      associationConfirmed = true;
      try {
        await captureCurrent({ force: true, complete: true });
        updateAssociation();
        prewarmProject();
        setStatus(`Associated with ${workspace.name}.`, 'current');
      } catch (error) {
        associationConfirmed = false;
        updateAssociation();
        setStatus(`Association failed: ${error.message}`, 'blocked');
      }
    });
    attachmentFallbackButton.addEventListener('click', () => {
      const fallbackFrom = pendingAttachmentFallback;
      attachmentFallbackButton.hidden = true;
      if (!fallbackFrom) return setStatus('Attachment fallback expired; press Send to prepare the current source again.', 'blocked');
      if (sendState === SEND_STATES.IDLE) prepareAndReplay({ attachmentMode: 'fallback', fallbackFrom });
      else setTimeout(() => prepareAndReplay({ attachmentMode: 'fallback', fallbackFrom }), 900);
    });

    document.addEventListener('click', interceptClick, true);
    document.addEventListener('keydown', interceptKeydown, true);
    const captureFileInput = event => {
      if (harnessAttachmentInjection) return;
      const input = event.target;
      if (!input?.matches?.('input[type="file"]') || !input.files?.length) return;
      for (const file of input.files) stageNativeInputFile(file, 'direct_file_input').catch(() => {});
    };
    const captureClipboard = event => {
      const composer = adapter.findComposer();
      if (!composer || !(event.target === composer || composer.contains?.(event.target))) return;
      const directFiles = [...(event.clipboardData?.files || [])];
      const itemFiles = directFiles.length ? [] : [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
      for (const file of [...directFiles, ...itemFiles]) stageNativeInputFile(file, String(file.type || '').startsWith('image/') ? 'clipboard_image' : 'direct_file_input').catch(() => {});
    };
    const captureDrop = event => {
      const composer = adapter.findComposer();
      if (!composer || !(event.target === composer || composer.contains?.(event.target))) return;
      for (const file of event.dataTransfer?.files || []) stageNativeInputFile(file, 'drag_drop').catch(() => {});
    };
    document.addEventListener('change', captureFileInput, true);
    document.addEventListener('paste', captureClipboard, true);
    document.addEventListener('drop', captureDrop, true);
    const captureTimer = setInterval(() => {
      if (autoCaptureEnabled && document.visibilityState === 'visible' && sendState === SEND_STATES.IDLE) captureCurrent().catch(() => {});
    }, AUTO_CAPTURE_INTERVAL_MS);
    const heartbeatTimer = setInterval(() => request('/companion/heartbeat', { method: 'POST', body: { version: COMPANION_VERSION, protocol_version: PROTOCOL_VERSION, provider, surface_id: adapter.surfaceId, metadata: { surface_id: adapter.surfaceId, adapter_version: adapter.version, capabilities: adapter.capabilities() } } }).catch(() => {}), 60000);
    const routeTimer = setInterval(() => refreshRouteBinding().catch(() => {}), 1500);
    document.addEventListener('visibilitychange', () => {
      if (autoCaptureEnabled && document.visibilityState === 'hidden') captureCurrent({ force: true }).catch(() => {});
    });
    document.addEventListener('input', event => {
      const composer = adapter.findComposer();
      if (!composer || !(event.target === composer || composer.contains?.(event.target))) return;
      if (sendState === SEND_STATES.IDLE) return scheduleDraftRetrieval();
      if (!sendAttempt || sendAttempt.internalComposerWrite || sendState === SEND_STATES.REPLAYING) return;
      sendAttempt.invalidated = true;
      sendAttempt.transaction?.invalidate();
    }, true);
    window.addEventListener('pagehide', () => {
      clearInterval(captureTimer);
      clearInterval(heartbeatTimer);
      clearInterval(routeTimer);
      clearTimeout(draftTimer);
      document.removeEventListener('click', interceptClick, true);
      document.removeEventListener('keydown', interceptKeydown, true);
      document.removeEventListener('change', captureFileInput, true);
      document.removeEventListener('paste', captureClipboard, true);
      document.removeEventListener('drop', captureDrop, true);
    }, { once: true });
    if (autoCaptureEnabled) setTimeout(() => captureCurrent({ force: true }).catch(() => {}), 2000);
  }

  mount();
})();
