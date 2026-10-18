// Check for updates: a release check now, from a click (POST /api/update/check; portal/updates.py Refresher.manual).
// The same line in Home's header and in Settings › Updates & backups › Daily release check — "Up to date · checked 12 min
// ago · Check for updates", "Update available — v0.9.0" (to Home's update card), "Checking…", GitHub could not be
// reached, GitHub's limit for this hour — and the Ctrl/⌘+K entry (search.js). The result is announced (aria-live). It
// asks GitHub's public release list through the portal and sends nothing about this install; it works with the daily
// check off too (a click is an explicit request). The portal answers within a few seconds, or says a check still runs:
// then Home's summary (app.js refresh) is followed until it ends. Loaded after app.js (el, $, showTab, renderUpdate,
// refresh come from there). Text only: every node is built with el()/textContent.
"use strict";

(function (root) {
  const TIP = "Asks GitHub's public list of bedrock-now releases now. It sends nothing about this install.";
  const TIP_OFF = " The daily release check is off (Settings › Updates & backups): this asks once.";

  // --- pure parts (portal/tests/js/updatecheck.test.mjs) ---
  // checked ISO -> "just now" / "12 min ago" / "3 h ago" / "yesterday" / "4 days ago" (app.js checked(), with a clock)
  function ago(iso, now) {
    const t = Date.parse(iso);
    if (isNaN(t)) return "";
    const ms = now - t;
    if (ms < 90000) return "just now";
    if (ms < 3600000) return `${Math.round(ms / 60000)} min ago`;
    if (ms < 86400000) return `${Math.round(ms / 3600000)} h ago`;
    const days = Math.floor(ms / 86400000);
    return days === 1 ? "yesterday" : `${days} days ago`;
  }
  // a time ahead -> "14:05" today, else "Oct 19, 14:05" (this browser's clock and language)
  function clock(iso, now) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const t = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date(now).toDateString() ? t : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${t}`;
  }
  const RELEASE = /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/;

  // What the line says. U: /api/summary's update (null before it loaded); BUSY: a click is waiting for its answer;
  // NOTE: what the last click's answer said besides U ({kind: "again" | "failed", until (ms), wait (s)}) — said as it was
  // answered (no countdown: the line is announced, and once is enough), until UNTIL.
  // -> {state, text, link (a release tag: "Update available — <tag>" leads to Home's card), when, title, disabled}
  function describe(u, now, busy, note) {
    const off = u && u.enabled === false;
    const out = { state: "", text: "", link: "", when: "", title: TIP + (off ? TIP_OFF : ""), disabled: false };
    if (busy || (u && u.checking)) return { ...out, state: "checking", text: "Checking for updates…", disabled: true };
    const n = note && note.until > now ? note : null;
    if (n && n.kind === "failed") return { ...out, state: "failed", text: "The portal could not be reached — try again" };
    if (!u) return out;
    const when = u.checked_at ? `checked ${ago(u.checked_at, now)}` : "";
    const latest = RELEASE.test(u.latest || "") ? u.latest : "";
    if (n && n.kind === "again") {
      return { ...out, state: "again", text: `Checked a moment ago — try again in ${Math.max(1, Math.round(Number(n.wait) || 30))} s` };
    }
    if (u.error && u.limited) {
      const at = u.retry_at && Date.parse(u.retry_at) > now ? clock(u.retry_at, now) : "";
      const why = "GitHub allows 60 requests an hour from one address without an account, and refused the last check.";
      if (at) return { ...out, state: "limit", text: `GitHub's limit for this hour — try again after ${at}`, when, title: `${why} ${out.title}`, disabled: true };
      return { ...out, state: "error", text: "GitHub's limit for this hour was reached — try again now", when, title: `${why} ${out.title}` };
    }
    if (u.error) return { ...out, state: "error", text: "GitHub could not be reached — try again later", when, title: `${u.error}. ${out.title}` };
    if (u.available && latest) return { ...out, state: "available", link: latest, when };
    if (latest && u.installed) return { ...out, state: "current", text: "Up to date", when, title: `${latest} is the newest release. ${out.title}` };
    if (latest) return { ...out, state: "newest", text: `Newest release: ${latest}`, when };
    return { ...out, state: off ? "off" : "none", text: off ? "Daily release check is off" : "Not checked yet" };
  }

  root.bnUpdateCheck = { _pure: { describe, ago, clock } };
  if (typeof document === "undefined") return;

  let last = null;          // the last update status seen (Home's summary, or a click's answer)
  let busy = false;         // a click waits for its answer
  let note = null;          // what that answer said besides the status (see describe)
  let following = false;    // a click's check still runs: Home's summary is asked for every 2 s until it ends
  let followT = null, noteT = null;
  const REDUCED = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: true };

  // one line: <p class="release-line"> with its parts, made once (the button keeps the focus across redraws)
  function parts(p) {
    if (p._rl) return p._rl;
    const state = el("span", { class: "rl-state", "aria-live": "polite" });
    const sep1 = el("span", { class: "rl-sep", "aria-hidden": "true", text: "·" });
    const when = el("span", { class: "rl-when" });
    const sep2 = el("span", { class: "rl-sep", "aria-hidden": "true", text: "·" });
    const btn = el("button", { type: "button", class: "linkish rl-check", text: "Check for updates" });
    // (aria-disabled, not disabled: a focused button keeps the focus while it waits, and hears the result)
    btn.addEventListener("click", () => { if (btn.getAttribute("aria-disabled") !== "true") run(); });
    // (a separator wraps to the next line with what follows it, never alone at the end of one)
    p.replaceChildren(state, el("span", { class: "rl-part" }, sep1, when), el("span", { class: "rl-part" }, sep2, btn));
    p._rl = { state, sep1, when, sep2, btn, key: "" };
    return p._rl;
  }
  function drawLine(p, d) {
    const r = parts(p);
    p.dataset.state = d.state || "none";
    // the live part changes only when what it says does (no announcement every 30 s)
    const key = `${d.state}|${d.text}|${d.link}`;
    if (r.key !== key) {
      r.key = key;
      const kids = [];
      if (d.state === "checking") kids.push(el("span", { class: "spinner", "aria-hidden": "true" }));
      if (d.link) {
        const a = el("a", { href: "#home", class: "rl-link", text: `Update available — ${d.link}` });
        a.addEventListener("click", (e) => { e.preventDefault(); toCard(); });
        kids.push(a);
      } else if (d.text) kids.push(d.text);
      r.state.replaceChildren(...kids);
    }
    r.when.textContent = d.when;
    r.sep1.hidden = !d.when || !(d.text || d.link);
    r.sep2.hidden = !(d.text || d.link || d.when);
    if (d.disabled) r.btn.setAttribute("aria-disabled", "true"); else r.btn.removeAttribute("aria-disabled");
    r.btn.title = d.title;
    p.hidden = false;
  }
  function draw() {
    const d = describe(last, Date.now(), busy, note);
    for (const p of document.querySelectorAll(".release-line")) drawLine(p, d);
  }
  // Home's update card, once app.js has shown it (renderUpdate draws this line before the card)
  function scrollCard() {
    requestAnimationFrame(() => {
      const card = $("#update-card");
      if (card && !card.hidden) card.scrollIntoView({ block: "start", behavior: REDUCED.matches ? "auto" : "smooth" });
    });
  }
  function toCard() { showTab("home"); scrollCard(); }

  // app.js renderUpdate(u): every new status (Home's summary every 30 s, and a click's answer)
  function render(u) {
    if (u && typeof u === "object") last = u;
    clearTimeout(followT);
    if (following && last && last.checking) followT = setTimeout(refresh, 2000);
    else if (following) {
      following = false;
      if (last && last.available && !$("#home").hidden) scrollCard();   // what the click found: the card, as on any visit
    }
    draw();
  }

  // the line's button, the ⌘K entry: ask now. The answer is the new status (or when to try again).
  async function run(opts = {}) {
    if (opts.home) {   // (the ⌘K entry: Home, and the focus on its line's button, which announces the result)
      showTab("home");
      const b = $("#home .release-line .rl-check");
      if (b) { try { b.focus({ preventScroll: false }); } catch (_) { /* fine */ } }
    }
    if (busy || (last && last.checking)) return;
    busy = true; note = null;
    draw();
    let r = null, d = {};
    try {
      r = await fetch("/api/update/check", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "X-Requested-With": "bedrock-now" } });
      d = await r.json().catch(() => ({}));
    } catch (_) { r = null; }
    busy = false;
    if (r && r.status === 401) { location.assign("/login"); return; }
    if (!r || (!r.ok && r.status !== 429)) note = { kind: "failed", until: Date.now() + 60000 };
    else if (r.status === 429 && d.reason === "again") {
      const wait = Math.min(3600, Math.max(1, Number(d.retry_after) || 30));
      note = { kind: "again", wait, until: Date.now() + wait * 1000 };
    }
    if (note) { clearTimeout(noteT); noteT = setTimeout(draw, note.until - Date.now() + 50); }
    const u = d && d.update && typeof d.update === "object" ? d.update : null;
    following = Boolean(r && r.ok);
    if (u && typeof renderUpdate === "function") renderUpdate(u);   // the card, the version label and this line
    else render(u);
  }
  // Settings' Daily release check row (settings.js): a line of its own, drawn at once from what Home last saw
  function line(where) {
    const p = el("p", { class: `release-line${where === "settings" ? " note set-extra" : ""}`, "data-where": where || "" });
    drawLine(p, describe(last, Date.now(), busy, note));
    return p;
  }

  Object.assign(root.bnUpdateCheck, { run, render, line });
  document.addEventListener("DOMContentLoaded", draw);
  setInterval(() => { if (!document.hidden) draw(); }, 60000);   // "checked 12 min ago" stays true
})(typeof window !== "undefined" ? window : globalThis);
