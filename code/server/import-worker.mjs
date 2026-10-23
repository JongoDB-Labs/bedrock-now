// The worker thread of import-plan.mjs's PlanQueue: one job at a time (a session's runJob, or a setup item's plan:
// dispatch), its answer or its refusal back.
import { parentPort } from 'node:worker_threads';
import { dispatch, ImportError } from './import-plan.mjs';

parentPort.on('message', async ({ seq, job }) => {
  try {
    parentPort.postMessage({ seq, ok: true, value: await dispatch(job) });
  } catch (e) {
    parentPort.postMessage({ seq, ok: false, ...(e instanceof ImportError ? { status: e.status, message: e.message } : {}) });
  }
});
