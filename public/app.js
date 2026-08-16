const API = 'http://127.0.0.1:4317/api';
let workspaces = [];
let active = null;
let currentView = 'workspace';
let readiness = null;
let health = null;
let managedMigrations = [];

const qs = s => document.querySelector(s);
const esc = (value = '') => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

function providerName(provider) {
  return ({ chatgpt: 'ChatGPT', gemini: 'Gemini' })[provider] || provider;
}

function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function bytes(value) {
  const n = Number(value || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function metric(label, value, note = '') {
  return `<div class="metric"><strong>${esc(value)}</strong><span>${esc(label)}</span>${note ? `<div class="metric-note">${esc(note)}</div>` : ''}</div>`;
}

function statusBadge(status) {
  const safe = status === 'safe_to_delete' || status === 'complete';
  return `<span class="badge ${safe ? 'safe' : ''}">${esc(String(status || 'unknown').replaceAll('_', ' '))}</span>`;
}

async function load() {
  const [settings, ws, ready, serviceHealth, migrations] = await Promise.all([api('/settings'), api('/workspaces'), api('/readiness'), api('/health'), api('/storage/managed-project-migrations')]);
  readiness = ready;
  health = serviceHealth;
  managedMigrations = migrations;
  workspaces = ws;
  const versionLabel = qs('#versionLabel');
  if (versionLabel) versionLabel.textContent = `Version ${health?.version || 'unknown'}`;
  qs('#themeSelect').value = settings.theme || 'system';
  applyTheme(settings.theme || 'system');
  active = await api('/active-workspace');
  renderWorkspaceSelect();
  renderReadiness();
  renderIntegrity();
  render();
  setInterval(async () => {
    try {
      readiness = await api('/readiness');
      if (active?.id) active.integrity = await api(`/workspaces/${encodeURIComponent(active.id)}/integrity`);
      renderReadiness();
      renderIntegrity();
    } catch {}
  }, 10000);
}

function renderReadiness() {
  const el = qs('#readyStatus');
  if (!el || !readiness) return;
  el.classList.toggle('ready', Boolean(readiness.ready_for_native_workflow));
  el.querySelector('span:last-child').textContent = readiness.ready_for_native_workflow ? 'Harness ready' : 'Install/open companion';
  el.title = readiness.ready_for_native_workflow ? `Browser companion ${readiness.browser_companion_version || ''} seen ${readiness.browser_companion_last_seen || ''}` : 'The local service is running, but the browser companion has not checked in yet.';
}

function renderIntegrity() {
  const el = qs('#integrityStatus');
  if (!el || !active) return;
  const integrity = active.integrity || {};
  const status = String(integrity.freshness || active.freshness_status || 'stale').toLowerCase();
  const labels = { current: 'Project Current', verifying: 'Verifying Project', stale: 'Context Stale', blocked: 'Context Blocked', error: 'Context Error' };
  el.dataset.status = status;
  el.querySelector('span:last-child').textContent = labels[status] || 'Context Stale';
  el.title = integrity.last_verified_at ? `Last verified ${integrity.last_verified_at}. Guaranteed sends always verify again.` : 'No verified managed send snapshot yet.';
}

function renderWorkspaceSelect() {
  qs('#workspaceSelect').innerHTML = workspaces.map(w => `<option value="${esc(w.id)}" ${active?.id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
}

function providerButtons() {
  const links = active?.providers || [];
  const preferred = ['chatgpt', 'gemini'];
  const sorted = links.filter(link => preferred.includes(link.provider)).sort((a,b) => preferred.indexOf(a.provider) - preferred.indexOf(b.provider));
  const buttons = sorted.map(link => `
    <button class="provider-button" data-open="${esc(link.url)}">
      <span>${esc(providerName(link.provider))}</span><span>Open native service ↗</span>
    </button>
  `).join('');
  const both = links.filter(l => ['chatgpt','gemini'].includes(l.provider));
  return `${buttons}${both.length === 2 ? `<button class="provider-button" id="openBoth"><span>ChatGPT + Gemini</span><span>Open both ↗</span></button>` : ''}`;
}

function resourceIcon(item) {
  const mime = String(item.mime_type || '');
  if (mime === 'application/pdf') return 'PDF';
  if (mime.startsWith('image/')) return 'IMG';
  if (/word|text|markdown|document/.test(mime)) return 'DOC';
  if (/sheet|csv|excel/.test(mime)) return 'DATA';
  if (/zip|compressed/.test(mime)) return 'ZIP';
  return 'FILE';
}

function renderProjectResources() {
  const items = (active.files || []).slice(0, 40);
  return `
    <div class="card project-resources-card">
      <div class="section-title"><div><div class="eyebrow">PROJECT FILESYSTEM</div><h2>Your real project folder</h2></div><span class="badge">${esc((active.files || []).length)} files</span></div>
      <p class="lede">These files live in a normal folder on your computer, outside the AI Harness application checkout. Updating the Harness cannot replace this project folder. The archive keeps immutable snapshots separately when files enter an AI workflow.</p>
      <div class="project-path-row"><code>${esc(active.root_path || 'Project folder not initialized')}</code><button class="tiny-button" id="openProjectFolder">Open folder</button><button class="tiny-button" id="attachProjectFolder">Attach existing folder</button></div>
      <div id="projectDropZone" class="drop-zone" tabindex="0">
        <div class="drop-zone-title">Drop files here</div>
        <div class="list-sub">or choose files / a folder. Files are written into the project folder and separately preserved in the archive.</div>
        <div class="drop-actions">
          <label class="file-picker">Add files<input id="projectFiles" type="file" multiple></label>
          <label class="file-picker secondary-picker">Add folder<input id="projectFolder" type="file" webkitdirectory directory multiple></label>
        </div>
        <div id="projectUploadProgress" class="upload-progress"></div>
      </div>
      <div class="resource-grid">${items.map(item => `
        <article class="resource-card">
          <div class="resource-type">${esc(resourceIcon(item))}</div>
          <div class="resource-body"><div class="resource-name" title="${esc(item.relative_path || item.name)}">${esc(item.relative_path || item.name)}</div><div class="list-sub">${esc(bytes(item.size_bytes))} · project file</div></div>
          <button class="tiny-button" data-project-file-open="${esc(item.id)}">Open</button>
        </article>`).join('') || '<div class="empty">No project files yet. Drag in the material you are actually working from.</div>'}</div>
    </div>`;
}

function renderProjectIntegrity() {
  const integrity = active.integrity || {};
  const roots = active.roots || [];
  const snapshot = integrity.latest_snapshot;
  const reasons = snapshot?.details?.reasons || [];
  const status = String(integrity.freshness || 'stale').toLowerCase();
  const labels = { current: 'Project Current', verifying: 'Verifying Project', stale: 'Context Stale', blocked: 'Context Blocked', error: 'Context Error' };
  return `
    <div class="card integrity-card">
      <div class="section-title"><div><div class="eyebrow">VERIFIED CONTEXT INTEGRITY</div><h3>${esc(labels[status] || 'Context Stale')}</h3></div><span class="badge ${status === 'current' ? 'safe' : ''}">${esc(status)}</span></div>
      <p class="lede">${status === 'current' ? `Verified ${esc(integrity.last_verified_at || '')}. Every managed native send verifies again before it proceeds.` : 'The next managed native Send will reconcile every required source and will pause if currentness cannot be proven.'}</p>
      <div class="integrity-grid">
        <div><strong>Files/index</strong><span>generation ${esc(integrity.corpus_generation || 0)} / ${esc(integrity.index_generation || 0)}</span></div>
        <div><strong>History coverage</strong><span>${esc(integrity.history_coverage || 'unknown')}</span></div>
        <div><strong>Last snapshot</strong><span>${esc(snapshot?.id || 'none yet')}</span></div>
      </div>
      ${reasons.length ? `<div class="blocked-reasons">${reasons.map(reason => `<div><strong>${esc(reason.code)}</strong> ${esc(reason.message)}</div>`).join('')}</div>` : ''}
      <div class="section-title source-head"><h3>Project Sources</h3><button class="tiny-button" id="addProjectRoot">Add linked source</button></div>
      <div class="list">${roots.map(root => `<div class="list-row"><div><div class="list-title">${esc(root.label || root.root_kind)}</div><div class="list-sub">${esc(root.root_path)}<br>${root.required_for_freshness ? 'required' : 'optional'} · ${root.indexing_enabled ? 'indexed' : 'not indexed'} · ${root.provider_transmission_allowed ? 'provider allowed' : 'local only'}</div></div><span class="badge ${root.status === 'current' ? 'safe' : ''}">${esc(root.status || 'unknown')}</span></div>`).join('') || '<div class="empty">No approved roots.</div>'}</div>
    </div>`;
}

function renderWorkspace() {
  const archive = active.archive || {};
  const recent = (active.sessions || []).slice(0, 6);
  return `
    <div class="hero">
      <div class="card">
        <div class="eyebrow">PROJECT SPACE</div>
        <h2>${esc(active.name)}</h2>
        <p class="lede">${esc(active.description)}</p>
        <div class="focus"><strong>CURRENT WORKING STATE</strong>${esc(active.active_focus || 'No active focus yet.')}</div>
        <div class="principle"><strong>Purpose</strong><span>Keep your project context, files, and chat history available when you start a new chat or switch between ChatGPT and Gemini. Use AI to improve productivity and understanding without replacing your judgment.</span></div>
      </div>
      <div class="card">
        <div class="section-title"><h3>Native AI surfaces</h3><span class="badge">same workspace</span></div>
        <div class="provider-actions">${providerButtons()}</div>
      </div>
    </div>
    ${renderProjectIntegrity()}
    ${renderProjectResources()}
    <div class="metric-grid">
      ${metric('raw messages archived', archive.messages || 0)}
      ${metric('canonical artifacts', archive.artifacts || 0, bytes(archive.artifact_bytes || 0))}
      ${metric('sessions retained', archive.sessions || 0)}
      ${metric('safe to delete', archive.safe_sessions || 0, `${archive.incomplete_sessions || 0} incomplete`)}
    </div>
    <div class="card">
      <div class="section-title"><h3>Recent chats</h3><span class="badge">same project context</span></div>
      <div class="list">${recent.map(s => `
        <div class="list-row"><div><div class="list-title">${esc(s.title)}</div><div class="list-sub">${esc(providerName(s.provider))} · ${esc(s.message_count)} messages<br>${esc(s.summary || 'Chat retained in this project.')}</div></div>${statusBadge(s.capture_status)}</div>`).join('') || '<div class="empty">No captured chats yet. Open ChatGPT or Gemini from this project to start.</div>'}</div>
    </div>`;
}

function renderSessions() {
  const a = active.archive || {};
  return `
    <div class="card" style="margin-bottom:18px">
      <div class="section-title"><div><div class="eyebrow">CHAT HISTORY</div><h2>All chats for ${esc(active.name)}</h2></div><span class="badge">${esc((active.sessions || []).length)} chats</span></div>
      <p class="lede">ChatGPT and Gemini conversations stay attached to this Project Space. Reopen an old native chat, search prior messages, or bring an archived chat back into a new prompt.</p>
      <div class="list">${(active.sessions || []).map(s => `
        <div class="list-row session-row" data-session="${esc(s.id)}"><div><div class="list-title">${esc(s.display_label || s.title)}</div><div class="list-sub">${esc(providerName(s.provider))} · ${esc(s.message_count)} messages · ${esc(s.started_at || '')}<br>${esc(s.title)}</div><div class="session-actions">${s.native_url ? `<button class="tiny-button" data-open="${esc(s.native_url)}">Open chat ↗</button>` : ''}<button class="tiny-button" data-session-context="${esc(s.id)}">Bring into prompt</button></div></div>${statusBadge(s.capture_status)}</div>`).join('') || '<div class="empty">No chats captured yet.</div>'}</div>
    </div>
    <div class="two-col">
      <div class="card">
        <div class="section-title"><h3>Search history</h3><span class="badge">${esc(a.messages || 0)} messages</span></div>
        <form id="searchForm" class="search-form"><input id="searchInput" placeholder="Search prior ChatGPT and Gemini chats…" autocomplete="off"><button class="primary">Search</button></form>
        <div id="searchResults" class="list"><div class="empty">Search the retained raw chat history for this project.</div></div>
      </div>
      <div class="card">
        <div class="section-title"><h3>Import older chats</h3><span class="badge">optional</span></div>
        <div class="import-box">
          <div class="import-controls">
            <select id="importProvider"><option value="chatgpt">ChatGPT export</option><option value="gemini">Gemini / Google export</option></select>
            <label class="file-picker">Choose extracted export folder<input id="importFolder" type="file" webkitdirectory directory multiple></label>
          </div>
          <div id="importProgress" class="list-sub">Use this only when you want to bring older ChatGPT or Gemini history into the project.</div>
        </div>
      </div>
    </div>`;
}

function renderSetup() {
  const companion = Boolean(readiness?.browser_companion_seen);
  const service = Boolean(health?.ok);
  const storage = health?.storage || {};
  const checks = [
    ['Local Harness service', service, service ? `v${health.version}` : 'not responding'],
    ['Persistent workspace root', Boolean(storage.workspace_root), storage.workspace_root || 'waiting for service'],
    ['SQLite archive', service, service ? `${health.archive?.messages || 0} messages indexed · ${storage.database_path || ''}` : 'waiting for service'],
    ['Browser companion pairing', Boolean(readiness?.browser_companion_paired), readiness?.browser_companion_paired ? `paired extension ${readiness.paired_extension_id || ''}` : 'pair the loaded extension below'],
    ['Browser companion heartbeat', companion, companion ? `v${readiness.browser_companion_version || 'unknown'} connected` : 'refresh ChatGPT or Gemini after pairing'],
    ['Active project space', Boolean(active?.id && active?.root_path), active?.root_path || active?.name || 'create a project'],
  ];
  return `
    <div class="card" style="margin-bottom:18px">
      <div class="eyebrow">TEST-READY GATE</div>
      <h2>First-run setup and smoke test</h2>
      <p class="lede">The bright red readiness dot means the local service and browser companion can see each other. It does not mean an individual chat is safe to delete. Chat preservation has its own verification status.</p>
    </div>
    <div class="two-col">
      <div class="card">
        <div class="section-title"><h3>Installation checks</h3>${companion && service ? '<span class="badge safe">ready</span>' : '<span class="badge">setup needed</span>'}</div>
        <div class="list">${checks.map(([name,ok,detail]) => `<div class="list-row"><div><div class="list-title">${esc(name)}</div><div class="list-sub">${esc(detail)}</div></div><span class="badge ${ok ? 'safe' : ''}">${ok ? 'pass' : 'wait'}</span></div>`).join('')}</div>
      </div>
      <div class="card">
        <div class="section-title"><h3>10-minute smoke test</h3><span class="badge">prototype</span></div>
        <ol class="test-steps">
          <li>Create a Project Space with <strong>New project</strong>.</li>
          <li>Drag a small PDF or image into Project Space and confirm it appears under resources.</li>
          <li>Open ChatGPT or Gemini, confirm the red AIH label appears, and send a short two-message exchange.</li>
          <li>Return here and confirm the chat appears under <strong>Chat History</strong>.</li>
          <li>Start a fresh chat in the other AI service and press the normal native Send button.</li>
          <li>Harness should verify the Project Space, insert relevant cross-provider context, and then replay Send once.</li>
          <li>Do not delete either native chat yet unless its session status explicitly says <strong>safe to delete</strong>.</li>
        </ol>
      </div>
    </div>
    <div class="card" style="margin-top:18px">
      <div class="section-title"><div><div class="eyebrow">APPLICATION</div><h3>Version ${esc(health?.version || 'unknown')}</h3></div><button class="secondary" id="checkUpdatesButton">Check for updates</button></div>
      <div id="updateStatusText" class="callout">Use the <strong>AI Harness</strong> desktop or Start Menu shortcut to check for an update and launch in one action. If GitHub is unavailable, it launches the currently installed version.</div>
    </div>
    <div class="card" style="margin-top:18px">
      <div class="section-title"><h3>Browser companion installation</h3><span class="badge">Chrome / Edge</span></div>
      <div class="callout">Open the browser extensions page, enable Developer mode, choose <strong>Load unpacked</strong>, and select this repository's <code>extension</code> folder. After an extension update, press Reload on the extension and refresh ChatGPT/Gemini.</div>
      <div class="pair-row"><button class="primary" id="pairCompanionButton">Pair browser companion</button><span id="pairCompanionStatus" class="list-sub">Pairing uses a one-time challenge; no token copying is required.</span></div>
      <p class="lede">Persistent projects, archive, and the database live under <code>${esc(storage.workspace_root || 'Documents\\AI Harness')}</code>, outside the updateable application checkout.</p>
    </div>
    ${managedMigrations.length ? `<div class="card" style="margin-top:18px"><div class="section-title"><h3>Move managed projects to AI Workspace</h3><span class="badge">${managedMigrations.length} pending</span></div><p class="lede">Harness copies and hash-verifies each managed project before updating its reference. The original remains as a recoverable fallback and conflicts are never overwritten.</p><div class="list">${managedMigrations.map(item => `<div class="list-row"><div><div class="list-title">${esc(item.name)}</div><div class="list-sub">${esc(item.root_path)}</div></div><button class="tiny-button" data-migrate-workspace="${esc(item.id)}">Migrate safely</button></div>`).join('')}</div></div>` : ''}`;
}

function render() {
  if (!active) return;
  const views = { workspace: renderWorkspace, history: renderSessions, setup: renderSetup };
  qs('#view').innerHTML = (views[currentView] || renderWorkspace)();
  wireDynamicButtons();
}

async function uploadImportFolder(files, provider) {
  const list = [...files];
  if (!list.length) return;
  const progress = qs('#importProgress');
  const start = await api('/imports/start', { method: 'POST', body: JSON.stringify({ provider, workspace_id: active.id }) });
  const rootName = list[0].webkitRelativePath?.split('/')[0] || '';
  let uploaded = 0;
  let uploadedBytes = 0;
  for (const file of list) {
    const original = file.webkitRelativePath || file.name;
    const relative = rootName && original.startsWith(`${rootName}/`) ? original.slice(rootName.length + 1) : original;
    progress.textContent = `Archiving ${uploaded + 1} of ${list.length}: ${relative}`;
    const response = await fetch(`${API}/imports/${encodeURIComponent(start.upload_id)}/file?path=${encodeURIComponent(relative)}`, { method: 'PUT', body: file });
    if (!response.ok) throw new Error(await response.text());
    uploaded += 1;
    uploadedBytes += file.size;
  }
  progress.textContent = `Parsing ${uploaded} files after preserving ${bytes(uploadedBytes)} of source data…`;
  const result = await api(`/imports/${encodeURIComponent(start.upload_id)}/finish`, { method: 'POST', body: '{}' });
  progress.textContent = `Import complete: ${result.raw_file_count} files preserved, ${result.parsed_message_count} messages parsed.`;
  active = await api(`/workspaces/${active.id}`);
  setTimeout(render, 700);
}

async function uploadProjectFiles(files) {
  const list = [...files].filter(file => file && file.size >= 0);
  if (!list.length) return;
  const progress = qs('#projectUploadProgress');
  let uploaded = 0;
  let uploadedBytes = 0;
  for (const file of list) {
    const displayName = file.webkitRelativePath || file.name;
    if (progress) progress.textContent = `Archiving ${uploaded + 1} of ${list.length}: ${displayName}`;
    const response = await fetch(`${API}/workspaces/${encodeURIComponent(active.id)}/artifacts?name=${encodeURIComponent(file.name || displayName)}&relative_path=${encodeURIComponent(displayName)}&mime_type=${encodeURIComponent(file.type || 'application/octet-stream')}`, { method: 'PUT', body: file });
    if (!response.ok) throw new Error(await response.text());
    uploaded += 1;
    uploadedBytes += Number(file.size || 0);
  }
  if (progress) progress.textContent = `Added ${uploaded} resource${uploaded === 1 ? '' : 's'} (${bytes(uploadedBytes)}) to ${active.name}.`;
  active = await api(`/workspaces/${active.id}`);
  setTimeout(render, 550);
}

function wireDynamicButtons() {
  document.querySelectorAll('[data-migrate-workspace]').forEach(button => button.addEventListener('click', async e => {
    const id = e.currentTarget.dataset.migrateWorkspace;
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Copying & verifying…';
    try {
      const result = await api(`/workspaces/${encodeURIComponent(id)}/migrate-managed-project`, { method: 'POST', body: '{}' });
      e.currentTarget.textContent = result.migrated ? 'Migrated' : result.status;
      managedMigrations = await api('/storage/managed-project-migrations');
      if (active?.id === id) active = await api(`/workspaces/${encodeURIComponent(id)}`);
      setTimeout(render, 500);
    } catch (error) { e.currentTarget.textContent = `Blocked: ${error.message}`; }
  }));

  qs('#pairCompanionButton')?.addEventListener('click', async e => {
    const button = e.currentTarget;
    const status = qs('#pairCompanionStatus');
    button.disabled = true;
    try {
      if (status) status.textContent = 'Creating one-time pairing challenge…';
      const challenge = await api('/companion/pairing-challenge', { method: 'POST', body: '{}' });
      const requestId = crypto.randomUUID();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('No loaded AI Harness extension answered the pairing request.')); }, 8000);
        const listener = event => {
          if (event.origin !== location.origin || event.data?.type !== 'aih-pair-result' || event.data.request_id !== requestId) return;
          clearTimeout(timer);
          window.removeEventListener('message', listener);
          event.data.ok ? resolve(event.data) : reject(new Error(event.data.error || 'Pairing failed'));
        };
        window.addEventListener('message', listener);
        window.postMessage({ type: 'aih-pair-request', request_id: requestId, challenge: challenge.challenge }, location.origin);
      });
      if (status) status.textContent = `Paired extension ${result.extension_id}. Refresh ChatGPT or Gemini.`;
      readiness = await api('/readiness');
      renderReadiness();
    } catch (error) {
      if (status) status.textContent = error.message;
    } finally { button.disabled = false; }
  });

  qs('#addProjectRoot')?.addEventListener('click', async () => {
    const folderPath = prompt('Paste the full path of the folder or repository to approve for this Project Space.');
    if (!folderPath?.trim()) return;
    const providerAllowed = confirm('Allow relevant non-secret material from this source to be sent to ChatGPT/Gemini? Choose Cancel to keep it local-only.');
    try {
      await api(`/workspaces/${encodeURIComponent(active.id)}/roots`, { method: 'POST', body: JSON.stringify({
        path: folderPath.trim(), root_kind: 'linked_folder', required_for_freshness: true, indexing_enabled: true,
        transmission_policy: providerAllowed ? 'provider_allowed' : 'local_only'
      }) });
      active = await api(`/workspaces/${encodeURIComponent(active.id)}`);
      renderIntegrity();
      render();
    } catch (error) { alert(`Could not add source: ${error.message}`); }
  });

  qs('#checkUpdatesButton')?.addEventListener('click', async e => {
    const button = e.currentTarget;
    const status = qs('#updateStatusText');
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Checking…';
    if (status) status.textContent = 'Checking GitHub for origin/main…';
    try {
      const result = await api('/update-status');
      if (result.error) {
        if (status) status.textContent = `${result.message} ${result.error}`;
      } else if (result.update_available) {
        if (status) status.innerHTML = `Update available: <strong>v${esc(result.remote_version || 'newer')}</strong>. Close Harness and use the <strong>AI Harness</strong> desktop/Start Menu shortcut to update and relaunch safely.`;
      } else {
        if (status) status.innerHTML = `<strong>${esc(result.message || 'AI Harness is up to date.')}</strong> Installed v${esc(result.current_version || health?.version || 'unknown')}.`;
      }
    } catch (error) {
      if (status) status.textContent = `Update check failed: ${error.message}`;
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });
  const dropZone = qs('#projectDropZone');
  const stopDrop = e => { e.preventDefault(); e.stopPropagation(); };
  if (dropZone) {
    ['dragenter','dragover'].forEach(type => dropZone.addEventListener(type, e => { stopDrop(e); dropZone.classList.add('dragging'); }));
    ['dragleave','drop'].forEach(type => dropZone.addEventListener(type, e => { stopDrop(e); dropZone.classList.remove('dragging'); }));
    dropZone.addEventListener('drop', async e => {
      try { await uploadProjectFiles(e.dataTransfer.files); }
      catch (error) { const p = qs('#projectUploadProgress'); if (p) p.textContent = `Upload failed: ${error.message}`; }
    });
  }
  qs('#projectFiles')?.addEventListener('change', async e => {
    try { await uploadProjectFiles(e.currentTarget.files); }
    catch (error) { const p = qs('#projectUploadProgress'); if (p) p.textContent = `Upload failed: ${error.message}`; }
    finally { e.currentTarget.value = ''; }
  });
  qs('#projectFolder')?.addEventListener('change', async e => {
    try { await uploadProjectFiles(e.currentTarget.files); }
    catch (error) { const p = qs('#projectUploadProgress'); if (p) p.textContent = `Upload failed: ${error.message}`; }
    finally { e.currentTarget.value = ''; }
  });
  document.querySelectorAll('[data-project-file-open]').forEach(button => button.addEventListener('click', e => {
    window.open(`${API}/workspace-files/${encodeURIComponent(e.currentTarget.dataset.projectFileOpen)}/content`, '_blank', 'noopener');
  }));
  document.querySelectorAll('[data-artifact-open]').forEach(button => button.addEventListener('click', e => {
    window.open(`${API}/artifacts/${encodeURIComponent(e.currentTarget.dataset.artifactOpen)}/content`, '_blank', 'noopener');
  }));
  qs('#openProjectFolder')?.addEventListener('click', async e => {
    const original = e.currentTarget.textContent;
    try {
      await api(`/workspaces/${encodeURIComponent(active.id)}/open-folder`, { method: 'POST', body: '{}' });
      e.currentTarget.textContent = 'Opened';
    } catch { e.currentTarget.textContent = 'Open failed'; }
    setTimeout(() => e.currentTarget.textContent = original, 1400);
  });
  qs('#attachProjectFolder')?.addEventListener('click', async e => {
    const folderPath = prompt('Paste the full path of the existing project folder to attach. The Harness will not move or delete it.', active.root_path || '');
    if (!folderPath?.trim()) return;
    const original = e.currentTarget.textContent;
    try {
      active = await api(`/workspaces/${encodeURIComponent(active.id)}/attach-folder`, { method: 'POST', body: JSON.stringify({ path: folderPath.trim() }) });
      e.currentTarget.textContent = 'Attached';
      setTimeout(render, 450);
    } catch (error) {
      alert(`Could not attach folder: ${error.message}`);
      e.currentTarget.textContent = 'Attach failed';
    }
    setTimeout(() => { if (document.body.contains(e.currentTarget)) e.currentTarget.textContent = original; }, 1400);
  });
  document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => window.open(button.dataset.open, '_blank', 'noopener')));
  qs('#openBoth')?.addEventListener('click', () => {
    const gpt = active.providers.find(p => p.provider === 'chatgpt')?.url || 'https://chatgpt.com/';
    const gem = active.providers.find(p => p.provider === 'gemini')?.url || 'https://gemini.google.com/';
    window.open(gpt, '_blank', 'noopener');
    window.open(gem, '_blank', 'noopener');
  });
  qs('#importFolder')?.addEventListener('change', async e => {
    const input = e.currentTarget;
    const provider = qs('#importProvider')?.value || 'chatgpt';
    const progress = qs('#importProgress');
    try {
      await uploadImportFolder(input.files, provider);
    } catch (error) {
      console.error(error);
      if (progress) progress.textContent = `Import failed: ${error.message}`;
    } finally {
      input.value = '';
    }
  });
  document.querySelectorAll('[data-session-context]').forEach(button => button.addEventListener('click', async e => {
    const id = e.currentTarget.dataset.sessionContext;
    const original = e.currentTarget.textContent;
    try {
      const packet = await api(`/sessions/${encodeURIComponent(id)}/context`);
      await navigator.clipboard.writeText(`[AI HARNESS ARCHIVED SESSION CONTEXT]\n${JSON.stringify(packet, null, 2)}\n[/AI HARNESS ARCHIVED SESSION CONTEXT]`);
      e.currentTarget.textContent = 'Copied';
    } catch { e.currentTarget.textContent = 'Copy failed'; }
    setTimeout(() => e.currentTarget.textContent = original, 1400);
  }));

  qs('#searchForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const q = qs('#searchInput').value.trim();
    if (!q) return;
    const results = await api(`/search?workspace_id=${encodeURIComponent(active.id)}&q=${encodeURIComponent(q)}&limit=30`);
    qs('#searchResults').innerHTML = results.map(r => `<div class="search-result"><div class="list-title">${esc(r.title)}</div><div class="list-sub">${esc(providerName(r.provider))} · ${esc(r.role)}</div><div class="result-text">${esc(r.content)}</div></div>`).join('') || '<div class="empty">No matching archived messages.</div>';
  });
}

qs('#workspaceSelect').addEventListener('change', async e => {
  active = await api('/active-workspace', { method: 'PUT', body: JSON.stringify({ workspace_id: e.target.value }) });
  renderIntegrity();
  render();
});

qs('#themeSelect').addEventListener('change', async e => {
  applyTheme(e.target.value);
  await api('/settings/theme', { method: 'PUT', body: JSON.stringify({ theme: e.target.value }) });
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (qs('#themeSelect').value === 'system') applyTheme('system');
});

qs('#nav').addEventListener('click', e => {
  const button = e.target.closest('[data-view]');
  if (!button) return;
  currentView = button.dataset.view;
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item === button));
  render();
});

qs('#contextButton').addEventListener('click', async () => {
  const runs = await api(`/workspaces/${encodeURIComponent(active.id)}/outgoing-context`);
  const packet = runs.length ? await api(`/outgoing-context/${encodeURIComponent(runs[0].id)}`) : { integrity: await api(`/workspaces/${encodeURIComponent(active.id)}/integrity`), note: 'No managed send has prepared an outgoing context envelope yet.' };
  qs('#contextJson').textContent = JSON.stringify(packet, null, 2);
  qs('#contextDialog').showModal();
});
qs('#closeDialog').addEventListener('click', () => qs('#contextDialog').close());

qs('#freshButton').addEventListener('click', async () => {
  const gpt = active.providers.find(p => p.provider === 'chatgpt');
  if (gpt) window.open(gpt.url, '_blank', 'noopener');
});

qs('#newWorkspaceButton').addEventListener('click', () => {
  qs('#workspaceName').value = '';
  qs('#workspaceFocus').value = '';
  qs('#workspaceDialog').showModal();
  setTimeout(() => qs('#workspaceName').focus(), 30);
});
qs('#closeWorkspaceDialog').addEventListener('click', () => qs('#workspaceDialog').close());
qs('#cancelWorkspaceButton').addEventListener('click', () => qs('#workspaceDialog').close());
qs('#workspaceForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = qs('#workspaceName').value.trim();
  if (!name) return;
  const created = await api('/workspaces', { method: 'POST', body: JSON.stringify({
    name, kind: 'general', active_focus: qs('#workspaceFocus').value.trim()
  }) });
  workspaces = await api('/workspaces');
  active = await api('/active-workspace', { method: 'PUT', body: JSON.stringify({ workspace_id: created.id }) });
  renderWorkspaceSelect();
  renderIntegrity();
  qs('#workspaceDialog').close();
  currentView = 'workspace';
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === 'workspace'));
  render();
});

load().catch(error => {
  console.error(error);
  qs('#view').innerHTML = `<div class="card"><h2>Harness service unavailable</h2><p class="lede">${esc(error.message)}</p></div>`;
});
