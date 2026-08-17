import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { archiveFile, sha256File } from './archive.mjs';
import { row, rows, run, workspaceRoots } from './db.mjs';
import { extractFile, classifyResource } from './resource-extractors.mjs';
import { processMultimodalVersion, recordBasicRepresentation } from './multimodal.mjs';
import { classifySensitivePath, scanOutgoingText } from './security/secrets.mjs';
import { isPathWithin, normalizeRelativePath, resolveApprovedTarget, verifyRegisteredRoot, walkApprovedRoot } from './security/paths.mjs';
import { createBackgroundJob } from './jobs.mjs';

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function now() {
  return new Date().toISOString();
}

function scanExtractedContent(extraction, source) {
  const scanned = extraction.chunks?.length
    ? scanOutgoingText(extraction.chunks.map(chunk => chunk.content).join('\n'), { source })
    : { blocked: false, redacted: false, detections: [] };
  const additional = extraction.additionalSecurity || {};
  return {
    blocked: Boolean(scanned.blocked || additional.blocked),
    redacted: Boolean(scanned.redacted || additional.redacted),
    detections: [...(scanned.detections || []), ...(additional.detections || [])]
  };
}

function syncLegacyWorkspaceFile(db, { workspaceId, absolutePath, relativePath, sha256, stat, mimeType }) {
  const existing = row(db, 'SELECT * FROM workspace_files WHERE workspace_id=? AND local_path=? ORDER BY created_at LIMIT 1', workspaceId, absolutePath);
  const ts = now();
  if (existing) {
    run(db, `UPDATE workspace_files SET name=?,mime_type=?,relative_path=?,sha256=?,size_bytes=?,modified_at=?,updated_at=? WHERE id=?`,
      path.basename(absolutePath), mimeType, relativePath, sha256, stat.size, new Date(stat.mtimeMs).toISOString(), ts, existing.id);
    return;
  }
  run(db, `INSERT INTO workspace_files (id,workspace_id,name,mime_type,local_path,source_provider,source_url,notes,created_at,sha256,size_bytes,relative_path,modified_at,updated_at)
           VALUES (?,?,?,?,?,'local','','',?,?,?,?,?,?)`,
    `file-${randomUUID()}`, workspaceId, path.basename(absolutePath), mimeType, absolutePath, ts, sha256, stat.size, relativePath, new Date(stat.mtimeMs).toISOString(), ts);
}

