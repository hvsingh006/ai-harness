import { rows } from './db.mjs';

export class SemanticRetriever {
  constructor({ id = 'none', available = false } = {}) {
    this.id = id;
    this.available = Boolean(available);
  }

  retrieve() { return []; }
}

export const noSemanticRetriever = Object.freeze(new SemanticRetriever());

const HIGH_AUTHORITY_SOURCE_TYPES = new Set(['file','pdf','repository_file','decision','memory','project_instruction']);

function evidenceClass(candidate) {
  if (candidate.source_type === 'ocr_text') return 'visual_ocr';
  if (candidate.source_type === 'chat_message') return candidate.provenance?.path_status === 'alternate' ? 'historical' : 'conversation';
  if (['file','pdf','repository_file','attached_resource'].includes(candidate.source_type)) return candidate.provenance?.knowledge_status && candidate.provenance.knowledge_status !== 'active' ? 'historical' : 'authoritative_source';
  return 'structured';
}

function queryTerms(query) {
  return [...new Set(String(query || '').toLowerCase().match(/[a-z0-9_./-]{2,}/g) || [])].slice(0, 16);
}

function lexicalScore(text, terms) {
  const lower = String(text || '').toLowerCase();
  let score = 0;
  for (const term of terms) {
    let index = lower.indexOf(term);
    if (index < 0) continue;
    score += 12;
    while ((index = lower.indexOf(term, index + term.length)) >= 0) score += 2;
  }
  return score;
}

function ftsQuery(terms) {
  return terms.map(term => `"${term.replaceAll('"', '""')}"*`).join(' OR ');
}

