(() => {
  const AUTO_CAPTURE_INTERVAL_MS = 15000;
  const COMPANION_VERSION = chrome.runtime.getManifest().version;
  const provider = location.hostname === 'chatgpt.com' ? 'chatgpt' : location.hostname === 'gemini.google.com' ? 'gemini' : '';
  const adapter = globalThis.AIH_PROVIDER_ADAPTERS?.[provider];
  if (!adapter || document.getElementById('aih-companion')) return;
  const pendingSessionRef = { ref_type: 'route', ref_value: `pending:${provider}:${crypto.randomUUID()}`, source: 'browser_companion' };

  let workspace = null;
  let boundSession = null;
  let lastFingerprint = '';
  let lastLocationHref = location.href;
  let captureInFlight = false;
  let autoCaptureEnabled = true;
  let sendState = 'idle';
  let cardNote = null;
  let pendingIdentityUsed = false;

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
    const assets = [];
    const seen = new Set();
    const filePattern = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|md|zip|png|jpe?g|webp|gif)(?:[?#]|$)/i;
    for (const anchor of document.querySelectorAll('a[href]')) {
      const url = anchor.href;
      if (!url || seen.has(url) || (!filePattern.test(url) && !anchor.hasAttribute('download') && !/file|download|attachment/i.test(anchor.getAttribute('aria-label') || ''))) continue;
      seen.add(url);
      assets.push({ asset_type: 'file', name: (anchor.getAttribute('download') || anchor.textContent?.trim() || 'linked asset').slice(0, 240), url, native_id: anchor.dataset?.id || '' });
    }
    for (const image of document.querySelectorAll('main img[src], [role="main"] img[src]')) {
      const url = image.currentSrc || image.src;
      if (!url || url.startsWith('data:') || seen.has(url) || (image.naturalWidth && image.naturalWidth < 120 && image.naturalHeight < 120)) continue;
      seen.add(url);
      assets.push({ asset_type: 'image', name: image.alt || 'conversation image', url, mime_type: 'image/*' });
    }
    return assets;
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

  async function captureCurrent({ force = false, complete = false } = {}) {
    if (captureInFlight || !workspace) return null;
    const messages = captureMessages();
    const assets = captureAssets();
    const fingerprint = `${location.href}|${messages.length}|${assets.length}|${messages.slice(-3).map(item => item.content).join('|')}`;
    if (!force && (!messages.length || fingerprint === lastFingerprint)) return null;
    captureInFlight = true;
    try {
      const result = await request('/companion/capture', { method: 'POST', body: await capturePayload({ complete }) });
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

  async function attachPreparedFiles(attachments) {
    for (const attachment of attachments || []) {
      const result = await chrome.runtime.sendMessage({ type: 'aih-resource-request', path: attachment.download_path });
      if (!result?.ok) throw new Error(result?.error || `Could not load current attachment ${attachment.name}`);
      const file = new File([decodeAttachment(result.data_base64, attachment.mime_type)], attachment.name, { type: attachment.mime_type, lastModified: Date.now() });
      const attached = await adapter.attachFile(file);
      if (!attached.ok) throw new Error(`${attachment.name}: ${attached.reason}`);
    }
  }

  async function prepareAndReplay() {
    if (sendState !== 'idle') return;
    const composer = adapter.findComposer();
    const originalText = adapter.composerText(composer).trim();
    if (!composer || !originalText) return;
    const sendButton = adapter.findSendButton();
    if (!sendButton) {
      setStatus('Context blocked: provider Send control was not recognized.', 'blocked');
      return;
    }
    sendState = 'preparing';
    setStatus('Verifying Project Space before send…', 'verifying');
    let prepared = null;
    try {
      prepared = await request(`/companion/workspaces/${encodeURIComponent(workspace.id)}/prepare-send`, {
        method: 'POST',
        body: { provider, user_prompt: originalText, capture: await capturePayload({ complete: true }) }
      });
      await attachPreparedFiles(prepared.attachments);
      if (!adapter.setComposerText(composer, prepared.provider_text)) throw new Error('provider composer could not receive verified context');
      const replayButton = adapter.findSendButton();
      if (!replayButton?.isConnected) throw new Error('provider Send control changed during context preparation');
      sendState = 'replaying';
      setStatus(`Project Current · snapshot ${prepared.snapshot_id.slice(-8)} · sending once`, 'current');
      replayButton.click();
      request(`/companion/outgoing-context/${encodeURIComponent(prepared.run_id)}/sent`, { method: 'POST', body: {} }).catch(() => {});
      setTimeout(() => { if (sendState === 'replaying') sendState = 'idle'; }, 1500);
    } catch (error) {
      if (prepared?.run_id) request(`/companion/outgoing-context/${encodeURIComponent(prepared.run_id)}/failed`, { method: 'POST', body: { code: prepared.attachments?.length ? 'ATTACHMENT_PREP_FAILED' : 'NATIVE_SEND_PREP_FAILED', message: error.message } }).catch(() => {});
      if (adapter.composerText(composer).includes('[AI HARNESS VERIFIED PROJECT CONTEXT]')) adapter.setComposerText(composer, originalText);
      sendState = 'error';
      const reasons = error.payload?.reasons || [];
      setStatus(`Context blocked: ${reasons.map(item => item.message).join('; ') || error.message}`, 'blocked');
      setTimeout(() => { if (sendState === 'error') sendState = 'idle'; }, 800);
    }
  }

  function interceptClick(event) {
    if (!adapter.matchesSendTarget(event.target)) return;
    if (sendState === 'replaying') {
      sendState = 'idle';
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    prepareAndReplay();
  }

  function interceptKeydown(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    const composer = adapter.findComposer();
    if (!composer || !(event.target === composer || composer.contains(event.target))) return;
    if (sendState === 'replaying') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    prepareAndReplay();
  }

  async function refreshRouteBinding() {
    if (location.href === lastLocationHref) return;
    lastLocationHref = location.href;
    lastFingerprint = '';
    boundSession = null;
    const resolved = await resolveCurrentSession();
    if (resolved) {
      boundSession = resolved;
      workspace = resolved.workspace || workspace;
    }
    updateNativeLabel();
  }

  async function mount() {
    try {
      workspace = await request('/companion/active-workspace');
      await request('/companion/heartbeat', { method: 'POST', body: { version: COMPANION_VERSION, provider, metadata: { hostname: location.hostname, adapter_version: adapter.version } } });
    } catch {
      return;
    }
    const resolved = await resolveCurrentSession();
    if (resolved) {
      boundSession = resolved;
      workspace = resolved.workspace || workspace;
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
          <button class="aih-button aih-auto"></button>
          <button class="aih-button aih-open">Open Harness</button>
          <div class="aih-note">Managed native sends verify current files, repository state, chat synchronization, retrieval, and security before replaying Send.</div>
        </div>
      </div>`;
    root.querySelector('.aih-title strong').textContent = workspace.name;
    root.querySelector('.aih-title span').textContent = `${providerName()} · guaranteed managed send active`;
    cardNote = root.querySelector('.aih-note');
    document.body.appendChild(root);
    updateNativeLabel();

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

    document.addEventListener('click', interceptClick, true);
    document.addEventListener('keydown', interceptKeydown, true);
    const captureTimer = setInterval(() => {
      if (autoCaptureEnabled && document.visibilityState === 'visible' && sendState === 'idle') captureCurrent().catch(() => {});
    }, AUTO_CAPTURE_INTERVAL_MS);
    const heartbeatTimer = setInterval(() => request('/companion/heartbeat', { method: 'POST', body: { version: COMPANION_VERSION, provider, metadata: { adapter_version: adapter.version } } }).catch(() => {}), 60000);
    const routeTimer = setInterval(() => refreshRouteBinding().catch(() => {}), 1500);
    document.addEventListener('visibilitychange', () => {
      if (autoCaptureEnabled && document.visibilityState === 'hidden') captureCurrent({ force: true }).catch(() => {});
    });
    window.addEventListener('pagehide', () => {
      clearInterval(captureTimer);
      clearInterval(heartbeatTimer);
      clearInterval(routeTimer);
      document.removeEventListener('click', interceptClick, true);
      document.removeEventListener('keydown', interceptKeydown, true);
    }, { once: true });
    if (autoCaptureEnabled) setTimeout(() => captureCurrent({ force: true }).catch(() => {}), 2000);
  }

  mount();
})();
