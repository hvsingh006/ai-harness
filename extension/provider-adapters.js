(() => {
  const shared = {
    composerText(element) {
      if (!element) return '';
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
      return element.innerText || element.textContent || '';
    },
    setComposerText(element, text) {
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
    },
    conversationScroller() {
      const main = document.querySelector('main') || document.querySelector('[role="main"]');
      let current = main;
      while (current) {
        const style = getComputedStyle(current);
        if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight) return current;
        current = current.parentElement;
      }
      return document.scrollingElement;
    },
    loadingVisible() {
      return Boolean(document.querySelector('[aria-busy="true"], [role="progressbar"], mat-progress-spinner'));
    },
    async attachFile(file) {
      const input = [...document.querySelectorAll('input[type="file"]')].find(item => !item.disabled);
      if (!input) return { ok: false, reason: 'provider file input unavailable' };
      const confirmationNodes = () => [...document.querySelectorAll('span,div,p,button,[aria-label],[data-testid]')].filter(node => {
        if (node.closest('[data-message-author-role],user-query,model-response')) return false;
        const label = `${node.getAttribute?.('aria-label') || ''}\n${node.textContent || ''}`.trim();
        return label.length <= 500 && label.includes(file.name);
      });
      const before = new Map(confirmationNodes().map(node => [node, `${node.getAttribute?.('aria-label') || ''}\n${node.textContent || ''}`]));
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const confirmed = confirmationNodes().some(node => !before.has(node) || before.get(node) !== `${node.getAttribute?.('aria-label') || ''}\n${node.textContent || ''}`);
        if (confirmed) return { ok: true };
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return { ok: false, reason: 'provider did not confirm the prepared attachment' };
    }
  };

  const chatgpt = {
    id: 'chatgpt',
    version: 'chatgpt-2026-08-16.1',
    refs() {
      const match = location.pathname.match(/\/c\/([^/?#]+)/);
      return [
        ...(match?.[1] ? [{ ref_type: 'chat_id', ref_value: match[1], source: 'browser_companion' }] : []),
        { ref_type: 'route', ref_value: `${location.pathname}${location.search}`, source: 'browser_companion' },
        { ref_type: 'native_url', ref_value: location.href, source: 'browser_companion' }
      ];
    },
    findComposer: () => document.querySelector('#prompt-textarea') || document.querySelector('main [contenteditable="true"]'),
    findSendButton: () => document.querySelector('button[data-testid="send-button"]') || document.querySelector('button[aria-label="Send prompt"]') || document.querySelector('button[aria-label="Send message"]'),
    matchesSendTarget(target) { return Boolean(target?.closest?.('button[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"]')); },
    captureMessages() {
      return [...document.querySelectorAll('[data-message-author-role]')].map((node, index) => ({
        role: node.getAttribute('data-message-author-role') || 'unknown',
        content: node.innerText?.trim() || '',
        provider_message_id: node.getAttribute('data-message-id') || node.closest('[data-message-id]')?.getAttribute('data-message-id') || '',
        raw: { index, html: node.outerHTML.slice(0, 50000) }
      })).filter(item => item.content);
    },
    ...shared
  };

  const gemini = {
    id: 'gemini',
    version: 'gemini-2026-08-16.1',
    refs() {
      const match = location.pathname.match(/\/app\/([^/?#]+)/);
      return [
        ...(match?.[1] ? [{ ref_type: 'chat_id', ref_value: match[1], source: 'browser_companion' }] : []),
        { ref_type: 'route', ref_value: `${location.pathname}${location.search}`, source: 'browser_companion' },
        { ref_type: 'native_url', ref_value: location.href, source: 'browser_companion' }
      ];
    },
    findComposer: () => document.querySelector('rich-textarea [contenteditable="true"]') || document.querySelector('main [contenteditable="true"]'),
    findSendButton: () => document.querySelector('button[aria-label*="Send"]') || document.querySelector('button.send-button') || document.querySelector('button[mattooltip*="Send"]'),
    matchesSendTarget(target) { return Boolean(target?.closest?.('button[aria-label*="Send"],button.send-button,button[mattooltip*="Send"]')); },
    captureMessages() {
      return [...document.querySelectorAll('user-query, model-response')].map((node, index) => ({
        role: node.tagName.toLowerCase() === 'user-query' ? 'user' : 'assistant',
        content: node.innerText?.trim() || '',
        provider_message_id: node.id || '',
        raw: { index, tag: node.tagName.toLowerCase(), html: node.outerHTML.slice(0, 50000) }
      })).filter(item => item.content);
    },
    ...shared
  };

  globalThis.AIH_PROVIDER_ADAPTERS = { chatgpt, gemini };
})();
