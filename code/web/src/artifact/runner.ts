// The artifact viewer's HTML runner (artifact/html.html, served only on the artifact site: caddy/artifact-on.caddy).
// It runs on a site of its own, sandboxed (an opaque origin: no cookies, no storage), under a CSP that lets the
// document's own scripts run but allows no network at all (connect-src 'none'; images only data:/blob:), framed only
// by the Code page. The Code page (src/preview/artifact.ts) frames a fresh copy of this page per document, waits for
// "ready" and posts the HTML once; this writes it as the frame's document — its scripts then run here, and only
// here. Messages from anything but the frame's parent, or after the first, are ignored.
(() => {
  const up = window.parent;
  let done = false;
  const onMessage = (e: MessageEvent) => {
    if (done || e.source !== up) return;
    const d = e.data as { type?: unknown; html?: unknown } | null;
    if (!d || typeof d !== 'object' || d.type !== 'bn-artifact-html' || typeof d.html !== 'string') return;
    done = true;
    window.removeEventListener('message', onMessage);
    // the height of what was written, for a frame that sizes itself to it (notebook outputs); a hint the Code page caps
    let last = 0;
    const report = () => {
      // the content's own height (scrollHeight would be at least the frame's, so a frame could never shrink to it)
      const el = document.documentElement;
      const h = el ? Math.ceil(el.getBoundingClientRect().height) : 0;
      if (h !== last) {
        last = h;
        up.postMessage({ type: 'bn-artifact-height', h }, '*');
      }
    };
    const timer = setInterval(report, 400);
    setTimeout(() => clearInterval(timer), 120_000);
    document.open();
    document.write(d.html);
    document.close();
    report();
  };
  window.addEventListener('message', onMessage);
  const ready = () => up.postMessage({ type: 'bn-artifact-ready' }, '*');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
})();
