#!/usr/bin/env node

const base = String(process.env.AIH_CONTEXT_URL || '').replace(/\/$/, '');
const token = String(process.env.AIH_CONTEXT_TOKEN || '');
if (!base || !token) {
  console.error('aih-context is available only inside a scoped Harness-launched agent session.');
  process.exit(2);
}

const [command = 'status', argument = ''] = process.argv.slice(2);
const allowed = new Set(['status','query','sources','resource','visual']);
if (!allowed.has(command)) {
  console.error('Usage: aih-context status | query <text> | sources | resource <resource-id> | visual <representation-id>');
  process.exit(2);
}

let url = `${base}/${command}`;
let options = { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) };
if (command === 'query') {
  options = { ...options, method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: argument }) };
} else if (['resource','visual'].includes(command)) {
  if (!argument) { console.error(`${command} requires an opaque ID returned by Harness.`); process.exit(2); }
  url += `/${encodeURIComponent(argument)}`;
}

const response = await fetch(url, options);
if (!response.ok) {
  const failure = await response.text();
  console.error(`Harness context request failed (${response.status}): ${failure}`);
  process.exit(1);
}
if (command === 'visual') {
  process.stdout.write(Buffer.from(await response.arrayBuffer()));
} else console.log(JSON.stringify(await response.json(), null, 2));
