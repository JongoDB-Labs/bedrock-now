// Parsing untrusted files happens in workers the page can stop: one worker per job, ended when the job is done, when
// it takes longer than its time budget, or when the preview closes. A worker reports with messages
// {type: 'chunk' | 'done' | 'error' | 'csp', …}; a CSP violation inside a worker (where the page's listener cannot see
// it) is forwarded and logged as an error, so it never goes unnoticed.
import { startWorker, type WorkerName } from './tt';

export interface Job<T> {
  promise: Promise<T>;
  cancel(): void;
}

export class JobError extends Error {}

export function runJob<T>(name: WorkerName, msg: unknown, transfer: Transferable[], opts: { timeoutMs: number; onChunk?: (m: Record<string, unknown>) => void }): Job<T> {
  let w: Worker | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settle: { resolve: (v: T) => void; reject: (e: Error) => void } | null = null;
  const end = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    w?.terminate();
    w = null;
  };
  const promise = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject };
    try {
      w = startWorker(name);
    } catch (e) {
      settle = null;
      reject(new JobError(`The preview could not start its worker (${e instanceof Error ? e.message : String(e)}).`));
      return;
    }
    timer = setTimeout(() => {
      end();
      settle?.reject(new JobError(`Reading the file took longer than ${Math.round(opts.timeoutMs / 1000)} s: stopped.`));
      settle = null;
    }, opts.timeoutMs);
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as Record<string, unknown> | null;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'csp') {
        console.error(`CSP violation in the ${name} worker: ${String(m.text).slice(0, 300)}`);
        return;
      }
      if (m.type === 'chunk') return opts.onChunk?.(m);
      if (m.type === 'done') {
        end();
        settle?.resolve(m as T);
        settle = null;
      } else if (m.type === 'error') {
        end();
        settle?.reject(new JobError(String(m.message ?? 'The file could not be read.').slice(0, 500)));
        settle = null;
      }
    };
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      end();
      settle?.reject(new JobError(`The preview's worker failed${e.message ? `: ${e.message.slice(0, 200)}` : ''} (out of memory?).`));
      settle = null;
    };
    w.postMessage(msg, transfer);
  });
  return {
    promise,
    cancel() {
      end();
      settle?.reject(new JobError('cancelled'));
      settle = null;
    },
  };
}
