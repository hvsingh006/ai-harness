import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { archiveFile, sha256File } from './archive.mjs';
import { row, rows, run, workspaceRoots } from './db.mjs';
import { extractFile, classifyResource } from './resource-extractors.mjs';
import { classifySensitivePath, scanOutgoingText } from './security/secrets.mjs';
import { resolveApprovedTarget, verifyRegisteredRoot, walkApprovedRoot } from './security/paths.mjs';

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function now() {
  return new Date().toISOString();
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
    run(db, `INSERT INTO resource_chunks (id,workspace_id,resource_id,resource_version_id,ordinal,content,content_hash,line_start,line_end,page_start,page_end,metadata_json,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, workspaceId, resource.id, version.id, ordinal, chunk.content, contentHash,
      chunk.lineStart || null, chunk.lineEnd || null, chunk.pageStart || null, chunk.pageEnd || null,
      JSON.stringify(extraction.metadata || {}), createdAt);
    try {
      run(db, `INSERT INTO resource_chunk_fts (chunk_id,workspace_id,resource_id,version_id,path,content) VALUES (?,?,?,?,?,?)`,
        id, workspaceId, resource.id, version.id, resource.relative_path, chunk.content);
    } catch {}
  });
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

function versionResource(db, { workspaceId, root, file, existingResource }) {
  const classification = classifyResource(file.absolutePath);
  let sha256 = sha256File(file.absolutePath);
  const sensitive = classifySensitivePath(file.relativePath);
  const current = existingResource?.current_version_id
    ? row(db, 'SELECT * FROM resource_versions WHERE id=?', existingResource.current_version_id)
    : null;
  if (current?.sha256 === sha256) {
    const liveStat = fs.statSync(file.absolutePath);
    run(db, `UPDATE workspace_resources SET status='active',mime_type=?,resource_type=?,provider_transmission_allowed=?,updated_at=? WHERE id=?`,
      classification.mimeType, classification.resourceType, root.provider_transmission_allowed && !sensitive.sensitive && !String(current.security_status).startsWith('local_only') ? 1 : 0, now(), existingResource.id);
    syncLegacyWorkspaceFile(db, { workspaceId, absolutePath: file.absolutePath, relativePath: file.relativePath, sha256, stat: liveStat, mimeType: classification.mimeType });
    return { changed: false, resource: existingResource, version: current, extractionFailed: current.indexing_status === 'failed', inventory: { path: file.relativePath, sha256, size: liveStat.size } };
  }

  const snapshot = archiveStableResource(db, { workspaceId, root, file });
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
  const extraction = extractFile(artifact.vault_path, { logicalPath: file.absolutePath });
  const contentSecurity = extraction.chunks?.length ? scanOutgoingText(extraction.chunks.map(chunk => chunk.content).join('\n'), { source: resourceId }) : { blocked: false, redacted: false, detections: [] };
  const transmissionAllowed = root.provider_transmission_allowed && !sensitive.sensitive && !contentSecurity.blocked;
  const securityStatus = sensitive.sensitive
    ? `local_only:${sensitive.rule}`
    : contentSecurity.blocked
      ? 'local_only:content-secret'
      : contentSecurity.redacted
        ? 'redact_required'
        : 'clear';
  const versionId = `version-${randomUUID()}`;
  const indexingStatus = extraction.status === 'complete' ? 'complete' : extraction.status === 'not_extractable' ? 'not_applicable' : 'failed';
  run(db, `INSERT INTO resource_versions (id,resource_id,sha256,size_bytes,modified_at,observed_at,archive_artifact_id,extraction_status,indexing_status,security_status,metadata_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    versionId, resourceId, sha256, snapshot.stat.size, new Date(snapshot.stat.mtimeMs).toISOString(), createdAt, artifact?.id || null,
    extraction.status, indexingStatus, securityStatus,
    JSON.stringify({ ...extraction.metadata, extraction_reason: extraction.reason || '', root_id: root.id, relative_path: file.relativePath, security_findings: contentSecurity.detections }));
  const version = row(db, 'SELECT * FROM resource_versions WHERE id=?', versionId);
  if (extraction.status === 'complete') replaceVersionChunks(db, { workspaceId, resource, version, extraction });
  run(db, `UPDATE workspace_resources SET current_version_id=?,status='active',resource_type=?,mime_type=?,provider_transmission_allowed=?,updated_at=? WHERE id=?`,
    versionId, classification.resourceType, classification.mimeType, transmissionAllowed ? 1 : 0, createdAt, resourceId);
  syncLegacyWorkspaceFile(db, { workspaceId, absolutePath: file.absolutePath, relativePath: file.relativePath, sha256, stat: snapshot.stat, mimeType: classification.mimeType });
  return {
    changed: true,
    resource: row(db, 'SELECT * FROM workspace_resources WHERE id=?', resourceId),
    version,
    extractionFailed: indexingStatus === 'failed',
    inventory: { path: file.relativePath, sha256, size: snapshot.stat.size }
  };
}

export function reconcileWorkspaceResources(db, workspaceId, { maxFilesPerRoot = 20000 } = {}) {
  const workspace = row(db, 'SELECT * FROM workspaces WHERE id=?', workspaceId);
  if (!workspace) throw Object.assign(new Error('workspace not found'), { code: 'WORKSPACE_NOT_FOUND' });
  const roots = workspaceRoots(db, workspaceId);
  const reasons = [];
  const rootDetails = [];
  let changedCount = 0;
  let deletedCount = 0;
  let indexedCount = 0;
  let extractionFailures = 0;

  for (const root of roots) {
    if (!root.indexing_enabled) {
      const verified = verifyRegisteredRoot(root);
      if (!verified.ok && root.required_for_freshness) reasons.push({ code: verified.code, root_id: root.id, message: verified.message });
      run(db, `UPDATE workspace_roots SET status=?,last_verified_at=?,updated_at=? WHERE id=?`, verified.ok ? 'current' : 'blocked', now(), now(), root.id);
      rootDetails.push({ root_id: root.id, status: verified.ok ? 'local_only_unindexed' : 'blocked', code: verified.code || '', message: verified.message || '', files: 0 });
      continue;
    }
    const scan = walkApprovedRoot(root, { maxFiles: maxFilesPerRoot });
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
    for (const file of scan.files) {
      seen.add(file.relativePath);
      const existing = row(db, 'SELECT * FROM workspace_resources WHERE root_id=? AND relative_path=?', root.id, file.relativePath);
      try {
        const result = versionResource(db, { workspaceId, root, file, existingResource: existing });
        if (result.changed) changedCount += 1;
        if (result.extractionFailed) extractionFailures += 1;
        if (result.version?.indexing_status === 'complete') indexedCount += 1;
        inventory.push(result.inventory);
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
      deletedCount += 1;
    }
    const rootHash = hashJson(inventory.sort((a, b) => a.path.localeCompare(b.path)));
    const verificationScan = walkApprovedRoot(root, { maxFiles: maxFilesPerRoot });
    if (!verificationScan.ok) {
      const failure = { code: verificationScan.code || 'ROOT_CHANGED_DURING_VERIFICATION', root_id: root.id, message: verificationScan.message || 'root changed during verification' };
      run(db, `UPDATE workspace_roots SET status='blocked',last_verified_at=?,updated_at=? WHERE id=?`, now(), now(), root.id);
      rootDetails.push({ root_id: root.id, status: 'blocked', code: failure.code, message: failure.message });
      if (root.required_for_freshness) reasons.push(failure);
      continue;
    }
    let verifiedRootHash = '';
    try {
      verifiedRootHash = hashJson(verificationScan.files.map(item => ({ path: item.relativePath, sha256: sha256File(item.absolutePath), size: fs.statSync(item.absolutePath).size })).sort((a, b) => a.path.localeCompare(b.path)));
    } catch (error) {
      verificationFailure = { code: 'ROOT_CHANGED_DURING_VERIFICATION', root_id: root.id, message: `root changed during final hash verification: ${error.message}` };
    }
    if (verificationFailure || verifiedRootHash !== rootHash) {
      const failure = verificationFailure || { code: 'ROOT_CHANGED_DURING_VERIFICATION', root_id: root.id, message: 'root inventory changed during freshness verification; retry against the new state' };
      run(db, `UPDATE workspace_roots SET status='blocked',last_verified_at=?,updated_at=? WHERE id=?`, now(), now(), root.id);
      rootDetails.push({ root_id: root.id, status: 'blocked', code: failure.code, message: failure.message });
      if (root.required_for_freshness) reasons.push(failure);
      continue;
    }
    run(db, `UPDATE workspace_roots SET canonical_path=?,status='current',last_verified_at=?,updated_at=? WHERE id=?`, scan.canonicalPath, now(), now(), root.id);
    rootDetails.push({ root_id: root.id, status: 'current', file_count: scan.files.length, skipped_symlinks: scan.skippedSymlinks.length, ignored_directories: scan.ignoredDirectories.length, state_hash: rootHash });
  }

  const requiredExtractionFailures = rows(db, `SELECT r.id,r.relative_path,v.extraction_status,v.indexing_status
    FROM workspace_resources r
    JOIN workspace_roots wr ON wr.id=r.root_id
    JOIN resource_versions v ON v.id=r.current_version_id
    WHERE r.workspace_id=? AND r.status='active' AND wr.required_for_freshness=1 AND v.indexing_status='failed'`, workspaceId);
  for (const failed of requiredExtractionFailures) reasons.push({ code: 'RESOURCE_INDEX_FAILED', resource_id: failed.id, message: `current resource could not be indexed: ${failed.relative_path}` });

  const previousCorpus = Number(workspace.corpus_generation || 0);
  const previousIndex = Number(workspace.index_generation || 0);
  const sourceChanged = Boolean(changedCount || deletedCount);
  const corpusGeneration = previousCorpus + (sourceChanged ? 1 : 0);
  if (!sourceChanged && previousIndex !== previousCorpus) {
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
    indexed_count: indexedCount,
    extraction_failures: extractionFailures,
    corpus_generation: corpusGeneration,
    index_generation: indexGeneration,
    root_state_hash: hashJson(rootDetails),
    roots: rootDetails
  };
}

export function currentWorkspaceResources(db, workspaceId, { transmissionOnly = false } = {}) {
  const transmission = transmissionOnly ? " AND r.provider_transmission_allowed=1 AND wr.provider_transmission_allowed=1 AND wr.status='current'" : '';
  return rows(db, `SELECT r.*,v.sha256,v.size_bytes,v.modified_at,v.observed_at,v.archive_artifact_id,v.extraction_status,v.indexing_status,v.security_status,
    wr.label AS root_label,wr.root_kind,wr.provider_transmission_allowed AS root_transmission_allowed
    FROM workspace_resources r
    JOIN workspace_roots wr ON wr.id=r.root_id
    LEFT JOIN resource_versions v ON v.id=r.current_version_id
    WHERE r.workspace_id=? AND r.status='active'${transmission}
    ORDER BY r.relative_path`, workspaceId);
}

export function resolveCurrentResourceFile(db, resourceId) {
  const resource = row(db, `SELECT r.*,wr.root_path,wr.canonical_path,wr.provider_transmission_allowed AS root_transmission_allowed
    FROM workspace_resources r JOIN workspace_roots wr ON wr.id=r.root_id WHERE r.id=?`, resourceId);
  if (!resource || resource.status !== 'active') throw Object.assign(new Error('resource not found'), { code: 'RESOURCE_NOT_FOUND' });
  const resolved = resolveApprovedTarget(resource, resource.relative_path, { expectedType: 'file' });
  return { resource, ...resolved };
}
