import { workspaceStatus } from '../src/dev-workspace.mjs';

const status = workspaceStatus();
const repo = status.repository;
console.log('\nAI Harness development workspace\n');
console.log(`Development root : ${status.development_root}`);
console.log(`Canonical repo   : ${status.canonical_repo}`);
console.log(`Private data     : ${status.private_harness_root}`);
console.log(`Roots separated  : ${status.separation_ok ? 'YES' : 'NO'}`);
if (!status.separation_ok) console.log(`  ${status.separation_error}`);
console.log('');
if (!repo.is_git) {
  console.log(`Repository       : NOT DETECTED (${repo.repo})`);
  process.exitCode = 1;
} else {
  console.log(`Repository       : ${repo.root}`);
  console.log(`Canonical path   : ${repo.canonical ? 'YES' : 'NO'}`);
  console.log(`Runtime source   : ${repo.runtime_matches_repo ? 'MATCHES REPOSITORY' : 'DIFFERENT PATH'}`);
  console.log(`Branch           : ${repo.branch}`);
  console.log(`Commit           : ${repo.short_head}`);
  console.log(`Working tree     : ${repo.dirty ? `${repo.changed_paths} changed path(s)` : 'clean'}`);
  console.log(`Origin           : ${repo.origin || 'not configured'}`);
  if (repo.upstream) console.log(`Upstream         : ${repo.upstream} (ahead ${repo.ahead}, behind ${repo.behind})`);
}