function resourceCandidates(db, workspaceId, terms, includeHistorical = false) {
  let candidates = [];
  if (terms.length) {
    try {
      candidates = rows(db, `SELECT f.chunk_id,f.path,f.content,bm25(resource_chunk_fts) AS rank,c.resource_id,c.resource_version_id,c.line_start,c.line_end,c.page_start,c.page_end,c.representation_id,c.source_kind,c.authority,c.confidence,c.region_json,
        r.mime_type,r.resource_type,r.source_type,r.origin_json,r.priority_status,r.knowledge_status,r.context_critical,v.sha256,v.observed_at,wr.label AS root_label,
        rs.branch AS repository_branch,rs.head_commit AS repository_head,rs.dirty AS repository_dirty,rs.observed_at AS repository_observed_at
        FROM resource_chunk_fts f
        JOIN resource_chunks c ON c.id=f.chunk_id
        JOIN workspace_resources r ON r.id=c.resource_id AND r.current_version_id=f.version_id AND r.status='active'
        JOIN resource_versions v ON v.id=f.version_id
        JOIN workspace_roots wr ON wr.id=r.root_id
        LEFT JOIN repository_states rs ON rs.id=(SELECT id FROM repository_states WHERE root_id=wr.id ORDER BY observed_at DESC LIMIT 1)
        WHERE f.workspace_id=? AND resource_chunk_fts MATCH ? AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1 AND wr.status='current'
          AND (r.knowledge_status='active' OR ?=1)
        ORDER BY rank LIMIT 80`, workspaceId, ftsQuery(terms), includeHistorical ? 1 : 0);
    } catch {
      const conditions = terms.map(() => '(LOWER(r.relative_path) LIKE ? OR LOWER(c.content) LIKE ?)').join(' OR ');
      const parameters = terms.flatMap(term => [`%${term}%`, `%${term}%`]);
      candidates = rows(db, `SELECT c.id AS chunk_id,r.relative_path AS path,c.content,0 AS rank,c.resource_id,c.resource_version_id,c.line_start,c.line_end,c.page_start,c.page_end,c.representation_id,c.source_kind,c.authority,c.confidence,c.region_json,
        r.mime_type,r.resource_type,r.source_type,r.origin_json,r.priority_status,r.knowledge_status,r.context_critical,v.sha256,v.observed_at,wr.label AS root_label,
        rs.branch AS repository_branch,rs.head_commit AS repository_head,rs.dirty AS repository_dirty,rs.observed_at AS repository_observed_at
        FROM resource_chunks c
        JOIN workspace_resources r ON r.id=c.resource_id AND r.current_version_id=c.resource_version_id AND r.status='active'
        JOIN resource_versions v ON v.id=c.resource_version_id
        JOIN workspace_roots wr ON wr.id=r.root_id
        LEFT JOIN repository_states rs ON rs.id=(SELECT id FROM repository_states WHERE root_id=wr.id ORDER BY observed_at DESC LIMIT 1)
        WHERE c.workspace_id=? AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1 AND wr.status='current' AND (r.knowledge_status='active' OR ?=1)
          AND (${conditions})
        ORDER BY v.observed_at DESC LIMIT 80`, workspaceId, includeHistorical ? 1 : 0, ...parameters);
    }
  }
  const currentBaseline = rows(db, `SELECT c.id AS chunk_id,r.relative_path AS path,c.content,c.resource_id,c.resource_version_id,c.line_start,c.line_end,c.page_start,c.page_end,c.representation_id,c.source_kind,c.authority,c.confidence,c.region_json,
      r.mime_type,r.resource_type,r.source_type,r.origin_json,r.priority_status,r.knowledge_status,r.context_critical,v.sha256,v.observed_at,wr.label AS root_label,0 AS rank,
      rs.branch AS repository_branch,rs.head_commit AS repository_head,rs.dirty AS repository_dirty,rs.observed_at AS repository_observed_at
    FROM workspace_resources r
    JOIN workspace_roots wr ON wr.id=r.root_id
    JOIN resource_versions v ON v.id=r.current_version_id
    JOIN resource_chunks c ON c.resource_version_id=v.id
    LEFT JOIN repository_states rs ON rs.id=(SELECT id FROM repository_states WHERE root_id=wr.id ORDER BY observed_at DESC LIMIT 1)
    WHERE r.workspace_id=? AND r.status='active' AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1 AND wr.status='current'
      AND (r.knowledge_status='active' OR ?=1)
    ORDER BY v.observed_at DESC,c.ordinal LIMIT 30`, workspaceId, includeHistorical ? 1 : 0);
  const alwaysConsider = rows(db, `SELECT c.id AS chunk_id,r.relative_path AS path,c.content,c.resource_id,c.resource_version_id,c.line_start,c.line_end,c.page_start,c.page_end,c.representation_id,c.source_kind,c.authority,c.confidence,c.region_json,
      r.mime_type,r.resource_type,r.source_type,r.origin_json,r.priority_status,r.knowledge_status,r.context_critical,v.sha256,v.observed_at,wr.label AS root_label,0 AS rank,
      rs.branch AS repository_branch,rs.head_commit AS repository_head,rs.dirty AS repository_dirty,rs.observed_at AS repository_observed_at
    FROM workspace_resources r
    JOIN workspace_roots wr ON wr.id=r.root_id
    JOIN resource_versions v ON v.id=r.current_version_id
    JOIN resource_chunks c ON c.resource_version_id=v.id
    LEFT JOIN repository_states rs ON rs.id=(SELECT id FROM repository_states WHERE root_id=wr.id ORDER BY observed_at DESC LIMIT 1)
    WHERE r.workspace_id=? AND r.status='active' AND r.knowledge_status='active' AND (r.priority_status='priority' OR r.context_critical=1)
      AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1 AND wr.status='current'
    ORDER BY r.context_critical DESC,r.updated_at DESC,c.ordinal LIMIT 24`, workspaceId);
  const merged = new Map();
  for (const item of [...candidates, ...currentBaseline, ...alwaysConsider]) merged.set(item.chunk_id, item);
  return [...merged.values()].map(item => ({
    source_type: item.source_kind === 'ocr_text' ? 'ocr_text' : item.resource_type === 'pdf' ? 'pdf' : item.resource_type === 'code' ? 'repository_file' : 'file',
    source_id: item.resource_id,
    resource_version_id: item.resource_version_id,
    chunk_id: item.chunk_id,
    representation_id: item.representation_id || null,
    content: item.content,
    score: 55 + lexicalScore(`${item.path}\n${item.content}`, terms) + (String(item.path).toLowerCase().includes(terms.join(' ')) ? 20 : 0) + (item.source_kind === 'ocr_text' ? -7 : 0)
      + (item.priority_status === 'priority' ? 45 : 0) + (item.context_critical ? 24 : 0) + (item.knowledge_status === 'active' ? 0 : -80),
    selection_reason: item.priority_status === 'priority' ? 'priority context from current verified resource version' : item.source_kind === 'ocr_text' ? 'current OCR evidence from verified resource version' : 'current verified resource version',
    provenance: { path: item.path, root: item.root_label, sha256: item.sha256, observed_at: item.observed_at, line_start: item.line_start, line_end: item.line_end, page_start: item.page_start, page_end: item.page_end, representation_id: item.representation_id || null, representation_kind: item.source_kind || 'digital_text', authority: item.authority || 'source_derived', confidence: item.confidence, region: JSON.parse(item.region_json || '{}'), current_version: true, source_type: item.source_type, origin: JSON.parse(item.origin_json || '{}'), priority_status: item.priority_status, knowledge_status: item.knowledge_status, context_critical: Boolean(item.context_critical), repository: item.repository_head ? { branch: item.repository_branch || '', head: item.repository_head, dirty: Boolean(item.repository_dirty), observed_at: item.repository_observed_at } : null }
  }));
}

