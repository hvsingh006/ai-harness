const API = 'http://127.0.0.1:4317/api';
let workspaces = [];
let active = null;
let currentView = 'workspace';
let readiness = null;
let health = null;

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
  return ({ chatgpt: 'ChatGPT', gemini: 'Gemini', notebooklm: 'NotebookLM' })[provider] || provider;
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
  const [settings, ws, ready, serviceHealth] = await Promise.all([api('/settings'), api('/workspaces'), api('/readiness'), api('/health')]);
  readiness = ready;
  health = serviceHealth;
  workspaces = ws;
  qs('#themeSelect').value = settings.theme || 'system';
  applyTheme(settings.theme || 'system');
  active = await api('/active-workspace');
  renderWorkspaceSelect();
  renderReadiness();
  render();
  setInterval(async () => {
    try { readiness = await api('/readiness'); renderReadiness(); } catch {}
  }, 10000);
}

function renderReadiness() {
  const el = qs('#readyStatus');
  if (!el || !readiness) return;
  el.classList.toggle('ready', Boolean(readiness.ready_for_native_workflow));
  el.querySelector('span:last-child').textContent = readiness.ready_for_native_workflow ? 'Harness ready' : 'Install/open companion';
  el.title = readiness.ready_for_native_workflow ? `Browser companion ${readiness.browser_companion_version || ''} seen ${readiness.browser_companion_last_seen || ''}` : 'The local service is running, but the browser companion has not checked in yet.';
}

