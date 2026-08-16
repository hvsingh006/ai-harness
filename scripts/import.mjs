#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { importChatGPTExport, importProviderArchive } from '../src/importers.mjs';

const [provider, directoryArg, workspaceId = 'ws-harness'] = process.argv.slice(2);
if (!provider || !directoryArg) {
  console.error('Usage: node scripts/import.mjs <chatgpt|gemini|notebooklm|generic> <extracted-directory> [workspace-id]');
  process.exit(2);
}
const directory = path.resolve(directoryArg);
if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
  console.error(`Directory not found: ${directory}`);
  process.exit(2);
}
const db = openDatabase();
try {
  const result = provider === 'chatgpt'
    ? importChatGPTExport(db, { directory, workspaceId })
    : importProviderArchive(db, { directory, workspaceId, provider });
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.close();
}
