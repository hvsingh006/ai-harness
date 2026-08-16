import { inspectSafeUpdate } from '../src/update-safety.mjs';
import { appRoot } from '../src/dev-workspace.mjs';

const status = inspectSafeUpdate(appRoot, { fetch: process.argv.includes('--fetch') });
process.stdout.write(`${JSON.stringify(status)}\n`);
process.exitCode = status.supported ? 0 : 1;
