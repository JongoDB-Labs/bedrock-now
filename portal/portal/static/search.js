// Search: Ctrl+K (⌘K on a Mac) anywhere in the portal, the search box at the top of the sidebar (desktop, tablet) or
// More → Search (phone). One box, results grouped, keyboard-driven (↑ ↓ Enter Esc), matched by fuzzy.js (linear time,
// capped inputs). What it looks through:
//   Pages               the portal's tabs, Activity and the walkthrough
//   Settings            every section and setting of the Settings page (/api/search/index: catalog/settings-layout.tsv
//                       and the settings' labels); Enter opens #settings/<KEY> (the section, the setting lit up)
//   Code sessions       the Code page's sessions — asked from the Code tab's frame when this browser has it open or
//   Workspace files     preloaded (a request and an answer by postMessage, checked both ways: the code host's origin
//                       and the frame's own window; the answer's shape, ids and lengths); titles and file names are
//                       sandbox data, shown as text with invisible and direction-changing characters made visible.
//                       Without the frame (a phone, a browser that never opened Code, the Code page locked) the
//                       sessions Home's Code card knows, and a note instead of files
//   Chat conversations  Open WebUI's own search, asked by the portal server (/api/search/chats: portal/chatsearch.py);
//                       if that fails, "Search in Chat" opens the Chat tab
//   Walkthrough         its steps (tour.js); Enter opens the walkthrough at that step
//   Docs                README.md and docs/*.md, an index built into the portal's image; Enter opens the section on
//                       GitHub, at the installed release
// Nothing typed here is sent outside the stack: the text goes to the portal (over remote access, from your device to it,
// as every request) and, for the Code page's part, to the Code tab's frame. Every node is built with el()/textContent. Loaded after app.js, code.js, tour.js and fuzzy.js (deferred).
"use strict";

