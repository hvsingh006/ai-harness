import { rows } from './db.mjs';
import { currentVisualRepresentations, ensurePdfPageRepresentation } from './multimodal.mjs';
import { surfaceRegistry } from './surface-registry.mjs';

function queryTerms(query) {
  const stop = new Set(['the','and','for','with','from','into','this','that','what','was','shown','earlier','inspect','visual','layout']);
  return [...new Set(String(query || '').toLowerCase().match(/[a-z0-9_.-]{3,}/g) || [])].filter(term => !stop.has(term)).slice(0, 24);
}

function visualIntent(query) {
  return /\b(image|screenshot|visual|layout|formatting|photo|diagram|figure|page|scan|chart|table appearance|look like)\b|\.(?:png|jpe?g|webp)\b/i.test(String(query || ''));
}

function explicitFileIntent(query) {
  return /\b(attach|attachment|pdf|document|spreadsheet|slides?|workbook|file itself|original file)\b|\.(?:pdf|docx?|pptx?|xlsx?)\b/i.test(String(query || ''));
}

function requestedPageNumber(query) {
  const match = String(query || '').match(/\bpage\s+(\d{1,6})\b/i);
  return match ? Number(match[1]) : 0;
}

function deicticFileIntent(query) {
  return /\b(?:this|that|the)\s+(?:pdf|file|document|attachment)\b|\b(?:file|attachment)\s+(?:above|earlier|just attached)\b/i.test(String(query || ''));
}

function requestedFileType(query) {
  const value = String(query || '');
  if (/\bpdf\b|\.pdf\b/i.test(value)) return 'pdf';
  if (/\b(?:spreadsheet|workbook)\b|\.xlsx?\b/i.test(value)) return 'spreadsheet';
  if (/\bslides?\b|\.pptx?\b/i.test(value)) return 'slides';
  if (/\b(?:word\s+)?document\b|\.docx?\b/i.test(value)) return 'document';
  return '';
}

function pathScore(relativePath, terms) {
  const lower = String(relativePath || '').toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? 15 : 0), 0);
}

