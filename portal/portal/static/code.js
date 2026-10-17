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

  // Sidebar: directly under Chat, with a pop-out like the other apps and a badge for permission prompts waiting.
  function addTab() {
    const chat = $(".tabs .tab[data-tab=chat]");
    const after = chat ? chat.closest("li") : null;
    if (!after) return;
    badge = el("span", { class: "tab-badge", "aria-label": "permission prompts waiting", hidden: "" });
    after.after(el("li", { class: "code-item" },
      el("button", { type: "button", class: "tab", "data-tab": "code" }, icon(BRACKETS), "Code", badge),
      el("a", { class: "popout", "data-app": "code", href: appUrl("code"), target: "_blank", rel: "noopener",
        title: "Open Code in its own window", "aria-label": "Open Code in its own window" }, icon(POPOUT))));
  }

  // Phone: under More, full screen in a new tab (chat-first; an on-screen keyboard leaves no room for a framed IDE).
  function addSheetLink() {
    const list = $("#more-sheet .sheet-links");
    if (!list) return;
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
        reported = { waiting: Number.isInteger(e.data.waiting) && e.data.waiting > 0 ? Math.min(e.data.waiting, 99) : 0, sessions: takeSessions(e.data.sessions) };
        renderCard();
      }
    });
  }

  // The badge needs the page running: its frame, hidden, once the portal has nothing else to do — only in a browser
  // that has used the Code page (else the code host would answer its locked form, unasked), and not on a phone (there
  // the Code page opens in a tab of its own, and an idle frame would only cost battery).
  function preload() {
    if (!used() || window.matchMedia("(max-width: 767.98px)").matches) return;
    const make = () => { if (!window.matchMedia("(max-width: 767.98px)").matches) appFrame("code"); };
    if ("requestIdleCallback" in window) window.requestIdleCallback(make, { timeout: 5000 });
    else setTimeout(make, 2000);
  }

  // Home's "Claude Code in your terminal" card: where else it runs.
  function cardLine() {
    const card = $("section.claude");
    if (!card) return;
    let line;
    if (here) {
      const open = el("button", { type: "button", class: "linkish", text: "Code tab" });
      open.addEventListener("click", () => showTab("code"));
      line = el("p", { class: "note code-line" }, "Or with a chat, your files and permission prompts: the ", open,
        ". Claude runs in the terminal's sandbox; it asks for the portal password again.");
    } else if (state.enabled) {
      line = el("p", { class: "note code-line" }, "The Code tab is off for remote access (", el("code", { text: "REMOTE_TERMINAL=true" }),
        " in ", el("code", { text: ".env" }), " turns it on with the terminal).");
    } else {
      line = el("p", { class: "note code-line" }, "Or in the browser with a chat: ", el("a", { href: "#settings/CODE_ENABLED", text: "Settings → Claude Code" }),
        " (on this computer) or ", el("code", { text: "./stack code enable" }),
        " adds a Code tab (Claude Code in the terminal's sandbox, with permission prompts and your files).");
    }
    card.append(line);
  }

  // (Home's Code card first: the framed page's first report finds it there)
  if (here) { codeCard(); document.addEventListener("bn:summary", (e) => budgetLine(e.detail)); }
  if (here) { addTab(); addSheetLink(); listen(); window.addEventListener("load", preload, { once: true }); }
  cardLine();
})();
