(() => {
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== 'http://127.0.0.1:4317' || event.data?.type !== 'aih-pair-request') return;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'aih-pair', challenge: event.data.challenge });
      window.postMessage({ type: 'aih-pair-result', request_id: event.data.request_id, ...result }, event.origin);
    } catch (error) {
      window.postMessage({ type: 'aih-pair-result', request_id: event.data.request_id, ok: false, error: error.message }, event.origin);
    }
  });
})();