(function (root) {
  const REPO = "https://github.com/JongoDB-Labs/bedrock-now/blob/";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const RELEASE = /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/;
  const HASH = /^#[a-z]+(?:\/[A-Za-z0-9_+-]{1,64}){0,2}$/;
  const PER_GROUP = { pages: 6, settings: 8, code: 5, files: 6, chats: 6, tour: 4, docs: 6 };
  const GROUPS = [["pages", "Pages"], ["settings", "Settings"], ["code", "Code sessions"], ["files", "Workspace files"],
    ["chats", "Chat conversations"], ["tour", "Walkthrough"], ["docs", "Docs"]];
  const MIN_ASYNC = 2;   // the Code page and Chat are asked from two characters on
  const WAIT_MS = 220;   // after typing pauses
  const CODE_TIMEOUT_MS = 4000;

  // A title or a name as this page shows untrusted text: at most MAX characters, line breaks and tabs as spaces, other
  // control characters and the invisible or direction-changing ones ("Trojan Source": bidi overrides and isolates,
  // zero-width characters, tag characters) shown as ⟨U+202E⟩ — code.js's shownTitle, with any cap. One character class:
  // linear in the input.
  const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;
  function shownText(t, max) {
    return Array.from(String(t).slice(0, max * 2)).slice(0, max).join("").replace(/[\t\n\r]/g, " ")
      .replace(INVISIBLE, (c) => `⟨U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`);
  }

  // --- pure parts (portal/tests/js/search.test.mjs) ---
  function settingsEntries(idx) {
    const out = [];
    const s = idx && idx.settings;
    if (!s) return out;
    for (const sec of (s.sections || []).slice(0, 40)) {
      if (!sec || typeof sec.id !== "string" || !/^[a-z]{2,20}$/.test(sec.id)) continue;
      out.push({ group: "settings", key: `sec:${sec.id}`, title: String(sec.title || sec.id), sub: "Settings section",
        alt: String(sec.lede || ""), href: `#settings/${sec.id}` });
    }
    for (const r of (s.rows || []).slice(0, 600)) {
      if (!r || typeof r.key !== "string" || !/^(\+[a-z-]{2,20}|[A-Z][A-Z0-9_]{1,40})$/.test(r.key)) continue;
      const own = r.key.startsWith("+");
      out.push({ group: "settings", key: `row:${r.key}`, title: String(r.title || r.key),
        sub: `${String(r.section_title || r.section || "")}${own ? "" : ` · ${r.key}`}`,
        alt: `${own ? "" : r.key} ${String(r.summary || "")}`, href: `#settings/${r.key}` });
    }
    return out;
  }
  // The docs' base address: the installed release's tag on GitHub (the docs as they were for it), else main.
  const docsBase = (installed) => REPO + (RELEASE.test(installed || "") ? installed : "main") + "/";
  function docEntries(idx, installed) {
    const out = [];
    const base = docsBase(installed);
    for (const p of ((idx && idx.docs && idx.docs.pages) || []).slice(0, 40)) {
      if (!p || typeof p.file !== "string" || !/^(README\.md|docs\/[a-z0-9-]{1,40}\.md)$/.test(p.file)) continue;
      const title = String(p.title || p.file);
      out.push({ group: "docs", key: `doc:${p.file}`, title, sub: p.file, alt: "", url: base + p.file });
      for (const sec of (p.sections || []).slice(0, 500)) {
        if (!sec || typeof sec.anchor !== "string" || !/^[\p{L}\p{N}_-]{1,120}$/u.test(sec.anchor)) continue;
        out.push({ group: "docs", key: `doc:${p.file}#${sec.anchor}`, title: String(sec.title || sec.anchor),
          sub: [title, String(sec.parent || "")].filter(Boolean).join(" › "), alt: String(sec.text || ""), url: `${base}${p.file}#${sec.anchor}` });
      }
    }
    return out;
  }
  // The Code tab's frame's answer to request WANT, checked: {sessions: [{id, title}], files: [{path, shown}], truncated},
  // or null when it is not that answer. A path is the workspace-relative name the Code page gave (no "..", ".", empty
  // part, leading "/" or NUL; folders, which end in "/", are left out): it goes back to the Code page only, which checks
  // it again before it opens anything.
  function takeCodeReply(d, want) {
    if (!d || typeof d !== "object" || d.type !== "bn-code-search" || typeof want !== "string" || d.id !== want) return null;
    const sessions = (Array.isArray(d.sessions) ? d.sessions.slice(0, 20) : [])
      .filter((x) => x && typeof x.id === "string" && UUID.test(x.id))
      .map((x) => ({ id: x.id, title: typeof x.title === "string" && x.title ? shownText(x.title, 120) : "Untitled session" }));
    const files = (Array.isArray(d.files) ? d.files.slice(0, 30) : [])
      .filter((p) => typeof p === "string" && p.length > 0 && p.length <= 1024 && !p.includes("\0") && !p.startsWith("/")
        && !p.split("/").some((x) => x === "" || x === "." || x === ".."))
      .map((p) => ({ path: p, shown: shownText(p, 300) }));
    return { sessions, files, truncated: d.truncated === true, error: typeof d.error === "string" ? shownText(d.error, 200) : "" };
  }
  // Ranked groups for query Q: {group id: {shown: [{entry, hits}], more}}, each at most its PER_GROUP, the group with
  // the best match first (ties in GROUPS' order: what you typed exactly, in a walkthrough step's title, comes before
  // settings that merely contain its letters). Entries a source already matched by itself (prefiltered: the Code
  // page's, Chat's) stay even when fuzzy finds none of the query in their title.
  function searchEntries(entries, q) {
    const by = {};
    for (const e of entries) (by[e.group] = by[e.group] || []).push(e);
    const out = {};
    for (const [g] of GROUPS) {
      const list = by[g] || [];
      if (!list.length) continue;
      const max = PER_GROUP[g] || 6;
      // (a page by its name and keywords only: "budget" is a setting, not the Settings page because of its description)
      let ranked = root.bnFuzzy.rank(list, q, (e) => e.title, (e) => (g === "pages" ? e.alt || "" : `${e.sub} ${e.alt || ""}`), 400);
      if (list.some((e) => e.prefiltered)) {
        const seen = new Set(ranked.map((r) => r.item));
        ranked = ranked.concat(list.filter((e) => e.prefiltered && !seen.has(e)).map((e) => ({ item: e, score: -1, hits: [] })));
      }
      if (ranked.length) out[g] = { best: ranked[0].score, shown: ranked.slice(0, max).map((r) => ({ entry: r.item, hits: r.hits })), more: Math.max(0, ranked.length - max) };
    }
    const order = GROUPS.map(([g]) => g).filter((g) => out[g]);
    const rank = (g) => GROUPS.findIndex(([x]) => x === g);
    order.sort((a, b) => out[b].best - out[a].best || rank(a) - rank(b));
    const sorted = {};
    for (const g of order) sorted[g] = out[g];
    return sorted;
  }

  const pure = { shownText, settingsEntries, docEntries, docsBase, takeCodeReply, searchEntries };
  root.bnSearch = { _pure: pure };
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return;

  // --- the page ---
  const PHONE = window.matchMedia("(max-width: 767.98px)");
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const dlg = $("#search"), opener = $("#search-btn"), moreEntry = $("#more-search");
  if (!dlg || !opener) return;
  let index = null, indexAt = 0, indexErr = "", q = "", active = -1, options = [], seq = 0;
  let chats = { q: "", list: [], error: "", busy: false }, code = { q: "", sessions: null, files: [], error: "", busy: false, id: "" };
  let waitT = null, codeT = null;

  const codeOrigin = (() => { try { return APP_URLS.code ? new URL(appUrl("code")).origin : ""; } catch (_) { return ""; } })();
  const codeFrame = () => document.querySelector('#frames iframe[data-app="code"]');
  // the frame can answer: it exists, it reported to the portal since it loaded (unlocked and running), not on a phone
  const codeReady = () => Boolean(window.bnCode && window.bnCode.ready() && codeFrame() && !PHONE.matches);

  function pages() {
    // (alt: a few other names for it — a page matches by its name and these, never by its description)
    const tab = (id, title, sub, alt) => ({ group: "pages", key: `page:${id}`, title, sub, alt, run: () => openTab(id) });
    const out = [tab("home", "Home", "Health, spend, models, the update card", "dashboard"), tab("chat", "Chat", "Open WebUI", "open webui conversations")];
    if (document.querySelector('.tab[data-tab="code"]')) out.push(tab("code", "Code", APP_URLS.code ? "Claude Code with a chat and your files" : "Off: what it is and how to turn it on", "claude code ide"));
    out.push(tab("admin", "Admin", "LiteLLM: keys, spend by model, logs", "litellm"), tab("files", "Files", "RustFS: the shared store", "rustfs"));
    if (APP_URLS.terminal) out.push(tab("terminal", "Terminal", "Claude Code in a sandbox shell", "shell"));
    out.push(tab("settings", "Settings", "Passwords, keys, budgets, voice, the Code page, updates", "preferences"));
    if (window.bnActivity && window.bnActivity.open) out.push({ group: "pages", key: "page:activity", title: "Activity", sub: "Budgets, updates, jobs, Code sessions that need you", alt: "notifications bell", run: () => window.bnActivity.open() });
    if (window.bnTour && window.bnTour.open) out.push({ group: "pages", key: "page:tour", title: "Walkthrough", sub: "Set up, your apps, use them together", alt: "tour", run: () => window.bnTour.open() });
    return out;
  }
  function openTab(id) {
    if (window.bnMobile && window.bnMobile.allowTab(id) !== id && Object.prototype.hasOwnProperty.call(APP_URLS, id)) {
      window.open(appUrl(id), "_blank", "noopener");
      return;
    }
    showTab(id);
  }
  function entries() {
    const out = pages();
    if (index) out.push(...settingsEntries(index));
    // Code sessions: the frame's answer for this query, else what Home's Code card knows (the open ones)
    const sess = code.q === q && code.sessions ? code.sessions.map((s) => ({ ...s, prefiltered: true }))
      : (window.bnCode ? window.bnCode.sessions() : []).map((s) => ({ id: s.id, title: s.title }));
    for (const s of sess) out.push({ group: "code", key: `code:${s.id}`, title: s.title, sub: "Code session", alt: "", prefiltered: s.prefiltered, run: () => window.bnCode.openSession(s.id) });
    if (code.q === q) for (const f of code.files) out.push({ group: "files", key: `file:${f.path}`, title: f.shown, sub: "Workspace file · opens in the Code tab", alt: "", prefiltered: true, run: () => window.bnCode.openFile(f.path) });
    if (chats.q === q) {
      for (const c of chats.list) {
        out.push({ group: "chats", key: `chat:${c.id}`, title: c.title, sub: c.snippet ? `Chat · ${c.snippet}` : "Chat conversation", alt: "", prefiltered: true, run: () => openChat(c.id) });
      }
    }
    if (window.bnTour && window.bnTour.steps) {
      for (const s of window.bnTour.steps()) out.push({ group: "tour", key: `tour:${s.id}`, title: s.title, sub: `Walkthrough · ${s.section}`, alt: "", run: () => window.bnTour.open(s.id) });
    }
    if (index) out.push(...docEntries(index, typeof lastSummary !== "undefined" && lastSummary && lastSummary.update ? lastSummary.update.installed : ""));
    return out;
  }
  function openChat(id) {
    if (!UUID.test(id)) return;
    showTab("chat");
    appFrame("chat").src = new URL(`c/${id}`, appUrl("chat")).href;
  }

  // --- sources that answer later ---
  async function loadIndex() {
    if (index && Date.now() - indexAt < 300000) return;
    try { index = await api("/api/search/index"); indexAt = Date.now(); indexErr = ""; } catch (e) {
      if (e.message === "signed out") return;
      indexErr = `Settings and docs could not be loaded (${e.message}).`;
    }
    if (dlg.open) draw();
  }
  async function askChats(text) {
    const mine = ++seq;
    chats = { q: text, list: [], error: "", busy: true };
    draw();
    let d = {}, status = 0;
    try {
      const r = await fetch(`/api/search/chats?q=${encodeURIComponent(text)}`, { headers: { "X-Requested-With": "bedrock-now" }, credentials: "same-origin", cache: "no-store" });
      status = r.status;
      if (r.status === 401) { location.assign("/login"); return; }
      d = await r.json().catch(() => ({}));
    } catch (e) { d = { error: `the portal did not answer (${e.message})` }; }
    if (chats.q !== text || mine !== seq) return;
    const list = Array.isArray(d.chats) ? d.chats.slice(0, 20).filter((c) => c && typeof c.id === "string" && UUID.test(c.id))
      .map((c) => ({ id: c.id, title: shownText(typeof c.title === "string" && c.title ? c.title : "Untitled chat", 200), snippet: typeof c.snippet === "string" ? shownText(c.snippet, 160) : "" })) : [];
    chats = { q: text, list, error: d.error ? shownText(String(d.error), 200) : status === 200 ? "" : `HTTP ${status}`, busy: false };
    draw();
  }
  function askCode(text) {
    clearTimeout(codeT);
    const f = codeFrame();
    if (!codeReady() || !f || !codeOrigin) { code = { q: text, sessions: null, files: [], error: "", busy: false, id: "" }; draw(); return; }
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
    code = { q: text, sessions: null, files: [], error: "", busy: true, id };
    draw();
    try { f.contentWindow.postMessage({ type: "bn-portal-search", id, q: text }, codeOrigin); } catch (_) { /* answered by the timeout */ }
    codeT = setTimeout(() => {
      if (code.id !== id || !code.busy) return;
      code = { ...code, busy: false, error: "The Code page did not answer (reload it in the Code tab)." };
      draw();
    }, CODE_TIMEOUT_MS);
  }
  window.addEventListener("message", (e) => {
    const f = codeFrame();
    if (!codeOrigin || e.origin !== codeOrigin || !f || e.source !== f.contentWindow) return;
    const r = takeCodeReply(e.data, code.id);
    if (!r || !code.busy) return;
    clearTimeout(codeT);
    code = { q: code.q, sessions: r.sessions, files: r.files, error: r.error, busy: false, id: code.id, truncated: r.truncated };
    if (dlg.open) draw();
  });

  // --- drawing ---
  function highlight(text, hits) {
    if (!hits || !hits.length) return [text];
    const set = new Set(hits), out = [];
    let run = "", mark = false;
    const flush = () => { if (run) out.push(mark ? el("mark", { text: run }) : run); run = ""; };
    for (let i = 0; i < text.length; i++) {
      const m = set.has(i);
      if (m !== mark) { flush(); mark = m; }
      run += text[i];
    }
    flush();
    return out;
  }
  function notes() {
    const out = [];
    if (indexErr) out.push(indexErr);
    if (q.length < MIN_ASYNC) return out;
    // an image built without the docs (Docker Compose older than 2.17, or a plain docker build): say where they are
    if (index && !((index.docs && index.docs.pages) || []).length) out.push("Docs: this portal's image has no index of them (Docker Compose older than 2.17 builds it without): README and docs/ are on GitHub.");
    if (PHONE.matches) out.push("Workspace files: search them in the Code page itself (More → Code).");
    else if (!APP_URLS.code) { /* the Code page is off here: nothing to say */ }
    else if (!codeReady()) out.push("Workspace files and every Code session: open the Code tab once (unlocked), and it answers here too.");
    else if (code.error) out.push(code.error);
    else if (code.truncated) out.push("Workspace files: the first matches only — the Code page's own search has them all.");
    if (chats.error) out.push(`Chat search: ${chats.error}`);
    return out;
  }
  function draw() {
    const list = $("#search-list", dlg);
    // nothing typed yet: the pages, and what can be searched (the hint under the box)
    const groups = searchEntries(q ? entries() : pages(), q);
    if (q.length >= MIN_ASYNC && chats.error && chats.q === q) {
      (groups.chats = groups.chats || { shown: [], more: 0 }).shown.push({ entry: { group: "chats", key: "chat:open", title: "Search in Chat", sub: "Opens the Chat tab: its own search box", alt: "", run: () => showTab("chat") }, hits: [] });
    }
    const keep = active >= 0 && options[active] ? options[active].key : null;
    options = [];
    const parts = [];
    const NAMES = Object.fromEntries(GROUPS);
    // the groups with results, best first; a source still searching after them
    const order = [...Object.keys(groups), ...GROUPS.map(([g]) => g).filter((g) => !groups[g])];
    for (const g of order) {
      const name = NAMES[g];
      const busy = q.length >= MIN_ASYNC && ((g === "chats" && chats.busy && chats.q === q) || (g === "files" && code.busy && code.q === q));
      const grp = groups[g];
      if (!grp && !busy) continue;
      const head = el("p", { class: "search-group", id: `sg-${g}`, role: "presentation" }, name,
        grp && grp.more ? el("span", { class: "search-more", text: ` · ${grp.more} more` }) : null);
      const box = el("div", { role: "group", "aria-labelledby": `sg-${g}`, class: "search-sec" }, head);
      for (const { entry, hits } of grp ? grp.shown : []) {
        const i = options.length;
        const opt = el("div", { role: "option", id: `so-${i}`, class: "search-opt", "aria-selected": "false", "data-key": entry.key },
          el("span", { class: "so-title" }, ...highlight(entry.title, hits)), el("span", { class: "so-sub", text: entry.sub }),
          entry.url ? el("span", { class: "so-ext", "aria-hidden": "true", text: "↗" }) : null);
        opt.addEventListener("mousemove", () => { if (active !== i) setActive(i, false); });
        opt.addEventListener("click", () => activate(i));
        options.push({ entry, key: entry.key, node: opt });
        box.append(opt);
      }
      if (busy) box.append(el("p", { class: "search-busy", role: "presentation" }, el("span", { class: "spinner", "aria-hidden": "true" }), " Searching…"));
      parts.push(box);
    }
    if (!options.length && q) parts.push(el("p", { class: "search-none", text: "Nothing matches." }));
    list.replaceChildren(...parts);
    const n = notes();
    const nb = $("#search-notes", dlg);
    nb.replaceChildren(...n.map((t) => el("span", { text: t })));
    nb.hidden = !n.length;
    const back = keep ? options.findIndex((o) => o.key === keep) : -1;
    setActive(back >= 0 ? back : options.length ? 0 : -1, false);
    $("#search-status", dlg).textContent = q ? `${options.length} result${options.length === 1 ? "" : "s"}` : "";
  }
  function setActive(i, scroll = true) {
    if (options[active]) options[active].node.setAttribute("aria-selected", "false");
    active = i;
    const input = $("#search-input", dlg);
    if (options[i]) {
      options[i].node.setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", options[i].node.id);
      if (scroll) options[i].node.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }
  function activate(i) {
    const o = options[i];
    if (!o) return;
    const e = o.entry;
    close();
    if (e.href && HASH.test(e.href)) { if (location.hash === e.href) showTab(e.href.slice(1)); else location.hash = e.href; }
    else if (e.url && e.url.startsWith(REPO)) window.open(e.url, "_blank", "noopener,noreferrer");
    else if (e.run) e.run();
  }

  function onInput() {
    const input = $("#search-input", dlg);
    q = input.value.slice(0, root.bnFuzzy.MAX_QUERY).replace(/\s+/g, " ").trim();
    draw();
    clearTimeout(waitT);
    if (q.length < MIN_ASYNC) { chats = { q: "", list: [], error: "", busy: false }; code = { q: "", sessions: null, files: [], error: "", busy: false, id: "" }; return; }
    waitT = setTimeout(() => { askCode(q); askChats(q); }, WAIT_MS);
  }
  function onKey(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!options.length) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((active + d + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) activate(active);
    } else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); setActive(options.length - 1); }
  }

  let returnTo = null;
  function open(text) {
    if (dlg.open) { $("#search-input", dlg).select(); return; }
    returnTo = document.activeElement;
    const input = $("#search-input", dlg);
    if (typeof text === "string") input.value = text;
    dlg.showModal();
    opener.setAttribute("aria-expanded", "true");
    input.focus();
    input.select();
    onInput();
    loadIndex();
  }
  function close() {
    if (!dlg.open) return;
    dlg.close();
  }
  dlg.addEventListener("close", () => {
    opener.setAttribute("aria-expanded", "false");
    clearTimeout(waitT); clearTimeout(codeT);
    // back where it was — unless what was chosen moved the focus already (Activity, the walkthrough, a setting)
    const a = document.activeElement;
    if ((!a || a === document.body || dlg.contains(a)) && returnTo && document.contains(returnTo) && returnTo !== document.body) {
      try { returnTo.focus({ preventScroll: true }); } catch (_) { /* fine */ }
    }
  });

  // --- wiring ---
  $("#search-input", dlg).addEventListener("input", onInput);
  $("#search-input", dlg).addEventListener("keydown", onKey);
  $("#search-close", dlg).addEventListener("click", close);
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });   // the backdrop
  const kbd = $("#search-kbd");
  if (kbd) kbd.textContent = MAC ? "⌘K" : "Ctrl K";
  opener.setAttribute("aria-keyshortcuts", MAC ? "Meta+K" : "Control+K");
  opener.hidden = false;
  opener.addEventListener("click", () => open());
  if (moreEntry) { moreEntry.hidden = false; moreEntry.addEventListener("click", () => setTimeout(() => open(), 0)); }   // (after More closes)
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (e.key || "").toLowerCase() !== "k") return;
    if (document.querySelector("dialog[open]:not(#search)")) return;   // never over the password dialogs
    e.preventDefault();
    if (dlg.open) close(); else open();
  });
  window.bnSearch.open = open;
})(typeof window !== "undefined" ? window : globalThis);
