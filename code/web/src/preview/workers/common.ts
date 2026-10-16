// Shared by the preview workers: a CSP violation inside a worker is posted to the page (which logs it as an error), and
// the input arrives as text or bytes (decoded as UTF-8; a byte order mark is dropped).
/** The worker's global scope (typed here: the page's tsconfig has the DOM library, not WebWorker's). */
interface Scope {
  postMessage(m: unknown): void;
  addEventListener(type: 'securitypolicyviolation', fn: (e: SecurityPolicyViolationEvent) => void): void;
  onmessage: ((e: MessageEvent) => void) | null;
}
export const scope = self as unknown as Scope;

export function reportCsp(): void {
  scope.addEventListener('securitypolicyviolation', (e) => {
    scope.postMessage({ type: 'csp', text: `${e.violatedDirective} ${e.blockedURI || ''} ${e.sample || ''}` });
  });
}

export function textOf(m: { text?: unknown; buf?: unknown }): string {
  if (typeof m.text === 'string') return m.text.replace(/^\uFEFF/, '');
  if (m.buf instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(m.buf);
  throw new Error('nothing to read');
}

export function fail(e: unknown): void {
  const msg = e instanceof Error ? `${e.name === 'RangeError' ? 'Too large or too deep to read: ' : ''}${e.message}` : String(e);
  scope.postMessage({ type: 'error', message: msg.slice(0, 500) });
}

export function on(fn: (m: Record<string, unknown>) => void): void {
  scope.onmessage = (e: MessageEvent) => {
    try {
      fn(e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : {});
    } catch (err) {
      fail(err);
    }
  };
}
