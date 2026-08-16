const API_ORIGIN = 'http://127.0.0.1:4317';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'aih-api-request') return false;

  const path = String(message.path || '');
  if (!path.startsWith('/')) {
    sendResponse({ error: 'Invalid Harness API path' });
    return false;
  }

  const url = `${API_ORIGIN}/api${path}`;
  const options = message.options || {};
  const requestOptions = {
    method: options.method || 'GET',
    headers: options.headers || { 'Content-Type': 'application/json' }
  };
  if (options.body !== undefined && requestOptions.method !== 'GET' && requestOptions.method !== 'HEAD') {
    requestOptions.body = options.body;
  }

  fetch(url, requestOptions)
    .then(async response => ({
      ok: response.ok,
      status: response.status,
      text: await response.text()
    }))
    .then(sendResponse)
    .catch(error => sendResponse({ error: error?.message || 'Harness service unavailable' }));

  return true;
});
