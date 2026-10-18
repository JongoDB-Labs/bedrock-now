// The optional Code page (./stack code): the Code tab — in the sidebar directly under Chat on a big screen, full
// screen from More on a phone — its badge (permission prompts waiting), and a line on Home's Claude Code card. Loaded
// after app.js and mobile.js (deferred; shares their $, el, appUrl and APP_URLS) and adds its elements before
// DOMContentLoaded, so app.js binds the tab like the others. The tab frames code.<host> like any app: while the Code
// page is locked, that host answers with its own "Unlock the Code page" form (the portal password again). On a big
// screen, in a browser that has used the Code page (its page reported to the portal once), the frame is made (hidden)
// once the portal is idle, so the badge counts prompts before the tab is opened; a browser that never opened it loads
// nothing from the code host. Home's Code card: the sessions that need you and the recent ones as the framed page
// reports them (titles are sandbox data: text only, capped), Resume and Ask links (deep links: ?session=, and ?prompt=
// — a draft the Code page marks as coming from a link, never sent by itself), and the terminal key's budget.
// The tab is there while the Code page is off on this site too (turned off, or not allowed over remote access): muted,
// with an "off" pill, it then shows a page of the portal's own — what the Code page is, what turning it on does and how —
// with no frame, no badge and nothing loaded from the code host.
"use strict";

