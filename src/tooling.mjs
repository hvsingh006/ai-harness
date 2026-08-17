import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, execFile } from 'node:child_process';

const TOOL_NAMES = Object.freeze({
  pdftotext: { family: 'poppler', versionArgs: ['-v'] },
  pdfinfo: { family: 'poppler', versionArgs: ['-v'] },
  pdftoppm: { family: 'poppler', versionArgs: ['-v'] },
  pdfimages: { family: 'poppler', versionArgs: ['-v'] },
  tesseract: { family: 'tesseract', versionArgs: ['--version'] }
});

function executableName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function isExecutableFile(candidate) {
  try { return Boolean(candidate) && fs.statSync(candidate).isFile(); }
  catch { return false; }
}

function findBelow(root, wanted, maxDepth = 5) {
  if (!root || !fs.existsSync(root)) return null;
  const pending = [{ directory: root, depth: 0 }];
  while (pending.length) {
    const current = pending.shift();
    let entries = [];
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const target = path.join(current.directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === wanted.toLowerCase()) return target;
      if (entry.isDirectory() && current.depth < maxDepth) pending.push({ directory: target, depth: current.depth + 1 });
    }
  }
  return null;
}

function fromPath(name) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    return execFileSync(locator, [name], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map(item => item.trim()).find(isExecutableFile) || null;
  } catch { return null; }
}

function windowsCandidates(name, definition) {
  const candidates = [];
  const wanted = executableName(name);
  const override = definition.family === 'poppler' ? process.env.AIH_POPPLER_BIN : process.env.AIH_TESSERACT_PATH;
  if (override) candidates.push(path.extname(override) ? override : path.join(override, wanted));
  if (definition.family === 'tesseract') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) if (root) candidates.push(path.join(root, 'Tesseract-OCR', wanted));
  }
  const packageRoot = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
  if (packageRoot) {
    const prefix = definition.family === 'poppler' ? 'oschwartz10612.Poppler_' : 'UB-Mannheim.TesseractOCR_';
    try {
      for (const entry of fs.readdirSync(packageRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
        const found = findBelow(path.join(packageRoot, entry.name), wanted);
        if (found) candidates.push(found);
      }
    } catch {}
  }
  return candidates;
}

export function resolveTool(name) {
  const definition = TOOL_NAMES[name];
  if (!definition) return null;
  const direct = fromPath(name);
  if (direct) return direct;
  if (process.platform === 'win32') return windowsCandidates(name, definition).find(isExecutableFile) || null;
  return null;
}

export function toolStatus(name) {
  const definition = TOOL_NAMES[name];
  if (!definition) return { name, available: false, code: 'TOOL_UNKNOWN', executable: '', version: '' };
  const executable = resolveTool(name);
  if (!executable) return { name, family: definition.family, available: false, code: 'TOOL_NOT_INSTALLED', executable: '', version: '' };
  const result = spawnSync(executable, definition.versionArgs, { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
  const version = String(result.stdout || result.stderr || '').split(/\r?\n/).find(Boolean)?.trim() || '';
  return { name, family: definition.family, available: !result.error && [0, 1].includes(result.status), code: result.error ? 'TOOL_EXECUTION_FAILED' : 'AVAILABLE', executable, version };
}

export function multimodalToolStatus() {
  return Object.fromEntries(Object.keys(TOOL_NAMES).map(name => [name, toolStatus(name)]));
}

export function runTool(name, args, options = {}) {
  const executable = resolveTool(name);
  if (!executable) return { error: Object.assign(new Error(`${name} is not installed`), { code: 'ENOENT' }), status: null, stdout: '', stderr: '' };
  return spawnSync(executable, args.map(String), {
    encoding: options.encoding === null ? null : (options.encoding || 'utf8'),
    windowsHide: true,
    timeout: options.timeout || 30000,
    maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
    cwd: options.cwd || os.tmpdir(),
    env: options.env || process.env,
    shell: false
  });
}

export function runToolAsync(name, args, options = {}) {
  return new Promise((resolve) => {
    const executable = resolveTool(name);
    if (!executable) {
      resolve({ error: Object.assign(new Error(`${name} is not installed`), { code: 'ENOENT' }), status: null, stdout: '', stderr: '' });
      return;
    }
    const timeout = options.timeout || 30000;
    const maxBuffer = options.maxBuffer || 32 * 1024 * 1024;
    const encoding = options.encoding === null ? null : (options.encoding || 'utf8');
    
    execFile(executable, args.map(String), {
      encoding,
      windowsHide: true,
      timeout,
      maxBuffer,
      cwd: options.cwd || os.tmpdir(),
      env: options.env || process.env,
      shell: false
    }, (error, stdout, stderr) => {
      resolve({ error, status: error ? (error.code === 'ETIMEDOUT' ? null : error.code) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}
