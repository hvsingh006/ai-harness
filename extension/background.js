const API_ORIGIN = 'http://127.0.0.1:4317';

const ALLOWED_PATHS = [
  /^\/companion\/heartbeat$/,
  /^\/companion\/active-workspace$/,
  /^\/companion\/provider-session(?:\?.*)?$/,
  /^\/companion\/capture$/,
  /^\/companion\/workspaces\/[A-Za-z0-9_-]+\/prepare-send$/,
  /^\/companion\/outgoing-context\/[A-Za-z0-9_-]+\/sent$/,
  /^\/companion\/outgoing-context\/[A-Za-z0-9_-]+\/failed$/,
  /^\/companion\/resource-versions\/[A-Za-z0-9_-]+\/content$/
];

function validPath(value) {
  const path = String(value || '');
  return path.startsWith('/') && !path.includes('..') && ALLOWED_PATHS.some(pattern => pattern.test(path));
}

async function pairedToken() {
  const stored = await chrome.storage.local.get('aih_companion_token');
  return stored.aih_companion_token || '';
}

async function authenticatedFetch(path, options = {}) {
  if (!validPath(path)) throw new Error('Harness API operation is not allowed for the browser companion');
  const token = await pairedToken();
  if (!token) throw new Error('Browser companion is not paired');
  const headers = {
    'X-AIH-Companion-Token': token,
    'X-AIH-Extension-Id': chrome.runtime.id,
    ...(options.headers || {})
  };
  return fetch(`${API_ORIGIN}/api${path}`, { ...options, headers });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !['aih-api-request', 'aih-pair', 'aih-resource-request'].includes(message.type)) return false;

  (async () => {
    if (message.type === 'aih-pair') {
      const response = await fetch(`${API_ORIGIN}/api/companion/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AIH-Extension-Id': chrome.runtime.id },
        body: JSON.stringify({ challenge: message.challenge, extension_id: chrome.runtime.id })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.token) throw new Error(payload.error || 'Companion pairing failed');
      await chrome.storage.local.set({ aih_companion_token: payload.token, aih_paired_at: payload.paired_at });
      return { ok: true, extension_id: chrome.runtime.id, paired_at: payload.paired_at };
    }

    if (message.type === 'aih-resource-request') {
      const response = await authenticatedFetch(message.path, { method: 'GET' });
      if (!response.ok) throw new Error(`Harness resource request failed (${response.status})`);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 25 * 1024 * 1024) throw new Error('Prepared attachment exceeds companion transfer limit');
      return { ok: true, data_base64: arrayBufferToBase64(buffer), content_type: response.headers.get('content-type') || 'application/octet-stream' };
    }

    const path = String(message.path || '');
    const options = message.options || {};
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const response = await authenticatedFetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined && !['GET', 'HEAD'].includes(options.method || 'GET') ? options.body : undefined
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  })().then(sendResponse).catch(error => sendResponse({ error: error?.message || 'Harness service unavailable' }));

  return true;
});
