// Activity: the portal's notification centre. One bell in the sidebar (desktop and tablet; on a phone an entry under
// More, and a dot on More) with the number of unread items, and a panel of them: budgets past BUDGET_ALERT_PCT or used
// up, an update, Code page sessions that wait for you, the update helper's and the terminal's jobs (Settings changes,
// diagnostics, updates, rollbacks, ./stack commands), the Code page turned on by an update nobody watched (Keep / Turn
// off: what used to be a banner on Home), a model check that could not check every model, failed OpenRouter requests.
//
// Where each comes from — nothing new is sent outside the stack, and nothing here is sent anywhere:
//   /api/activity   what the status files say (portal/activity.py): the jobs, the update, the Code page notice, the
//                   model check — the same for every browser
//   /api/summary    budgets and OpenRouter failures (Home loads it; here at most every 5 minutes while Home is not shown)
//   bn:code-status  the Code tab's frame's report (code.js checks its origin and its window, and its fields)
// Read, unread and dismissed are this browser's (localStorage "bn.activity": item ids and times only, never a title or
// a text), as are browser notifications: off until you turn them on here (the browser asks once), and only while a
// portal tab is open — no push service, no service worker push. Every node is built with el()/textContent: nothing from
// the API, the status files or the Code page is parsed as HTML. Loaded after app.js, mobile.js and code.js (deferred).
"use strict";