function renderWorkspaceSelect() {
  qs('#workspaceSelect').innerHTML = workspaces.map(w => `<option value="${esc(w.id)}" ${active?.id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
}

function providerButtons() {
  const links = active?.providers || [];
  const preferred = ['chatgpt', 'gemini', 'notebooklm'];
  const sorted = [...links].sort((a,b) => preferred.indexOf(a.provider) - preferred.indexOf(b.provider));
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
  const items = (active.artifacts || []).slice(0, 18);
  return `
    <div class="card project-resources-card">
      <div class="section-title"><div><div class="eyebrow">PROJECT RESOURCES</div><h2>Files live with the workspace</h2></div><span class="badge">${esc((active.artifacts || []).length)} resources</span></div>
      <p class="lede">Drop course documents, PDFs, images, screenshots, datasets, design files, notes, or other project material here once. They become canonical workspace resources that can be retrieved into future ChatGPT, Gemini, NotebookLM, and coding-tool sessions.</p>
      <div id="projectDropZone" class="drop-zone" tabindex="0">
        <div class="drop-zone-title">Drop files here</div>
        <div class="list-sub">or choose files / a folder. Originals are copied into the lossless vault.</div>
        <div class="drop-actions">
          <label class="file-picker">Add files<input id="projectFiles" type="file" multiple></label>
          <label class="file-picker secondary-picker">Add folder<input id="projectFolder" type="file" webkitdirectory directory multiple></label>
        </div>
        <div id="projectUploadProgress" class="upload-progress"></div>
      </div>
      <div class="resource-grid">${items.map(item => `
        <article class="resource-card">
          <div class="resource-type">${esc(resourceIcon(item))}</div>
          <div class="resource-body"><div class="resource-name" title="${esc(item.name)}">${esc(item.name)}</div><div class="list-sub">${esc(bytes(item.size_bytes))} · ${esc(item.provider || 'local')}</div></div>
          <button class="tiny-button" data-artifact-open="${esc(item.id)}">Open</button>
        </article>`).join('') || '<div class="empty">No project resources yet. Drag in the material you are actually working from.</div>'}</div>
    </div>`;
}

function renderWorkspace() {
  const archive = active.archive || {};
  const openTasks = (active.tasks || []).filter(t => t.status === 'open');
  const recent = (active.sessions || []).slice(0, 6);
  return `
    <div class="hero">
      <div class="card">
        <div class="eyebrow">${esc(active.kind.toUpperCase())} WORKSPACE</div>
        <h2>${esc(active.name)}</h2>
        <p class="lede">${esc(active.description)}</p>
        <div class="focus"><strong>CURRENT WORKING STATE</strong>${esc(active.active_focus || 'No active focus yet.')}</div>
        <div class="principle"><strong>Collaboration principle</strong><span>Use AI to increase output and understanding, not to remove the reasoning you should be practicing.</span></div>
      </div>
      <div class="card">
        <div class="section-title"><h3>Native AI surfaces</h3><span class="badge">same workspace</span></div>
        <div class="provider-actions">${providerButtons()}</div>
      </div>
    </div>
    ${renderProjectResources()}
    <div class="metric-grid">
      ${metric('raw messages archived', archive.messages || 0)}
      ${metric('canonical artifacts', archive.artifacts || 0, bytes(archive.artifact_bytes || 0))}
      ${metric('sessions retained', archive.sessions || 0)}
      ${metric('safe to delete', archive.safe_sessions || 0, `${archive.incomplete_sessions || 0} incomplete`)}
    </div>
    <div class="two-col">
      <div class="card">
        <div class="section-title"><h3>Next actions</h3><span class="badge">working state</span></div>
        <div class="list">${openTasks.slice(0, 7).map(t => `
          <div class="list-row"><div><div class="list-title">${esc(t.title)}</div><div class="list-sub">${esc(t.details)}</div></div><span class="badge">P${esc(t.priority)}</span></div>`).join('') || '<div class="empty">No open next actions.</div>'}</div>
      </div>
      <div class="card">
        <div class="section-title"><h3>Recent native sessions</h3><span class="badge">disposable surfaces</span></div>
        <div class="list">${recent.map(s => `
          <div class="list-row"><div><div class="list-title">${esc(s.title)}</div><div class="list-sub">${esc(providerName(s.provider))} · ${esc(s.message_count)} messages<br>${esc(s.summary || 'Raw session retained; derived summary not yet available.')}</div></div>${statusBadge(s.capture_status)}</div>`).join('') || '<div class="empty">No captured sessions yet.</div>'}</div>
      </div>
    </div>`;
}

function renderLearning() {
  return `
    <div class="card" style="margin-bottom:18px">
      <div class="eyebrow">ACTIVE LEARNING</div>
      <h2>Continuity should improve understanding, not automate it away</h2>
      <p class="lede">The workspace carries course sources, prior attempts, misconceptions, mastery evidence, and unfinished questions into ChatGPT, Gemini, NotebookLM, or a future provider. The default handoff asks native AIs to favor recall, hints, questions, and explanation checks before full solutions when the goal is learning.</p>
    </div>
    <div class="two-col">
      <div class="card">
        <div class="section-title"><h3>Knowledge state</h3><span class="badge">evidence over confidence</span></div>
        <div class="list">${(active.learning || []).map(item => `
          <div class="list-row"><div><div class="list-title">${esc(item.title)}</div><div class="list-sub">${esc(item.details)}${item.attempt_count ? `<br>${esc(item.attempt_count)} recorded attempts` : ''}</div><div class="progress"><span style="width:${Math.round(Number(item.mastery || 0)*100)}%"></span></div></div><span class="badge">${Math.round(Number(item.mastery || 0)*100)}%</span></div>`).join('') || '<div class="empty">No learning evidence yet. This is expected in the harness-development workspace.</div>'}</div>
      </div>
      <div class="card">
        <h3>Learning loop</h3>
        <ol class="flow-list">
          <li><strong>Attempt</strong><span>You first retrieve, derive, predict, or implement.</span></li>
          <li><strong>Feedback</strong><span>The AI checks reasoning and points to gaps.</span></li>
          <li><strong>Repair</strong><span>Use hints, sources, or a targeted explanation.</span></li>
          <li><strong>Verify</strong><span>Explain or solve a fresh case without the answer in view.</span></li>
          <li><strong>Carry forward</strong><span>The next AI knows what you actually demonstrated.</span></li>
        </ol>
      </div>
    </div>`;
}

function renderDevelopment() {
  return `
    <div class="card" style="margin-bottom:18px">
      <div class="eyebrow">DEVELOPMENT CONTINUITY</div>
      <h2>Repository state and reasoning survive model changes</h2>
      <p class="lede">The harness archives the implementation record and maintains a compact current state: objective, requirements, architecture, relevant files, experiments, failures, technical decisions, blockers, and next actions.</p>
    </div>
    <div class="two-col">
      <div class="card"><div class="section-title"><h3>Project state</h3><span class="badge">provider neutral</span></div><div class="list">${(active.development || []).map(item => `<div class="list-row"><div><div class="list-title">${esc(item.title)}</div><div class="list-sub">${esc(item.details)}</div></div>${statusBadge(item.status)}</div>`).join('') || '<div class="empty">No development state recorded in this workspace yet.</div>'}</div></div>
      <div class="card"><h3>Critical-thinking boundary</h3><div class="callout" style="margin-top:12px">Models can implement, debug, research, and compare approaches. Product requirements, important architectural tradeoffs, and uncertain assumptions stay visible and attributable so you can evaluate them rather than inheriting opaque AI decisions.</div></div>
    </div>
    <div class="card" style="margin-top:18px">
      <div class="section-title"><div><div class="eyebrow">FUTURE CODING TOOLS</div><h3>Attach agents to the same project state</h3></div><span class="badge">planned adapter</span></div>
      <p class="lede">Codex and other coding agents should receive repository identity, branch/commit state, requirements, relevant project resources, prior technical decisions, and current blockers. Their task IDs, patches, commits, tests, and pull requests then return to the Harness as traceable project evidence.</p>
    </div>`;
}

function renderSessions() {
  return `
    <div class="card">
      <div class="section-title"><div><div class="eyebrow">SESSION ARCHIVE</div><h2>Native chats are replaceable</h2></div><span class="badge">${esc((active.sessions || []).length)} sessions</span></div>
      <div class="list">${(active.sessions || []).map(s => `
        <div class="list-row session-row" data-session="${esc(s.id)}"><div><div class="list-title">${esc(s.display_label || s.title)}</div><div class="list-sub">${esc(s.title)}<br>${esc(providerName(s.provider))} · ${esc(s.message_count)} messages · ${esc(s.started_at || '')}<br>raw ${s.raw_complete ? '✓' : '…'} · attachments ${s.attachments_complete ? '✓' : '…'} · derived state ${s.derived_complete ? '✓' : '…'}</div><div class="session-actions">${s.native_url ? `<button class="tiny-button" data-open="${esc(s.native_url)}">Open native chat ↗</button>` : ''}<button class="tiny-button" data-session-context="${esc(s.id)}">Copy chat context</button></div></div>${statusBadge(s.capture_status)}</div>`).join('') || '<div class="empty">No sessions captured.</div>'}</div>
    </div>`;
}

function renderArchive() {
  const a = active.archive || {};
  return `
    <div class="card" style="margin-bottom:18px">
      <div class="eyebrow">LOSSLESS ARCHIVE</div>
      <h2>Originals are preserved before anything is summarized</h2>
      <p class="lede">The vault stores exact provider exports and copied artifacts by SHA-256. Parsed messages, summaries, learning state, and decisions are derivative indexes. A parser can be rebuilt without losing the underlying source.</p>
    </div>
    <div class="metric-grid">
      ${metric('messages', a.messages || 0)}
      ${metric('artifacts', a.artifacts || 0)}
      ${metric('vault size', bytes(a.artifact_bytes || 0))}
      ${metric('imports', a.imports || 0)}
    </div>
    <div class="two-col">
      <div class="card">
        <div class="section-title"><h3>Historical imports</h3><span class="badge">raw first</span></div>
        <div class="import-box">
          <div class="import-controls">
            <select id="importProvider"><option value="chatgpt">ChatGPT export</option><option value="gemini">Gemini / Google export</option><option value="notebooklm">NotebookLM export</option><option value="generic">Other provider</option></select>
            <label class="file-picker">Choose extracted export folder<input id="importFolder" type="file" webkitdirectory directory multiple></label>
          </div>
          <div id="importProgress" class="list-sub">Select the folder you extracted from the provider's export ZIP. The harness copies every file into the vault before parsing.</div>
        </div>
        <div class="list">${(active.imports || []).map(i => `<div class="list-row"><div><div class="list-title">${esc(providerName(i.provider))} · ${esc(i.import_type)}</div><div class="list-sub">${esc(i.raw_file_count)} raw files · ${esc(i.parsed_message_count)} parsed messages · ${esc(i.artifact_count)} artifacts<br>${esc(i.source_path)}</div></div>${statusBadge(i.status)}</div>`).join('') || '<div class="empty">No provider exports imported yet.</div>'}</div>
      </div>
      <div class="card">
        <div class="section-title"><h3>Search the complete archive</h3><span class="badge">not summaries</span></div>
        <form id="searchForm" class="search-form"><input id="searchInput" placeholder="Search exact prior discussions…" autocomplete="off"><button class="primary">Search</button></form>
        <div id="searchResults" class="list"><div class="empty">Search archived raw messages across providers.</div></div>
      </div>
    </div>`;
}

function renderKnowledge() {
  return `
    <div class="two-col">
      <div class="card"><div class="section-title"><h3>Durable context</h3><span class="badge">derived + sourced</span></div><div class="list">${(active.memories || []).map(m => `<div class="list-row"><div><div class="list-title">${esc(m.category.replaceAll('_',' '))}</div><div class="list-sub">${esc(m.content)}<br>source: ${esc(m.source_ref || m.source_type)}</div></div><span class="badge">${esc(m.scope)}</span></div>`).join('') || '<div class="empty">No durable memory.</div>'}</div></div>
      <div class="card"><div class="section-title"><h3>Decisions</h3><span class="badge">reasoning retained</span></div><div class="list">${(active.decisions || []).map(d => `<div class="list-row"><div><div class="list-title">${esc(d.title)}</div><div class="list-sub">${esc(d.decision)}<br>${esc(d.rationale)}</div></div></div>`).join('') || '<div class="empty">No formal decisions recorded yet.</div>'}</div></div>
    </div>`;
}

function renderIntegrations() {
  return `<div class="card" style="margin-bottom:18px"><div class="eyebrow">RESOURCE POLICY</div><h2>Use the evidence, not just the summary</h2><p class="lede">Fresh AI sessions are instructed to use relevant user prompts, prior model responses, full archive search, files, PDFs, images, notebook sources, native tools, and current web research. If the corpus is too large, context is retrieved progressively while the complete archive remains intact.</p></div><div class="integrations">
    <div class="card integration-card"><h3>ChatGPT</h3><div class="status">Native surface</div><p>Use the real ChatGPT interface and features. The companion handles workspace context and capture. Historical exports can seed the archive.</p><a href="https://chatgpt.com/" target="_blank">Open ChatGPT ↗</a></div>
    <div class="card integration-card"><h3>Gemini</h3><div class="status">Native surface</div><p>Use Gemini chats, notebooks, learning and research features while keeping the canonical archive provider-neutral.</p><a href="https://gemini.google.com/" target="_blank">Open Gemini ↗</a></div>
    <div class="card integration-card"><h3>NotebookLM</h3><div class="status">Native learning surface</div><p>Notebook sources and notebook context stay useful natively while the harness records source inventories and cross-provider learning state.</p><a href="https://notebooklm.google.com/" target="_blank">Open NotebookLM ↗</a></div>
  </div>`;
}

function renderSetup() {
  const companion = Boolean(readiness?.browser_companion_seen);
  const service = Boolean(health?.ok);
  const checks = [
    ['Local Harness service', service, service ? `v${health.version}` : 'not responding'],
    ['SQLite archive', service, service ? `${health.archive?.messages || 0} messages indexed` : 'waiting for service'],
    ['Browser companion', companion, companion ? `v${readiness.browser_companion_version || 'unknown'} connected` : 'load the unpacked extension and refresh an AI tab'],
    ['Active project space', Boolean(active?.id), active?.name || 'create a project'],
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
          <li>Return here and confirm the session appears under <strong>Sessions</strong>.</li>
          <li>Start a fresh chat in the other AI service and use <strong>Insert workspace context</strong> in the companion.</li>
          <li>Ask the second AI to identify the workspace objective/resource list. It should continue without you restating them.</li>
          <li>Do not delete either native chat yet unless its session status explicitly says <strong>safe to delete</strong>.</li>
        </ol>
      </div>
    </div>
    <div class="card" style="margin-top:18px">
      <div class="section-title"><h3>Browser companion installation</h3><span class="badge">Chrome / Edge</span></div>
      <div class="callout">Open the browser extensions page, enable Developer mode, choose <strong>Load unpacked</strong>, and select this repository's <code>extension</code> folder. After any extension update, press Reload on the extension and refresh ChatGPT/Gemini/NotebookLM.</div>
      <p class="lede">Windows shortcut: double-click <code>start-harness.cmd</code> to start the service and open this dashboard. Run <code>npm run doctor</code> if something is not connecting.</p>
    </div>`;
}

function render() {
  if (!active) return;
  const views = { workspace: renderWorkspace, learning: renderLearning, development: renderDevelopment, sessions: renderSessions, archive: renderArchive, knowledge: renderKnowledge, integrations: renderIntegrations, setup: renderSetup };
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
    const response = await fetch(`${API}/workspaces/${encodeURIComponent(active.id)}/artifacts?name=${encodeURIComponent(displayName)}&mime_type=${encodeURIComponent(file.type || 'application/octet-stream')}`, { method: 'PUT', body: file });
    if (!response.ok) throw new Error(await response.text());
    uploaded += 1;
    uploadedBytes += Number(file.size || 0);
  }
  if (progress) progress.textContent = `Added ${uploaded} resource${uploaded === 1 ? '' : 's'} (${bytes(uploadedBytes)}) to ${active.name}.`;
  active = await api(`/workspaces/${active.id}`);
  setTimeout(render, 550);
}