export function planContextDelivery(db, { workspaceId, query, surfaceId, retrieval, registry = surfaceRegistry }) {
  const surface = registry.resolve(surfaceId);
  const terms = queryTerms(query);
  const requestedPage = requestedPageNumber(query);
  const deicticFile = deicticFileIntent(query);
  const requestedType = requestedFileType(query);
  let pageMaterializationFailure = null;
  if (requestedPage && surface.capabilities.image_attachment) {
    const pdfCandidates = rows(db, `SELECT r.id,r.relative_path,v.observed_at,
        (SELECT MAX(sa.updated_at) FROM session_assets sa WHERE sa.resource_id=r.id AND UPPER(sa.mirror_status)='CAPTURED') AS last_captured_at
      FROM workspace_resources r JOIN resource_versions v ON v.id=r.current_version_id JOIN workspace_roots wr ON wr.id=r.root_id
      WHERE r.workspace_id=? AND r.status='active' AND r.resource_type='pdf' AND r.knowledge_status='active' AND wr.status='current'
      ORDER BY v.observed_at DESC`, workspaceId)
      .map(item => ({ ...item, relevance: pathScore(item.relative_path, terms) + (deicticFile && item.last_captured_at ? 120 : 0) }))
      .filter(item => item.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance || String(b.last_captured_at || b.observed_at || '').localeCompare(String(a.last_captured_at || a.observed_at || '')));
    if (pdfCandidates[0]) {
      const materialized = ensurePdfPageRepresentation(db, { workspaceId, resourceId: pdfCandidates[0].id, page: requestedPage });
      if (!materialized.ok) pageMaterializationFailure = { code: materialized.code || 'VISUAL_PAGE_NOT_READY', page: requestedPage, resource_id: pdfCandidates[0].id, message: materialized.message || `page ${requestedPage} could not be prepared safely` };
    }
  }
  const matchedOcr = retrieval.selected.filter(item => item.source_type === 'ocr_text'
    && (!requestedPage || Number(item.provenance?.page_start || 0) === requestedPage)
    && terms.some(term => `${item.content || ''}\n${item.provenance?.path || ''}`.toLowerCase().includes(term)));
  const ocrResources = new Set(matchedOcr.map(item => item.source_id));
  const ocrPages = new Set(matchedOcr.map(item => `${item.source_id}:${item.provenance?.page_start || ''}`));
  const wantsVisual = visualIntent(query) || ocrResources.size > 0;
  const wantsFile = explicitFileIntent(query);
  const reasons = [];
  const selectedVisuals = [];
  const selectedFiles = [];
  const maxAttachments = Number(surface.capabilities.max_attachments || 0);

  if (wantsVisual) {
    const scoredVisuals = currentVisualRepresentations(db, workspaceId).map(item => {
      const pathRelevance = pathScore(item.relative_path, terms);
      const ocrRelevance = ocrResources.has(item.resource_id) ? 120 : 0;
      const pageRelevance = ocrPages.has(`${item.resource_id}:${item.page_start || ''}`) ? 40 : 0;
      const requestedPageRelevance = requestedPage && Number(item.page_start || 0) === requestedPage ? 240 : requestedPage ? -1000 : 0;
      return { ...item, path_relevance: pathRelevance, evidence_relevance: ocrRelevance, relevance: pathRelevance + ocrRelevance + pageRelevance + requestedPageRelevance + (item.representation_kind === 'page_image' ? 5 : 0) };
    });
    const pageEligibleVisuals = requestedPage ? scoredVisuals.filter(item => Number(item.page_start || 0) === requestedPage) : scoredVisuals;
    const visuals = (pageEligibleVisuals.some(item => item.path_relevance > 0 || item.evidence_relevance > 0) ? pageEligibleVisuals.filter(item => item.path_relevance > 0 || item.evidence_relevance > 0) : pageEligibleVisuals)
      .sort((a, b) => b.relevance - a.relevance || Number(a.page_start || 0) - Number(b.page_start || 0));
    if (surface.capabilities.image_attachment) {
      for (const item of visuals.slice(0, Math.min(3, maxAttachments))) selectedVisuals.push({
        representation_id: item.id, resource_id: item.resource_id, version_id: item.resource_version_id,
        name: `${item.relative_path}${item.page_start ? ` · page ${item.page_start}` : ''}`,
        mime_type: item.mime_type || 'image/png', size_bytes: item.size_bytes, sha256: item.artifact_sha256,
        page: item.page_start, kind: item.representation_kind,
        download_path: item.representation_kind === 'original_visual' && item.root_kind !== 'provider_archive'
          ? `/companion/resource-versions/${encodeURIComponent(item.resource_version_id)}/content`
          : `/companion/representations/${encodeURIComponent(item.id)}/content`
      });
    } else if (!matchedOcr.length) {
      reasons.push({ code: 'SURFACE_VISUAL_UNSUPPORTED', message: `${surface.display_name} cannot receive image evidence and no current OCR fallback matches this query` });
    }
  }

  if (wantsFile && maxAttachments && !selectedVisuals.some(item => Number(item.page || 0) === requestedPage)) {
    const resources = rows(db, `SELECT r.id,r.relative_path,r.resource_type,r.mime_type,r.current_version_id,r.provider_transmission_allowed,wr.provider_transmission_allowed AS root_transmission_allowed,v.sha256,v.size_bytes,v.indexing_status,v.security_status,v.representation_coverage,
        (SELECT MAX(sa.updated_at) FROM session_assets sa WHERE sa.resource_id=r.id AND UPPER(sa.mirror_status)='CAPTURED') AS last_captured_at
      FROM workspace_resources r JOIN workspace_roots wr ON wr.id=r.root_id JOIN resource_versions v ON v.id=r.current_version_id
      WHERE r.workspace_id=? AND r.status='active' AND r.knowledge_status='active' AND wr.status='current'
      ORDER BY v.observed_at DESC`, workspaceId)
      .filter(item => !requestedType
        || requestedType === 'pdf' && item.resource_type === 'pdf'
        || ['spreadsheet','slides','document'].includes(requestedType) && item.resource_type === 'office')
      .map(item => ({ ...item, relevance: pathScore(item.relative_path, terms) + (deicticFile && item.last_captured_at ? 120 : 0) }))
      .filter(item => item.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance || String(b.last_captured_at || '').localeCompare(String(a.last_captured_at || '')));
    for (const item of resources) {
      const supported = item.resource_type === 'pdf' ? surface.capabilities.pdf_attachment : surface.capabilities.file_attachment;
      if (!supported) continue;
      if (!item.provider_transmission_allowed || !item.root_transmission_allowed) {
        reasons.push({ code: 'ATTACHMENT_POLICY_BLOCKED', resource_id: item.id, version_id: item.current_version_id, message: `${item.relative_path} is outside the approved provider-transmission policy` });
        continue;
      }
      if (item.security_status !== 'clear') {
        reasons.push({ code: 'ATTACHMENT_SECURITY_BLOCKED', resource_id: item.id, version_id: item.current_version_id, message: `${item.relative_path} is not security-cleared for provider delivery` });
        continue;
      }
      if (!['complete','not_applicable'].includes(item.indexing_status)) {
        reasons.push({ code: 'ATTACHMENT_RESOURCE_NOT_READY', resource_id: item.id, version_id: item.current_version_id, message: `${item.relative_path} has not completed the required local processing for provider delivery` });
        continue;
      }
      if (['pdf','image'].includes(item.resource_type) && item.representation_coverage !== 'complete') {
        reasons.push({ code: 'ATTACHMENT_RESOURCE_NOT_READY', resource_id: item.id, version_id: item.current_version_id, message: `${item.relative_path} has incomplete visual/security coverage, so the whole original cannot be attached` });
        continue;
      }
      if (Number(item.size_bytes) > Number(surface.capabilities.max_attachment_bytes || 0)) {
        reasons.push({ code: 'ATTACHMENT_TOO_LARGE', resource_id: item.id, version_id: item.current_version_id, message: `${item.relative_path} exceeds the ${surface.capabilities.max_attachment_bytes} byte attachment limit for ${surface.display_name}` });
        continue;
      }
      if (selectedFiles.length + selectedVisuals.length >= maxAttachments) break;
      selectedFiles.push({ resource_id: item.id, version_id: item.current_version_id, name: item.relative_path.split('/').pop(), mime_type: item.mime_type, size_bytes: item.size_bytes, sha256: item.sha256, download_path: `/companion/resource-versions/${encodeURIComponent(item.current_version_id)}/content` });
    }
  }

  if (requestedPage && !selectedVisuals.some(item => Number(item.page || 0) === requestedPage) && !selectedFiles.some(item => item.mime_type === 'application/pdf')) {
    reasons.push(pageMaterializationFailure || {
      code: 'VISUAL_PAGE_NOT_READY',
      page: requestedPage,
      message: `Verified visual evidence for page ${requestedPage} is not ready and no current PDF original can be delivered to ${surface.display_name}`
    });
  }

  if (wantsVisual && !requestedPage && !selectedVisuals.length && !selectedFiles.length && !matchedOcr.length && !reasons.length) {
    reasons.push({ code: 'VISUAL_EVIDENCE_NOT_READY', message: `No security-cleared current visual or matching OCR fallback is ready for ${surface.display_name}` });
  }

  const status = reasons.length ? 'blocked' : wantsVisual && !selectedVisuals.length && !selectedFiles.length ? 'text_fallback' : 'ready';
  return {
    status, surface_id: surface.id, provider_family: surface.provider_family, channel: surface.channel,
    capabilities: surface.capabilities, intents: { visual: wantsVisual, file: wantsFile, requested_page: requestedPage || null, requested_file_type: requestedType || null, deictic_file: deicticFile },
    text_source_ids: retrieval.selected.map(item => item.source_id), visual_attachments: selectedVisuals, file_attachments: selectedFiles,
    attachments: [...selectedVisuals, ...selectedFiles], reasons,
    limits: { attachments: maxAttachments, attachment_bytes: surface.capabilities.max_attachment_bytes || 0 }
  };
}
