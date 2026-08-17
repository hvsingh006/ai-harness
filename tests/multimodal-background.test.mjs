import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, ensureWorkspaceProjectRoot, row, rows } from '../src/db.mjs';
import { ensurePdfPageRepresentation, MULTIMODAL_LIMITS, completePdfBackground } from '../src/multimodal.mjs';
import { reconcileWorkspaceResources } from '../src/resources.mjs';
import { multimodalToolStatus } from '../src/tooling.mjs';

function requireTools(t) {
  const tools = multimodalToolStatus();
  const missing = ['pdfinfo','pdftotext','pdftoppm','pdfimages','tesseract'].filter(name => !tools[name].available);
  if (missing.length) t.skip(`missing multimodal dependencies: ${missing.join(', ')}`);
  return missing.length === 0;
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-multimodal-bg-'));
  const db = openDatabase(path.join(dir, 'harness.db'));
  const root = ensureWorkspaceProjectRoot(db, 'ws-harness');
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, root };
}

function createTextPdfPages(pdfPath, pageCount) {
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  for (let i = 1; i <= pageCount; i++) {
    chunks.push(Buffer.from(`\n${i} 0 obj\n<< /Type /Page /Parent 1 0 R /MediaBox [0 0 612 792] /Contents ${i+1000} 0 R >>\nendobj\n`, 'binary'));
    chunks.push(Buffer.from(`\n${i+1000} 0 obj\n<< /Length 21 >>\nstream\nBT\n/F1 24 Tf\n100 700 Td\n(Page ${i}) Tj\nET\nendstream\nendobj\n`, 'binary'));
  }
  let kids = '';
  for (let i = 1; i <= pageCount; i++) kids += `${i} 0 R `;
  chunks.push(Buffer.from(`\n1 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`, 'binary'));
  chunks.push(Buffer.from(`\n2 0 obj\n<< /Type /Catalog /Pages 1 0 R >>\nendobj\n`, 'binary'));
  chunks.push(Buffer.from(`\ntrailer\n<< /Root 2 0 R /Size ${pageCount + 1001} >>\n%%EOF\n`, 'binary'));
  fs.writeFileSync(pdfPath, Buffer.concat(chunks));
}



test('LARGE PDF EVENTUAL COMPLETION TEST', async t => {
  if (!requireTools(t)) return;
  const { db, root } = fixture(t);
  createTextPdfPages(path.join(root, 'large-doc.pdf'), 81);
  const rec = reconcileWorkspaceResources(db, 'ws-harness');
  assert.equal(rec.ok, true, JSON.stringify(rec.reasons));
  const resource = row(db, `SELECT * FROM workspace_resources WHERE relative_path='large-doc.pdf'`);
  const version = row(db, 'SELECT * FROM resource_versions WHERE id=?', resource.current_version_id);
  
  assert.equal(version.representation_coverage, 'partial');
  
  const jobs = rows(db, `SELECT * FROM background_jobs WHERE workspace_id='ws-harness' AND target_id=? AND job_type='complete_pdf'`, version.id);
  assert.equal(jobs.length, 1);
  
  let progresses = 0;
  await completePdfBackground(db, version.id, (p) => { progresses++; });
  
  const finalVersion = row(db, 'SELECT * FROM resource_versions WHERE id=?', version.id);
  assert.equal(finalVersion.representation_coverage, 'complete');
  assert.equal(JSON.parse(finalVersion.coverage_json).pending_page_count, 0);
  assert.equal(row(db, `SELECT COUNT(DISTINCT page_start) AS n FROM resource_representations WHERE resource_version_id=? AND representation_kind='page_image' AND status='complete'`, version.id).n, 81);
  assert.ok(progresses > 0);
});

test('LARGE PDF PRIORITY JUMP TEST', async t => {
  if (!requireTools(t)) return;
  const { db, root } = fixture(t);
  createTextPdfPages(path.join(root, 'large-jump.pdf'), 81);
  const rec = reconcileWorkspaceResources(db, 'ws-harness');
  assert.equal(rec.ok, true, JSON.stringify(rec.reasons));
  const resource = row(db, `SELECT * FROM workspace_resources WHERE relative_path='large-jump.pdf'`);
  const versionId = resource.current_version_id;
  
  const jumpResult = ensurePdfPageRepresentation(db, { workspaceId: 'ws-harness', resourceId: resource.id, page: 79 });
  assert.equal(jumpResult.ok, true);
  assert.equal(jumpResult.representation.page_start, 79);
  
  await completePdfBackground(db, versionId, () => {});
  
  const finalCount = row(db, `SELECT COUNT(DISTINCT page_start) AS n FROM resource_representations WHERE resource_version_id=? AND representation_kind='page_image' AND status='complete'`, versionId).n;
  assert.equal(finalCount, 81);
});

test('LARGE PDF RESTART TEST', async t => {
  if (!requireTools(t)) return;
  const { db, root } = fixture(t);
  createTextPdfPages(path.join(root, 'large-restart.pdf'), 81);
  const rec = reconcileWorkspaceResources(db, 'ws-harness');
  assert.equal(rec.ok, true, JSON.stringify(rec.reasons));
  const resource = row(db, `SELECT * FROM workspace_resources WHERE relative_path='large-restart.pdf'`);
  const versionId = resource.current_version_id;
  
  try {
    await completePdfBackground(db, versionId, (p) => {
      if (p.current === 5) throw new Error('INTENTIONAL_INTERRUPTION');
    });
  } catch (err) {
    assert.equal(err.message, 'INTENTIONAL_INTERRUPTION');
  }
  
  const midCount = row(db, `SELECT COUNT(DISTINCT page_start) AS n FROM resource_representations WHERE resource_version_id=? AND representation_kind='page_image' AND status='complete'`, versionId).n;
  assert.ok(midCount > 24 && midCount < 81);
  
  await completePdfBackground(db, versionId, () => {});
  
  const finalCount = row(db, `SELECT COUNT(DISTINCT page_start) AS n FROM resource_representations WHERE resource_version_id=? AND representation_kind='page_image' AND status='complete'`, versionId).n;
  assert.equal(finalCount, 81);
});
