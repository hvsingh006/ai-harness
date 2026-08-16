import { rows } from './db.mjs';

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

function resourceCandidates(db, workspaceId, terms) {
  let candidates = [];
  if (terms.length) {
    try {
      candidates = rows(db, `SELECT f.chunk_id,f.path,f.content,bm25(resource_chunk_fts) AS rank,c.resource_id,c.resource_version_id,c.line_start,c.line_end,c.page_start,c.page_end,
        r.mime_type,r.resource_type,v.sha256,v.observed_at,wr.label AS root_label
        FROM resource_chunk_fts f
        JOIN resource_chunks c ON c.id=f.chunk_id
        JOIN workspace_resources r ON r.id=c.resource_id AND r.current_version_id=f.version_id AND r.status='active'
        JOIN resource_versions v ON v.id=f.version_id
        JOIN workspace_roots wr ON wr.id=r.root_id
        WHERE f.workspace_id=? AND resource_chunk_fts MATCH ? AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1 AND wr.status='current'
        ORDER BY rank LIMIT 80`, workspaceId, ftsQuery(terms));
    } catch {
      const conditions = terms.map(() => '(LOWER(r.relative_path) LIKE ? OR LOWER(c.content) LIKE ?)').join(' OR ');
      const parameters = terms.flatMap(term => [`%${term}%`, `%${term}%`]);
      candidates = rows(db, `SELECT c.id AS chunk_id,r.relative_path AS path,c.content,0 AS rank,c.resource_id,c.resource_version_id,c.line_start,c.line_end,c.page_start,c.page_end,
        r.mime_type,r.resource_type,v.sha256,v.observed_at,wr.label AS root_label
        FROM resource_chunks c
        JOIN workspace_resources r ON r.id=c.resource_id AND r.current_version_id=c.resource_version_id AND r.status='active'
        JOIN resource_versions v ON v.id=c.resource_version_id
        JOIN workspace_roots wr ON wr.id=r.root_id
        WHERE c.workspace_id=? AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1 AND wr.status='current'
          AND (${conditions})
        ORDER BY v.observed_at DESC LIMIT 80`, workspaceId, ...parameters);
    }
  }
  const currentBaseline = rows(db, `SELECT c.id AS chunk_id,r.relative_path AS path,c.content,c.resource_id,c.resource_version_id,c.line_start,c.line_end,c.page_start,c.page_end,
      r.mime_type,r.resource_type,v.sha256,v.observed_at,wr.label AS root_label,0 AS rank
    FROM workspace_resources r
    JOIN workspace_roots wr ON wr.id=r.root_id
    JOIN resource_versions v ON v.id=r.current_version_id
    JOIN resource_chunks c ON c.resource_version_id=v.id
    WHERE r.workspace_id=? AND r.status='active' AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1 AND wr.status='current'
    ORDER BY v.observed_at DESC,c.ordinal LIMIT 30`, workspaceId);
  const merged = new Map();
  for (const item of [...candidates, ...currentBaseline]) merged.set(item.chunk_id, item);
  return [...merged.values()].map(item => ({
    source_type: item.resource_type === 'pdf' ? 'pdf' : item.resource_type === 'code' ? 'repository_file' : 'file',
    source_id: item.resource_id,
    resource_version_id: item.resource_version_id,
    chunk_id: item.chunk_id,
    content: item.content,
    score: 55 + lexicalScore(`${item.path}\n${item.content}`, terms) + (String(item.path).toLowerCase().includes(terms.join(' ')) ? 20 : 0),
    selection_reason: 'current verified resource version',
    provenance: { path: item.path, root: item.root_label, sha256: item.sha256, observed_at: item.observed_at, line_start: item.line_start, line_end: item.line_end, page_start: item.page_start, page_end: item.page_end, current_version: true }
  }));
}

