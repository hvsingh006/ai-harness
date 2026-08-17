import { randomUUID } from 'node:crypto';
import { row, rows, run } from './db.mjs';

export const JOB_TYPES = Object.freeze(['verify_sources','full_integrity_verify','reprocess_resource','complete_pdf','rebuild_derived','create_backup','run_diagnostics']);
const JOB_PRIORITIES = Object.freeze({ verify_sources: 0, full_integrity_verify: 3, reprocess_resource: 1, complete_pdf: 5, rebuild_derived: 4, create_backup: 3, run_diagnostics: 2 });
const queue = [];
const queuedJobIds = new Set();
let activeJobs = 0;
const maxConcurrentJobs = Math.max(1, Math.min(4, Number(process.env.AIH_BACKGROUND_CONCURRENCY || 2)));

function now() { return new Date().toISOString(); }

let globalJobDispatcher = null;

export function registerJobDispatcher(dispatcher) {
  globalJobDispatcher = dispatcher;
}

export function createBackgroundJob(db, { workspaceId = null, jobType, targetType = 'workspace', targetId = '' }) {
  if (!JOB_TYPES.includes(jobType)) throw Object.assign(new Error(`unsupported background job type: ${jobType}`), { code: 'JOB_TYPE_UNSUPPORTED' });
  
  if (jobType === 'complete_pdf' && targetType === 'resource_version') {
    const existing = row(db, `SELECT * FROM background_jobs WHERE workspace_id=? AND job_type=? AND target_type=? AND target_id=? AND status IN ('queued','running')`, workspaceId, jobType, targetType, targetId);
    if (existing) return existing;
  }

  const outstanding = Number(row(db, `SELECT COUNT(*) AS n FROM background_jobs WHERE status IN ('queued','running')`)?.n || 0);
  if (outstanding >= 100) throw Object.assign(new Error('background processing queue is full; current interactive work remains prioritized'), { code: 'JOB_BACKPRESSURE' });
  const id = `job-${randomUUID()}`;
  run(db, `INSERT INTO background_jobs (id,workspace_id,job_type,target_type,target_id,status,created_at) VALUES (?,?,?,?,?,'queued',?)`, id, workspaceId, jobType, targetType, targetId, now());
  const job = row(db, 'SELECT * FROM background_jobs WHERE id=?', id);
  if (globalJobDispatcher) {
    const handler = globalJobDispatcher(job);
    if (handler) startBackgroundJob(db, job.id, handler);
  }
  return job;
}

function pumpQueue() {
  while (activeJobs < maxConcurrentJobs && queue.length) {
    const task = queue.shift();
    queuedJobIds.delete(task.jobId);
    if (row(task.db, 'SELECT status FROM background_jobs WHERE id=?', task.jobId)?.status !== 'queued') continue;
    activeJobs += 1;
    setImmediate(async () => {
      const { db, jobId, handler } = task;
      if (row(db, 'SELECT status FROM background_jobs WHERE id=?', jobId)?.status !== 'queued') {
        activeJobs -= 1;
        pumpQueue();
        return;
      }
      run(db, `UPDATE background_jobs SET status='running',started_at=?,phase='starting' WHERE id=?`, now(), jobId);
      const progress = ({ current = 0, total = 0, phase = '' }) => {
        if (row(db, 'SELECT status FROM background_jobs WHERE id=?', jobId)?.status === 'cancel_requested') {
          throw Object.assign(new Error('background job was canceled'), { code: 'JOB_CANCELLED' });
        }
        run(db, 'UPDATE background_jobs SET progress_current=?,progress_total=?,phase=? WHERE id=?', current, total, String(phase).slice(0, 200), jobId);
      };
      try {
        const result = await handler(progress);
        if (row(db, 'SELECT status FROM background_jobs WHERE id=?', jobId)?.status === 'cancel_requested') {
          throw Object.assign(new Error('background job was canceled'), { code: 'JOB_CANCELLED' });
        }
        let finalStatus = 'completed';
          let finalPhase = 'complete';
          let finalError = '';
          if (result && result.status === 'cancelled') {
            finalStatus = 'cancelled';
            finalPhase = 'cancelled';
            finalError = result.code || result.reason || 'CANCELLED';
          }
          run(db, `UPDATE background_jobs SET status=?,progress_current=CASE WHEN progress_total>0 THEN progress_total ELSE progress_current END,phase=?,error_code=?,result_json=?,completed_at=? WHERE id=?`, finalStatus, finalPhase, finalError, JSON.stringify(result || {}), now(), jobId);
      } catch (error) {
        const cancelled = error.code === 'JOB_CANCELLED';
        run(db, `UPDATE background_jobs SET status=?,phase=?,error_code=?,error_message=?,completed_at=? WHERE id=?`, cancelled ? 'cancelled' : 'failed', cancelled ? 'cancelled' : 'failed', error.code || 'JOB_FAILED', String(error.message || error).slice(0, 2000), now(), jobId);
      } finally {
        activeJobs -= 1;
        pumpQueue();
      }
    });
  }
}

export function startBackgroundJob(db, jobId, handler) {
  const job = row(db, 'SELECT * FROM background_jobs WHERE id=?', jobId);
  if (!job || job.status !== 'queued' || queuedJobIds.has(jobId)) return false;
  queuedJobIds.add(jobId);
  queue.push({ db, jobId, handler, priority: JOB_PRIORITIES[row(db, 'SELECT job_type FROM background_jobs WHERE id=?', jobId)?.job_type] ?? 5, queuedAt: Date.now() });
  queue.sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt);
  pumpQueue();
  return true;
}

export function recoverBackgroundJobs(db, handlerFactory) {
  const recoverable = rows(db, `SELECT * FROM background_jobs WHERE status IN ('queued','running','cancel_requested') ORDER BY created_at`);
  const recovered = [];
  for (const job of recoverable) {
    if (job.status === 'cancel_requested') {
      run(db, `UPDATE background_jobs SET status='cancelled',phase='cancelled after service restart',error_code='JOB_CANCELLED',completed_at=? WHERE id=?`, now(), job.id);
      continue;
    }
    run(db, `UPDATE background_jobs SET status='queued',phase='recovered after service restart',started_at=NULL,error_code='',error_message='' WHERE id=?`, job.id);
    if (startBackgroundJob(db, job.id, handlerFactory(job))) recovered.push(job.id);
  }
  return recovered;
}

export function cancelBackgroundJob(db, jobId) {
  const job = row(db, 'SELECT * FROM background_jobs WHERE id=?', jobId);
  if (!job) return null;
  if (job.status === 'queued') {
    queuedJobIds.delete(jobId);
    run(db, `UPDATE background_jobs SET status='cancelled',phase='cancelled',error_code='JOB_CANCELLED',completed_at=? WHERE id=?`, now(), jobId);
  } else if (job.status === 'running') {
    run(db, `UPDATE background_jobs SET status='cancel_requested',phase='cancellation requested' WHERE id=?`, jobId);
  }
  return row(db, 'SELECT * FROM background_jobs WHERE id=?', jobId);
}

export function backgroundQueueStatus() {
  return { active: activeJobs, queued: queue.length, max_concurrent: maxConcurrentJobs };
}
