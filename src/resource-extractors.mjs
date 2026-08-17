import fs from 'node:fs';
import path from 'node:path';
import { mimeFromName } from './archive.mjs';
import { runTool, toolStatus } from './tooling.mjs';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.xml', '.html', '.htm', '.css',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.c', '.h', '.cpp', '.hpp', '.cc', '.java',
  '.go', '.rs', '.sv', '.v', '.vhd', '.vhdl', '.tcl', '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat',
  '.csv', '.tsv', '.ini', '.toml', '.cfg', '.conf', '.sql', '.graphql', '.gql', '.tex', '.log', '.gitignore'
]);

export function classifyResource(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = mimeFromName(filePath);
  if (extension === '.pdf') return { resourceType: 'pdf', mimeType, extractable: true };
  if (['.docx', '.pptx', '.xlsx', '.doc', '.ppt', '.xls'].includes(extension)) {
    return { resourceType: 'office', mimeType, extractable: false, attachmentOnly: true };
  }
  if (extension === '.svg') return { resourceType: 'image', mimeType, extractable: true };
  if (mimeType.startsWith('image/')) return { resourceType: 'image', mimeType, extractable: false, ocrExtractable: ['image/png','image/jpeg','image/webp'].includes(mimeType) };
  if (TEXT_EXTENSIONS.has(extension) || mimeType.startsWith('text/') || /(?:json|xml|yaml)/.test(mimeType)) {
    return { resourceType: extension && ['.js','.mjs','.cjs','.jsx','.ts','.tsx','.py','.c','.h','.cpp','.hpp','.java','.go','.rs','.sv','.v','.vhd','.vhdl','.tcl','.sh','.ps1'].includes(extension) ? 'code' : 'text', mimeType, extractable: true };
  }
  return { resourceType: 'binary', mimeType, extractable: false };
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  let control = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  return sample.length > 0 && control / sample.length > 0.02;
}

function imageMetadata(filePath, mimeType) {
  const buffer = fs.readFileSync(filePath);
  if (mimeType === 'image/png' && buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === 'image/gif' && buffer.length >= 10) return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  if (mimeType === 'image/jpeg' && buffer.length >= 4) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      if (!length) break;
      offset += 2 + length;
    }
  }
  return {};
}

function chunkLines(text, { linesPerChunk = 80, overlapLines = 12 } = {}) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + linesPerChunk);
    if (end < lines.length) {
      for (let candidate = end; candidate > Math.max(start + 25, end - 18); candidate--) {
        if (!lines[candidate - 1]?.trim() || /^(?:#{1,6}\s|(?:export\s+)?(?:async\s+)?function\s|class\s|describe\(|test\(|it\()/.test(lines[candidate - 1] || '')) {
          end = candidate;
          break;
        }
      }
    }
    const content = lines.slice(start, end).join('\n').trim();
    if (content) chunks.push({ content, lineStart: start + 1, lineEnd: end });
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - overlapLines);
  }
  return chunks;
}

function extractPdf(filePath, maxBytes) {
  const tool = toolStatus('pdftotext');
  if (!tool.available) return { status: 'unsupported', reason: 'pdftotext is not installed', chunks: [], metadata: { extractor: 'pdftotext', available: false } };
  const result = runTool('pdftotext', ['-layout', filePath, '-'], { timeout: 30000, maxBuffer: maxBytes });
  if (result.error?.code === 'ENOENT') return { status: 'unsupported', reason: 'pdftotext is not installed', chunks: [], metadata: { extractor: 'pdftotext', available: false } };
  if (result.error) return { status: 'failed', reason: result.error.message, chunks: [], metadata: { extractor: 'pdftotext' } };
  if (result.status !== 0) return { status: 'failed', reason: String(result.stderr || 'PDF extraction failed').trim(), chunks: [], metadata: { extractor: 'pdftotext' } };
  const pages = String(result.stdout || '').split('\f');
  const chunks = [];
  pages.forEach((page, index) => {
    for (const chunk of chunkLines(page, { linesPerChunk: 60, overlapLines: 8 })) chunks.push({ ...chunk, pageStart: index + 1, pageEnd: index + 1 });
  });
  return { status: 'complete', chunks, metadata: { extractor: 'pdftotext', extractor_version: tool.version, page_count: pages.length } };
}

export function extractFile(filePath, { maxTextBytes = 8 * 1024 * 1024, maxPdfInputBytes = 100 * 1024 * 1024, maxPdfOutputBytes = 32 * 1024 * 1024, logicalPath = filePath } = {}) {
  const classification = classifyResource(logicalPath);
  const stat = fs.statSync(filePath);
  if (!classification.extractable) return { ...classification, status: 'not_extractable', chunks: [], metadata: classification.resourceType === 'image' ? imageMetadata(filePath, classification.mimeType) : {} };
  if (classification.resourceType === 'pdf') {
    if (stat.size > maxPdfInputBytes) return { ...classification, status: 'failed', reason: `PDF exceeds ${maxPdfInputBytes} byte extraction limit`, chunks: [], metadata: { size_bytes: stat.size, extractor: 'pdftotext' } };
    return { ...classification, ...extractPdf(filePath, maxPdfOutputBytes) };
  }
  if (stat.size > maxTextBytes) return { ...classification, status: 'failed', reason: `text resource exceeds ${maxTextBytes} byte extraction limit`, chunks: [], metadata: { size_bytes: stat.size } };
  const buffer = fs.readFileSync(filePath);
  if (looksBinary(buffer)) return { ...classification, status: 'failed', reason: 'resource classified as text contains binary data', chunks: [], metadata: {} };
  const text = buffer.toString('utf8');
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  if (replacementCount > Math.max(4, text.length * 0.001)) return { ...classification, status: 'failed', reason: 'resource text encoding could not be decoded safely', chunks: [], metadata: { replacement_characters: replacementCount } };
  return { ...classification, status: 'complete', chunks: chunkLines(text), metadata: { encoding: 'utf8', character_count: text.length } };
}
