import fs from 'node:fs';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { archiveFile } from './archive.mjs';
import { row, rows, run, storageForDatabase } from './db.mjs';
import { scanOutgoingText } from './security/secrets.mjs';
import { runTool, toolStatus } from './tooling.mjs';

export const MULTIMODAL_LIMITS = Object.freeze({
  maxInputBytes: 200 * 1024 * 1024,
  maxPdfPages: 5000,
  eagerPdfPageThreshold: 80,
  eagerLargePdfPages: 24,
  renderDpi: 144,
  maxRenderedPixelsPerPage: 45_000_000,
  maxRenderedPixelsTotal: 600_000_000,
  maxOcrCharactersPerPage: 2_000_000,
  toolTimeoutMs: 60_000,
  maxToolOutputBytes: 64 * 1024 * 1024
});

function now() { return new Date().toISOString(); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function normalizeText(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

function textSimilarity(a, b) {
  const left = new Set(normalizeText(a).split(' ').filter(Boolean));
  const right = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const word of left) if (right.has(word)) intersection += 1;
  return intersection / Math.max(1, Math.min(left.size, right.size));
}

function pngDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  return {};
}

function parsePdfInfo(text) {
  const metadata = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) metadata[match[1].trim().toLowerCase().replaceAll(' ', '_')] = match[2].trim();
  }
  return { ...metadata, page_count: Number(metadata.pages || 0), encrypted: /^yes/i.test(metadata.encrypted || '') };
}

function chunkText(text, { page = null, sourceKind = 'digital_text', confidence = null, authority = 'source_derived', region = {} } = {}) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  for (let start = 0; start < lines.length; start += 52) {
    const end = Math.min(lines.length, start + 60);
    const content = lines.slice(start, end).join('\n').trim();
    if (content) output.push({ content, lineStart: start + 1, lineEnd: end, pageStart: page, pageEnd: page, sourceKind, confidence, authority, region });
  }
  return output;
}

