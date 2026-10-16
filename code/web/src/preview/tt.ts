// The page's one Trusted Types policy. The Code page runs under `require-trusted-types-for 'script'`, and
// `new Worker(url)` is a Trusted Types sink: it takes only a TrustedScriptURL. The CSP allows exactly one policy name,
// `trusted-types bn-worker` (caddy/Caddyfile, code_page), and this module is the only place that creates it. The
// policy turns exactly the worker paths of this build (build.mjs writes them in, with their content hashes) into
// script URLs and refuses everything else — no other URL, and no HTML or script at all (it has no createHTML or
// createScript). A second policy by any name is refused by the CSP itself.

export type WorkerName = keyof typeof __BN_WORKERS__;

const ALLOWED: ReadonlySet<string> = new Set(Object.values(__BN_WORKERS__));

interface Policy {
  createScriptURL(url: string): unknown;
}
let policy: Policy | null = null;

function getPolicy(): Policy | null {
  if (policy) return policy;
  const tt = (globalThis as { trustedTypes?: { createPolicy(name: string, rules: object): Policy } }).trustedTypes;
  // browsers without Trusted Types: the CSP's worker-src 'self' still limits workers to this site's own files
  if (!tt?.createPolicy) return null;
  policy = tt.createPolicy('bn-worker', {
    createScriptURL(url: string): string {
      if (ALLOWED.has(url)) return url;
      throw new TypeError(`bn-worker: not one of this page's workers: ${String(url).slice(0, 200)}`);
    },
  });
  return policy;
}

/** The script URL of one of this build's workers, as the CSP lets `new Worker` take it. */
export function workerUrl(name: WorkerName): string {
  const url = __BN_WORKERS__[name];
  const p = getPolicy();
  return (p ? p.createScriptURL(url) : url) as string;
}

/** Start one of this build's workers (`pdf` is pdf.js's own, an ES module; ours are classic scripts). */
export function startWorker(name: WorkerName): Worker {
  return new Worker(workerUrl(name), name === 'pdf' ? { type: 'module', name: 'pdf.js' } : { name });
}
