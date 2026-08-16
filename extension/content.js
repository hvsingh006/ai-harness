(() => {
  const API = 'http://127.0.0.1:4317/api';
  const AUTO_CAPTURE_INTERVAL_MS = 15000;
  const COMPANION_VERSION = chrome.runtime.getManifest().version;
  if (document.getElementById('aih-companion')) return;

  let lastFingerprint = '';
  let autoCaptureEnabled = true;
  let captureInFlight = false;
  let boundSession = null;
  let boundWorkspace = null;
  let lastLocationHref = location.href;

  function providerId() {
    if (location.hostname === 'chatgpt.com') return 'chatgpt';
    if (location.hostname === 'gemini.google.com') return 'gemini';
    return 'unknown';
  }

  function providerRefs() {
    const refs = [
      { ref_type: 'route', ref_value: `${location.pathname}${location.search}`, source: 'browser_companion' },
      { ref_type: 'native_url', ref_value: location.href, source: 'browser_companion' }
    ];
    let match = null;
    if (providerId() === 'chatgpt') match = location.pathname.match(/\/c\/([^/?#]+)/);
    if (providerId() === 'gemini') match = location.pathname.match(/\/app\/([^/?#]+)/);
    if (match?.[1]) refs.unshift({ ref_type: 'chat_id', ref_value: match[1], source: 'browser_companion' });
    return refs;
  }

  async function clientId() {
    try {
      const stored = await chrome.storage.local.get('aih_client_id');
      if (stored.aih_client_id) return stored.aih_client_id;
      const id = crypto.randomUUID();
      await chrome.storage.local.set({ aih_client_id: id });
      return id;
    } catch {
      return 'anonymous-companion';
    }
  }

  async function heartbeat() {
    return request('/companion/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ client_id: await clientId(), version: COMPANION_VERSION, provider: providerId(), metadata: { hostname: location.hostname } })
    });
  }

  async function resolveCurrentSession() {
    const params = new URLSearchParams({ provider: providerId() });
    for (const ref of providerRefs()) params.set(ref.ref_type, ref.ref_value);
    try {
      return await request(`/provider-session?${params.toString()}`);
    } catch {
      return null;
    }
  }

  function providerName() {
    return ({ chatgpt: 'ChatGPT', gemini: 'Gemini' })[providerId()] || 'AI service';
  }

  async function request(path, options = {}) {
    const result = await chrome.runtime.sendMessage({
      type: 'aih-api-request',
      path,
      options: {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        body: typeof options.body === 'string' ? options.body : undefined
      }
    });
    if (!result) throw new Error('Harness companion background unavailable');
    if (result.error) throw new Error(result.error);
    if (!result.ok) throw new Error(result.text || `Harness request failed (${result.status})`);
    if (result.status === 204 || !result.text) return null;
    try { return JSON.parse(result.text); }
    catch { throw new Error('Harness returned an invalid response'); }
  }

  function findComposer() {
    if (providerId() === 'chatgpt') return document.querySelector('#prompt-textarea') || document.querySelector('[contenteditable="true"]');
    if (providerId() === 'gemini') return document.querySelector('rich-textarea [contenteditable="true"]') || document.querySelector('[contenteditable="true"]');
    return null;
  }

  function insertText(element, text) {
    if (!element) return false;
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
      if (setter) setter.call(element, text); else element.value = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (element.isContentEditable) {
      element.textContent = text;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    }
    return false;
  }

  async function contextText(workspace) {
    const packet = await request(`/workspaces/${workspace.id}/context`);
    return [
      '[AI HARNESS WORKSPACE CONTEXT]',
      'Use this as durable workspace background. Do not repeat it unless useful. Continue established work without requiring restatement. Use relevant prior user prompts, prior ChatGPT/Gemini responses, project files, PDFs, images, native tools, archive material, and current web information when useful. If the corpus is too large, retrieve progressively relevant subsets rather than ignoring material or flooding the context window. Preserve the user\'s critical thinking and judgment.',
      JSON.stringify(packet),
      '[/AI HARNESS WORKSPACE CONTEXT]',
      '',
      'Continue the workspace from here:'
    ].join('\n');
  }

  function uniqueMessages(items) {
    const seen = new Set();
    return items.filter(item => {
      const key = `${item.role}\0${item.content}`;
      if (!item.content || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function captureMessages() {
    const provider = providerId();
    const messages = [];
    if (provider === 'chatgpt') {
      const nodes = [...document.querySelectorAll('[data-message-author-role]')];
      nodes.forEach((node, index) => messages.push({
        role: node.getAttribute('data-message-author-role') || 'unknown',
        content: node.innerText?.trim() || '',
        provider_message_id: node.getAttribute('data-message-id') || node.closest('[data-message-id]')?.getAttribute('data-message-id') || '',
        raw: { index, html: node.outerHTML.slice(0, 250000) }
      }));
    } else if (provider === 'gemini') {
      const nodes = [...document.querySelectorAll('user-query, model-response')];
      nodes.forEach((node, index) => messages.push({
        role: node.tagName.toLowerCase() === 'user-query' ? 'user' : 'assistant',
        content: node.innerText?.trim() || '',
        provider_message_id: node.id || '',
        raw: { index, tag: node.tagName.toLowerCase(), html: node.outerHTML.slice(0, 250000) }
      }));
    }
    return uniqueMessages(messages);
  }

  function captureAssetReferences() {
    const assets = [];
    const seen = new Set();
    const filePattern = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|md|zip|png|jpe?g|webp|gif)(?:[?#]|$)/i;
    for (const anchor of document.querySelectorAll('a[href]')) {
      const url = anchor.href;
      const name = anchor.getAttribute('download') || anchor.textContent?.trim() || url.split('/').pop() || 'linked asset';
      if (!url || (!filePattern.test(url) && !anchor.hasAttribute('download') && !/file|download|attachment/i.test(anchor.getAttribute('aria-label') || ''))) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      assets.push({ asset_type: 'file', name: name.slice(0, 240), url, native_id: anchor.dataset?.id || '' });
    }
    for (const img of document.querySelectorAll('main img[src], [role="main"] img[src]')) {
      const url = img.currentSrc || img.src;
      if (!url || url.startsWith('data:') || (img.naturalWidth && img.naturalWidth < 120 && img.naturalHeight < 120) || seen.has(url)) continue;
      seen.add(url);
      assets.push({ asset_type: 'image', name: img.alt || 'conversation image', url, mime_type: 'image/*' });
    }
    return assets;
  }

  function fingerprint(messages, assets) {
    const tail = messages.slice(-4).map(m => `${m.role}:${m.content}`).join('|');
    return `${location.href}|${messages.length}|${assets.length}|${tail}`;
  }

  async function mirrorAssets(result) {
    const pending = (result.asset_refs || []).filter(a => a.mirror_status !== 'captured' && a.source_url);
    let mirrored = 0;
    for (const asset of pending.slice(0, 12)) {
      try {
        const source = await fetch(asset.source_url, { credentials: 'include' });
        if (!source.ok) continue;
        const blob = await source.blob();
        if (!blob.size) continue;
        const response = await fetch(`${API}/session-assets/${encodeURIComponent(asset.id)}/content`, {
          method: 'PUT',
          headers: { 'Content-Type': blob.type || asset.mime_type || 'application/octet-stream' },
          body: blob
        });
        if (response.ok) mirrored += 1;
      } catch {
        // An authenticated or cross-origin source may not be fetchable from a content script.
        // It remains referenced and therefore blocks deletion-safe status.
      }
    }
    return mirrored;
  }

  async function captureCurrent(workspace, { force = false } = {}) {
    if (captureInFlight) return null;
    const messages = captureMessages();
    const assets = captureAssetReferences();
    const nextFingerprint = fingerprint(messages, assets);
    if (!force && (!messages.length || nextFingerprint === lastFingerprint)) return null;
    captureInFlight = true;
    try {
      const result = await request('/capture', {
        method: 'POST',
        body: JSON.stringify({
          workspace_id: workspace.id,
          provider: providerId(),
          title: document.title.replace(/\s*[-|]\s*(ChatGPT|Gemini).*$/i, '').trim() || `${providerName()} session`,
          native_url: location.href,
          external_id: providerRefs().find(ref => ref.ref_type === 'chat_id')?.ref_value || location.pathname + location.search,
          provider_refs: providerRefs(),
          complete: false,
          messages,
          assets
        })
      });
      lastFingerprint = nextFingerprint;
      boundSession = result.session || boundSession;
      boundWorkspace = result.workspace || boundWorkspace;
      updateNativeLabel();
      const mirrored = await mirrorAssets(result);
      return { ...result, mirrored };
    } finally {
      captureInFlight = false;
    }
  }

  async function getAutoCaptureSetting() {
    try {
      const value = await chrome.storage.local.get('aih_auto_capture');
      return value.aih_auto_capture !== false;
    } catch { return true; }
  }

  async function setAutoCaptureSetting(enabled) {
    try { await chrome.storage.local.set({ aih_auto_capture: enabled }); } catch {}
  }

  function updateNativeLabel() {
    let label = document.getElementById('aih-native-label');
    if (!label) {
      label = document.createElement('button');
      label.id = 'aih-native-label';
      label.type = 'button';
      label.title = 'AI Harness workspace label. Click to open the local archive.';
      label.addEventListener('click', () => window.open('http://127.0.0.1:4317/', '_blank'));
      document.body.appendChild(label);
    }
    const workspaceName = boundWorkspace?.name || 'AI Harness';
    const chatId = providerRefs().find(ref => ref.ref_type === 'chat_id')?.ref_value || '';
    const shortId = chatId ? chatId.slice(0, 8) : (boundSession?.id || '').replace(/^session-/, '').slice(0, 8);
    label.textContent = `AIH · ${workspaceName}${shortId ? ` · ${shortId}` : ''}`;
  }

  async function archivedSessionText() {
    if (!boundSession) {
      const resolved = await resolveCurrentSession();
      if (resolved) { boundSession = resolved; boundWorkspace = resolved.workspace; updateNativeLabel(); }
    }
    if (!boundSession) throw new Error('Capture this chat first');
    const packet = await request(`/sessions/${encodeURIComponent(boundSession.id)}/context`);
    return [
      '[AI HARNESS ARCHIVED SESSION CONTEXT]',
      'Use this archived session as source material for the current task. Prior assistant responses are fallible; retain the user prompts, reasoning, files, and provenance. If this packet is truncated, retrieve deeper archive material when needed.',
      JSON.stringify(packet),
      '[/AI HARNESS ARCHIVED SESSION CONTEXT]'
    ].join('\n');
  }

  async function refreshRouteBinding() {
    if (location.href === lastLocationHref) return;
    lastLocationHref = location.href;
    lastFingerprint = '';
    boundSession = null;
    boundWorkspace = null;
    const resolved = await resolveCurrentSession();
    if (resolved) { boundSession = resolved; boundWorkspace = resolved.workspace; }
    updateNativeLabel();
  }

  async function mount() {
    let workspace;
    try { workspace = await request('/active-workspace'); } catch { return; }
    if (!workspace) return;
    autoCaptureEnabled = await getAutoCaptureSetting();
    try { await heartbeat(); } catch {}
    const resolved = await resolveCurrentSession();
    if (resolved) { boundSession = resolved; boundWorkspace = resolved.workspace; }

    const root = document.createElement('div');
    root.id = 'aih-companion';
    root.innerHTML = `
      <div class="aih-card">
        <div class="aih-head">
          <span class="aih-dot"></span>
          <div class="aih-title"><strong></strong><span></span></div>
          <button class="aih-toggle" title="Collapse">−</button>
        </div>
        <div class="aih-body">
          <button class="aih-button aih-capture">Capture now</button>
          <button class="aih-button aih-auto"></button>
          <button class="aih-button aih-insert">Insert workspace context</button>
          <button class="aih-button aih-use-chat">Bring this chat into prompt</button>
          <button class="aih-button aih-copy">Copy context packet</button>
          <button class="aih-button aih-open">Open Harness</button>
          <div class="aih-note">Loaded-page history is archived incrementally. A chat remains deletion-unsafe until the harness verifies transcript completeness and mirrors every discovered asset.</div>
        </div>
      </div>`;
    root.querySelector('.aih-title strong').textContent = workspace.name;
    root.querySelector('.aih-title span').textContent = `${providerName()} · persistent workspace connected`;
    document.body.appendChild(root);
    updateNativeLabel();

    const autoButton = root.querySelector('.aih-auto');
    const updateAutoLabel = () => { autoButton.textContent = `Auto capture: ${autoCaptureEnabled ? 'on' : 'off'}`; };
    updateAutoLabel();

    root.querySelector('.aih-toggle').addEventListener('click', e => {
      root.classList.toggle('aih-collapsed');
      e.currentTarget.textContent = root.classList.contains('aih-collapsed') ? '+' : '−';
    });
    root.querySelector('.aih-open').addEventListener('click', () => window.open('http://127.0.0.1:4317/', '_blank'));

    autoButton.addEventListener('click', async () => {
      autoCaptureEnabled = !autoCaptureEnabled;
      await setAutoCaptureSetting(autoCaptureEnabled);
      updateAutoLabel();
      if (autoCaptureEnabled) captureCurrent(workspace, { force: true }).catch(() => {});
    });

    root.querySelector('.aih-copy').addEventListener('click', async e => {
      const original = e.currentTarget.textContent;
      try {
        await navigator.clipboard.writeText(await contextText(workspace));
        e.currentTarget.textContent = 'Copied';
      } catch { e.currentTarget.textContent = 'Copy failed'; }
      setTimeout(() => e.currentTarget.textContent = original, 1400);
    });

    root.querySelector('.aih-insert').addEventListener('click', async e => {
      const original = e.currentTarget.textContent;
      const text = await contextText(workspace);
      const composer = findComposer();
      if (insertText(composer, text)) e.currentTarget.textContent = 'Context inserted';
      else {
        await navigator.clipboard.writeText(text);
        e.currentTarget.textContent = 'Copied, paste into chat';
      }
      setTimeout(() => e.currentTarget.textContent = original, 1600);
    });

    root.querySelector('.aih-use-chat').addEventListener('click', async e => {
      const original = e.currentTarget.textContent;
      e.currentTarget.textContent = 'Preparing archived chat…';
      try {
        const text = await archivedSessionText();
        const composer = findComposer();
        if (insertText(composer, text)) e.currentTarget.textContent = 'Chat context inserted';
        else {
          await navigator.clipboard.writeText(text);
          e.currentTarget.textContent = 'Copied, paste into prompt';
        }
      } catch (error) {
        e.currentTarget.textContent = 'Capture chat first';
      }
      setTimeout(() => e.currentTarget.textContent = original, 1800);
    });

    root.querySelector('.aih-capture').addEventListener('click', async e => {
      const original = e.currentTarget.textContent;
      e.currentTarget.textContent = 'Capturing…';
      try {
        const result = await captureCurrent(workspace, { force: true });
        const count = result?.session?.message_count || 0;
        const mirrored = result?.mirrored || 0;
        e.currentTarget.textContent = `Saved ${count} messages`;
        root.querySelector('.aih-note').textContent = `Snapshot saved${mirrored ? `; mirrored ${mirrored} new assets` : ''}. Status: ${String(result?.session?.capture_status || 'captured').replaceAll('_',' ')}.`;
      } catch (error) {
        console.error('[AI Harness] capture failed', error);
        e.currentTarget.textContent = 'Capture failed';
      }
      setTimeout(() => e.currentTarget.textContent = original, 2200);
    });

    const interval = setInterval(() => {
      if (autoCaptureEnabled && document.visibilityState === 'visible') captureCurrent(workspace).catch(() => {});
    }, AUTO_CAPTURE_INTERVAL_MS);
    const heartbeatInterval = setInterval(() => heartbeat().catch(() => {}), 60000);
    const routeInterval = setInterval(() => refreshRouteBinding().catch(() => {}), 1500);

    document.addEventListener('visibilitychange', () => {
      if (autoCaptureEnabled && document.visibilityState === 'hidden') captureCurrent(workspace, { force: true }).catch(() => {});
    });
    window.addEventListener('pagehide', () => { clearInterval(interval); clearInterval(heartbeatInterval); clearInterval(routeInterval); }, { once: true });

    if (autoCaptureEnabled) setTimeout(() => captureCurrent(workspace, { force: true }).catch(() => {}), 2500);
  }

  mount();
})();