function parseTsv(tsv, maxCharacters) {
  const lines = String(tsv || '').split(/\r?\n/);
  const groups = new Map();
  for (let index = 1; index < lines.length; index++) {
    const fields = lines[index].split('\t');
    if (fields.length < 12) continue;
    const text = fields.slice(11).join('\t').trim();
    const confidence = Number(fields[10]);
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue;
    const key = fields.slice(1, 5).join(':');
    const box = { x: Number(fields[6]), y: Number(fields[7]), width: Number(fields[8]), height: Number(fields[9]) };
    const group = groups.get(key) || { words: [], confidence: [], left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
    group.words.push(text);
    group.confidence.push(confidence);
    group.left = Math.min(group.left, box.x); group.top = Math.min(group.top, box.y);
    group.right = Math.max(group.right, box.x + box.width); group.bottom = Math.max(group.bottom, box.y + box.height);
    groups.set(key, group);
  }
  const regions = [...groups.values()].map(group => ({
    text: group.words.join(' '),
    confidence: group.confidence.reduce((sum, value) => sum + value, 0) / group.confidence.length / 100,
    region: { x: group.left, y: group.top, width: group.right - group.left, height: group.bottom - group.top }
  }));
  const text = regions.map(item => item.text).join('\n').slice(0, maxCharacters);
  const confidence = regions.length ? regions.reduce((sum, item) => sum + item.confidence, 0) / regions.length : null;
  return { text, confidence, regions };
}

function archiveDerivedText(db, { workspaceId, versionId, kind, page, text, tempDir }) {
  const filePath = path.join(tempDir, `${kind}-${String(page || 0).padStart(4, '0')}.txt`);
  fs.writeFileSync(filePath, text, { encoding: 'utf8', flag: 'w' });
  return archiveFile(db, {
    filePath,
    workspaceId,
    provider: 'local',
    artifactType: 'derived_representation',
    sourcePathOverride: `derived:${versionId}:${kind}:${page || 0}`,
    metadata: { resource_version_id: versionId, representation_kind: kind, page: page || null, rebuildable: true }
  });
}

function addRepresentation(db, values) {
  const id = `representation-${randomUUID()}`;
  run(db, `INSERT INTO resource_representations
    (id,workspace_id,resource_id,resource_version_id,representation_kind,status,artifact_id,page_start,page_end,region_json,extractor,extractor_version,content_sha256,confidence,trust_class,metadata_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, values.workspaceId, values.resourceId, values.versionId, values.kind, values.status || 'complete', values.artifactId || null,
    values.page || null, values.page || null, JSON.stringify(values.region || {}), values.extractor || '', values.extractorVersion || '',
    values.contentSha256 || '', values.confidence ?? null, values.trustClass || 'untrusted_derived', JSON.stringify(values.metadata || {}), now());
  if (values.securityStatus) run(db, 'UPDATE resource_representations SET security_status=? WHERE id=?', values.securityStatus, id);
  return id;
}

function inspectPdf(filePath) {
  const status = toolStatus('pdfinfo');
  if (!status.available) return { ok: false, code: 'PDFINFO_UNAVAILABLE', message: 'Poppler pdfinfo is unavailable', metadata: {}, tool: status };
  const result = runTool('pdfinfo', [filePath], { timeout: MULTIMODAL_LIMITS.toolTimeoutMs, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) return { ok: false, code: 'PDF_METADATA_FAILED', message: String(result.stderr || result.error?.message || 'pdfinfo failed').trim(), metadata: {}, tool: status };
  const metadata = parsePdfInfo(result.stdout);
  if (metadata.encrypted) return { ok: false, code: 'PDF_ENCRYPTED', message: 'Encrypted PDFs require an unlocked source copy', metadata, tool: status };
  if (!metadata.page_count || metadata.page_count > MULTIMODAL_LIMITS.maxPdfPages) return { ok: false, code: 'PDF_PAGE_LIMIT', message: `PDF page count must be between 1 and ${MULTIMODAL_LIMITS.maxPdfPages}`, metadata, tool: status };
  return { ok: true, metadata, tool: status };
}

function extractPdfPageText(filePath, page) {
  const status = toolStatus('pdftotext');
  if (!status.available) return { ok: false, text: '', status };
  const result = runTool('pdftotext', ['-layout', '-f', page, '-l', page, filePath, '-'], { timeout: MULTIMODAL_LIMITS.toolTimeoutMs, maxBuffer: MULTIMODAL_LIMITS.maxToolOutputBytes });
  return { ok: !result.error && result.status === 0, text: String(result.stdout || '').trim(), status, error: String(result.stderr || result.error?.message || '').trim() };
}

function renderPdfPages(filePath, pageCount, tempDir) {
  const status = toolStatus('pdftoppm');
  if (!status.available) return { ok: false, status, pages: [], message: 'Poppler pdftoppm is unavailable' };
  const prefix = path.join(tempDir, 'page');
  const result = runTool('pdftoppm', ['-png', '-r', MULTIMODAL_LIMITS.renderDpi, '-f', 1, '-l', pageCount, filePath, prefix], { timeout: Math.max(MULTIMODAL_LIMITS.toolTimeoutMs, pageCount * 5000), maxBuffer: MULTIMODAL_LIMITS.maxToolOutputBytes });
  if (result.error || result.status !== 0) return { ok: false, status, pages: [], message: String(result.stderr || result.error?.message || 'PDF rendering failed').trim() };
  const pages = fs.readdirSync(tempDir).filter(name => /^page-\d+\.png$/i.test(name)).sort().map(name => path.join(tempDir, name));
  if (pages.length !== pageCount) return { ok: false, status, pages, message: `rendered ${pages.length} of ${pageCount} pages` };
  let totalPixels = 0;
  for (const page of pages) {
    const dimensions = pngDimensions(page);
    const pixels = Number(dimensions.width || 0) * Number(dimensions.height || 0);
    totalPixels += pixels;
    if (pixels > MULTIMODAL_LIMITS.maxRenderedPixelsPerPage || totalPixels > MULTIMODAL_LIMITS.maxRenderedPixelsTotal) return { ok: false, status, pages: [], message: 'rendered PDF exceeds configured pixel bounds' };
  }
  return { ok: true, status, pages };
}

function renderPdfPage(filePath, page, tempDir) {
  const status = toolStatus('pdftoppm');
  if (!status.available) return { ok: false, status, pagePath: '', message: 'Poppler pdftoppm is unavailable' };
  const prefix = path.join(tempDir, 'requested-page');
  const result = runTool('pdftoppm', ['-png', '-r', MULTIMODAL_LIMITS.renderDpi, '-f', page, '-l', page, filePath, prefix], { timeout: MULTIMODAL_LIMITS.toolTimeoutMs, maxBuffer: MULTIMODAL_LIMITS.maxToolOutputBytes });
  if (result.error || result.status !== 0) return { ok: false, status, pagePath: '', message: String(result.stderr || result.error?.message || 'PDF page rendering failed').trim() };
  const name = fs.readdirSync(tempDir).find(item => /^requested-page-\d+\.png$/i.test(item));
  if (!name) return { ok: false, status, pagePath: '', message: `page ${page} did not produce a render` };
  const pagePath = path.join(tempDir, name);
  const dimensions = pngDimensions(pagePath);
  const pixels = Number(dimensions.width || 0) * Number(dimensions.height || 0);
  if (!pixels || pixels > MULTIMODAL_LIMITS.maxRenderedPixelsPerPage) return { ok: false, status, pagePath: '', message: `page ${page} exceeds the configured pixel bound` };
  return { ok: true, status, pagePath, dimensions };
}

function extractEmbeddedImages(filePath, pageCount, tempDir) {
  const status = toolStatus('pdfimages');
  if (!status.available) return { ok: false, status, images: [], message: 'Poppler pdfimages is unavailable' };
  const prefix = path.join(tempDir, 'embedded');
  const list = runTool('pdfimages', ['-f', 1, '-l', pageCount, '-list', filePath], { timeout: MULTIMODAL_LIMITS.toolTimeoutMs, maxBuffer: 8 * 1024 * 1024 });
  const pages = String(list.stdout || '').split(/\r?\n/).map(line => line.trim().match(/^(\d+)\s+(\d+)\s+/)).filter(Boolean).map(match => Number(match[1]));
  const result = runTool('pdfimages', ['-png', '-f', 1, '-l', pageCount, filePath, prefix], { timeout: Math.max(MULTIMODAL_LIMITS.toolTimeoutMs, pageCount * 3000), maxBuffer: MULTIMODAL_LIMITS.maxToolOutputBytes });
  if (result.error || result.status !== 0) return { ok: false, status, images: [], message: String(result.stderr || result.error?.message || 'embedded image extraction failed').trim() };
  const images = fs.readdirSync(tempDir).filter(name => /^embedded-\d+\.(?:png|jpg|jpeg|ppm|pbm)$/i.test(name)).sort().slice(0, 500).map((name, index) => ({ path: path.join(tempDir, name), page: pages[index] || null }));
  return { ok: true, status, images };
}

function ocrImage(filePath) {
  const status = toolStatus('tesseract');
  if (!status.available) return { ok: false, status, text: '', confidence: null, regions: [], message: 'Tesseract OCR is unavailable' };
  const result = runTool('tesseract', [filePath, 'stdout', '-l', 'eng', '--psm', '6', 'tsv'], { timeout: MULTIMODAL_LIMITS.toolTimeoutMs, maxBuffer: MULTIMODAL_LIMITS.maxToolOutputBytes });
  if (result.error || result.status !== 0) return { ok: false, status, text: '', confidence: null, regions: [], message: String(result.stderr || result.error?.message || 'OCR failed').trim() };
  return { ok: true, status, ...parseTsv(result.stdout, MULTIMODAL_LIMITS.maxOcrCharactersPerPage) };
}

export function clearVersionRepresentations(db, versionId) {
  try { run(db, 'DELETE FROM resource_chunk_fts WHERE version_id=?', versionId); } catch {}
  run(db, 'DELETE FROM resource_chunks WHERE resource_version_id=?', versionId);
  run(db, 'DELETE FROM resource_representations WHERE resource_version_id=?', versionId);
}

export function recordBasicRepresentation(db, { workspaceId, resource, version, extraction }) {
  clearVersionRepresentations(db, version.id);
  const artifact = version.archive_artifact_id;
  const originalId = addRepresentation(db, {
    workspaceId, resourceId: resource.id, versionId: version.id, kind: resource.resource_type === 'image' ? 'original_visual' : 'original_source',
    artifactId: artifact, extractor: 'original', contentSha256: version.sha256, trustClass: 'authoritative_original',
    metadata: extraction.metadata || {}, securityStatus: resource.resource_type === 'image' ? 'unchecked' : 'clear'
  });
  const textId = extraction.status === 'complete' ? addRepresentation(db, {
    workspaceId, resourceId: resource.id, versionId: version.id, kind: 'digital_text', artifactId: artifact,
    extractor: extraction.metadata?.extractor || 'utf8', contentSha256: sha256(extraction.chunks.map(chunk => chunk.content).join('\n')),
    trustClass: 'source_derived', metadata: extraction.metadata || {}
  }) : null;
  return {
    originalId,
    textId,
    chunks: extraction.chunks.map(chunk => ({ ...chunk, representationId: textId, sourceKind: 'digital_text', authority: 'source_derived', confidence: 1, region: {} })),
    coverage: {
      status: extraction.status === 'complete' ? 'complete' : resource.resource_type === 'office' ? 'attachment_only' : 'source_only',
      availability_states: extraction.status === 'complete' ? ['SOURCE_CURRENT','SEARCHABLE'] : resource.resource_type === 'office' ? ['SOURCE_CURRENT','ATTACHMENT_ONLY'] : ['SOURCE_CURRENT'],
      digital_text: extraction.status === 'complete', original_retained: true, ocr: false, visual_pages: resource.resource_type === 'image' ? 1 : 0
    }
  };
}

export function processMultimodalVersion(db, { workspaceId, resource, version, filePath }) {
  const stat = fs.statSync(filePath);
  if (stat.size > MULTIMODAL_LIMITS.maxInputBytes) return { status: 'failed', reason: 'resource exceeds multimodal input bound', chunks: [], coverage: { status: 'blocked', availability_states: ['SOURCE_CURRENT','FAILED'], code: 'MULTIMODAL_INPUT_LIMIT' } };
  clearVersionRepresentations(db, version.id);
  const storage = storageForDatabase(db);
  const tempDir = path.join(storage.derivedDir, `process-${version.id}-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const chunks = [];
  const failures = [];
  const deduplicatedOcrSecurity = { blocked: false, redacted: false, detections: [] };
  const scanDeduplicatedOcr = text => {
    const result = scanOutgoingText(text, { source: resource.id });
    deduplicatedOcrSecurity.blocked ||= result.blocked;
    deduplicatedOcrSecurity.redacted ||= result.redacted;
    deduplicatedOcrSecurity.detections.push(...result.detections);
  };
  let representationCount = 0;
  const add = values => { representationCount += 1; return addRepresentation(db, { workspaceId, resourceId: resource.id, versionId: version.id, ...values }); };
  try {
    const originalRepresentationId = add({ kind: resource.resource_type === 'image' ? 'original_visual' : 'original_source', artifactId: version.archive_artifact_id, extractor: 'original', contentSha256: version.sha256, trustClass: 'authoritative_original', securityStatus: 'unchecked' });
    if (resource.resource_type === 'image') {
      const dimensions = resource.mime_type === 'image/png' ? pngDimensions(filePath) : {};
      const ocr = ocrImage(filePath);
      if (!ocr.ok) failures.push({ code: ocr.status?.code || 'OCR_FAILED', message: ocr.message });
      else {
        const visualSecurity = scanOutgoingText(ocr.text, { source: `${resource.id}:page:1` });
        run(db, 'UPDATE resource_representations SET security_status=? WHERE id=?', visualSecurity.blocked ? 'blocked' : visualSecurity.redacted ? 'redact_required' : 'clear', originalRepresentationId);
        deduplicatedOcrSecurity.blocked ||= visualSecurity.blocked;
        deduplicatedOcrSecurity.redacted ||= visualSecurity.redacted;
        deduplicatedOcrSecurity.detections.push(...visualSecurity.detections);
        const textArtifact = archiveDerivedText(db, { workspaceId, versionId: version.id, kind: 'ocr_text', page: 1, text: ocr.text, tempDir });
        const repId = add({ kind: 'ocr_text', page: 1, artifactId: textArtifact?.id, extractor: 'tesseract', extractorVersion: ocr.status.version, contentSha256: sha256(ocr.text), confidence: ocr.confidence, metadata: { regions: ocr.regions, untrusted_evidence: true }, securityStatus: visualSecurity.blocked ? 'blocked' : visualSecurity.redacted ? 'redact_required' : 'clear' });
        chunks.push(...chunkText(ocr.text, { page: 1, sourceKind: 'ocr_text', confidence: ocr.confidence, authority: 'untrusted_derived', region: { regions: ocr.regions } }).map(chunk => ({ ...chunk, representationId: repId })));
      }
      const coverage = { status: failures.length ? 'partial' : 'complete', availability_states: ['SOURCE_CURRENT', ...(failures.length ? ['VISUAL_READY','PARTIAL'] : ['SEARCHABLE','VISUAL_READY'])], original_visual: true, ocr: !failures.length, visual_pages: 1, failures };
      return { status: 'complete', chunks, coverage, representationCount, metadata: dimensions, additionalSecurity: deduplicatedOcrSecurity };
    }

    const inspection = inspectPdf(filePath);
    if (!inspection.ok) return { status: 'failed', reason: inspection.message, chunks, coverage: { status: 'blocked', availability_states: ['SOURCE_CURRENT','FAILED'], metadata: inspection.metadata, failures: [{ code: inspection.code, message: inspection.message }] }, representationCount };
    add({ kind: 'pdf_metadata', extractor: 'pdfinfo', extractorVersion: inspection.tool.version, contentSha256: sha256(JSON.stringify(inspection.metadata)), metadata: inspection.metadata });
    const incremental = inspection.metadata.page_count > MULTIMODAL_LIMITS.eagerPdfPageThreshold;
    const processingPageCount = incremental ? Math.min(MULTIMODAL_LIMITS.eagerLargePdfPages, inspection.metadata.page_count) : inspection.metadata.page_count;
    const rendered = renderPdfPages(filePath, processingPageCount, tempDir);
    if (!rendered.ok) failures.push({ code: rendered.status?.code || 'PDF_RENDER_FAILED', message: rendered.message });
    const digitalByPage = new Map();
    for (let page = 1; page <= processingPageCount; page++) {
      const digital = extractPdfPageText(filePath, page);
      if (!digital.ok) { failures.push({ code: digital.status?.code || 'PDF_TEXT_FAILED', page, message: digital.error || 'digital text extraction failed' }); continue; }
      digitalByPage.set(page, digital.text);
      if (digital.text) {
        const artifact = archiveDerivedText(db, { workspaceId, versionId: version.id, kind: 'digital_text', page, text: digital.text, tempDir });
        const repId = add({ kind: 'digital_text', page, artifactId: artifact?.id, extractor: 'pdftotext', extractorVersion: digital.status.version, contentSha256: sha256(digital.text), confidence: 1, trustClass: 'source_derived' });
        chunks.push(...chunkText(digital.text, { page, sourceKind: 'digital_text', confidence: 1, authority: 'source_derived' }).map(chunk => ({ ...chunk, representationId: repId })));
      }
    }
    if (rendered.ok) {
      for (let index = 0; index < rendered.pages.length; index++) {
        const page = index + 1;
        const imagePath = rendered.pages[index];
        const dimensions = pngDimensions(imagePath);
        const artifact = archiveFile(db, { filePath: imagePath, workspaceId, provider: 'local', artifactType: 'pdf_page_image', sourcePathOverride: `derived:${version.id}:page_image:${page}`, metadata: { resource_version_id: version.id, page, rebuildable: true, ...dimensions } });
        const pageImageId = add({ kind: 'page_image', page, artifactId: artifact?.id, extractor: 'pdftoppm', extractorVersion: rendered.status.version, contentSha256: artifact?.sha256 || '', metadata: dimensions, securityStatus: 'unchecked' });
        const ocr = ocrImage(imagePath);
        if (!ocr.ok) { failures.push({ code: ocr.status?.code || 'OCR_FAILED', page, message: ocr.message }); continue; }
        const visualSecurity = scanOutgoingText(ocr.text, { source: `${resource.id}:page:${page}` });
        run(db, 'UPDATE resource_representations SET security_status=? WHERE id=?', visualSecurity.blocked ? 'blocked' : visualSecurity.redacted ? 'redact_required' : 'clear', pageImageId);
        const similarity = textSimilarity(digitalByPage.get(page), ocr.text);
        const textArtifact = archiveDerivedText(db, { workspaceId, versionId: version.id, kind: 'ocr_text', page, text: ocr.text, tempDir });
        const repId = add({ kind: 'ocr_text', page, artifactId: textArtifact?.id, extractor: 'tesseract', extractorVersion: ocr.status.version, contentSha256: sha256(ocr.text), confidence: ocr.confidence, metadata: { regions: ocr.regions, deduplicated_from_digital: similarity >= 0.82, digital_similarity: similarity, untrusted_evidence: true }, securityStatus: visualSecurity.blocked ? 'blocked' : visualSecurity.redacted ? 'redact_required' : 'clear' });
        if (similarity < 0.82) chunks.push(...chunkText(ocr.text, { page, sourceKind: 'ocr_text', confidence: ocr.confidence, authority: 'untrusted_derived', region: { regions: ocr.regions } }).map(chunk => ({ ...chunk, representationId: repId })));
        else scanDeduplicatedOcr(ocr.text);
      }
    }
    const embedded = extractEmbeddedImages(filePath, processingPageCount, tempDir);
    if (!embedded.ok) failures.push({ code: embedded.status?.code || 'PDF_EMBEDDED_IMAGE_FAILED', message: embedded.message });
    else for (let index = 0; index < embedded.images.length; index++) {
      const image = embedded.images[index];
      const artifact = archiveFile(db, { filePath: image.path, workspaceId, provider: 'local', artifactType: 'pdf_embedded_image', sourcePathOverride: `derived:${version.id}:embedded_image:${index + 1}`, metadata: { resource_version_id: version.id, page: image.page, rebuildable: true } });
      add({ kind: 'embedded_image', page: image.page, artifactId: artifact?.id, extractor: 'pdfimages', extractorVersion: embedded.status.version, contentSha256: artifact?.sha256 || '', metadata: { index: index + 1 } });
    }
    const coverage = {
      status: failures.length || incremental ? 'partial' : 'complete',
      availability_states: ['SOURCE_CURRENT', ...(chunks.length ? ['SEARCHABLE'] : []), ...(rendered.pages.length ? ['VISUAL_READY'] : []), ...(failures.length || incremental ? ['PARTIAL'] : [])],
      page_count: inspection.metadata.page_count,
      processed_page_count: processingPageCount,
      pending_page_count: Math.max(0, inspection.metadata.page_count - processingPageCount),
      processing_scope: incremental ? `incremental_initial_pages_1_${processingPageCount}` : 'complete_document',
      digital_text_pages: [...digitalByPage.values()].filter(Boolean).length,
      rendered_pages: rendered.pages.length,
      ocr_pages: rows(db, `SELECT COUNT(*) AS n FROM resource_representations WHERE resource_version_id=? AND representation_kind='ocr_text'`, version.id)[0]?.n || 0,
      embedded_images: embedded.images.length,
      original_retained: true, failures
    };
    return { status: chunks.length || rendered.pages.length ? 'complete' : 'failed', reason: failures[0]?.message || '', chunks, coverage, representationCount, additionalSecurity: deduplicatedOcrSecurity };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

function appendVersionChunks(db, { workspaceId, resource, version, chunks, metadata = {} }) {
  let ordinal = Number(row(db, 'SELECT COALESCE(MAX(ordinal),-1) AS n FROM resource_chunks WHERE resource_version_id=?', version.id)?.n ?? -1) + 1;
  for (const chunk of chunks) {
    const id = `chunk-${randomUUID()}`;
    const contentHash = sha256(chunk.content);
    run(db, `INSERT INTO resource_chunks (id,workspace_id,resource_id,resource_version_id,ordinal,content,content_hash,line_start,line_end,page_start,page_end,metadata_json,created_at,representation_id,source_kind,authority,confidence,region_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, workspaceId, resource.id, version.id, ordinal++, chunk.content, contentHash,
      chunk.lineStart || null, chunk.lineEnd || null, chunk.pageStart || null, chunk.pageEnd || null,
      JSON.stringify(metadata), now(), chunk.representationId || null, chunk.sourceKind || 'digital_text',
      chunk.authority || 'source_derived', chunk.confidence ?? null, JSON.stringify(chunk.region || {}));
    try { run(db, 'INSERT INTO resource_chunk_fts (chunk_id,workspace_id,resource_id,version_id,path,content) VALUES (?,?,?,?,?,?)', id, workspaceId, resource.id, version.id, resource.relative_path, chunk.content); } catch {}
  }
}

export function ensurePdfPageRepresentation(db, { workspaceId, resourceId, page }) {
  const requestedPage = Number(page || 0);
  if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > MULTIMODAL_LIMITS.maxPdfPages) return { ok: false, code: 'PDF_PAGE_INVALID', message: 'requested PDF page is outside the supported range' };
  const current = row(db, `SELECT r.*,v.id AS version_id,v.sha256,v.security_status,v.coverage_json,v.metadata_json,v.archive_artifact_id,a.vault_path
    FROM workspace_resources r JOIN resource_versions v ON v.id=r.current_version_id LEFT JOIN artifacts a ON a.id=v.archive_artifact_id
    WHERE r.id=? AND r.workspace_id=? AND r.status='active' AND r.resource_type='pdf'`, resourceId, workspaceId);
  if (!current?.vault_path || !fs.existsSync(current.vault_path)) return { ok: false, code: 'PDF_ORIGINAL_UNAVAILABLE', message: 'the immutable current PDF original is unavailable' };
  if (current.security_status !== 'clear' || !current.provider_transmission_allowed) return { ok: false, code: 'VISUAL_PAGE_SECURITY_BLOCKED', message: 'the PDF is not security-cleared for visual delivery' };
  const existing = row(db, `SELECT rr.*,a.name,a.mime_type,a.size_bytes,a.sha256 AS artifact_sha256 FROM resource_representations rr
    LEFT JOIN artifacts a ON a.id=rr.artifact_id WHERE rr.resource_version_id=? AND rr.representation_kind='page_image' AND rr.page_start=? AND rr.status='complete' AND rr.security_status='clear'
    ORDER BY rr.created_at DESC LIMIT 1`, current.version_id, requestedPage);
  if (existing) return { ok: true, created: false, representation: existing };

  let coverage = {};
  try { coverage = JSON.parse(current.coverage_json || '{}'); } catch {}
  let pageCount = Number(coverage.page_count || 0);
  if (!pageCount) {
    const inspected = inspectPdf(current.vault_path);
    if (!inspected.ok) return { ok: false, code: inspected.code, message: inspected.message };
    pageCount = inspected.metadata.page_count;
  }
  if (requestedPage > pageCount) return { ok: false, code: 'PDF_PAGE_OUT_OF_RANGE', message: `the current PDF has ${pageCount} pages, not page ${requestedPage}` };

  const storage = storageForDatabase(db);
  const tempDir = path.join(storage.derivedDir, `page-${current.version_id}-${requestedPage}-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    const rendered = renderPdfPage(current.vault_path, requestedPage, tempDir);
    if (!rendered.ok) return { ok: false, code: rendered.status?.code || 'PDF_PAGE_RENDER_FAILED', message: rendered.message };
    const digital = extractPdfPageText(current.vault_path, requestedPage);
    const ocr = ocrImage(rendered.pagePath);
    if (!ocr.ok) return { ok: false, code: ocr.status?.code || 'OCR_FAILED', message: ocr.message || 'OCR failed; visual security could not be evaluated' };
    const digitalText = digital.ok ? digital.text : '';
    const visualSecurity = scanOutgoingText(`${digitalText}\n${ocr.text}`, { source: `${resourceId}:page:${requestedPage}` });
    const pageSecurityStatus = visualSecurity.blocked ? 'blocked' : visualSecurity.redacted ? 'redact_required' : 'clear';
    const imageArtifact = archiveFile(db, { filePath: rendered.pagePath, workspaceId, provider: 'local', artifactType: 'pdf_page_image', sourcePathOverride: `derived:${current.version_id}:page_image:${requestedPage}`, metadata: { resource_version_id: current.version_id, page: requestedPage, rebuildable: true, ...rendered.dimensions } });
    const pageImageId = addRepresentation(db, { workspaceId, resourceId, versionId: current.version_id, kind: 'page_image', page: requestedPage, artifactId: imageArtifact?.id, extractor: 'pdftoppm', extractorVersion: rendered.status.version, contentSha256: imageArtifact?.sha256 || '', metadata: { ...rendered.dimensions, materialized_on_demand: true, visual_secret_analysis: 'ocr_based_not_mathematically_complete' }, securityStatus: pageSecurityStatus });
    const chunks = [];
    if (digitalText) {
      const digitalHash = sha256(digitalText);
      let digitalRepresentation = row(db, `SELECT id FROM resource_representations WHERE resource_version_id=? AND representation_kind='digital_text' AND page_start=? AND content_sha256=? ORDER BY created_at DESC LIMIT 1`, current.version_id, requestedPage, digitalHash);
      if (!digitalRepresentation) {
        const artifact = archiveDerivedText(db, { workspaceId, versionId: current.version_id, kind: 'digital_text', page: requestedPage, text: digitalText, tempDir });
        const id = addRepresentation(db, { workspaceId, resourceId, versionId: current.version_id, kind: 'digital_text', page: requestedPage, artifactId: artifact?.id, extractor: 'pdftotext', extractorVersion: digital.status.version, contentSha256: digitalHash, confidence: 1, trustClass: 'source_derived', metadata: { materialized_on_demand: true }, securityStatus: pageSecurityStatus });
        digitalRepresentation = { id };
      }
      const hasDigitalChunk = Number(row(db, `SELECT COUNT(*) AS n FROM resource_chunks WHERE resource_version_id=? AND page_start=? AND source_kind='digital_text'`, current.version_id, requestedPage)?.n || 0) > 0;
      if (!hasDigitalChunk) chunks.push(...chunkText(digitalText, { page: requestedPage, sourceKind: 'digital_text', confidence: 1, authority: 'source_derived' }).map(chunk => ({ ...chunk, representationId: digitalRepresentation.id })));
    }
    const similarity = textSimilarity(digitalText, ocr.text);
    const ocrHash = sha256(ocr.text);
    let ocrRepresentation = row(db, `SELECT id FROM resource_representations WHERE resource_version_id=? AND representation_kind='ocr_text' AND page_start=? AND content_sha256=? ORDER BY created_at DESC LIMIT 1`, current.version_id, requestedPage, ocrHash);
    if (!ocrRepresentation) {
      const ocrArtifact = archiveDerivedText(db, { workspaceId, versionId: current.version_id, kind: 'ocr_text', page: requestedPage, text: ocr.text, tempDir });
      const id = addRepresentation(db, { workspaceId, resourceId, versionId: current.version_id, kind: 'ocr_text', page: requestedPage, artifactId: ocrArtifact?.id, extractor: 'tesseract', extractorVersion: ocr.status.version, contentSha256: ocrHash, confidence: ocr.confidence, metadata: { regions: ocr.regions, deduplicated_from_digital: similarity >= 0.82, digital_similarity: similarity, untrusted_evidence: true, materialized_on_demand: true }, securityStatus: pageSecurityStatus });
      ocrRepresentation = { id };
    }
    const hasOcrChunk = Number(row(db, `SELECT COUNT(*) AS n FROM resource_chunks WHERE resource_version_id=? AND page_start=? AND source_kind='ocr_text'`, current.version_id, requestedPage)?.n || 0) > 0;
    if (similarity < 0.82 && !hasOcrChunk) chunks.push(...chunkText(ocr.text, { page: requestedPage, sourceKind: 'ocr_text', confidence: ocr.confidence, authority: 'untrusted_derived', region: { regions: ocr.regions } }).map(chunk => ({ ...chunk, representationId: ocrRepresentation.id })));
    appendVersionChunks(db, { workspaceId, resource: current, version: { id: current.version_id }, chunks, metadata: { materialized_on_demand: true, page: requestedPage } });

    let versionMetadata = {};
    try { versionMetadata = JSON.parse(current.metadata_json || '{}'); } catch {}
    const securityFindings = [...(versionMetadata.security_findings || []), ...visualSecurity.detections];
    const nextVersionSecurity = visualSecurity.blocked ? 'local_only:content-secret' : visualSecurity.redacted ? 'redact_required' : current.security_status;
    const processedPages = Number(row(db, `SELECT COUNT(DISTINCT page_start) AS n FROM resource_representations WHERE resource_version_id=? AND representation_kind='page_image' AND status='complete'`, current.version_id)?.n || 0);
    const onDemandPages = [...new Set([...(coverage.on_demand_pages || []), requestedPage])].sort((a, b) => a - b);
    const nextCoverage = { ...coverage, status: processedPages >= pageCount && coverage.processing_scope === 'complete_document' ? 'complete' : 'partial', processed_page_count: processedPages, pending_page_count: Math.max(0, pageCount - processedPages), on_demand_pages: onDemandPages, visual_secret_analysis: 'ocr_based_not_mathematically_complete' };
    run(db, 'UPDATE resource_versions SET security_status=?,metadata_json=?,representation_coverage=?,coverage_json=? WHERE id=?', nextVersionSecurity, JSON.stringify({ ...versionMetadata, security_findings: securityFindings }), nextCoverage.status, JSON.stringify(nextCoverage), current.version_id);
    if (visualSecurity.blocked) run(db, 'UPDATE workspace_resources SET provider_transmission_allowed=0,updated_at=? WHERE id=?', now(), resourceId);
    if (pageSecurityStatus !== 'clear') return { ok: false, code: 'VISUAL_PAGE_SECURITY_BLOCKED', message: `page ${requestedPage} contains possible secret material and cannot be attached`, security_status: pageSecurityStatus };
    return { ok: true, created: true, representation: row(db, `SELECT rr.*,a.name,a.mime_type,a.size_bytes,a.sha256 AS artifact_sha256 FROM resource_representations rr LEFT JOIN artifacts a ON a.id=rr.artifact_id WHERE rr.id=?`, pageImageId) };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

export function representationCoverage(db, workspaceId) {
  const items = rows(db, `SELECT r.id,r.relative_path,r.resource_type,r.current_version_id,v.representation_status,v.representation_coverage,v.coverage_json
    FROM workspace_resources r JOIN resource_versions v ON v.id=r.current_version_id WHERE r.workspace_id=? AND r.status='active' ORDER BY r.relative_path`, workspaceId)
    .map(item => ({ ...item, coverage: JSON.parse(item.coverage_json || '{}') }));
  return {
    status: items.some(item => item.representation_coverage === 'blocked') ? 'blocked' : items.some(item => !['complete','not_applicable'].includes(item.representation_coverage)) ? 'partial' : 'complete',
    total: items.length,
    complete: items.filter(item => item.representation_coverage === 'complete').length,
    partial: items.filter(item => item.representation_coverage === 'partial').length,
    blocked: items.filter(item => item.representation_coverage === 'blocked').length,
    items
  };
}

export function currentVisualRepresentations(db, workspaceId, { kinds = ['page_image','embedded_image','original_visual'] } = {}) {
  const placeholders = kinds.map(() => '?').join(',');
  return rows(db, `SELECT rr.*,a.name,a.mime_type,a.size_bytes,a.sha256 AS artifact_sha256,r.relative_path,wr.root_kind
    FROM resource_representations rr
    JOIN workspace_resources r ON r.id=rr.resource_id AND r.current_version_id=rr.resource_version_id AND r.status='active'
    JOIN workspace_roots wr ON wr.id=r.root_id AND wr.status='current'
    JOIN resource_versions v ON v.id=rr.resource_version_id
    LEFT JOIN artifacts a ON a.id=rr.artifact_id
    WHERE rr.workspace_id=? AND rr.status='complete' AND rr.representation_kind IN (${placeholders})
      AND rr.security_status='clear' AND v.security_status='clear'
      AND r.knowledge_status='active' AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1
    ORDER BY rr.created_at DESC,rr.page_start LIMIT 500`, workspaceId, ...kinds);
}