function relationshipCandidates(db, workspaceId, terms, currentSessionId, query, includeHistorical = false) {
  const deictic = /\b(this|that|the)\s+(pdf|file|image|screenshot|diagram)|\b(image|file)\s+(above|attached)|\bjust attached\b|\bpasted earlier\b/i.test(String(query || ''));
  const items = rows(db, `SELECT sa.id AS asset_id,sa.session_id,sa.provider,sa.name,sa.origin_kind,sa.capture_method,sa.originating_provider_message_id,sa.created_at,
      r.id AS resource_id,r.relative_path,r.source_type,r.origin_json,r.current_version_id,sa.resource_version_id AS attached_version_id,c.id AS chunk_id,c.content,c.source_kind,c.representation_id,c.page_start,c.page_end,v.sha256
    FROM session_assets sa
    JOIN sessions s ON s.id=sa.session_id
    JOIN workspace_resources r ON r.id=sa.resource_id AND r.status='active'
    JOIN workspace_roots wr ON wr.id=r.root_id
    JOIN resource_versions v ON v.id=r.current_version_id
    LEFT JOIN resource_chunks c ON c.resource_version_id=v.id
    WHERE s.workspace_id=? AND sa.mirror_status='CAPTURED' AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1 AND wr.status='current'
      AND (r.knowledge_status='active' OR ?=1)
    ORDER BY CASE WHEN sa.session_id=? THEN 0 ELSE 1 END,sa.created_at DESC,c.ordinal LIMIT 80`, workspaceId, includeHistorical ? 1 : 0, currentSessionId || '');
  return items.filter(item => item.content).map(item => ({
    source_type: item.source_kind === 'ocr_text' ? 'ocr_text' : 'attached_resource',
    source_id: item.resource_id,
    resource_version_id: item.current_version_id,
    chunk_id: item.chunk_id,
    representation_id: item.representation_id || null,
    content: item.content,
    score: 72 + lexicalScore(`${item.name}\n${item.content}`, terms) + (item.session_id === currentSessionId ? 28 : 0) + (deictic ? 34 : 0) + (item.origin_kind === 'user_input' ? 12 : 0),
    selection_reason: deictic ? 'recent native-chat attachment relationship resolves conversational reference' : 'durable native-chat resource relationship',
    provenance: { provider: item.provider, session_id: item.session_id, session_asset_id: item.asset_id, originating_provider_message_id: item.originating_provider_message_id, origin_kind: item.origin_kind, capture_method: item.capture_method, original_name: item.name, path: item.relative_path, sha256: item.sha256, source_type: item.source_type, origin: JSON.parse(item.origin_json || '{}'), attached_version_id: item.attached_version_id, page_start: item.page_start, page_end: item.page_end, current_version: true }
  }));
}