function wireDynamicButtons() {
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
  document.querySelectorAll('[data-artifact-open]').forEach(button => button.addEventListener('click', e => {
    window.open(`${API}/artifacts/${encodeURIComponent(e.currentTarget.dataset.artifactOpen)}/content`, '_blank', 'noopener');
  }));
  document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => window.open(button.dataset.open, '_blank', 'noopener')));
  qs('#openBoth')?.addEventListener('click', () => {
    const gpt = active.providers.find(p => p.provider === 'chatgpt')?.url || 'https://chatgpt.com/';
    const gem = active.providers.find(p => p.provider === 'gemini')?.url || 'https://gemini.google.com/';
    window.open(gpt, '_blank', 'noopener');
    window.open(gem, '_blank', 'noopener');
  });
  qs('#importFolder')?.addEventListener('change', async e => {
    const input = e.currentTarget;
    const provider = qs('#importProvider')?.value || 'generic';
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
  const packet = await api(`/workspaces/${active.id}/context`);
  qs('#contextJson').textContent = JSON.stringify(packet, null, 2);
  qs('#contextDialog').showModal();
});
qs('#closeDialog').addEventListener('click', () => qs('#contextDialog').close());

qs('#freshButton').addEventListener('click', async () => {
  const packet = await api(`/workspaces/${active.id}/context`);
  await navigator.clipboard.writeText(`WORKSPACE HANDOFF CONTEXT\n\n${JSON.stringify(packet, null, 2)}`);
  const gpt = active.providers.find(p => p.provider === 'chatgpt');
  if (gpt) window.open(gpt.url, '_blank', 'noopener');
  alert('Workspace context copied. The browser companion can insert it into the fresh native chat.');
});

qs('#newWorkspaceButton').addEventListener('click', () => {
  qs('#workspaceName').value = '';
  qs('#workspaceKind').value = 'mixed';
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
    name, kind: qs('#workspaceKind').value, active_focus: qs('#workspaceFocus').value.trim()
  }) });
  workspaces = await api('/workspaces');
  active = await api('/active-workspace', { method: 'PUT', body: JSON.stringify({ workspace_id: created.id }) });
  renderWorkspaceSelect();
  qs('#workspaceDialog').close();
  currentView = 'workspace';
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === 'workspace'));
  render();
});

load().catch(error => {
  console.error(error);
  qs('#view').innerHTML = `<div class="card"><h2>Harness service unavailable</h2><p class="lede">${esc(error.message)}</p></div>`;
});