function replaceVersionChunks(db, { workspaceId, resource, version, extraction }) {
  run(db, 'DELETE FROM resource_chunks WHERE resource_version_id=?', version.id);
  try { run(db, 'DELETE FROM resource_chunk_fts WHERE version_id=?', version.id); } catch {}
  const createdAt = now();
  extraction.chunks.forEach((chunk, ordinal) => {
    const id = `chunk-${randomUUID()}`;
    const contentHash = crypto.createHash('sha256').update(chunk.content).digest('hex');
    run(db, `INSERT INTO resource_chunks (id,workspace_id,resource_id,resource_version_id,ordinal,content,content_hash,line_start,line_end,page_start,page_end,metadata_json,created_at,representation_id,source_kind,authority,confidence,region_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, workspaceId, resource.id, version.id, ordinal, chunk.content, contentHash,
      chunk.lineStart || null, chunk.lineEnd || null, chunk.pageStart || null, chunk.pageEnd || null,
      JSON.stringify(extraction.metadata || {}), createdAt, chunk.representationId || null, chunk.sourceKind || 'digital_text',
      chunk.authority || 'source_derived', chunk.confidence ?? null, JSON.stringify(chunk.region || {}));
    try {
      run(db, `INSERT INTO resource_chunk_fts (chunk_id,workspace_id,resource_id,version_id,path,content) VALUES (?,?,?,?,?,?)`,
        id, workspaceId, resource.id, version.id, resource.relative_path, chunk.content);
    } catch {}
  });
}

function processVersion(db, { workspaceId, resource, version, artifactPath, logicalPath }) {
  const effective = { ...resource, resource_type: classifyResource(logicalPath).resourceType, mime_type: classifyResource(logicalPath).mimeType };
  if (effective.resource_type === 'pdf' || (effective.resource_type === 'image' && effective.mime_type !== 'image/svg+xml')) {
    const processed = processMultimodalVersion(db, { workspaceId, resource: effective, version, filePath: artifactPath });
    return { ...processed, metadata: { ...(processed.metadata || {}), multimodal: true, coverage: processed.coverage || {} } };
  }
  const extraction = extractFile(artifactPath, { logicalPath });
  const representations = recordBasicRepresentation(db, { workspaceId, resource: effective, version, extraction });
  return { ...extraction, chunks: representations.chunks, coverage: representations.coverage, metadata: { ...(extraction.metadata || {}), multimodal: false, coverage: representations.coverage } };
}

function retryFailedExtraction(db, { workspaceId, root, resource, version, metrics }) {
  if ((!['failed'].includes(version?.indexing_status) && !['partial','blocked','unknown'].includes(version?.representation_coverage)) || !version.archive_artifact_id) return version;
  const artifact = row(db, 'SELECT vault_path FROM artifacts WHERE id=?', version.archive_artifact_id);
  if (!artifact?.vault_path || !fs.existsSync(artifact.vault_path)) return version;
  const extractionStart = performance.now();
  const extraction = processVersion(db, { workspaceId, root, resource, version, artifactPath: artifact.vault_path, logicalPath: path.join(root.root_path, ...resource.relative_path.split('/')) });
  const metadata = { ...JSON.parse(version.metadata_json || '{}'), ...extraction.metadata, extraction_reason: extraction.reason || '', extraction_retried_at: now() };
  const indexingStatus = extraction.status === 'complete' ? 'complete' : extraction.status === 'not_extractable' ? 'not_applicable' : 'failed';
  const contentSecurity = extraction.status === 'complete' ? scanExtractedContent(extraction, resource.id) : { blocked: false, redacted: false, detections: [] };
  const sensitive = classifySensitivePath(resource.relative_path);
  const securityStatus = sensitive.sensitive ? `local_only:${sensitive.rule}` : contentSecurity.blocked ? 'local_only:content-secret' : contentSecurity.redacted ? 'redact_required' : 'clear';
  metadata.security_findings = contentSecurity.detections;
  if (extraction.status === 'complete') replaceVersionChunks(db, { workspaceId, resource, version, extraction });
  run(db, 'UPDATE resource_versions SET extraction_status=?,indexing_status=?,security_status=?,metadata_json=?,representation_status=?,representation_coverage=?,coverage_json=? WHERE id=?', extraction.status, indexingStatus, securityStatus, JSON.stringify(metadata), extraction.status, extraction.coverage?.status || 'unknown', JSON.stringify(extraction.coverage || {}), version.id);
  run(db, 'UPDATE workspace_resources SET provider_transmission_allowed=?,updated_at=? WHERE id=?', root.provider_transmission_allowed && !sensitive.sensitive && !contentSecurity.blocked ? 1 : 0, now(), resource.id);
  if (indexingStatus === 'complete') run(db, 'UPDATE workspace_resources SET updated_at=? WHERE id=?', now(), resource.id);
  if (extraction.coverage?.pending_page_count > 0) createBackgroundJob(db, { workspaceId, jobType: 'complete_pdf', targetType: 'resource_version', targetId: version.id });
  metrics.extraction_index_ms += performance.now() - extractionStart;
  return row(db, 'SELECT * FROM resource_versions WHERE id=?', version.id);
}

function archiveStableResource(db, { workspaceId, root, file, attempts = 3 }) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const artifact = archiveFile(db, {
      filePath: file.absolutePath,
      workspaceId,
      provider: 'local',
      artifactType: 'resource_version',
      sourcePathOverride: `workspace-root:${root.id}:${file.relativePath}`,
      metadata: { root_id: root.id, relative_path: file.relativePath, immutable_resource_version: true }
    });
    const liveSha256 = sha256File(file.absolutePath);
    const liveStat = fs.statSync(file.absolutePath);
    if (artifact?.sha256 === liveSha256 && Number(artifact.size_bytes) === Number(liveStat.size)) return { artifact, sha256: liveSha256, stat: liveStat };
  }
  throw Object.assign(new Error(`resource changed while it was being captured: ${file.relativePath}`), { code: 'ROOT_CHANGED_DURING_VERIFICATION' });
}

function versionResource(db, { workspaceId, root, file, existingResource, metrics }) {
  const classification = classifyResource(file.absolutePath);
  const initialHashStart = performance.now();
  let sha256 = sha256File(file.absolutePath);
  metrics.files_hashed += 1;
  metrics.hash_version_ms += performance.now() - initialHashStart;
  const sensitive = classifySensitivePath(file.relativePath);
  const current = existingResource?.current_version_id
    ? row(db, 'SELECT * FROM resource_versions WHERE id=?', existingResource.current_version_id)
    : null;
  if (current?.sha256 === sha256) {
    const liveStat = fs.statSync(file.absolutePath);
    run(db, `UPDATE workspace_resources SET status='active',mime_type=?,resource_type=?,provider_transmission_allowed=?,updated_at=? WHERE id=?`,
      classification.mimeType, classification.resourceType, root.provider_transmission_allowed && !sensitive.sensitive && !String(current.security_status).startsWith('local_only') ? 1 : 0, now(), existingResource.id);
    syncLegacyWorkspaceFile(db, { workspaceId, absolutePath: file.absolutePath, relativePath: file.relativePath, sha256, stat: liveStat, mimeType: classification.mimeType });
    return { changed: false, indexRecovered: false, resource: existingResource, version: current, extractionFailed: current.indexing_status === 'failed', inventory: { path: file.relativePath, sha256, size: liveStat.size } };
  }

  const archiveStart = performance.now();
  const snapshot = archiveStableResource(db, { workspaceId, root, file });
  metrics.hash_version_ms += performance.now() - archiveStart;
  sha256 = snapshot.sha256;
  if (current?.sha256 === sha256) {
    run(db, `UPDATE workspace_resources SET status='active',mime_type=?,resource_type=?,provider_transmission_allowed=?,updated_at=? WHERE id=?`,
      classification.mimeType, classification.resourceType, root.provider_transmission_allowed && !sensitive.sensitive && !String(current.security_status).startsWith('local_only') ? 1 : 0, now(), existingResource.id);
    syncLegacyWorkspaceFile(db, { workspaceId, absolutePath: file.absolutePath, relativePath: file.relativePath, sha256, stat: snapshot.stat, mimeType: classification.mimeType });
    return { changed: false, resource: existingResource, version: current, extractionFailed: current.indexing_status === 'failed', inventory: { path: file.relativePath, sha256, size: snapshot.stat.size } };
  }
  const resourceId = existingResource?.id || `resource-${randomUUID()}`;
  const createdAt = now();
  const priorVersion = existingResource ? row(db, 'SELECT * FROM resource_versions WHERE resource_id=? AND sha256=?', existingResource.id, sha256) : null;
  if (priorVersion) {
    run(db, `UPDATE workspace_resources SET current_version_id=?,status='active',resource_type=?,mime_type=?,provider_transmission_allowed=?,updated_at=? WHERE id=?`,
      priorVersion.id, classification.resourceType, classification.mimeType, root.provider_transmission_allowed && !sensitive.sensitive && !String(priorVersion.security_status).startsWith('local_only') ? 1 : 0, createdAt, existingResource.id);
    syncLegacyWorkspaceFile(db, { workspaceId, absolutePath: file.absolutePath, relativePath: file.relativePath, sha256, stat: snapshot.stat, mimeType: classification.mimeType });
    return {
      changed: true,
      resource: row(db, 'SELECT * FROM workspace_resources WHERE id=?', existingResource.id),
      version: priorVersion,
      extractionFailed: priorVersion.indexing_status === 'failed',
      inventory: { path: file.relativePath, sha256, size: snapshot.stat.size }
    };
  }
  if (!existingResource) {
    run(db, `INSERT INTO workspace_resources (id,workspace_id,root_id,relative_path,resource_type,mime_type,status,provider_transmission_allowed,created_at,updated_at)
             VALUES (?,?,?,?,?,?,'active',?,?,?)`,
      resourceId, workspaceId, root.id, file.relativePath, classification.resourceType, classification.mimeType,
      root.provider_transmission_allowed && !sensitive.sensitive ? 1 : 0, createdAt, createdAt);
  }
  const resource = row(db, 'SELECT * FROM workspace_resources WHERE id=?', resourceId);
  const artifact = snapshot.artifact;
  const extractionStart = performance.now();
  metrics.files_processed += 1;
  const versionId = `version-${randomUUID()}`;
  run(db, `INSERT INTO resource_versions (id,resource_id,sha256,size_bytes,modified_at,observed_at,archive_artifact_id,extraction_status,indexing_status,security_status,metadata_json,representation_status,representation_coverage,coverage_json)
           VALUES (?,?,?,?,?,?,?,'processing','processing','unchecked','{}','processing','unknown','{}')`,
    versionId, resourceId, sha256, snapshot.stat.size, new Date(snapshot.stat.mtimeMs).toISOString(), createdAt, artifact?.id || null);
  const version = row(db, 'SELECT * FROM resource_versions WHERE id=?', versionId);
  const extraction = processVersion(db, { workspaceId, root, resource: { ...resource, resource_type: classification.resourceType, mime_type: classification.mimeType }, version, artifactPath: artifact.vault_path, logicalPath: file.absolutePath });
  const contentSecurity = scanExtractedContent(extraction, resourceId);
  const transmissionAllowed = root.provider_transmission_allowed && !sensitive.sensitive && !contentSecurity.blocked;
  const securityStatus = sensitive.sensitive
    ? `local_only:${sensitive.rule}`
    : contentSecurity.blocked
      ? 'local_only:content-secret'
      : contentSecurity.redacted
        ? 'redact_required'
        : 'clear';
  const indexingStatus = extraction.status === 'complete' ? 'complete' : extraction.status === 'not_extractable' ? 'not_applicable' : 'failed';
  run(db, `UPDATE resource_versions SET extraction_status=?,indexing_status=?,security_status=?,metadata_json=?,representation_status=?,representation_coverage=?,coverage_json=? WHERE id=?`,
    extraction.status, indexingStatus, securityStatus,
    JSON.stringify({ ...extraction.metadata, extraction_reason: extraction.reason || '', root_id: root.id, relative_path: file.relativePath, security_findings: contentSecurity.detections }),
    extraction.status, extraction.coverage?.status || 'unknown', JSON.stringify(extraction.coverage || {}), versionId);
  if (extraction.status === 'complete') replaceVersionChunks(db, { workspaceId, resource, version, extraction });
  if (extraction.coverage?.pending_page_count > 0) createBackgroundJob(db, { workspaceId, jobType: 'complete_pdf', targetType: 'resource_version', targetId: versionId });
  metrics.extraction_index_ms += performance.now() - extractionStart;
  run(db, `UPDATE workspace_resources SET current_version_id=?,status='active',resource_type=?,mime_type=?,provider_transmission_allowed=?,updated_at=? WHERE id=?`,
    versionId, classification.resourceType, classification.mimeType, transmissionAllowed ? 1 : 0, createdAt, resourceId);
  syncLegacyWorkspaceFile(db, { workspaceId, absolutePath: file.absolutePath, relativePath: file.relativePath, sha256, stat: snapshot.stat, mimeType: classification.mimeType });
  return {
    changed: true,
    resource: row(db, 'SELECT * FROM workspace_resources WHERE id=?', resourceId),
    version: row(db, 'SELECT * FROM resource_versions WHERE id=?', versionId),
    extractionFailed: indexingStatus === 'failed',
    inventory: { path: file.relativePath, sha256, size: snapshot.stat.size }
  };
}

function manifestMetadata(file) {
  const stat = file.stat;
  const nanoseconds = value => String(Math.round(Number(value || 0) * 1_000_000));
  return {
    size_bytes: Number(stat.size || 0),
    modified_ns: nanoseconds(stat.mtimeMs),
    changed_ns: nanoseconds(stat.ctimeMs),
    file_identity: `${String(stat.dev || '')}:${String(stat.ino || '')}:${nanoseconds(stat.birthtimeMs)}`
  };
}

function manifestMetadataMatches(entry, file) {
  if (!entry) return false;
  const current = manifestMetadata(file);
  return Number(entry.size_bytes) === current.size_bytes
    && String(entry.modified_ns) === current.modified_ns
    && String(entry.changed_ns || '') === current.changed_ns
    && String(entry.file_identity || '') === current.file_identity;
}

function upsertRootManifestEntry(db, { root, file, resource, version, generation }) {
  const metadata = manifestMetadata(file);
  run(db, `INSERT INTO root_manifest_entries (root_id,relative_path,resource_id,resource_version_id,size_bytes,modified_ns,changed_ns,file_identity,sha256,verified_generation,verified_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(root_id,relative_path) DO UPDATE SET
      resource_id=excluded.resource_id,resource_version_id=excluded.resource_version_id,size_bytes=excluded.size_bytes,modified_ns=excluded.modified_ns,
      changed_ns=excluded.changed_ns,file_identity=excluded.file_identity,sha256=excluded.sha256,verified_generation=excluded.verified_generation,verified_at=excluded.verified_at`,
    root.id, file.relativePath, resource.id, version.id, metadata.size_bytes, metadata.modified_ns, metadata.changed_ns, metadata.file_identity,
    version.sha256, generation, now());
  return { path: file.relativePath, sha256: version.sha256, size: metadata.size_bytes, ...metadata };
}

export function reconcileWorkspaceResources(db, workspaceId, { maxFilesPerRoot = 20000, fullIntegrity = false } = {}) {
  const workspace = row(db, 'SELECT * FROM workspaces WHERE id=?', workspaceId);
  if (!workspace) throw Object.assign(new Error('workspace not found'), { code: 'WORKSPACE_NOT_FOUND' });
  const roots = workspaceRoots(db, workspaceId);
  const reasons = [];
  const rootDetails = [];
  let changedCount = 0;
  let deletedCount = 0;
  let renamedCount = 0;
  let indexedCount = 0;
  let extractionFailures = 0;
  let indexRecoveredCount = 0;
  const metrics = { root_inventory_ms: 0, hash_version_ms: 0, extraction_index_ms: 0, files_inventory_count: 0, candidate_files: 0, files_hashed: 0, files_processed: 0, full_integrity: fullIntegrity ? 1 : 0 };

  for (const root of roots) {
    if (root.root_kind === 'provider_archive') {
      run(db, `UPDATE workspace_roots SET status='current',last_verified_at=?,updated_at=? WHERE id=?`, now(), now(), root.id);
      rootDetails.push({ root_id: root.id, status: 'current', source: 'content_addressed_provider_archive', files: Number(row(db, `SELECT COUNT(*) AS n FROM workspace_resources WHERE root_id=? AND status='active'`, root.id)?.n || 0) });
      continue;
    }
    if (!root.indexing_enabled) {
      const verified = verifyRegisteredRoot(root);
      if (!verified.ok && root.required_for_freshness) reasons.push({ code: verified.code, root_id: root.id, message: verified.message });
      run(db, `UPDATE workspace_roots SET status=?,last_verified_at=?,updated_at=? WHERE id=?`, verified.ok ? 'current' : 'blocked', now(), now(), root.id);
      rootDetails.push({ root_id: root.id, status: verified.ok ? 'local_only_unindexed' : 'blocked', code: verified.code || '', message: verified.message || '', files: 0 });
      continue;
    }
    const inventoryStart = performance.now();
    const scan = walkApprovedRoot(root, { maxFiles: maxFilesPerRoot });
    metrics.root_inventory_ms += performance.now() - inventoryStart;
    metrics.files_inventory_count += scan.files?.length || 0;
    if (!scan.ok) {
      run(db, `UPDATE workspace_roots SET status='blocked',last_verified_at=?,updated_at=? WHERE id=?`, now(), now(), root.id);
      rootDetails.push({ root_id: root.id, status: 'blocked', code: scan.code, message: scan.message });
      if (root.required_for_freshness) reasons.push({ code: scan.code || 'ROOT_UNAVAILABLE', root_id: root.id, message: scan.message });
      continue;
    }
    if (!root.canonical_path) run(db, 'UPDATE workspace_roots SET canonical_path=? WHERE id=?', scan.canonicalPath, root.id);
    const seen = new Set();
    const inventory = [];
    let verificationFailure = null;
    const manifest = new Map(rows(db, 'SELECT * FROM root_manifest_entries WHERE root_id=?', root.id).map(item => [item.relative_path, item]));
    const scannedPaths = new Set(scan.files.map(item => item.relativePath));
    let rootCandidateCount = 0;
    for (const file of scan.files) {
      seen.add(file.relativePath);
      let existing = row(db, 'SELECT * FROM workspace_resources WHERE root_id=? AND relative_path=?', root.id, file.relativePath);
      try {
        if (!existing) {
          const metadata = manifestMetadata(file);
          const renameCandidates = [...manifest.values()].filter(item => !scannedPaths.has(item.relative_path)
            && item.file_identity && item.file_identity === metadata.file_identity && Number(item.size_bytes) === metadata.size_bytes);
          if (renameCandidates.length === 1) {
            const prior = row(db, `SELECT * FROM workspace_resources WHERE id=? AND root_id=? AND status='active'`, renameCandidates[0].resource_id, root.id);
            if (prior) {
              run(db, 'UPDATE workspace_resources SET relative_path=?,updated_at=? WHERE id=?', file.relativePath, now(), prior.id);
              try { run(db, 'UPDATE resource_chunk_fts SET path=? WHERE resource_id=?', file.relativePath, prior.id); } catch {}
              run(db, 'DELETE FROM root_manifest_entries WHERE root_id=? AND relative_path=?', root.id, renameCandidates[0].relative_path);
              const oldAbsolutePath = path.join(scan.canonicalPath, ...renameCandidates[0].relative_path.split('/'));
              for (const legacy of rows(db, 'SELECT id FROM workspace_files WHERE workspace_id=? AND local_path=?', workspaceId, oldAbsolutePath)) run(db, 'DELETE FROM workspace_files WHERE id=?', legacy.id);
              existing = row(db, 'SELECT * FROM workspace_resources WHERE id=?', prior.id);
              renamedCount += 1;
              changedCount += 1;
            }
          }
        }
        const entry = manifest.get(file.relativePath);
        const currentVersion = existing?.current_version_id ? row(db, 'SELECT * FROM resource_versions WHERE id=?', existing.current_version_id) : null;
        const candidate = fullIntegrity || !existing || existing.status !== 'active' || !currentVersion || !manifestMetadataMatches(entry, file)
          || entry.resource_id !== existing.id || entry.resource_version_id !== currentVersion.id || entry.sha256 !== currentVersion.sha256;
        let result;
        if (candidate) {
          metrics.candidate_files += 1;
          rootCandidateCount += 1;
          result = versionResource(db, { workspaceId, root, file, existingResource: existing, metrics });
        } else {
          result = { changed: false, indexRecovered: false, resource: existing, version: currentVersion, extractionFailed: currentVersion.indexing_status === 'failed' };
        }
        if (result.changed) changedCount += 1;
        if (result.indexRecovered) indexRecoveredCount += 1;
        if (result.extractionFailed) extractionFailures += 1;
        if (result.version?.indexing_status === 'complete') indexedCount += 1;
        inventory.push(upsertRootManifestEntry(db, { root, file, resource: result.resource, version: result.version, generation: Number(workspace.corpus_generation || 0) + (result.changed ? 1 : 0) }));
      } catch (error) {
        verificationFailure = { code: error.code || 'ROOT_CHANGED_DURING_VERIFICATION', root_id: root.id, message: error.message };
        break;
      }
    }
    if (verificationFailure) {
      run(db, `UPDATE workspace_roots SET status='blocked',last_verified_at=?,updated_at=? WHERE id=?`, now(), now(), root.id);
      rootDetails.push({ root_id: root.id, status: 'blocked', code: verificationFailure.code, message: verificationFailure.message });
      if (root.required_for_freshness) reasons.push(verificationFailure);
      continue;
    }
    for (const resource of rows(db, `SELECT * FROM workspace_resources WHERE root_id=? AND status='active'`, root.id)) {
      if (seen.has(resource.relative_path)) continue;
      run(db, `UPDATE workspace_resources SET status='deleted',updated_at=? WHERE id=?`, now(), resource.id);
      const priorAbsolutePath = path.join(scan.canonicalPath, ...resource.relative_path.split('/'));
      const legacy = rows(db, 'SELECT id FROM workspace_files WHERE workspace_id=? AND local_path=?', workspaceId, priorAbsolutePath);
      for (const item of legacy) run(db, 'DELETE FROM workspace_files WHERE id=?', item.id);
      run(db, 'DELETE FROM root_manifest_entries WHERE root_id=? AND relative_path=?', root.id, resource.relative_path);
      deletedCount += 1;
    }
    const rootHash = hashJson(inventory.sort((a, b) => a.path.localeCompare(b.path)));
    const verificationInventoryStart = performance.now();
    const verificationScan = walkApprovedRoot(root, { maxFiles: maxFilesPerRoot });
    metrics.root_inventory_ms += performance.now() - verificationInventoryStart;
    if (!verificationScan.ok) {
      const failure = { code: verificationScan.code || 'ROOT_CHANGED_DURING_VERIFICATION', root_id: root.id, message: verificationScan.message || 'root changed during verification' };
      run(db, `UPDATE workspace_roots SET status='blocked',last_verified_at=?,updated_at=? WHERE id=?`, now(), now(), root.id);
      rootDetails.push({ root_id: root.id, status: 'blocked', code: failure.code, message: failure.message });
      if (root.required_for_freshness) reasons.push(failure);
      continue;
    }
    let verifiedRootHash = '';
    try {
      const initialByPath = new Map(scan.files.map(item => [item.relativePath, item]));
      const inventoryByPath = new Map(inventory.map(item => [item.path, item]));
      const metadataStable = verificationScan.files.length === scan.files.length && verificationScan.files.every(item => {
        const before = initialByPath.get(item.relativePath);
        return before && manifestMetadataMatches(manifestMetadata(before), item) && inventoryByPath.has(item.relativePath);
      });
      if (!metadataStable) throw Object.assign(new Error('root metadata inventory changed during verification'), { code: 'ROOT_CHANGED_DURING_VERIFICATION' });
      if (fullIntegrity) {
        const finalHashStart = performance.now();
        const verified = verificationScan.files.map(item => {
          const digest = sha256File(item.absolutePath);
          metrics.files_hashed += 1;
          return { path: item.relativePath, sha256: digest, size: item.stat.size, ...manifestMetadata(item) };
        }).sort((a, b) => a.path.localeCompare(b.path));
        metrics.hash_version_ms += performance.now() - finalHashStart;
        verifiedRootHash = hashJson(verified);
      } else {
        verifiedRootHash = rootHash;
      }
    } catch (error) {
      verificationFailure = { code: error.code || 'ROOT_CHANGED_DURING_VERIFICATION', root_id: root.id, message: `root changed during final verification: ${error.message}` };
    }
    if (verificationFailure || verifiedRootHash !== rootHash) {
      const failure = verificationFailure || { code: 'ROOT_CHANGED_DURING_VERIFICATION', root_id: root.id, message: 'root inventory changed during freshness verification; retry against the new state' };
      run(db, `UPDATE workspace_roots SET status='blocked',last_verified_at=?,updated_at=? WHERE id=?`, now(), now(), root.id);
      rootDetails.push({ root_id: root.id, status: 'blocked', code: failure.code, message: failure.message });
      if (root.required_for_freshness) reasons.push(failure);
      continue;
    }
    run(db, `UPDATE workspace_roots SET canonical_path=?,status='current',last_verified_at=?,updated_at=? WHERE id=?`, scan.canonicalPath, now(), now(), root.id);
    rootDetails.push({ root_id: root.id, status: 'current', verification_mode: fullIntegrity ? 'full_integrity' : rootCandidateCount ? 'delta_candidates' : 'warm_manifest', candidate_files: rootCandidateCount, file_count: scan.files.length, skipped_symlinks: scan.skippedSymlinks.length, ignored_directories: scan.ignoredDirectories.length, state_hash: rootHash });
  }

  const requiredExtractionFailures = rows(db, `SELECT r.id,r.relative_path,v.extraction_status,v.indexing_status
    FROM workspace_resources r
    JOIN workspace_roots wr ON wr.id=r.root_id
    JOIN resource_versions v ON v.id=r.current_version_id
    WHERE r.workspace_id=? AND r.status='active' AND wr.required_for_freshness=1
      AND r.resource_type IN ('text','code') AND v.indexing_status='failed'`, workspaceId);
  for (const failed of requiredExtractionFailures) reasons.push({ code: 'RESOURCE_INDEX_FAILED', resource_id: failed.id, message: `current resource could not be indexed: ${failed.relative_path}` });

  const criticalResourceFailures = rows(db, `SELECT r.id,r.relative_path,v.extraction_status,v.indexing_status,v.security_status,v.representation_coverage
    FROM workspace_resources r
    JOIN workspace_roots wr ON wr.id=r.root_id
    JOIN resource_versions v ON v.id=r.current_version_id
    WHERE r.workspace_id=? AND r.status='active' AND r.knowledge_status='active' AND r.context_critical=1
      AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1
      AND (v.indexing_status NOT IN ('complete','not_applicable') OR v.security_status!='clear' OR v.representation_coverage IN ('partial','blocked','unknown'))`, workspaceId);
  for (const failed of criticalResourceFailures) reasons.push({
    code: 'CONTEXT_CRITICAL_RESOURCE_NOT_READY',
    resource_id: failed.id,
    message: `context-critical resource is not fully ready for verified retrieval: ${failed.relative_path}`,
    details: {
      extraction_status: failed.extraction_status,
      indexing_status: failed.indexing_status,
      security_status: failed.security_status,
      representation_coverage: failed.representation_coverage
    }
  });

  const previousCorpus = Number(workspace.corpus_generation || 0);
  const previousIndex = Number(workspace.index_generation || 0);
  const sourceChanged = Boolean(changedCount || deletedCount);
  const corpusGeneration = previousCorpus + (sourceChanged ? 1 : 0);
  if (!sourceChanged && !indexRecoveredCount && previousIndex !== previousCorpus) {
    reasons.push({ code: 'INDEX_GENERATION_MISMATCH', message: 'the retrieval index generation does not match the known corpus generation' });
  }
  const indexGeneration = reasons.length ? previousIndex : corpusGeneration;
  const freshness = reasons.length ? 'blocked' : 'verifying';
  run(db, `UPDATE workspaces SET corpus_generation=?,index_generation=?,freshness_status=?,updated_at=? WHERE id=?`, corpusGeneration, indexGeneration, freshness, now(), workspaceId);
  return {
    ok: reasons.length === 0,
    reasons,
    changed_count: changedCount,
    deleted_count: deletedCount,
    renamed_count: renamedCount,
    indexed_count: indexedCount,
    extraction_failures: extractionFailures,
    index_recovered_count: indexRecoveredCount,
    corpus_generation: corpusGeneration,
    index_generation: indexGeneration,
    root_state_hash: hashJson(rootDetails.map(item => ({ root_id: item.root_id, status: item.status, state_hash: item.state_hash || '', files: item.files ?? item.file_count ?? 0, code: item.code || '' }))),
    roots: rootDetails,
    diagnostics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, Number.isInteger(value) ? value : Number(value.toFixed(2))])),
    fast_path: !fullIntegrity && metrics.candidate_files === 0 && metrics.files_hashed === 0 && metrics.files_processed === 0
  };
}

export function recordResourceRelationship(db, {
  workspaceId, sourceType, sourceId, relationshipType, targetType, targetId, provenance = {}
}) {
  const id = `relationship-${randomUUID()}`;
  run(db, `INSERT INTO resource_relationships (id,workspace_id,source_type,source_id,relationship_type,target_type,target_id,provenance_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,source_type,source_id,relationship_type,target_type,target_id)
    DO UPDATE SET provenance_json=excluded.provenance_json`,
    id, workspaceId, sourceType, sourceId, relationshipType, targetType, targetId, JSON.stringify(provenance || {}), now());
  return row(db, `SELECT * FROM resource_relationships WHERE workspace_id=? AND source_type=? AND source_id=? AND relationship_type=? AND target_type=? AND target_id=?`,
    workspaceId, sourceType, sourceId, relationshipType, targetType, targetId);
}

export function ingestProviderArtifactResource(db, {
  workspaceId,
  artifact,
  sourceId,
  provider = 'provider',
  name = '',
  sourceType = 'provider_generated_asset',
  provenance = {}
}) {
  if (!artifact?.id || !artifact.vault_path || !fs.existsSync(artifact.vault_path)) throw Object.assign(new Error('captured provider artifact is unavailable'), { code: 'PROVIDER_ARTIFACT_MISSING' });
  if (!row(db, 'SELECT id FROM workspaces WHERE id=?', workspaceId)) throw Object.assign(new Error('workspace not found'), { code: 'WORKSPACE_NOT_FOUND' });
  const normalizedSourceType = sourceType === 'provider_user_attachment' || sourceType === 'clipboard_image'
    ? sourceType
    : 'provider_generated_asset';
  if (normalizedSourceType !== 'provider_generated_asset') {
    const matches = rows(db, `SELECT r.*,v.id AS version_id,v.sha256,v.size_bytes,wr.root_kind
      FROM workspace_resources r
      JOIN resource_versions v ON v.id=r.current_version_id
      JOIN workspace_roots wr ON wr.id=r.root_id
      WHERE r.workspace_id=? AND r.status='active' AND wr.root_kind!='provider_archive' AND v.sha256=?`, workspaceId, artifact.sha256);
    if (matches.length === 1) {
      const matched = matches[0];
      recordResourceRelationship(db, { workspaceId, sourceType: 'session_asset', sourceId, relationshipType: 'attached_existing_resource', targetType: 'resource_version', targetId: matched.version_id,
        provenance: { ...provenance, exact_sha256: artifact.sha256, reconciliation: 'unique_current_approved_root_hash', source_type: normalizedSourceType } });
      return { resource: row(db, 'SELECT * FROM workspace_resources WHERE id=?', matched.id), version: row(db, 'SELECT * FROM resource_versions WHERE id=?', matched.version_id), reconciled: true };
    }
  }
  const canonical = `provider-archive:${workspaceId}`;
  let root = row(db, 'SELECT * FROM workspace_roots WHERE workspace_id=? AND canonical_path=?', workspaceId, canonical);
  const ts = now();
  if (!root) {
    const rootId = `root-provider-${randomUUID()}`;
    run(db, `INSERT INTO workspace_roots (id,workspace_id,root_path,canonical_path,root_kind,label,required_for_freshness,indexing_enabled,provider_transmission_allowed,status,last_verified_at,created_at,updated_at)
      VALUES (?,?,?,?,'provider_archive',?,0,0,1,'current',?,?,?)`, rootId, workspaceId, '', canonical, 'Captured native-chat resources', ts, ts, ts);
    root = row(db, 'SELECT * FROM workspace_roots WHERE id=?', rootId);
  }
  const safeName = String(name || artifact.name || 'captured-output').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').slice(0, 180) || 'captured-output';
  const category = normalizedSourceType === 'provider_generated_asset' ? 'provider-output' : 'user-input';
  const relativePath = `${category}/${provider}/${String(sourceId || artifact.id).replace(/[^A-Za-z0-9_.-]/g, '_')}/${safeName}`;
  let resource = row(db, 'SELECT * FROM workspace_resources WHERE root_id=? AND relative_path=?', root.id, relativePath);
  const classification = classifyResource(relativePath);
  if (!resource) {
    const resourceId = `resource-${randomUUID()}`;
    run(db, `INSERT INTO workspace_resources (id,workspace_id,root_id,relative_path,resource_type,mime_type,status,provider_transmission_allowed,created_at,updated_at,source_type,origin_json)
      VALUES (?,?,?,?,?,?,'active',1,?,?,?,?)`,
      resourceId, workspaceId, root.id, relativePath, classification.resourceType, artifact.mime_type || classification.mimeType, ts, ts,
      normalizedSourceType, JSON.stringify({ provider, original_name: safeName, imported_at: ts, ...provenance }));
    resource = row(db, 'SELECT * FROM workspace_resources WHERE id=?', resourceId);
  }
  const existing = row(db, 'SELECT * FROM resource_versions WHERE resource_id=? AND sha256=?', resource.id, artifact.sha256);
  if (existing) {
    run(db, `UPDATE workspace_resources SET current_version_id=?,status='active',updated_at=? WHERE id=?`, existing.id, ts, resource.id);
    recordResourceRelationship(db, { workspaceId, sourceType: 'session_asset', sourceId, relationshipType: normalizedSourceType === 'provider_generated_asset' ? 'generated_resource' : 'introduced_resource', targetType: 'resource_version', targetId: existing.id,
      provenance: { ...provenance, exact_sha256: artifact.sha256, source_type: normalizedSourceType } });
    return { resource: row(db, 'SELECT * FROM workspace_resources WHERE id=?', resource.id), version: existing, reconciled: false };
  }
  const versionId = `version-${randomUUID()}`;
  run(db, `INSERT INTO resource_versions (id,resource_id,sha256,size_bytes,observed_at,archive_artifact_id,extraction_status,indexing_status,security_status,metadata_json,representation_status,representation_coverage,coverage_json)
    VALUES (?,?,?,?,?,?,'processing','processing','unchecked','{}','processing','unknown','{}')`, versionId, resource.id, artifact.sha256, artifact.size_bytes, ts, artifact.id);
  const version = row(db, 'SELECT * FROM resource_versions WHERE id=?', versionId);
  const extraction = processVersion(db, { workspaceId, resource: { ...resource, resource_type: classification.resourceType, mime_type: artifact.mime_type || classification.mimeType }, version, artifactPath: artifact.vault_path, logicalPath: relativePath });
  const security = scanExtractedContent(extraction, resource.id);
  const securityStatus = security.blocked ? 'local_only:content-secret' : security.redacted ? 'redact_required' : 'clear';
  const indexingStatus = extraction.status === 'complete' ? 'complete' : extraction.status === 'not_extractable' ? 'not_applicable' : 'failed';
    if (extraction.status === 'complete') replaceVersionChunks(db, { workspaceId, resource, version, extraction });
  run(db, `UPDATE resource_versions SET extraction_status=?,indexing_status=?,security_status=?,metadata_json=?,representation_status=?,representation_coverage=?,coverage_json=? WHERE id=?`,
    extraction.status, indexingStatus, securityStatus, JSON.stringify({ ...(extraction.metadata || {}), captured_provider: provider, source_id: sourceId, source_type: normalizedSourceType, provenance, security_findings: security.detections }), extraction.status, extraction.coverage?.status || 'unknown', JSON.stringify(extraction.coverage || {}), version.id);
  if (extraction.coverage?.pending_page_count > 0) createBackgroundJob(db, { workspaceId, jobType: 'complete_pdf', targetType: 'resource_version', targetId: version.id });
  run(db, `UPDATE workspace_resources SET current_version_id=?,provider_transmission_allowed=?,updated_at=? WHERE id=?`, version.id, security.blocked ? 0 : 1, ts, resource.id);
  recordResourceRelationship(db, { workspaceId, sourceType: 'session_asset', sourceId, relationshipType: normalizedSourceType === 'provider_generated_asset' ? 'generated_resource' : 'introduced_resource', targetType: 'resource_version', targetId: version.id,
    provenance: { ...provenance, exact_sha256: artifact.sha256, source_type: normalizedSourceType } });
  run(db, `UPDATE workspaces SET corpus_generation=corpus_generation+1,index_generation=index_generation+1,freshness_status='stale',updated_at=? WHERE id=?`, ts, workspaceId);
  return { resource: row(db, 'SELECT * FROM workspace_resources WHERE id=?', resource.id), version: row(db, 'SELECT * FROM resource_versions WHERE id=?', version.id), reconciled: false };
}

export function currentWorkspaceResources(db, workspaceId, { transmissionOnly = false } = {}) {
  const transmission = transmissionOnly ? " AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1 AND wr.status='current'" : '';
  return rows(db, `SELECT r.*,v.sha256,v.size_bytes,v.modified_at,v.observed_at,v.archive_artifact_id,v.extraction_status,v.indexing_status,v.security_status,
    v.representation_status,v.representation_coverage,v.coverage_json,
    wr.label AS root_label,wr.root_kind,wr.provider_transmission_allowed AS root_transmission_allowed
    FROM workspace_resources r
    JOIN workspace_roots wr ON wr.id=r.root_id
    LEFT JOIN resource_versions v ON v.id=r.current_version_id
    WHERE r.workspace_id=? AND r.status='active'${transmission}
    ORDER BY r.relative_path`, workspaceId);
}

export function reprocessResourceVersion(db, resourceId) {
  const resource = row(db, `SELECT r.*,v.id AS version_id,v.archive_artifact_id,wr.root_path,
    wr.provider_transmission_allowed AS root_transmission_allowed
    FROM workspace_resources r JOIN resource_versions v ON v.id=r.current_version_id JOIN workspace_roots wr ON wr.id=r.root_id WHERE r.id=? AND r.status='active'`, resourceId);
  if (!resource) throw Object.assign(new Error('active resource not found'), { code: 'RESOURCE_NOT_FOUND' });
  const version = row(db, 'SELECT * FROM resource_versions WHERE id=?', resource.version_id);
  const artifact = row(db, 'SELECT * FROM artifacts WHERE id=?', resource.archive_artifact_id);
  if (!artifact?.vault_path || !fs.existsSync(artifact.vault_path)) throw Object.assign(new Error('immutable resource source is unavailable'), { code: 'RESOURCE_ARCHIVE_MISSING' });
  const logicalPath = path.join(resource.root_path, ...resource.relative_path.split('/'));
  const extraction = processVersion(db, { workspaceId: resource.workspace_id, resource, version, artifactPath: artifact.vault_path, logicalPath });
  const scan = scanExtractedContent(extraction, resource.id);
  const indexingStatus = extraction.status === 'complete' ? 'complete' : extraction.status === 'not_extractable' ? 'not_applicable' : 'failed';
  const securityStatus = scan.blocked ? 'local_only:content-secret' : scan.redacted ? 'redact_required' : version.security_status?.startsWith('local_only:') ? version.security_status : 'clear';
  if (extraction.status === 'complete') replaceVersionChunks(db, { workspaceId: resource.workspace_id, resource, version, extraction });
  run(db, `UPDATE resource_versions SET extraction_status=?,indexing_status=?,security_status=?,representation_status=?,representation_coverage=?,coverage_json=?,metadata_json=? WHERE id=?`,
    extraction.status, indexingStatus, securityStatus, extraction.status, extraction.coverage?.status || 'unknown', JSON.stringify(extraction.coverage || {}),
    JSON.stringify({ ...(JSON.parse(version.metadata_json || '{}')), ...(extraction.metadata || {}), security_findings: scan.detections, reprocessed_at: now() }), version.id);
  if (extraction.coverage?.pending_page_count > 0) createBackgroundJob(db, { workspaceId: resource.workspace_id, jobType: 'complete_pdf', targetType: 'resource_version', targetId: version.id });
  run(db, 'UPDATE workspace_resources SET provider_transmission_allowed=?,updated_at=? WHERE id=?',
    resource.root_transmission_allowed && !securityStatus.startsWith('local_only:') ? 1 : 0, now(), resource.id);
  const remainingBlockers = Number(row(db, `SELECT COUNT(*) AS n FROM workspace_resources r
    JOIN workspace_roots wr ON wr.id=r.root_id JOIN resource_versions v ON v.id=r.current_version_id
    WHERE r.workspace_id=? AND r.status='active' AND (
      (wr.required_for_freshness=1 AND r.resource_type IN ('text','code') AND v.indexing_status='failed') OR
      (r.knowledge_status='active' AND r.context_critical=1 AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1
        AND (v.indexing_status NOT IN ('complete','not_applicable') OR v.security_status!='clear' OR v.representation_coverage IN ('partial','blocked','unknown')))
    )`, resource.workspace_id)?.n || 0);
  if (remainingBlockers === 0) run(db, `UPDATE workspaces SET index_generation=corpus_generation,freshness_status='stale',updated_at=? WHERE id=?`, now(), resource.workspace_id);
  return { resource: row(db, 'SELECT * FROM workspace_resources WHERE id=?', resource.id), version: row(db, 'SELECT * FROM resource_versions WHERE id=?', version.id), representations: rows(db, 'SELECT * FROM resource_representations WHERE resource_version_id=? ORDER BY page_start,representation_kind', version.id) };
}

export function resolveCurrentResourceFile(db, resourceId) {
  const resource = row(db, `SELECT r.*,wr.root_path,wr.canonical_path,wr.provider_transmission_allowed AS root_transmission_allowed
    FROM workspace_resources r JOIN workspace_roots wr ON wr.id=r.root_id WHERE r.id=?`, resourceId);
  if (!resource || resource.status !== 'active') throw Object.assign(new Error('resource not found'), { code: 'RESOURCE_NOT_FOUND' });
  const resolved = resolveApprovedTarget(resource, resource.relative_path, { expectedType: 'file' });
  return { resource, ...resolved };
}

export function updateResourceContextPolicy(db, resourceId, policy = {}) {
  const resource = row(db, `SELECT r.*,wr.provider_transmission_allowed AS root_transmission_allowed FROM workspace_resources r JOIN workspace_roots wr ON wr.id=r.root_id WHERE r.id=?`, resourceId);
  if (!resource) throw Object.assign(new Error('resource not found'), { code: 'RESOURCE_NOT_FOUND' });
  const priorityStatus = policy.priority_status === 'priority' ? 'priority' : policy.priority_status === 'normal' ? 'normal' : resource.priority_status;
  const knowledgeStatus = ['active','superseded','deprecated','historical'].includes(policy.knowledge_status) ? policy.knowledge_status : resource.knowledge_status;
  const contextCritical = policy.context_critical === undefined ? Number(resource.context_critical) : policy.context_critical ? 1 : 0;
  let providerAllowed = policy.provider_transmission_allowed === undefined ? Number(resource.provider_transmission_allowed) : policy.provider_transmission_allowed ? 1 : 0;
  const version = resource.current_version_id ? row(db, 'SELECT security_status FROM resource_versions WHERE id=?', resource.current_version_id) : null;
  if (!resource.root_transmission_allowed || String(version?.security_status || '').startsWith('local_only:')) providerAllowed = 0;
  run(db, `UPDATE workspace_resources SET priority_status=?,knowledge_status=?,context_critical=?,provider_transmission_allowed=?,updated_at=? WHERE id=?`,
    priorityStatus, knowledgeStatus, contextCritical, providerAllowed, now(), resourceId);
  run(db, `UPDATE workspaces SET corpus_generation=corpus_generation+1,index_generation=index_generation+1,freshness_status='stale',updated_at=? WHERE id=?`, now(), resource.workspace_id);
  return row(db, 'SELECT * FROM workspace_resources WHERE id=?', resourceId);
}

export function saveResourceCopyToProjectFolder(db, { resourceId, rootId, relativePath }) {
  const resource = row(db, `SELECT r.*,v.id AS version_id,v.sha256,v.archive_artifact_id,a.vault_path
    FROM workspace_resources r JOIN resource_versions v ON v.id=r.current_version_id JOIN artifacts a ON a.id=v.archive_artifact_id
    WHERE r.id=? AND r.status='active'`, resourceId);
  if (!resource || !resource.vault_path || !fs.existsSync(resource.vault_path)) throw Object.assign(new Error('current immutable resource bytes are unavailable'), { code: 'RESOURCE_ARCHIVE_MISSING' });
  const root = row(db, `SELECT * FROM workspace_roots WHERE id=? AND workspace_id=? AND root_kind!='provider_archive'`, rootId, resource.workspace_id);
  if (!root) throw Object.assign(new Error('approved project destination root not found'), { code: 'ROOT_NOT_APPROVED' });
  const normalized = normalizeRelativePath(relativePath);
  const target = resolveApprovedTarget(root, normalized, { mustExist: false });
  if (fs.existsSync(target.absolutePath)) throw Object.assign(new Error('destination already exists; choose another name'), { code: 'DESTINATION_CONFLICT' });
  const parts = normalized.split('/');
  let parent = target.canonicalRoot;
  for (const part of parts.slice(0, -1)) {
    const next = path.join(parent, part);
    if (fs.existsSync(next)) {
      const stat = fs.lstatSync(next);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('destination parent is not a safe directory'), { code: 'ROOT_SECURITY_FAILURE' });
      const real = fs.realpathSync.native(next);
      if (!isPathWithin(real, target.canonicalRoot)) throw Object.assign(new Error('destination parent escapes approved root'), { code: 'ROOT_SECURITY_FAILURE' });
      parent = real;
    } else {
      fs.mkdirSync(next);
      parent = next;
    }
  }
  try {
    fs.copyFileSync(resource.vault_path, target.absolutePath, fs.constants.COPYFILE_EXCL);
    if (sha256File(target.absolutePath) !== resource.sha256) throw Object.assign(new Error('exported copy hash verification failed'), { code: 'COPY_VERIFY_FAILED' });
    const result = reconcileWorkspaceResources(db, resource.workspace_id);
    if (!result.ok) throw Object.assign(new Error(result.reasons[0]?.message || 'exported copy could not be indexed'), { code: result.reasons[0]?.code || 'RESOURCE_INDEX_FAILED' });
    const exported = row(db, 'SELECT * FROM workspace_resources WHERE root_id=? AND relative_path=?', root.id, normalized);
    if (!exported?.current_version_id) throw Object.assign(new Error('exported copy was not reconciled as a project resource'), { code: 'RESOURCE_INDEX_FAILED' });
    recordResourceRelationship(db, { workspaceId: resource.workspace_id, sourceType: 'resource_version', sourceId: resource.version_id, relationshipType: 'saved_copy_as', targetType: 'resource_version', targetId: exported.current_version_id,
      provenance: { exact_sha256: resource.sha256, destination_root_id: root.id, destination_relative_path: normalized } });
    return { source_resource_id: resource.id, source_version_id: resource.version_id, exported_resource: exported, destination_root_id: root.id, destination_relative_path: normalized, sha256: resource.sha256 };
  } catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('destination already exists; choose another name'), { code: 'DESTINATION_CONFLICT' });
    throw error;
  }
}
