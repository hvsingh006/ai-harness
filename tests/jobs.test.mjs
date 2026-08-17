import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, row, run } from '../src/db.mjs';
import { backgroundQueueStatus, cancelBackgroundJob, createBackgroundJob, recoverBackgroundJobs, startBackgroundJob } from '../src/jobs.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-jobs-'));
  const db = openDatabase(path.join(directory, 'harness.db'));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return db;
}

async function waitForTerminal(db, id) {
  for (let index = 0; index < 100; index++) {
    const job = row(db, 'SELECT * FROM background_jobs WHERE id=?', id);
    if (['completed','failed','cancelled'].includes(job?.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`job did not reach a terminal state: ${id}`);
}

test('background jobs are bounded, cancellable before execution, and safely recovered after restart', async t => {
  const db = fixture(t);
  const cancelled = createBackgroundJob(db, { workspaceId: 'ws-harness', jobType: 'verify_sources' });
  startBackgroundJob(db, cancelled.id, async () => ({ should_not_run: true }));
  assert.equal(cancelBackgroundJob(db, cancelled.id).status, 'cancelled');
  assert.equal((await waitForTerminal(db, cancelled.id)).status, 'cancelled');

  const queued = createBackgroundJob(db, { workspaceId: 'ws-harness', jobType: 'verify_sources' });
  const running = createBackgroundJob(db, { workspaceId: 'ws-harness', jobType: 'run_diagnostics' });
  run(db, `UPDATE background_jobs SET status='running',phase='interrupted' WHERE id=?`, running.id);
  const recovered = recoverBackgroundJobs(db, job => async progress => {
    progress({ current: 0, total: 1, phase: `recovered ${job.job_type}` });
    progress({ current: 1, total: 1, phase: 'done' });
    return { recovered: true };
  });
  assert.deepEqual(new Set(recovered), new Set([queued.id, running.id]));
  assert.equal((await waitForTerminal(db, queued.id)).status, 'completed');
  assert.equal((await waitForTerminal(db, running.id)).status, 'completed');
  assert.ok(backgroundQueueStatus().max_concurrent >= 1 && backgroundQueueStatus().max_concurrent <= 4);
});

test('background job admission fails closed under persistent queue backpressure', t => {
  const db = fixture(t);
  const createdAt = new Date().toISOString();
  for (let index = 0; index < 100; index++) {
    run(db, `INSERT INTO background_jobs (id,workspace_id,job_type,target_type,target_id,status,created_at) VALUES (?,?,?,'workspace','','queued',?)`, `saturated-${index}`, 'ws-harness', 'verify_sources', createdAt);
  }
  assert.throws(() => createBackgroundJob(db, { workspaceId: 'ws-harness', jobType: 'verify_sources' }), error => error.code === 'JOB_BACKPRESSURE');
});