function messageCandidates(db, workspaceId, terms, targetProvider, currentSessionId) {
  let matches = [];
  if (terms.length) {
    try {
      matches = rows(db, `SELECT f.message_id,f.session_id,f.provider,f.title,f.role,f.content,bm25(message_fts) AS rank,s.started_at,m.created_at,
        m.provider_message_id,m.parent_provider_message_id,m.path_status,m.last_seen_in_capture_at,m.content_hash
        FROM message_fts f JOIN messages m ON m.id=f.message_id JOIN sessions s ON s.id=f.session_id
        WHERE f.workspace_id=? AND message_fts MATCH ? ORDER BY rank LIMIT 100`, workspaceId, ftsQuery(terms));
    } catch {
      const conditions = terms.map(() => "LOWER(COALESCE(NULLIF(m.clean_content_text,''),m.content_text)) LIKE ?").join(' OR ');
      const parameters = terms.map(term => `%${term}%`);
      matches = rows(db, `SELECT m.id AS message_id,m.session_id,s.provider,s.title,m.role,COALESCE(NULLIF(m.clean_content_text,''),m.content_text) AS content,0 AS rank,s.started_at,m.created_at,
        m.provider_message_id,m.parent_provider_message_id,m.path_status,m.last_seen_in_capture_at,m.content_hash
        FROM messages m JOIN sessions s ON s.id=m.session_id
        WHERE s.workspace_id=? AND (${conditions})
        ORDER BY COALESCE(m.created_at,s.started_at) DESC LIMIT 100`, workspaceId, ...parameters);
    }
  }
  const recent = rows(db, `SELECT m.id AS message_id,m.session_id,s.provider,s.title,m.role,COALESCE(NULLIF(m.clean_content_text,''),m.content_text) AS content,0 AS rank,s.started_at,m.created_at,
      m.provider_message_id,m.parent_provider_message_id,m.path_status,m.last_seen_in_capture_at,m.content_hash
    FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.workspace_id=?
    ORDER BY COALESCE(m.created_at,s.started_at) DESC LIMIT 40`, workspaceId);
  const merged = new Map();
  for (const item of [...matches, ...recent]) merged.set(item.message_id, item);
  const now = Date.now();
  return [...merged.values()].map(item => {
    const ageDays = Math.max(0, (now - Date.parse(item.created_at || item.started_at || 0)) / 86400000);
    const recency = Math.max(0, 18 - Math.log2(ageDays + 1) * 3);
    const roleWeight = item.role === 'user' ? 48 : item.role === 'assistant' ? 6 : 4;
    const crossProvider = item.provider && item.provider !== targetProvider ? 8 : 0;
    const currentSession = item.session_id === currentSessionId ? 10 : 0;
    const visiblePath = item.path_status === 'visible' ? 16 : item.path_status === 'alternate' ? -16 : 0;
    return {
      source_type: 'chat_message',
      source_id: item.message_id,
      content: item.content,
      score: 28 + lexicalScore(item.content, terms) + roleWeight + recency + crossProvider + currentSession + visiblePath,
      selection_reason: item.path_status === 'visible' ? 'retained evidence on the currently visible provider conversation path' : item.path_status === 'alternate' ? 'retained alternate provider conversation branch' : item.role === 'user' ? 'retained user reasoning' : 'retained provider evidence',
      provenance: { provider: item.provider, session_id: item.session_id, title: item.title, role: item.role, created_at: item.created_at || item.started_at, current_session: item.session_id === currentSessionId, provider_message_id: item.provider_message_id || '', parent_provider_message_id: item.parent_provider_message_id || '', path_status: item.path_status || 'unknown', last_seen_in_capture_at: item.last_seen_in_capture_at || '', content_hash: item.content_hash || '' }
    };
  });
}

