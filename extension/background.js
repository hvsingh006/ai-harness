const API_ORIGIN = 'http://127.0.0.1:4317';

const ALLOWED_PATHS = [
  /^\/companion\/heartbeat$/,
  /^\/companion\/active-workspace$/,
  /^\/companion\/provider-session(?:\?.*)?$/,
  /^\/companion\/capture$/,
  /^\/companion\/workspaces\/[A-Za-z0-9_-]+\/prepare-send$/,
  /^\/companion\/outgoing-context\/[A-Za-z0-9_-]+\/sent$/,
  /^\/companion\/outgoing-context\/[A-Za-z0-9_-]+\/failed$/,
  /^\/companion\/resource-versions\/[A-Za-z0-9_-]+\/content$/,
  /^\/companion\/session-assets\/[A-Za-z0-9_-]+\/source$/,
  /^\/companion\/session-assets\/[A-Za-z0-9_-]+\/content$/,
  /^\/companion\/session-assets\/[A-Za-z0-9_-]+\/status$/
];

const PROVIDER_ASSET_HOSTS = Object.freeze({
  chatgpt: ['chatgpt.com', 'oaiusercontent.com', 'oaistatic.com'],
  gemini: ['gemini.google.com', 'googleusercontent.com', 'gstatic.com']
});

function validProviderAssetUrl(provider, value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return false;
    return (PROVIDER_ASSET_HOSTS[provider] || []).some(suffix => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
  } catch { return false; }
}

function validProviderBlobUrl(provider, value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'blob:') return false;
    const origin = new URL(url.origin);
    return origin.protocol === 'https:' && (PROVIDER_ASSET_HOSTS[provider] || []).some(suffix => origin.hostname === suffix || origin.hostname.endsWith(`.${suffix}`));
  } catch { return false; }
}

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
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await fetch(`${API_ORIGIN}/api${path}`, { ...options, headers }); }
    catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, Math.min(2000, 200 * (2 ** attempt))));
    }
  }
  throw lastError || new Error('Harness service unavailable');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function discoveredAssetDescriptor(assetId) {
  const response = await authenticatedFetch(`/companion/session-assets/${assetId}/source`, { method: 'GET' });
  const descriptor = await response.json().catch(() => ({}));
  if (!response.ok || !descriptor.ok) throw new Error(descriptor.code || `Provider asset descriptor unavailable (${response.status})`);
  return descriptor;
}

async function reportAssetStatus(assetId, status, message) {
  await authenticatedFetch(`/companion/session-assets/${assetId}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, message: String(message || '').slice(0, 500) }) }).catch(() => {});
}

async function uploadDiscoveredAsset(descriptor, bytes, contentType) {
  const uploaded = await authenticatedFetch(`/companion/session-assets/${descriptor.asset_id}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || descriptor.mime_type || 'application/octet-stream', 'X-AIH-Asset-Source-Url': descriptor.source_url, 'X-AIH-Asset-Capture-Strategy': descriptor.capture_strategy },
    body: bytes
  });
  if (!uploaded.ok) throw new Error(`Harness rejected provider asset (${uploaded.status})`);
  return { ok: true, status: 'CAPTURED', result: await uploaded.json() };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !['aih-api-request', 'aih-pair', 'aih-resource-request', 'aih-mirror-asset', 'aih-mirror-asset-bytes'].includes(message.type)) return false;

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

    if (message.type === 'aih-mirror-asset') {
      const descriptor = await discoveredAssetDescriptor(message.asset_id);
      if (descriptor.provider !== message.provider || descriptor.capture_strategy !== 'background_https' || !validProviderAssetUrl(descriptor.provider, descriptor.source_url)) throw new Error('Provider asset descriptor rejected');
      let source;
      try { source = await fetch(descriptor.source_url, { credentials: 'include', redirect: 'follow', cache: 'no-store' }); }
      catch (error) {
        await reportAssetStatus(message.asset_id, 'CORS_BLOCKED', error.message);
        throw error;
      }
      if (source.status === 401 || source.status === 403) {
        await reportAssetStatus(message.asset_id, 'AUTH_REQUIRED', `HTTP ${source.status}`);
        throw new Error('Provider asset authentication required');
      }
      if (!source.ok || !source.body) {
        const status = source.status === 404 || source.status === 410 ? 'EXPIRED' : 'UNAVAILABLE';
        await reportAssetStatus(message.asset_id, status, `HTTP ${source.status}`);
        throw new Error(`Provider asset unavailable (${source.status})`);
      }
      const declared = Number(source.headers.get('content-length') || 0);
      if (declared > descriptor.max_bytes) {
        await reportAssetStatus(message.asset_id, 'FAILED', 'Provider asset exceeds capture limit');
        throw new Error('Provider asset exceeds capture limit');
      }
      const buffer = await source.arrayBuffer();
      if (buffer.byteLength > descriptor.max_bytes) {
        await reportAssetStatus(message.asset_id, 'FAILED', 'Provider asset exceeds capture limit');
        throw new Error('Provider asset exceeds capture limit');
      }
      return uploadDiscoveredAsset(descriptor, buffer, source.headers.get('content-type') || descriptor.mime_type);
    }

    if (message.type === 'aih-mirror-asset-bytes') {
      const descriptor = await discoveredAssetDescriptor(message.asset_id);
      if (descriptor.provider !== message.provider || descriptor.capture_strategy !== 'page_blob' || !validProviderBlobUrl(descriptor.provider, descriptor.source_url)) throw new Error('Provider blob asset descriptor rejected');
      const bytes = base64ToBytes(message.data_base64);
      if (bytes.byteLength > descriptor.max_bytes) {
        await reportAssetStatus(message.asset_id, 'FAILED', 'Provider blob asset exceeds capture limit');
        throw new Error('Provider blob asset exceeds capture limit');
      }
      return uploadDiscoveredAsset(descriptor, bytes, message.mime_type || descriptor.mime_type);
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
