(() => {
  const ADAPTER_PROTOCOL_VERSION = 4;
  const PROVIDER_ACCEPT_TIMEOUT_MS = 15000;
  const SELECTORS = Object.freeze({
    chatgpt: Object.freeze({
      composer: ['#prompt-textarea', 'form [contenteditable="true"][data-virtualkeyboard="true"]', 'main form [contenteditable="true"]', 'main textarea'],
      send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'form button[type="submit"]'],
      messages: ['[data-message-author-role]'],
      streaming: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop generating"]', '[data-message-author-role="assistant"] [aria-busy="true"]'],
      attachmentInputs: ['form input[type="file"]', 'main input[type="file"]'],
      attachmentEvidence: ['form [data-testid*="attachment"]', 'form [aria-label*="attachment" i]', 'form [class*="attachment"]'],
      scrollers: ['main [data-testid="conversation-turns"]', 'main']
    }),
    gemini: Object.freeze({
      composer: ['rich-textarea [contenteditable="true"]', 'main [contenteditable="true"][role="textbox"]', 'main [contenteditable="true"]', 'main textarea'],
      send: ['button[aria-label="Send message"]', 'button[aria-label*="Send" i]', 'button.send-button', 'button[mattooltip*="Send" i]'],
      messages: ['user-query', 'model-response'],
      streaming: ['button[aria-label*="Stop response" i]', 'model-response [aria-busy="true"]', 'mat-progress-spinner'],
      attachmentInputs: ['rich-textarea input[type="file"]', 'main input[type="file"]'],
      attachmentEvidence: ['rich-textarea [class*="attachment"]', 'rich-textarea [aria-label*="attachment" i]', 'main [data-test-id*="attachment"]'],
      scrollers: ['main infinite-scroller', 'main']
    })
  });

  function nodeVisible(node) {
    if (!node || node.isConnected === false || node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
    const style = globalThis.getComputedStyle ? getComputedStyle(node) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
    const rect = node.getBoundingClientRect?.();
    return !rect || (rect.width > 0 && rect.height > 0);
  }

  function chooseActive(nodes, { allowDisabled = false } = {}) {
    return [...nodes].filter(node => nodeVisible(node) && (allowDisabled || !node.disabled)).sort((a, b) => {
      const aFocused = a === document.activeElement || a.contains?.(document.activeElement) ? 1 : 0;
      const bFocused = b === document.activeElement || b.contains?.(document.activeElement) ? 1 : 0;
      return bFocused - aFocused;
    })[0] || null;
  }

  function queryCandidates(selectors, root = document) {
    const result = [];
    for (const selector of selectors) {
      try { result.push(...root.querySelectorAll(selector)); } catch {}
    }
    return [...new Set(result)];
  }

  function textOf(element) {
    if (!element) return '';
    if (globalThis.HTMLTextAreaElement && element instanceof HTMLTextAreaElement) return element.value;
    if (globalThis.HTMLInputElement && element instanceof HTMLInputElement) return element.value;
    return element.innerText || element.textContent || '';
  }

  function setText(element, text) {
    if (!element || !nodeVisible(element)) return false;
    element.focus?.();
    if ((globalThis.HTMLTextAreaElement && element instanceof HTMLTextAreaElement) || (globalThis.HTMLInputElement && element instanceof HTMLInputElement)) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
      if (setter) setter.call(element, text); else element.value = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      return element.value === text;
    }
    if (element.isContentEditable) {
      element.textContent = text;
      const Input = globalThis.InputEvent || Event;
      element.dispatchEvent(new Input('input', { bubbles: true, inputType: 'insertText', data: text }));
      return textOf(element).trim() === String(text).trim();
    }
    return false;
  }

  function conversationScroller(selectors) {
    for (const candidate of queryCandidates(selectors)) {
      let current = candidate;
      while (current) {
        const style = globalThis.getComputedStyle ? getComputedStyle(current) : null;
        if (nodeVisible(current) && style && /(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight) return current;
        current = current.parentElement;
      }
    }
    return document.scrollingElement;
  }

  function outsideConversation(node) {
    return !node.closest?.('[data-message-author-role], user-query, model-response, article[data-testid*="conversation"]');
  }

  function attachmentInventory(selectors) {
    const items = [];
    for (const node of queryCandidates(selectors)) {
      if (!nodeVisible(node) || !outsideConversation(node)) continue;
      const name = `${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''} ${node.textContent || ''}`.replace(/\s+/g, ' ').trim().slice(0, 500);
      if (name) items.push({ key: `${node.tagName || ''}:${name}`, name });
    }
    return items;
  }

  function attachmentConfirmed(before, after, filename) {
    const prior = new Set(before.map(item => item.key));
    const lower = String(filename || '').toLowerCase();
    return after.some(item => !prior.has(item.key) && item.name.toLowerCase().includes(lower));
  }

  function messageContext(providerId, node) {
    const container = providerId === 'chatgpt'
      ? node?.closest?.('[data-message-author-role]')
      : node?.closest?.('user-query, model-response');
    if (!container) return null;
    const role = providerId === 'chatgpt'
      ? container.getAttribute('data-message-author-role') || 'unknown'
      : container.tagName.toLowerCase() === 'user-query' ? 'user' : 'assistant';
    const providerMessageId = providerId === 'chatgpt'
      ? container.getAttribute('data-message-id') || container.closest('[data-message-id]')?.getAttribute('data-message-id') || ''
      : container.id || '';
    return { role, provider_message_id: providerMessageId, container };
  }

  function makeShared(providerId) {
    const selectors = SELECTORS[providerId];
    return {
      protocolVersion: ADAPTER_PROTOCOL_VERSION,
      surfaceId: `${providerId}.web`,
      composerText: textOf,
      setComposerText: setText,
      findComposer: () => chooseActive(queryCandidates(selectors.composer)),
      findSendButton: ({ allowDisabled = false } = {}) => chooseActive(queryCandidates(selectors.send), { allowDisabled }),
      findAttachmentInput: () => chooseActive(queryCandidates(selectors.attachmentInputs)),
      conversationScroller: () => conversationScroller(selectors.scrollers),
      loadingVisible: () => queryCandidates(['[aria-busy="true"]', '[role="progressbar"]', 'mat-progress-spinner']).some(nodeVisible),
      streamingVisible: () => queryCandidates(selectors.streaming).some(nodeVisible),
      attachmentInventory: () => attachmentInventory(selectors.attachmentEvidence),
      messageContext: node => messageContext(providerId, node),
      capabilities() {
        const composer = this.findComposer();
        const send = this.findSendButton({ allowDisabled: true });
        const messages = this.captureMessages();
        const established = this.refs().some(ref => ref.ref_type === 'chat_id');
        const failures = [];
        if (!composer) failures.push({ code: 'PROVIDER_COMPOSER_UNAVAILABLE', capability: 'composer' });
        if (!send) failures.push({ code: 'PROVIDER_SEND_CONTROL_UNAVAILABLE', capability: 'send' });
        if (established && messages.length === 0) failures.push({ code: 'PROVIDER_MESSAGE_EXTRACTION_EMPTY', capability: 'messages' });
        return { ok: failures.length === 0, protocol_version: ADAPTER_PROTOCOL_VERSION, provider: providerId, surface_id: this.surfaceId, adapter_version: this.version,
          established_conversation: established, composer: Boolean(composer), send: Boolean(send), messages: messages.length,
          streaming: this.streamingVisible(), attachment_input: Boolean(this.findAttachmentInput()),
          attachment_evidence_count: this.attachmentInventory().length, scroller: Boolean(this.conversationScroller()), failures };
      },
      matchesSendTarget(target) {
        const button = target?.closest?.('button');
        return Boolean(button && queryCandidates(selectors.send).includes(button) && nodeVisible(button));
      },
      async attachFile(file) {
        const input = this.findAttachmentInput();
        if (!input) return { ok: false, code: 'PROVIDER_ATTACHMENT_INPUT_UNAVAILABLE', reason: 'provider file input unavailable' };
        const before = this.attachmentInventory();
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          const after = this.attachmentInventory();
          if (attachmentConfirmed(before, after, file.name)) return { ok: true, before, after };
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { ok: false, code: 'PROVIDER_ATTACHMENT_UNCONFIRMED', reason: 'provider did not expose new composer-scoped attachment evidence', before, after: this.attachmentInventory() };
      },
      acceptanceBaseline() {
        return { route: `${location.pathname}${location.search}`, message_count: this.captureMessages().length,
          composer_text: textOf(this.findComposer()).trim(), streaming: this.streamingVisible(),
          send_disabled: Boolean(this.findSendButton({ allowDisabled: true })?.disabled) };
      },
      async observeProviderAcceptance(baseline, { timeoutMs = PROVIDER_ACCEPT_TIMEOUT_MS } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const composerText = textOf(this.findComposer()).trim();
          const signals = { message_count_increased: this.captureMessages().length > baseline.message_count,
            composer_cleared: Boolean(baseline.composer_text) && !composerText,
            streaming_started: !baseline.streaming && this.streamingVisible(),
            send_became_disabled: !baseline.send_disabled && Boolean(this.findSendButton({ allowDisabled: true })?.disabled),
            route_changed: `${location.pathname}${location.search}` !== baseline.route };
          const strong = signals.message_count_increased || signals.streaming_started;
          if (strong || Object.values(signals).filter(Boolean).length >= 2) return { accepted: true, certainty: strong ? 'strong' : 'corroborated', signals };
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        return { accepted: false, certainty: 'uncertain', code: 'PROVIDER_ACCEPTANCE_UNCERTAIN', signals: {} };
      }
    };
  }

  const chatgpt = {
    id: 'chatgpt', version: 'chatgpt-2026-08-16.2',
    refs() { const match = location.pathname.match(/\/c\/([^/?#]+)/); return [...(match?.[1] ? [{ ref_type: 'chat_id', ref_value: match[1], source: 'browser_companion' }] : []), { ref_type: 'route', ref_value: `${location.pathname}${location.search}`, source: 'browser_companion' }, { ref_type: 'native_url', ref_value: location.href, source: 'browser_companion' }]; },
    captureMessages() { return queryCandidates(SELECTORS.chatgpt.messages).filter(nodeVisible).map((node, index) => ({ role: node.getAttribute('data-message-author-role') || 'unknown', content: node.innerText?.trim() || '', provider_message_id: node.getAttribute('data-message-id') || node.closest('[data-message-id]')?.getAttribute('data-message-id') || '', parent_provider_message_id: node.getAttribute('data-parent-message-id') || node.closest('[data-parent-message-id]')?.getAttribute('data-parent-message-id') || '', raw: { index, html: node.outerHTML.slice(0, 50000) } })).filter(item => item.content); },
    ...makeShared('chatgpt')
  };
  const gemini = {
    id: 'gemini', version: 'gemini-2026-08-16.2',
    refs() { const match = location.pathname.match(/\/app\/([^/?#]+)/); return [...(match?.[1] ? [{ ref_type: 'chat_id', ref_value: match[1], source: 'browser_companion' }] : []), { ref_type: 'route', ref_value: `${location.pathname}${location.search}`, source: 'browser_companion' }, { ref_type: 'native_url', ref_value: location.href, source: 'browser_companion' }]; },
    captureMessages() { return queryCandidates(SELECTORS.gemini.messages).filter(nodeVisible).map((node, index) => ({ role: node.tagName.toLowerCase() === 'user-query' ? 'user' : 'assistant', content: node.innerText?.trim() || '', provider_message_id: node.id || '', raw: { index, tag: node.tagName.toLowerCase(), html: node.outerHTML.slice(0, 50000) } })).filter(item => item.content); },
    ...makeShared('gemini')
  };
  globalThis.AIH_PROVIDER_ADAPTERS = { chatgpt, gemini };
  globalThis.AIH_PROVIDER_TESTING = { SELECTORS, nodeVisible, chooseActive, attachmentConfirmed, protocolVersion: ADAPTER_PROTOCOL_VERSION };
})();