function structuredCandidates(db, workspaceId, terms) {
  const candidates = [];
  for (const item of rows(db, `SELECT id,category,content,source_type,source_ref,updated_at FROM memories WHERE (workspace_id=? OR scope='global') AND status='active' ORDER BY updated_at DESC`, workspaceId)) {
    candidates.push({ source_type: 'memory', source_id: item.id, content: item.content, score: 72 + lexicalScore(item.content, terms), selection_reason: item.source_type === 'user_explicit' ? 'explicit user constraint' : 'durable project memory', provenance: { category: item.category, source_type: item.source_type, source_ref: item.source_ref, updated_at: item.updated_at } });
  }
  for (const item of rows(db, 'SELECT * FROM decisions WHERE workspace_id=? ORDER BY created_at DESC', workspaceId)) {
    const content = `${item.title}: ${item.decision}${item.rationale ? `\nRationale: ${item.rationale}` : ''}`;
    candidates.push({ source_type: 'decision', source_id: item.id, content, score: 82 + lexicalScore(content, terms), selection_reason: 'explicit project decision', provenance: { source_ref: item.source_ref, created_at: item.created_at } });
  }
  for (const item of rows(db, `SELECT * FROM workspace_tasks WHERE workspace_id=? AND status='open' ORDER BY priority,updated_at DESC`, workspaceId)) {
    const content = `${item.title}${item.details ? `: ${item.details}` : ''}`;
    candidates.push({ source_type: 'open_task', source_id: item.id, content, score: 68 + lexicalScore(content, terms), selection_reason: 'current open task', provenance: { priority: item.priority, task_type: item.task_type, updated_at: item.updated_at } });
  }
  for (const item of rows(db, `SELECT rs.* FROM repository_states rs
    WHERE rs.workspace_id=? AND rs.id=(SELECT id FROM repository_states latest WHERE latest.root_id=rs.root_id ORDER BY latest.observed_at DESC LIMIT 1)
    ORDER BY rs.observed_at DESC`, workspaceId)) {
    let details = {};
    try { details = JSON.parse(item.details_json || '{}'); } catch {}
    const changed = Array.isArray(details.changed_paths) ? details.changed_paths.slice(0, 80) : [];
    const content = `Current repository branch ${item.branch || '(detached)'} at ${item.head_commit || '(unknown HEAD)'}; working tree ${item.dirty ? 'dirty' : 'clean'}${changed.length ? `; changed paths: ${changed.join(', ')}` : ''}.`;
    candidates.push({ source_type: 'current_working_set', source_id: item.id, content, score: 92 + lexicalScore(content, terms), selection_reason: 'current branch, HEAD, and working-tree state', provenance: { root_id: item.root_id, branch: item.branch, head: item.head_commit, dirty: Boolean(item.dirty), observed_at: item.observed_at, changed_paths: changed } });
  }
  return candidates;
}

function semanticCandidates(retriever, context) {
  if (!retriever?.available || typeof retriever.retrieve !== 'function') return [];
  try {
    const results = retriever.retrieve(context);
    if (!Array.isArray(results)) return [];
    return results.filter(item => item && item.workspace_id === context.workspaceId && item.source_id && item.content)
      .slice(0, 40).map(item => ({
        source_type: item.source_type || 'semantic_evidence', source_id: String(item.source_id), resource_version_id: item.resource_version_id || null,
        chunk_id: item.chunk_id || null, representation_id: item.representation_id || null, content: String(item.content).slice(0, 4000),
        score: Math.min(120, Math.max(0, Number(item.score) || 0)) + 35,
        selection_reason: `optional local semantic candidate from ${retriever.id || 'registered retriever'}`,
        provenance: { ...(item.provenance || {}), semantic_retriever: retriever.id || 'registered', workspace_id: context.workspaceId }
      }));
  } catch { return []; }
}