(function (root) {
  const STORE = "bn.activity";
  const NOTICE_SEEN = "bn.code.defaultNotice";   // Keep on the old Home banner (code.js before): that notice stays read
  const KEEP_MS = 45 * 86400000;
  const MAX_IDS = 300;
  const ID = /^[A-Za-z0-9:._@+-]{1,160}$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const LINK = /^#[a-z]+(?:\/[A-Za-z0-9_+-]{1,64}){0,2}$/;
  const LEVELS = ["info", "good", "warn", "bad"];
  // a key's budget setting (Settings › Spending & budgets), by the alias of its LiteLLM key
  const BUDGET_SETTING = { "open-webui": "BUDGET_OPENWEBUI", "claude-code": "BUDGET_CLAUDE_CODE", setup: "BUDGET_SETUP",
    "claude-code-terminal": "BUDGET_TERMINAL" };
  const MAPS = ["read", "dismissed", "first", "notified", "codeEp"];

  // --- pure parts (portal/tests/js/activity.test.mjs runs these in Node) ---
  const money = (v) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const idPart = (v) => String(v == null ? "" : v).replace(/[^A-Za-z0-9:.-]/g, "").slice(0, 40);

  // Budgets: a key at BUDGET_ALERT_PCT or more of its monthly budget (warn), or at 100 % (bad) — one item per key,
  // period and level, so the next period, or crossing from warn to used up, is new again.
  function budgetItems(spend) {
    const out = [];
    if (!spend || !Array.isArray(spend.keys)) return out;
    const alert = Number.isInteger(spend.alert_pct) && spend.alert_pct > 0 && spend.alert_pct < 100 ? spend.alert_pct : 80;
    for (const k of spend.keys.slice(0, 20)) {
      if (!k || k.error || typeof k.spend !== "number" || typeof k.max_budget !== "number" || !(k.max_budget > 0)) continue;
      const pct = (k.spend / k.max_budget) * 100;
      if (!(pct >= alert)) continue;
      const over = pct >= 100;
      const alias = idPart(k.alias) || "key";
      const label = String(k.label || k.alias || "A key").slice(0, 60);
      const reset = typeof k.reset_at === "string" ? k.reset_at : "";
      let resets = "";
      const d = reset ? new Date(reset) : null;
      if (d && !isNaN(d)) resets = ` · resets ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
      out.push({ id: `budget:${alias}:${idPart(k.period_start || reset) || "now"}:${over ? "over" : "warn"}`, kind: "budget",
        level: over ? "bad" : "warn",
        title: over ? `${label}: budget used up` : `${label}: ${Math.floor(pct)}% of its budget used`,
        text: (over ? "Requests with this key are refused until it resets. " : "") +
          `${money(k.spend)} of ${money(k.max_budget)} this period${resets}.`,
        at: null, link: `#settings/${BUDGET_SETTING[k.alias] || "spending"}`, notify: true, data: { label, pct: Math.floor(pct), over } });
    }
    return out;
  }

  // OpenRouter: requests that failed in the last hours (Home's list), as one item per newest failure.
  function openrouterItems(spend) {
    const f = spend && spend.openrouter_usage && spend.openrouter_usage.failures;
    if (!f || f.error || !Array.isArray(f.groups) || !f.groups.length) return [];
    const groups = f.groups.slice(0, 20).filter((g) => g && Number.isInteger(g.count) && g.count > 0);
    if (!groups.length) return [];
    const total = groups.reduce((n, g) => n + g.count, 0);
    const newest = groups.map((g) => (typeof g.last_at === "string" ? g.last_at : "")).sort().pop() || "";
    const hours = Number.isInteger(f.hours) ? f.hours : 24;
    const what = groups.slice(0, 2).map((g) => `${g.count}× ${String(g.label || "").slice(0, 80)}`).join("; ");
    const fix = groups[0].fix ? ` ${String(groups[0].fix).slice(0, 160)}` : "";
    return [{ id: `openrouter:${idPart(newest) || total}`, kind: "openrouter", level: "warn",
      title: `${total} failed OpenRouter request${total === 1 ? "" : "s"} in the last ${hours} hours`,
      text: `${what}.${fix}`, at: newest ? Math.floor(Date.parse(newest) / 1000) || null : null, link: "#home", notify: true }];
  }

  // Code page sessions that wait for you (a permission prompt, a question, a plan), from the Code tab's frame. An episode
  // (EPISODES: session id -> when it was first seen waiting) makes each wait an item of its own; it ends when the
  // session no longer waits. -> {items, episodes}
  function codeItems(report, episodes, now) {
    const eps = {};
    const items = [];
    const sessions = report && Array.isArray(report.sessions) ? report.sessions.slice(0, 8) : [];
    for (const s of sessions) {
      if (!s || typeof s.id !== "string" || !UUID.test(s.id) || s.state !== "waiting") continue;
      const ep = episodes && Number.isFinite(episodes[s.id]) ? episodes[s.id] : now;
      eps[s.id] = ep;
      items.push({ id: `code:${s.id}:${Math.floor(ep / 1000)}`, kind: "code", level: "warn", title: "A Code session needs you",
        text: typeof s.title === "string" && s.title ? s.title.slice(0, 120) : "Untitled session",
        at: Math.floor(ep / 1000), link: "", notify: true, data: { session: s.id } });
    }
    // Git hosts' uses the Code page reports (code.js checked them): Claude's own git getting a credential (it may push
    // where the token reaches: worth a look, and a notification), a failed operation, your pushes and pulls
    const git = report && Array.isArray(report.git) ? report.git.slice(0, 10) : [];
    const VERB = { fetch: "Fetched", pull: "Pulled", push: "Pushed", publish: "Published", clone: "Cloned", test: "Tested a git host",
      claude: "Changed whether Claude may use a Git host" };
    for (const g of git) {
      if (!g || typeof g.id !== "string" || !Number.isFinite(g.at)) continue;
      const claude = g.who === "claude";
      const title = claude ? (g.ok ? `Claude's git used the Git host ${g.host || ""}`.trim() : `Claude's git was refused the Git host ${g.host || ""}`.trim())
        : g.ok ? `${VERB[g.action] || "Git"}${g.host ? ` (${g.host})` : ""}` : `A git ${g.action} failed`;
      const look = claude || !g.ok || g.action === "claude";
      items.push({ id: `git:${g.id}`, kind: "git", level: look ? "warn" : "info", title, text: String(g.target || "").slice(0, 200),
        at: Math.floor(g.at / 1000), link: "", notify: look, data: null });
    }
    return { items, episodes: eps };
  }

  // An item from /api/activity, checked (the server already did; this page trusts no shape it did not check).
  function takeServerItem(x) {
    if (!x || typeof x.id !== "string" || !ID.test(x.id) || !LEVELS.includes(x.level)) return null;
    const link = typeof x.link === "string" && LINK.test(x.link) ? x.link : "";
    const it = { id: x.id, kind: typeof x.kind === "string" ? x.kind.slice(0, 20) : "", level: x.level,
      title: String(x.title || "").slice(0, 160), text: String(x.text || "").slice(0, 400),
      at: Number.isInteger(x.at) && x.at > 0 ? x.at : null, link, notify: x.notify !== false, data: null };
    const d = x.data;
    if (d && typeof d === "object") {
      if (it.kind === "code-default" && Number.isInteger(d.at) && typeof d.workspace === "string") {
        it.data = { at: d.at, workspace: d.workspace.slice(0, 1024), egress: d.egress === true, terminal: d.terminal === true };
      } else if (it.kind === "job") {
        it.data = { origin: d.origin === "terminal" ? "terminal" : "helper", action: String(d.action || "").slice(0, 32), phase: String(d.phase || "").slice(0, 32) };
      }
    }
    return it;
  }

  // This browser's state from localStorage's text (anything odd in it is dropped).
  function loadState(text) {
    const s = { v: 1, notify: false };
    for (const m of MAPS) s[m] = {};
    let raw = null;
    try { raw = JSON.parse(text || "null"); } catch (_) { raw = null; }
    if (!raw || typeof raw !== "object") return s;
    s.notify = raw.notify === true;
    for (const m of MAPS) {
      const src = raw[m];
      if (!src || typeof src !== "object" || Array.isArray(src)) continue;
      for (const k of Object.keys(src).slice(0, MAX_IDS * 2)) {
        if (ID.test(k) && Number.isFinite(src[k])) s[m][k] = src[k];
      }
    }
    return s;
  }

  // Older than 45 days goes, and each map keeps its newest MAX_IDS (a waiting Code session's episode stays while it waits).
  function prune(s, now) {
    for (const m of MAPS) {
      let entries = Object.entries(s[m]).filter(([, t]) => m === "codeEp" || now - t < KEEP_MS);
      if (entries.length > MAX_IDS) entries = entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_IDS);
      s[m] = Object.fromEntries(entries);
    }
    return s;
  }

  // Server items and this page's, the newest first (an item without a time: when this browser first saw it).
  function merge(server, local, first, now) {
    const seen = new Set();
    const all = [];
    for (const it of [...local, ...server]) {
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      all.push({ ...it, at: it.at || Math.floor((first[it.id] || now) / 1000) });
    }
    return all.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
  }

  // What a browser notification says: fixed words only, never an item's title or text — a Code session's title or
  // prompt, a job's message, a model name or an error would otherwise show on a lock screen or in the system's
  // notification history. The details stay in the Activity panel, behind the portal's sign-in. A budget names its
  // key's label (this stack's own wording: "Chat (Open WebUI)") and the percentage.
  const NOTE_BODY = "Details in Activity, in the bedrock-now portal.";
  function notificationText(it) {
    const d = it && it.data && typeof it.data === "object" ? it.data : {};
    let title = "Something new in Activity";
    if (it && it.kind === "budget") {
      const label = typeof d.label === "string" && d.label ? d.label.slice(0, 40) : "a key";
      title = d.over === true ? `Budget used up: ${label}` : `Budget alert: ${label} at ${Number.isInteger(d.pct) ? d.pct : "?"} %`;
    } else if (it && it.kind === "code") title = "A Code session needs you";
    else if (it && it.kind === "git") title = "A Git host was used";
    else if (it && it.kind === "job") title = d.phase === "failed" ? "A job failed" : d.phase === "skipped" ? "A job was skipped" : "A job finished";
    else if (it && it.kind === "update") title = "A bedrock-now update is available";
    else if (it && it.kind === "code-default") title = "The Code page was turned on";
    else if (it && it.kind === "models") title = "A model check could not check every model";
    else if (it && it.kind === "openrouter") title = "OpenRouter requests failed";
    return { title, body: NOTE_BODY };
  }

  const isUnread = (it, s) => it.notify !== false && !s.read[it.id] && !s.dismissed[it.id];
  const unreadCount = (items, s) => items.filter((it) => isUnread(it, s)).length;

  const pure = { budgetItems, openrouterItems, codeItems, takeServerItem, loadState, prune, merge, unreadCount, isUnread, notificationText };
  root.bnActivity = { _pure: pure };
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return;

  // --- the page ---
  const PHONE = window.matchMedia("(max-width: 767.98px)");
  const ACTIVITY_MS = 30000, HIDDEN_MS = 60000, SUMMARY_MS = 5 * 60000;
  let state = loadState(read());
  let serverItems = [], localBudget = [], localOr = [], localCode = [], items = [];
  let lastReport = null, primed = false, showDismissed = false, opened = false;
  let actTimer = null, sumTimer = null, summaryAt = 0, lastJob = "", fetchErr = "";
  const panel = $("#activity"), bell = $("#activity-btn"), count = $("#activity-count");
  const moreEntry = $("#more-activity"), moreCount = $("#more-activity-count"), moreDot = $("#more-dot");
  if (!panel || !bell) return;

  function read() { try { return localStorage.getItem(STORE); } catch (_) { return null; } }
  function save() {
    prune(state, Date.now());
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (_) { /* storage blocked: kept for this page only */ }
  }
  // the Keep of the old Home banner still counts (one browser that pressed it then does not see the notice again)
  function legacyKept(it) {
    if (it.kind !== "code-default" || !it.data) return false;
    try { return localStorage.getItem(NOTICE_SEEN) === String(it.data.at); } catch (_) { return false; }
  }

  function rebuild() {
    const now = Date.now();
    const local = [...localBudget, ...localOr, ...localCode];
    let changed = false;
    for (const it of [...local, ...serverItems]) {
      if (!state.first[it.id]) { state.first[it.id] = now; changed = true; }
      if (legacyKept(it) && !state.dismissed[it.id]) { state.dismissed[it.id] = now; changed = true; }
    }
    items = merge(serverItems, local, state.first, now);
    if (changed) save();
    render();
    maybeNotify();
  }

  // --- notifications (opt-in, while a portal tab is open) ---
  const canNotify = () => "Notification" in window;
  function showNotification(it) {
    const t = notificationText(it);   // (generic words only: see above)
    const opts = { body: t.body, tag: `bn-${it.id}`.slice(0, 120), icon: "/icons/app-192.png" };
    try {
      const n = new Notification(t.title, opts);
      n.onclick = () => { try { window.focus(); } catch (_) { /* fine */ } n.close(); setOpen(true); };
    } catch (_) {
      // Android Chrome: notifications only through the service worker (sw.js focuses the portal on a click)
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then((r) => r && r.showNotification(t.title, opts)).catch(() => { /* fine */ });
      }
    }
  }
  function maybeNotify() {
    if (!state.notify || !canNotify() || Notification.permission !== "granted") return;
    // another tab may have notified already: its marks first
    state.notified = { ...state.notified, ...loadState(read()).notified };
    const now = Date.now();
    const news = items.filter((it) => isUnread(it, state) && !state.notified[it.id]);
    for (const it of news) state.notified[it.id] = now;
    if (news.length) save();
    // what was there when this page opened is on the bell, not a notification; nor is anything while you look at it
    if (!primed) { primed = true; return; }
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    news.slice(0, 3).forEach(showNotification);
  }
  async function setNotify(on) {
    const note = $("#activity-notify-note", panel);
    if (on) {
      if (!canNotify()) return;
      let perm = Notification.permission;
      if (perm === "default") { try { perm = await Notification.requestPermission(); } catch (_) { perm = "denied"; } }
      if (perm !== "granted") {
        state.notify = false;
        if (note) note.textContent = "Your browser blocks notifications for this site: allow them in its site settings, then turn this on again.";
        save(); render();
        return;
      }
      state.notify = true;
      const now = Date.now();
      for (const it of items) state.notified[it.id] = state.notified[it.id] || now;   // only what comes from now on
      primed = true;
    } else state.notify = false;
    save(); render(); schedule();
  }

  // --- data ---
  async function loadActivity() {
    clearTimeout(actTimer);
    try {
      const d = await api("/api/activity");
      serverItems = (Array.isArray(d.items) ? d.items : []).slice(0, 40).map(takeServerItem).filter(Boolean);
      fetchErr = "";
    } catch (e) {
      if (e.message === "signed out") return;
      fetchErr = `Could not load the latest (${e.message}); trying again.`;
    }
    rebuild();
    schedule();
  }
  async function loadSummary() {
    summaryAt = Date.now();   // (also when it fails: the next try is 5 minutes away)
    try { onSummary(await api("/api/summary")); } catch (_) { /* Home says why; the next try in 5 minutes */ }
  }
  function onSummary(d) {
    if (!d || !d.spend) return;
    summaryAt = Date.now();
    localBudget = budgetItems(d.spend);
    localOr = openrouterItems(d.spend);
    rebuild();
  }
  // /api/activity every 30 s while the page is seen; while hidden only with notifications on (every minute); the summary
  // only when Home's own refresh has not come for 5 minutes
  function schedule() {
    clearTimeout(actTimer); clearTimeout(sumTimer);
    const hidden = document.hidden;
    if (hidden && !state.notify) return;
    actTimer = setTimeout(loadActivity, hidden ? HIDDEN_MS : ACTIVITY_MS);
    sumTimer = setTimeout(() => { if (Date.now() - summaryAt >= SUMMARY_MS - 1000) loadSummary(); schedule(); },
      Math.max(5000, summaryAt + SUMMARY_MS - Date.now()));
  }

  // --- rendering ---
  function ago(sec) {
    const s = Math.max(0, Date.now() / 1000 - sec);
    if (s < 90) return "just now";
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 172800) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }
  const KIND_LABEL = { budget: "Budget", update: "Update", job: "Job", "code-default": "Code page", code: "Code", models: "Models", openrouter: "OpenRouter" };

  function go(link) {
    if (!LINK.test(link)) return;
    setOpen(false, false);
    if (link === "#home") { showTab("home"); return; }
    if (location.hash === link) showTab(link.slice(1)); else location.hash = link;
  }
  function onHome(sel) {
    setOpen(false, false);
    showTab("home");
    requestAnimationFrame(() => { const c = $(sel); if (c && !c.hidden) c.scrollIntoView({ block: "start" }); });
  }
  function markRead(it, on = true) {
    if (on) state.read[it.id] = Date.now(); else delete state.read[it.id];
    save(); render();
  }
  function dismiss(it, on = true) {
    if (on) { state.dismissed[it.id] = Date.now(); state.read[it.id] = state.read[it.id] || Date.now(); } else delete state.dismissed[it.id];
    // (the old banner's key follows: Keep is Keep everywhere, Restore undoes it)
    if (it.kind === "code-default" && it.data) {
      try { if (on) localStorage.setItem(NOTICE_SEEN, String(it.data.at)); else if (localStorage.getItem(NOTICE_SEEN) === String(it.data.at)) localStorage.removeItem(NOTICE_SEEN); } catch (_) { /* fine */ }
    }
    save(); render();
  }
  function actionButtons(it) {
    const out = [];
    const act = (label, fn, cls = "linkish") => {
      const b = el("button", { type: "button", class: cls, text: label });
      b.addEventListener("click", () => { markRead(it); fn(); });
      out.push(b);
    };
    if (it.kind === "update") act("What's new", () => { onHome("#update-card"); const n = $(".update-notes"); if (n) n.open = true; });
    else if (it.kind === "budget") act("Change the budget", () => go(it.link));
    else if (it.kind === "code" && it.data && window.bnCode) act("Answer", () => { setOpen(false, false); window.bnCode.openSession(it.data.session); });
    else if (it.kind === "git" && window.bnCode && window.bnCode.openGitHosts) act("Git hosts", () => { setOpen(false, false); window.bnCode.openGitHosts(); });
    else if (it.kind === "code-default") {
      act("Keep", () => dismiss(it), "action");
      act("Turn off", () => go("#settings/CODE_ENABLED"), "action");
    } else if (it.kind === "models") act("Check again in Settings", () => go(it.link));
    else if (it.kind === "openrouter") act("Show on Home", () => onHome("#openrouter"));
    else if (it.kind === "job") act(it.link === "#home" ? "Show on Home" : "Open Settings", () => (it.link === "#home" ? onHome("#job") : go(it.link)));
    else if (it.link) act("Open", () => go(it.link));
    return out;
  }
  function itemNode(it) {
    const unread = isUnread(it, state), gone = Boolean(state.dismissed[it.id]);
    const li = el("li", { class: `act-item act-${it.level}${unread ? " unread" : ""}${gone ? " gone" : ""}`, "data-id": it.id, "data-kind": it.kind });
    const head = el("p", { class: "act-title" }, el("span", { class: "act-kind", text: KIND_LABEL[it.kind] || "Note" }), " ",
      el("span", { class: "act-name", text: it.title }));
    const meta = el("p", { class: "act-meta" }, it.notify === false ? el("span", { class: "spinner", "aria-hidden": "true" }) : null,
      it.at ? el("time", { datetime: new Date(it.at * 1000).toISOString(), text: ago(it.at) }) : null,
      unread ? el("span", { class: "sr", text: " · unread" }) : null);
    const acts = el("p", { class: "act-actions" }, ...(gone ? [] : actionButtons(it)));
    if (gone) {
      const b = el("button", { type: "button", class: "quiet", text: "Restore" });
      b.addEventListener("click", () => dismiss(it, false));
      acts.append(b);
    } else {
      if (it.notify !== false) {
        const r = el("button", { type: "button", class: "quiet act-read", text: unread ? "Mark as read" : "Mark as unread" });
        r.addEventListener("click", () => markRead(it, unread));
        acts.append(r);
      }
      const x = el("button", { type: "button", class: "act-x", "aria-label": `Dismiss: ${it.title}`, title: "Dismiss (this browser)" }, el("span", { "aria-hidden": "true", text: "✕" }));
      x.addEventListener("click", () => dismiss(it));
      acts.append(x);
    }
    li.append(el("span", { class: "act-dot", "aria-hidden": "true" }), el("div", { class: "act-body" }, head,
      it.text ? el("p", { class: it.kind === "code" || it.kind === "git" ? "act-text act-untrusted" : "act-text", text: it.text }) : null, meta, acts));
    return li;
  }

  function build() {
    const close = el("button", { type: "button", class: "act-close", "aria-label": "Close activity", title: "Close (Esc)" }, el("span", { "aria-hidden": "true", text: "✕" }));
    close.addEventListener("click", () => setOpen(false));
    const all = el("button", { type: "button", class: "quiet", id: "activity-all-read", text: "Mark all as read" });
    all.addEventListener("click", () => { const now = Date.now(); for (const it of items) if (isUnread(it, state)) state.read[it.id] = now; save(); render(); });
    const bar = el("div", { class: "act-bar" }, all);
    if (canNotify()) {
      const chip = el("button", { type: "button", class: "chip", id: "activity-notify", "aria-pressed": "false", text: "Browser notifications" });
      chip.addEventListener("click", () => setNotify(!state.notify));
      bar.append(chip);
    }
    const toggle = el("button", { type: "button", class: "linkish", id: "activity-show-dismissed" });
    toggle.addEventListener("click", () => { showDismissed = !showDismissed; render(); });
    panel.replaceChildren(el("div", { class: "act-panel" },
      el("header", { class: "act-head" }, el("h2", { id: "activity-title", tabindex: "-1", text: "Activity" }), close),
      bar,
      el("p", { class: "note act-note", id: "activity-notify-note", "aria-live": "polite" }),
      el("p", { class: "note act-error", id: "activity-error", hidden: "" }),
      el("ul", { class: "act-list", id: "activity-list", "aria-labelledby": "activity-title" }),
      el("p", { class: "note act-empty", id: "activity-empty", hidden: "", text: "Nothing new. Budget warnings, updates, finished jobs and Code sessions that need you show up here." }),
      el("p", { class: "act-foot" }, toggle)));
  }

  function render() {
    const n = unreadCount(items, state);
    const label = n ? `Activity: ${n} unread` : "Activity";
    count.textContent = n > 9 ? "9+" : String(n);
    count.hidden = !n;
    bell.setAttribute("aria-label", label);
    bell.title = n ? `${n} unread in Activity` : "Activity";
    bell.classList.toggle("has-unread", n > 0);
    bell.classList.toggle("has-bad", items.some((it) => isUnread(it, state) && it.level === "bad"));
    if (moreCount) { moreCount.textContent = n > 9 ? "9+" : String(n); moreCount.hidden = !n; }
    if (moreDot) {
      moreDot.hidden = !n;
      const more = $("#more-btn");
      if (more) { if (n) more.setAttribute("aria-label", `More (${n} unread in Activity)`); else more.removeAttribute("aria-label"); }
    }
    if (!$("#activity-list", panel)) return;
    const shown = items.filter((it) => showDismissed || !state.dismissed[it.id]);
    const gone = items.filter((it) => state.dismissed[it.id]).length;
    // drawn again only when something it shows changed (or the minute did: "12 min ago"), and the button that had the
    // focus has it again — a refresh every 30 s must not take it away while you read or tab through
    const digest = JSON.stringify([Math.floor(Date.now() / 60000), showDismissed, shown.map((it) => [it.id, it.level, it.title, it.text, it.at,
      isUnread(it, state), Boolean(state.dismissed[it.id])])]);
    const list = $("#activity-list", panel);
    if (list.dataset.digest !== digest) {
      const f = document.activeElement && list.contains(document.activeElement) ? document.activeElement : null;
      const again = f ? [f.closest(".act-item") && f.closest(".act-item").dataset.id, f.className, f.textContent] : null;
      list.replaceChildren(...shown.map(itemNode));
      list.dataset.digest = digest;
      if (again) {
        const li = [...list.children].find((x) => x.dataset.id === again[0]);
        const b = li && ([...li.querySelectorAll("button")].find((x) => x.className === again[1] && x.textContent === again[2]) || li.querySelector("button"));
        (b || $("#activity-title", panel)).focus({ preventScroll: true });
      }
    }
    $("#activity-empty", panel).hidden = shown.length > 0;
    const toggle = $("#activity-show-dismissed", panel);
    toggle.hidden = !gone && !showDismissed;
    toggle.textContent = showDismissed ? "Hide dismissed" : `Show dismissed (${gone})`;
    $("#activity-all-read", panel).disabled = !n;
    const chip = $("#activity-notify", panel);
    if (chip) {
      const granted = Notification.permission === "granted";
      chip.setAttribute("aria-pressed", String(state.notify && granted));
      const note = $("#activity-notify-note", panel);
      if (note && !(Notification.permission === "denied" && !state.notify && note.textContent)) {
        note.textContent = state.notify && granted ? "On in this browser, while a portal tab is open (no push service): budgets, updates, finished jobs, Code sessions that need you."
          : Notification.permission === "denied" ? "Blocked for this site in your browser's settings." : "";
      }
    }
    const er = $("#activity-error", panel);
    er.textContent = fetchErr; er.hidden = !fetchErr;
  }

  // --- the panel: beside the sidebar (desktop, tablet), a sheet on a phone ---
  function onKey(e) {
    if (panel.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key !== "Tab" || !PHONE.matches) return;
    const f = [...panel.querySelectorAll("button:not([disabled]), a[href]")].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
  function onOutside(e) {
    if (panel.hidden || PHONE.matches) return;
    if (panel.contains(e.target) || bell.contains(e.target)) return;
    setOpen(false, false);
  }
  function setOpen(on, focus = true) {
    if (on === opened) { if (on && focus) $("#activity-title", panel).focus(); return; }
    opened = on;
    if (on && !$("#activity-list", panel)) build();
    panel.hidden = !on;
    panel.setAttribute("aria-modal", String(on && PHONE.matches));
    bell.setAttribute("aria-expanded", String(on));
    if (moreEntry) moreEntry.setAttribute("aria-expanded", String(on));
    document.body.classList.toggle("activity-open", on);
    if (on) {
      render();
      requestAnimationFrame(() => panel.classList.add("open"));
      if (focus) $("#activity-title", panel).focus();
      loadActivity();
    } else {
      panel.classList.remove("open");
      if (focus) (PHONE.matches ? $("#more-btn") : bell).focus();
    }
  }

  // --- wiring ---
  bell.hidden = false;
  if (moreEntry) moreEntry.hidden = false;
  bell.addEventListener("click", () => setOpen(!opened));
  if (moreEntry) moreEntry.addEventListener("click", () => setTimeout(() => setOpen(true), 0));   // (after More closes)
  panel.addEventListener("click", (e) => { if (e.target === panel && PHONE.matches) setOpen(false); });   // the backdrop
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", onOutside);
  // a click into an app's frame never reaches this page: the window losing focus to a frame closes the panel too
  window.addEventListener("blur", () => setTimeout(() => {
    if (opened && !PHONE.matches && document.activeElement && document.activeElement.tagName === "IFRAME") setOpen(false, false);
  }, 0));
  document.addEventListener("bn:summary", (e) => onSummary(e.detail));
  document.addEventListener("bn:code-status", (e) => {
    lastReport = e.detail;
    const r = codeItems(lastReport, state.codeEp, Date.now());
    localCode = r.items;
    const same = JSON.stringify(r.episodes) === JSON.stringify(state.codeEp);
    state.codeEp = r.episodes;
    if (!same) save();
    rebuild();
  });
  // a job that starts or ends (app.js polls the helper's status for Home): its item at once, not in 30 s
  document.addEventListener("bn:admin", (e) => {
    const j = e.detail && e.detail.job;
    const key = j ? `${j.id || ""}:${j.phase || ""}` : "";
    if (key !== lastJob) { lastJob = key; clearTimeout(actTimer); actTimer = setTimeout(loadActivity, 500); }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadActivity(); else schedule(); });
  // another tab marked something read or dismissed it
  window.addEventListener("storage", (e) => { if (e.key === STORE) { state = loadState(e.newValue); render(); } });
  PHONE.addEventListener("change", () => { if (opened) setOpen(false, false); });
  window.bnActivity.open = () => setOpen(true);
  window.bnActivity.items = () => items.map((it) => ({ ...it, unread: isUnread(it, state) }));
  window.bnActivity.refresh = loadActivity;
  if (typeof lastSummary !== "undefined" && lastSummary) onSummary(lastSummary);
  render();
  loadActivity();
})(typeof window !== "undefined" ? window : globalThis);
