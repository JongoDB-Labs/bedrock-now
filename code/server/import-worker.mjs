// The worker thread of import-plan.mjs's PlanQueue: one job at a time (runJob), its answer or its refusal back.
import { parentPort } from 'node:worker_threads';
import { runJob, ImportError } from './import-plan.mjs';

parentPort.on('message', async ({ seq, job }) => {
  try {
    parentPort.postMessage({ seq, ok: true, value: await runJob(job) });
  } catch (e) {
    parentPort.postMessage({ seq, ok: false, ...(e instanceof ImportError ? { status: e.status, message: e.message } : {}) });
  }
});