function assertionKey(value) {
  return String(value || '').toLowerCase().replace(/\b(?:the|a|an|target|current|required|requirement)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
}

function assertionValue(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.;,]+$/, '').trim().slice(0, 120);
}

function sourceAssertions(source, terms, query) {
  const assertions = [];
  const frequencyIntent = /\b(clock|frequency|rate|speed|hz|khz|mhz|ghz)\b/i.test(String(query || ''));
  for (const rawLine of String(source.content || '').split(/\r?\n/).slice(0, 500)) {
    const line = rawLine.trim();
    if (!line || line.length > 500) continue;
    let match = line.match(/^([A-Za-z][A-Za-z0-9 _./()-]{1,80}?)\s*(?:=|:)\s*([^#]{1,160})$/);
    if (!match) match = line.match(/^([A-Za-z][A-Za-z0-9 _./()-]{1,80}?)\s+(?:is|must be|should be|shall be)\s+([^#]{1,160})$/i);
    if (!match) continue;
    const key = assertionKey(match[1]);
    const value = assertionValue(match[2]);
    if (!key || !value) continue;
    const lexical = lexicalScore(`${match[1]} ${match[2]}`, terms);
    const frequencyValue = /\b\d+(?:\.\d+)?\s*(?:hz|khz|mhz|ghz)\b/i.test(match[2]);
    if (terms.length && lexical === 0 && !(frequencyIntent && frequencyValue)) continue;
    assertions.push({ key, value, text: line.slice(0, 260), source_type: source.source_type, source_id: source.source_id, source_label: source.provenance?.path || source.provenance?.title || source.source_type, version_id: source.resource_version_id || null, score: Number(source.score || 0) + lexical });
  }
  return assertions;
}

function detectConflicts(db, workspaceId, candidates, terms, query) {
  const sources = candidates.filter(candidate => HIGH_AUTHORITY_SOURCE_TYPES.has(candidate.source_type) && candidate.provenance?.knowledge_status !== 'superseded');
  const instructions = rows(db, `SELECT id,version_number,content,content_hash FROM instruction_versions WHERE workspace_id=? AND status='active' ORDER BY version_number DESC LIMIT 1`, workspaceId)[0];
  if (instructions?.content) sources.unshift({ source_type: 'project_instruction', source_id: instructions.id, content: instructions.content, score: 160, provenance: { title: 'Project Instructions', version: instructions.version_number, hash: instructions.content_hash } });
  const grouped = new Map();
  for (const source of sources.slice(0, 120)) for (const assertion of sourceAssertions(source, terms, query)) {
    const list = grouped.get(assertion.key) || [];
    if (!list.some(item => item.value === assertion.value && item.source_id === assertion.source_id)) list.push(assertion);
    grouped.set(assertion.key, list);
  }
  return [...grouped.entries()].map(([key, assertions]) => ({ key, assertions, values: [...new Set(assertions.map(item => item.value))] }))
    .filter(item => item.values.length > 1 && new Set(item.assertions.map(assertion => assertion.source_id)).size > 1)
    .sort((a, b) => Math.max(...b.assertions.map(item => item.score)) - Math.max(...a.assertions.map(item => item.score)))
    .slice(0, 5).map(item => ({ key: item.key, assertions: item.assertions.slice(0, 6), resolution: 'unresolved_current_authority_conflict' }));
}

function selectWithClassBudgets(candidates, characterBudget) {
  const fractions = { authoritative_source: 0.38, structured: 0.22, conversation: 0.20, visual_ocr: 0.12, historical: 0.08 };
  const limits = Object.fromEntries(Object.entries(fractions).map(([key, fraction]) => [key, Math.max(1200, Math.floor(characterBudget * fraction))]));
  const classUse = Object.fromEntries(Object.keys(fractions).map(key => [key, 0]));
  const normalized = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const content = String(candidate.content || '').slice(0, 4000);
    const compact = content.replace(/\s+/g, ' ').trim();
    const dedupe = compact.slice(0, 300).toLowerCase();
    if (!compact || seen.has(dedupe)) continue;
    seen.add(dedupe);
    const klass = evidenceClass(candidate);
    normalized.push({ ...candidate, content, evidence_class: klass, cost: content.length + 240 });
  }
  const selected = [];
  const deferred = [];
  let used = 0;
  for (const candidate of normalized) {
    const classLimit = limits[candidate.evidence_class] || limits.structured;
    if (used + candidate.cost <= characterBudget && classUse[candidate.evidence_class] + candidate.cost <= classLimit) {
      selected.push(candidate); used += candidate.cost; classUse[candidate.evidence_class] += candidate.cost;
    } else deferred.push(candidate);
  }
  for (const candidate of deferred) {
    if (used + candidate.cost > characterBudget) continue;
    selected.push(candidate); used += candidate.cost; classUse[candidate.evidence_class] += candidate.cost;
  }
  return { selected: selected.map(({ cost, ...candidate }) => candidate), used, classUse, limits };
}

export function retrieveWorkspaceEvidence(db, {
  workspaceId,
  query,
  provider,
  currentSessionId = null,
  characterBudget = 24000,
  semanticRetriever = noSemanticRetriever
}) {
  const terms = queryTerms(query);
  const currentIntent = /\b(current|latest|now|today|repository|code|implementation|working state)\b/i.test(String(query || ''));
  const historicalIntent = /\b(history|historical|historically|earlier|previous|originally|why did|decision trail)\b/i.test(String(query || ''));
  const stages = {
    structured: structuredCandidates(db, workspaceId, terms),
    conversation: messageCandidates(db, workspaceId, terms, provider, currentSessionId),
    relationships: relationshipCandidates(db, workspaceId, terms, currentSessionId, query, historicalIntent),
    lexical_resources: resourceCandidates(db, workspaceId, terms, historicalIntent),
    semantic: semanticCandidates(semanticRetriever, { db, workspaceId, query, terms, provider, currentSessionId })
  };
  const all = [
    ...stages.structured,
    ...stages.conversation,
    ...stages.relationships,
    ...stages.lexical_resources,
    ...stages.semantic
  ].map(candidate => ({ ...candidate, score: candidate.score
    + (currentIntent && ['file','pdf','repository_file'].includes(candidate.source_type) ? 45 : 0)
    + (currentIntent && candidate.source_type === 'chat_message' && candidate.provenance?.role === 'assistant' ? -12 : 0)
    + (historicalIntent && candidate.source_type === 'chat_message' ? 24 : 0)
    + (historicalIntent && candidate.provenance?.knowledge_status && candidate.provenance.knowledge_status !== 'active' ? 70 : 0) }))
    .sort((a, b) => b.score - a.score || String(a.source_id).localeCompare(String(b.source_id)));
  const directlyRelevant = all.filter(candidate => lexicalScore(`${candidate.content}\n${candidate.provenance?.path || ''}`, terms) > 0 || candidate.provenance?.priority_status === 'priority').length;
  const broadened = terms.length > 0 && directlyRelevant < 3;
  const selection = selectWithClassBudgets(all, characterBudget);
  const conflicts = detectConflicts(db, workspaceId, all, terms, query);
  return {
    query_terms: terms, selected: selection.selected, character_budget: characterBudget, used_characters: selection.used, candidate_count: all.length,
    conflicts,
    diagnostics: {
      stages: Object.fromEntries(Object.entries(stages).map(([name, items]) => [name, items.length])),
      directly_relevant_candidates: directlyRelevant,
      retrieval_broadened: broadened,
      semantic_retriever: semanticRetriever?.available ? semanticRetriever.id : 'unavailable_optional',
      evidence_class_characters: selection.classUse,
      evidence_class_soft_limits: selection.limits
    }
  };
}