function messageCandidates(db, workspaceId, terms, targetProvider, currentSessionId) {
  let matches = [];
  if (terms.length) {
    try {
      matches = rows(db, `SELECT f.message_id,f.session_id,f.provider,f.title,f.role,f.content,bm25(message_fts) AS rank,s.started_at,m.created_at
        FROM message_fts f JOIN messages m ON m.id=f.message_id JOIN sessions s ON s.id=f.session_id
        WHERE f.workspace_id=? AND message_fts MATCH ? ORDER BY rank LIMIT 100`, workspaceId, ftsQuery(terms));
    } catch {
      const conditions = terms.map(() => "LOWER(COALESCE(NULLIF(m.clean_content_text,''),m.content_text)) LIKE ?").join(' OR ');
      const parameters = terms.map(term => `%${term}%`);
      matches = rows(db, `SELECT m.id AS message_id,m.session_id,s.provider,s.title,m.role,COALESCE(NULLIF(m.clean_content_text,''),m.content_text) AS content,0 AS rank,s.started_at,m.created_at
        FROM messages m JOIN sessions s ON s.id=m.session_id
        WHERE s.workspace_id=? AND (${conditions})
        ORDER BY COALESCE(m.created_at,s.started_at) DESC LIMIT 100`, workspaceId, ...parameters);
    }
  }
  const recent = rows(db, `SELECT m.id AS message_id,m.session_id,s.provider,s.title,m.role,COALESCE(NULLIF(m.clean_content_text,''),m.content_text) AS content,0 AS rank,s.started_at,m.created_at
    FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.workspace_id=?
    ORDER BY COALESCE(m.created_at,s.started_at) DESC LIMIT 40`, workspaceId);
  const merged = new Map();
  for (const item of [...matches, ...recent]) merged.set(item.message_id, item);
  const now = Date.now();
  return [...merged.values()].map(item => {
    const ageDays = Math.max(0, (now - Date.parse(item.created_at || item.started_at || 0)) / 86400000);
    const recency = Math.max(0, 18 - Math.log2(ageDays + 1) * 3);
    const roleWeight = item.role === 'user' ? 32 : item.role === 'assistant' ? 10 : 4;
    const crossProvider = item.provider && item.provider !== targetProvider ? 8 : 0;
    const currentSession = item.session_id === currentSessionId ? 10 : 0;
    return {
      source_type: 'chat_message',
      source_id: item.message_id,
      content: item.content,
      score: 28 + lexicalScore(item.content, terms) + roleWeight + recency + crossProvider + currentSession,
      selection_reason: item.role === 'user' ? 'retained user reasoning' : 'retained provider evidence',
      provenance: { provider: item.provider, session_id: item.session_id, title: item.title, role: item.role, created_at: item.created_at || item.started_at, current_session: item.session_id === currentSessionId }
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
  return candidates;
}

export function retrieveWorkspaceEvidence(db, {
  workspaceId,
  query,
  provider,
  currentSessionId = null,
  characterBudget = 24000
}) {
  const terms = queryTerms(query);
  const all = [
    ...structuredCandidates(db, workspaceId, terms),
    ...messageCandidates(db, workspaceId, terms, provider, currentSessionId),
    ...resourceCandidates(db, workspaceId, terms)
  ].sort((a, b) => b.score - a.score || String(a.source_id).localeCompare(String(b.source_id)));
  const selected = [];
  const seen = new Set();
  let used = 0;
  for (const candidate of all) {
    const normalized = candidate.content.replace(/\s+/g, ' ').trim().slice(0, 4000);
    const dedupe = normalized.slice(0, 300).toLowerCase();
    if (!normalized || seen.has(dedupe)) continue;
    const cost = candidate.content.length + 240;
    if (selected.length && used + cost > characterBudget) continue;
    seen.add(dedupe);
    selected.push({ ...candidate, content: candidate.content.slice(0, 4000) });
    used += cost;
  }
  return { query_terms: terms, selected, character_budget: characterBudget, used_characters: used, candidate_count: all.length };
}