(() => {
  const state = (() => {
    try { return JSON.parse(document.querySelector('meta[name="bn-code"]').content) || {}; } catch (_) { return {}; }
  })();
  const here = Boolean(state.here && APP_URLS.code);
  const NS = "http://www.w3.org/2000/svg";
  const icon = (d) => {
    const s = document.createElementNS(NS, "svg"), p = document.createElementNS(NS, "path");
    s.setAttribute("viewBox", "0 0 20 20"); s.setAttribute("aria-hidden", "true"); p.setAttribute("d", d); s.append(p);
    return s;
  };
  const BRACKETS = "M7.5 5.5 3 10l4.5 4.5M12.5 5.5 17 10l-4.5 4.5M11 4l-2 12";
  const POPOUT = "M11 4h5v5M16 4l-7 7M14 12v4H4V6h4";
  let badge = null;
  // set the first time the Code page's own page (unlocked, running) reports to the portal; kept in this browser
  const USED = "bn.code.used";
  const used = () => { try { return localStorage.getItem(USED) === "1"; } catch (_) { return false; } };
  const markUsed = () => { try { if (!used()) localStorage.setItem(USED, "1"); } catch (_) { /* storage blocked: fine */ } };

  // Sidebar: directly under Chat, with a pop-out like the other apps and a badge for permission prompts waiting — or,
  // while the Code page is off here, muted with an "off" pill (no pop-out, no badge: its page is the portal's own).
  function addTab() {
    const chat = $(".tabs .tab[data-tab=chat]");
    const after = chat ? chat.closest("li") : null;
    if (!after) return;
    if (!here) {
      after.after(el("li", { class: "code-item off" },
        el("button", { type: "button", class: "tab", "data-tab": "code", "data-label": "Code (off)" }, icon(BRACKETS), "Code",
          el("span", { class: "tab-off", text: "off" }))));
      return;
    }
    badge = el("span", { class: "tab-badge", "aria-label": "permission prompts waiting", hidden: "" });
    after.after(el("li", { class: "code-item" },
      el("button", { type: "button", class: "tab", "data-tab": "code" }, icon(BRACKETS), "Code", badge),
      el("a", { class: "popout", "data-app": "code", href: appUrl("code"), target: "_blank", rel: "noopener",
        title: "Open Code in its own window", "aria-label": "Open Code in its own window" }, icon(POPOUT))));
  }

  // Phone: under More, full screen in a new tab (chat-first; an on-screen keyboard leaves no room for a framed IDE) —
  // or, while it is off here, its page of the portal (on a phone too: it is no frame; mobile.js closes the sheet).
  function addSheetLink() {
    const list = $("#more-sheet .sheet-links");
    if (!list) return;
    if (!here) {
      const b = el("button", { type: "button", class: "sheet-link code-off-link" }, "Code (off)",
        el("span", { text: "Claude Code in the browser: what it is, and how to turn it on" }));
      b.addEventListener("click", () => showTab("code"));
      list.prepend(el("li", {}, b));
      return;
    }
    list.prepend(el("li", {}, el("a", { class: "sheet-link", "data-app": "code", href: appUrl("code"), target: "_blank",
      rel: "noopener" }, "Code", el("span", { text: "Claude Code with a chat and your files, full screen" }))));
  }

  // --- Home's Code card ---
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const STATES = { waiting: "needs you", working: "working", idle: "idle" };
  let reported = null;   // {waiting, sessions} from the framed page; null until it reports
  // linkTo({session, prompt}) -> the Code page's address with that deep link
  function linkTo(params) {
    const u = new URL(appUrl("code"));
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    return u.href;
  }
  // a deep link in the Code tab (its frame loads it: the page reads it once and takes it out of its address), or on a
  // phone in a tab of its own
  function openLink(params) {
    const href = linkTo(params);
    if (window.matchMedia("(max-width: 767.98px)").matches) { window.open(href, "_blank", "noopener"); return; }
    showTab("code");
    appFrame("code").src = href;
  }
  function codeCard() {
    let card = $("section.code-card");
    if (card) return card;
    const claude = $("section.claude");
    if (!claude) return null;
    const input = el("input", { type: "text", id: "code-ask", maxlength: "4000", placeholder: "Ask Claude in Code…", "aria-label": "A prompt for the Code page" });
    const form = el("form", { class: "code-ask" }, input, el("button", { type: "submit", class: "action", text: "Open in Code" }));
    form.addEventListener("submit", (e) => { e.preventDefault(); const t = input.value.trim(); if (t) { openLink({ prompt: t }); input.value = ""; } });
    const open = el("button", { type: "button", class: "linkish", text: "Open Code" });
    open.addEventListener("click", () => { if (window.matchMedia("(max-width: 767.98px)").matches) window.open(appUrl("code"), "_blank", "noopener"); else showTab("code"); });
    card = el("section", { class: "code-card", "aria-labelledby": "code-card-title" },
      el("h2", { id: "code-card-title", text: "Code" }),
      el("p", { class: "note code-status", id: "code-status", "aria-live": "polite" }),
      el("ul", { class: "code-sessions", id: "code-sessions" }),
      form,
      el("p", { class: "note", text: "Opens Code with your text in its prompt box, to read and send there: nothing is sent from here." }),
      el("p", { class: "note code-budget", id: "code-budget", hidden: "" }),
      el("p", { class: "note" }, open));
    // high in the second column, under Services: "N sessions need you" is something to act on
    const services = $("section.services");
    if (services) services.after(card); else claude.before(card);
    renderCard();
    return card;
  }
  function renderCard() {
    const status = $("#code-status"), list = $("#code-sessions");
    if (!status || !list) return;
    list.replaceChildren();
    if (!reported) {
      status.textContent = used() ? "Your sessions show here once the Code page has loaded (it loads in the background)." : "Claude Code with a chat, your files and permission prompts: open Code to start.";
      return;
    }
    const n = reported.waiting;
    status.textContent = n ? `${n} session${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you` : reported.sessions.length ? "Nothing waits for you." : "No session is open.";
    status.classList.toggle("waiting", n > 0);
    for (const s of reported.sessions.slice(0, 5)) {
      const resume = el("a", { class: "linkish", href: linkTo({ session: s.id }), text: s.state === "waiting" ? "Answer" : "Resume" });
      resume.addEventListener("click", (e) => { e.preventDefault(); openLink({ session: s.id }); });
      list.append(el("li", { class: `code-session ${s.state}` }, el("span", { class: "code-dot", "aria-hidden": "true" }),
        el("span", { class: "code-title", text: s.title || "Untitled session" }), el("span", { class: "note code-state", text: STATES[s.state] }), resume));
    }
  }
  // the framed page's Git hosts uses (its Git panel: your pushes and pulls, Claude's own git getting a credential),
  // checked: ids, times, a few words each, at most 10 — shown as text by Activity
  const GIT_ACTIONS = ["fetch", "pull", "push", "publish", "clone", "test", "credential", "ssh-login", "claude"];
  function takeGit(v) {
    if (!Array.isArray(v)) return [];
    return v.slice(0, 10).filter((x) => x && typeof x.id === "string" && /^[0-9a-f]{12}$/.test(x.id) && Number.isFinite(x.at) && x.at > 0 && GIT_ACTIONS.includes(x.action))
      .map((x) => ({ id: x.id, at: Math.floor(x.at), who: x.who === "claude" ? "claude" : "you", action: x.action, ok: x.ok !== false,
        host: typeof x.host === "string" ? shownTitle(x.host).slice(0, 60) : "", target: typeof x.target === "string" ? shownTitle(x.target) : "" }));
  }
  // the framed page's list, checked: ids, states, short titles, at most 8
  function takeSessions(v) {
    if (!Array.isArray(v)) return [];
    return v.slice(0, 8).filter((x) => x && typeof x.id === "string" && UUID.test(x.id) && Object.prototype.hasOwnProperty.call(STATES, x.state))
      .map((x) => ({ id: x.id, state: x.state, title: typeof x.title === "string" ? shownTitle(x.title) : "" }));
  }
  // A title as the Code page shows it: at most 120 characters, line breaks and tabs as spaces, other control
  // characters and the invisible or direction-changing ones ("Trojan Source": bidi overrides and isolates, zero-width
  // characters, tag characters) shown as ⟨U+202E⟩ — so "notes⟨U+202E⟩fdp.exe" cannot pass for another name.
  const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;
  function shownTitle(t) {
    return Array.from(t.slice(0, 240)).slice(0, 120).join("").replace(/[\t\n\r]/g, " ")
      .replace(INVISIBLE, (c) => `⟨U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`);
  }
  function budgetLine(d) {
    const p = $("#code-budget");
    const k = d && d.spend && (d.spend.keys || []).find((x) => x.alias === "claude-code-terminal");
    if (!p) return;
    p.hidden = !k || k.error || typeof k.spend !== "number";
    if (!p.hidden) p.textContent = `Its key (Terminal / Code page): ${usd(k.spend)}${k.max_budget != null ? ` of ${usd(k.max_budget)}` : ""} this period.`;
  }

  // The framed page says how many permission prompts wait ({type: "bn-code-status", pending: N, busy, bypass, waiting,
  // sessions}, or the plain page's {bn: "code", pending: N}); only the code host may. bypass: a session runs without
  // asking (Bypass permissions) — the badge turns red and says ⏵⏵ (the CLI's marker) while nothing waits.
  function listen() {
    let codeOrigin = "";
    try { codeOrigin = new URL(appUrl("code")).origin; } catch (_) { return; }
    // (and only from the Code tab's own frame: another window of the code host — a pop-out, a page it opened — says
    // nothing here)
    const codeFrame = () => document.querySelector('#frames iframe[data-app="code"]');
    window.addEventListener("message", (e) => {
      const f = codeFrame();
      if (e.origin !== codeOrigin || !f || e.source !== f.contentWindow || !e.data || (e.data.type !== "bn-code-status" && e.data.bn !== "code") || !badge) return;
      markUsed();
      const n = Number.isInteger(e.data.pending) && e.data.pending > 0 ? Math.min(e.data.pending, 99) : 0;
      const bypass = e.data.bypass === true;
      badge.textContent = n ? String(n) : bypass ? "⏵⏵" : "";
      badge.hidden = !n && !bypass;
      badge.classList.toggle("bypass", bypass);
      badge.title = bypass ? "A Code session runs without asking (Bypass permissions)" : "";
      document.title = n ? `(${n}) bedrock-now` : "bedrock-now";
      if (e.data.type === "bn-code-status") {
        reported = { waiting: Number.isInteger(e.data.waiting) && e.data.waiting > 0 ? Math.min(e.data.waiting, 99) : 0, sessions: takeSessions(e.data.sessions), git: takeGit(e.data.git) };
        renderCard();
        // the frame reported since it (re)loaded: the global search may ask it (search.js); a reload (a deep link, the
        // unlock ending) waits for its next report
        if (!hooked.has(f)) { hooked.add(f); f.addEventListener("load", () => { loadedAt = Date.now(); }); }
        reportedAt = Date.now();
        // Activity (activity.js): the sessions that wait for you — the same checked copy the card shows
        document.dispatchEvent(new CustomEvent("bn:code-status", { detail: { waiting: reported.waiting, sessions: reported.sessions.map((x) => ({ ...x })), git: reported.git.map((x) => ({ ...x })) } }));
      }
    });
  }
  const hooked = new WeakSet();
  let reportedAt = 0, loadedAt = 0;

  // For the global search (search.js) and Activity: what Home's card knows, whether the frame can be asked, and the two
  // ways into the Code page from there — a session by deep link (as Resume), a workspace file by a message to the frame
  // (the Code page checks the path itself, and opens it only as a file of its workspace)
  window.bnCode = {
    ready: () => Boolean(reported) && reportedAt > loadedAt && Boolean(document.querySelector('#frames iframe[data-app="code"]')),
    sessions: () => (reported ? reported.sessions.map((x) => ({ id: x.id, title: x.title, state: x.state })) : []),
    openSession: (id) => { if (typeof id === "string" && UUID.test(id)) openLink({ session: id }); },
    // Settings › Claude Code › Git hosts, and an Activity item of one: the Code page's Git hosts
    openGitHosts: () => openLink({ git: "hosts" }),
    openFile: (path) => {
      const f = document.querySelector('#frames iframe[data-app="code"]');
      let origin = "";
      try { origin = new URL(appUrl("code")).origin; } catch (_) { return; }
      if (!f || typeof path !== "string" || !path || path.length > 1024) return;
      showTab("code");
      f.contentWindow.postMessage({ type: "bn-portal-open", path }, origin);
    },
  };

  // The badge needs the page running: its frame, hidden, once the portal has nothing else to do — only in a browser
  // that has used the Code page (else the code host would answer its locked form, unasked), and not on a phone (there
  // the Code page opens in a tab of its own, and an idle frame would only cost battery).
  function preload() {
    if (!used() || window.matchMedia("(max-width: 767.98px)").matches) return;
    const make = () => { if (!window.matchMedia("(max-width: 767.98px)").matches) appFrame("code"); };
    if ("requestIdleCallback" in window) window.requestIdleCallback(make, { timeout: 5000 });
    else setTimeout(make, 2000);
  }

  // --- the Code tab while the Code page is off here: a page of the portal (no frame, nothing from the code host) ---
  // Settings at the Code page's switch: its address, #settings/CODE_ENABLED — settings.js opens its section (Claude
  // Code), scrolls to it and lights it up (also when the address is that already: showTab reads it again)
  const SWITCH = "#settings/CODE_ENABLED";
  function toSettings() {
    if (location.hash === SWITCH) showTab(SWITCH.slice(1)); else location.hash = SWITCH;
  }
  const settingsLink = (text) => el("a", { href: SWITCH, text });
  const code = (t, id) => el("code", id ? { id, text: t } : { text: t });
  function copyCmd(text) {
    const b = el("button", { type: "button", class: "copy", text: "Copy" });
    b.addEventListener("click", () => copy(text, "the command"));
    return el("p", { class: "cmdline" }, code(text), " ", b);
  }
  const item = (...c) => el("li", {}, ...c);
  const FEATURES = [
    ["Chat", "Ask in plain words. Answers stream in, with each command and its output, and each file change as a diff."],
    ["Your files", "An explorer and an editor for the workspace folder; drop files in to upload them."],
    ["Permission prompts", "Allow once, Always or Deny, before a command runs or a file changes."],
    ["Previews", "The dev servers Claude starts, shown beside the chat."],
    ["Review and Git", "Every change with Keep and Undo; stage, commit and discard."],
    ["Run & test", "Your project's scripts and tests, with the problems they report."],
  ];

  function offPage() {
    const remoteOnly = state.enabled === true;   // on, but not over remote access (REMOTE_TERMINAL)
    const features = el("ul", { class: "code-off-features" },
      ...FEATURES.map(([t, d]) => el("li", {}, el("strong", { text: t }), el("span", { text: d }))));
    const card = el("div", { class: "code-off-card" });
    if (remoteOnly) {
      card.append(
        el("p", { class: "code-off-lede", text: "The Code page is on, on the computer running bedrock-now: open the portal there and this tab opens it. Over remote access it stays off unless you allow it, because Claude runs commands on that computer." }),
        el("p", { class: "note", text: "It is Claude Code in your browser, like its desktop app:" }), features,
        el("h2", { text: "Using it from your devices too" }),
        el("ol", { class: "code-off-list" },
          item("On the computer running bedrock-now, set ", code("REMOTE_TERMINAL=true"), " in ", code(".env"), ", then run ", code("./stack up"), "."),
          item("The same switch shares the browser terminal over remote access too (a shell from your phone), so it is a step in a terminal on purpose: Settings shows it, read-only."),
          item("With Tailscale, approve the new Services (", code("…-terminal"), " and ", code("…-code"), ") in the admin console like the others; ", code("./stack remote status"), " lists them."),
          item("Both still ask for the portal password again before they open.")));
    } else {
      const ws = code("~/bedrock-now-workspace", "code-off-ws");
      const other = code("./stack code enable --workspace DIR", "code-off-other");
      const turnOn = el("button", { type: "button", class: "action primary", id: "code-off-settings", text: "Turn on in Settings" });
      turnOn.addEventListener("click", toSettings);
      card.append(
        el("p", { class: "code-off-lede", text: "Claude Code in your browser, like its desktop app: a chat with Claude beside your project's files, and every command and file change shown to you first." }),
        el("p", { class: "code-off-actions" }, turnOn, el("span", { class: "note", text: "on the computer running bedrock-now" })),
        features,
        el("h2", { text: "What turning it on does" }),
        el("ul", { class: "code-off-list" },
          item("Claude runs in the browser terminal's ", el("strong", { text: "sandbox" }), ", not on your computer itself; the terminal is turned on too if it is off (a Terminal tab comes with it)."),
          item("It sees ", el("strong", { text: "one folder" }), " of this computer, its workspace: ", ws, " (created if it is not there). Another folder: ", other, "."),
          item("It has ", el("strong", { text: "its own key and budget" }), " (the terminal's, $50 a month unless you change it), apart from Chat's and ", code("claude-bedrock"), "'s; its spend shows on Home."),
          item("Claude ", el("strong", { text: "asks before acting" }), ": in Manual mode every command and file change waits for your OK. Bypass permissions and Auto mode stay off unless you allow them in Settings › Claude Code."),
          item("It asks for the portal password again before it opens, because it runs commands. The sandbox reaches ", el("strong", { text: "public internet addresses only" }), ", through its egress proxy: not this computer's own services, your local network or private addresses. Settings › Claude Code › Sandbox internet access changes that (", code("TERMINAL_EGRESS=off"), " in ", code(".env"), ": no internet at all)."),
          item("The first time, it builds the Code page's image: a few minutes.")),
        el("h2", { text: "Turning it on" }),
        el("p", { class: "note", text: "Turn on in Settings works only on the computer running bedrock-now: from another device, Settings shows the switch but leaves it to that computer. Or in a terminal, in your bedrock-now folder:" }),
        copyCmd("./stack code enable"),
        el("p", { class: "note", text: "Once it is on, reload this page: this tab then opens Claude Code. Turning it off again works from anywhere and keeps the terminal." }));
    }
    const head = el("header", { class: "home-head code-off-head" },
      el("h1", { id: "code-off-title" }, el("span", { class: "code-off-icon", "aria-hidden": "true" }, icon(BRACKETS)), "Code",
        el("span", { class: "code-off-pill", text: remoteOnly ? "off for remote access" : "off" })));
    const page = el("section", { id: "code", class: "code-off-page", "aria-labelledby": "code-off-title", hidden: "" }, head, card);
    $("#frames").before(page);
    PAGES.push("code");
    if (!remoteOnly) document.addEventListener("bn:tab", (e) => { if (e.detail === "code") fillFolder(); });
  }
  // The folder Claude would see, as Settings names it: the terminal's (TERMINAL_WORKSPACE) while the terminal is on,
  // else the one ./stack code enable would give it (the snapshot's choices.code_workspace). Asked when the page shows.
  let folderAsked = false;
  async function fillFolder() {
    if (folderAsked) return;
    folderAsked = true;
    try {
      const d = await api("/api/settings");
      const keys = {};
      for (const k of (d.snapshot && d.snapshot.keys) || []) keys[k.key] = k;
      const termOn = Boolean(keys.TERMINAL_ENABLED && keys.TERMINAL_ENABLED.value === "true");
      const ws = termOn ? (keys.TERMINAL_WORKSPACE && keys.TERMINAL_WORKSPACE.value) || ""
        : (d.snapshot && d.snapshot.choices && d.snapshot.choices.code_workspace) || "";
      if (ws) $("#code-off-ws").textContent = ws;
      if (termOn) $("#code-off-other").textContent = "./stack terminal enable --workspace DIR";
    } catch (_) { folderAsked = false; /* the default folder's name stays */ }
  }

  // Home's "Claude Code in your terminal" card: where else it runs.
  function cardLine() {
    const card = $("section.claude");
    if (!card) return;
    let line;
    const tab = el("button", { type: "button", class: "linkish", text: "Code tab" });
    tab.addEventListener("click", () => showTab("code"));
    if (here) {
      line = el("p", { class: "note code-line" }, "Or with a chat, your files and permission prompts: the ", tab,
        ". Claude runs in the terminal's sandbox; it asks for the portal password again.");
    } else if (state.enabled) {
      line = el("p", { class: "note code-line" }, "The ", tab, " is off for remote access (", code("REMOTE_TERMINAL=true"),
        " in ", code(".env"), " turns it on with the terminal).");
    } else {
      line = el("p", { class: "note code-line" }, "Or in the browser with a chat: the ", tab, ", off for now. ",
        settingsLink("Settings › Claude Code"), " (on the computer running bedrock-now) or ", code("./stack code enable"), " turns it on.");
    }
    card.append(line);
  }

  // An update nobody watched turning the Code page on by default (lib/code.sh code_default_notice) is said once in
  // Activity (activity.js, from /api/activity), with Keep and Turn off: it used to be a banner on Home.

  // (Home's Code card first: the framed page's first report finds it there)
  if (here) { codeCard(); document.addEventListener("bn:summary", (e) => budgetLine(e.detail)); }
  addTab(); addSheetLink();
  if (here) { listen(); window.addEventListener("load", preload, { once: true }); } else offPage();
  cardLine();
})();
