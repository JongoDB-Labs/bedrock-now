// bedrock-now service worker. It exists so Android Chrome offers "Install app", and does nothing more.
// It keeps NOTHING: no Cache Storage, no copy of Home, /api/* or anything else signed-in.
// Page loads go to the network as usual; only when the network is unreachable does it answer with a short
// built-in "can't reach bedrock-now" page instead of the browser's error. Every other request (API calls,
// scripts, icons) is not touched. Chat, Admin and Files live on other origins and never pass through here.
"use strict";

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>bedrock-now</title>
<style>
:root { color-scheme: light dark; --bg: #edf0f2; --ink: #18232e; --muted: #5a6775; --accent: #1d6a84; --on: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #111820; --ink: #e4e9ee; --muted: #93a0ae; --accent: #73b6cd; --on: #0e1a21; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box;
  background: var(--bg); color: var(--ink); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 340px; }
h1 { font-size: 22px; margin: 0 0 8px; }
p { color: var(--muted); margin: 0 0 20px; }
a { display: inline-block; min-height: 44px; line-height: 44px; padding: 0 18px; border-radius: 8px;
  background: var(--accent); color: var(--on); text-decoration: none; font-weight: 600; }
</style></head><body><main>
<h1>Can't reach bedrock-now</h1>
<p>This device is offline, or the computer running bedrock-now is asleep or out of reach.</p>
<a href="/">Try again</a>
</main></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.mode !== "navigate" || req.method !== "GET") return;  // untouched: the browser handles it as usual
  event.respondWith(fetch(req).catch(() => new Response(OFFLINE, {
    status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  })));
});
