const BUILTIN_SURFACES = Object.freeze([
  {
    id: 'chatgpt.web', provider_family: 'openai', display_name: 'ChatGPT (web)', channel: 'browser_companion', adapter_version: '4.0.0',
    capabilities: { text_context: true, image_attachment: true, pdf_attachment: true, file_attachment: true, local_context_api: false, filesystem: false, shell: false, max_attachments: 8, max_attachment_bytes: 25 * 1024 * 1024 }
  },
  {
    id: 'gemini.web', provider_family: 'google', display_name: 'Gemini (web)', channel: 'browser_companion', adapter_version: '4.0.0',
    capabilities: { text_context: true, image_attachment: true, pdf_attachment: true, file_attachment: true, local_context_api: false, filesystem: false, shell: false, max_attachments: 8, max_attachment_bytes: 25 * 1024 * 1024 }
  },
  {
    id: 'codex.local', provider_family: 'openai', display_name: 'Codex (local)', channel: 'local_agent', adapter_version: '1.0.0',
    capabilities: { text_context: true, image_attachment: false, pdf_attachment: false, file_attachment: false, local_context_api: true, filesystem: 'registered_repository_only', shell: 'agent_controlled_in_registered_repository', max_attachments: 0, max_attachment_bytes: 0 }
  },
  {
    id: 'antigravity.local', provider_family: 'google', display_name: 'Antigravity (local)', channel: 'local_agent', adapter_version: '1.0.0',
    capabilities: { text_context: true, image_attachment: false, pdf_attachment: false, file_attachment: false, local_context_api: true, filesystem: 'registered_repository_only', shell: 'agent_controlled_in_registered_repository', max_attachments: 0, max_attachment_bytes: 0 }
  }
]);

function freezeSurface(surface) {
  return Object.freeze({ ...surface, capabilities: Object.freeze({ ...(surface.capabilities || {}) }) });
}

export class SurfaceRegistry {
  #surfaces = new Map();

  constructor(surfaces = BUILTIN_SURFACES) {
    for (const surface of surfaces) this.register(surface);
  }

  register(surface) {
    if (!surface?.id || !surface?.provider_family || !surface?.channel) throw Object.assign(new Error('surface adapter requires id, provider family, and channel'), { code: 'SURFACE_CONTRACT_INVALID' });
    if (!['browser_companion','local_agent'].includes(surface.channel)) throw Object.assign(new Error(`unsupported surface channel: ${surface.channel}`), { code: 'SURFACE_CHANNEL_UNSUPPORTED' });
    if (surface.channel === 'browser_companion' && (surface.capabilities?.filesystem !== false || surface.capabilities?.shell !== false)) {
      throw Object.assign(new Error('browser companion surfaces must explicitly deny filesystem and shell capability'), { code: 'SURFACE_BROWSER_PRIVILEGE_REJECTED' });
    }
    if (this.#surfaces.has(surface.id)) throw Object.assign(new Error(`surface adapter already registered: ${surface.id}`), { code: 'SURFACE_ALREADY_REGISTERED' });
    const normalized = freezeSurface(surface);
    this.#surfaces.set(normalized.id, normalized);
    return normalized;
  }

  resolve(id) {
    const surface = this.#surfaces.get(String(id || ''));
    if (!surface) throw Object.assign(new Error(`unknown or unsupported delivery surface: ${id || '(missing)'}`), { code: 'SURFACE_UNSUPPORTED' });
    return surface;
  }

  list() { return [...this.#surfaces.values()]; }
}

export const surfaceRegistry = new SurfaceRegistry();

export function browserSurfaceForProvider(provider) {
  const id = provider === 'chatgpt' ? 'chatgpt.web' : provider === 'gemini' ? 'gemini.web' : '';
  return surfaceRegistry.resolve(id);
}

export function publicSurfaceStatus(surface, live = {}) {
  return {
    id: surface.id,
    provider_family: surface.provider_family,
    display_name: surface.display_name,
    channel: surface.channel,
    adapter_version: surface.adapter_version,
    capabilities: surface.capabilities,
    status: live.status || 'configured',
    last_seen_at: live.last_seen_at || null,
    limitation: live.limitation || ''
  };
}
