// The optional Code page (./stack code): the Code tab — in the sidebar directly under Chat on a big screen, full
// screen from More on a phone — its badge (permission prompts waiting), and a line on Home's Claude Code card. Loaded
// after app.js and mobile.js (deferred; shares their $, el, appUrl and APP_URLS) and adds its elements before
// DOMContentLoaded, so app.js binds the tab like the others. The tab frames code.<host> like any app: while the Code
// page is locked, that host answers with its own "Unlock the Code page" form (the portal password again).
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

  // The framed page says how many permission prompts wait ({type: "bn-code-status", pending: N, busy}, or the plain
  // page's {bn: "code", pending: N}); only the code host may.
  function listen() {
    let codeOrigin = "";
    try { codeOrigin = new URL(appUrl("code")).origin; } catch (_) { return; }
    window.addEventListener("message", (e) => {
      if (e.origin !== codeOrigin || !e.data || (e.data.type !== "bn-code-status" && e.data.bn !== "code") || !badge) return;
      const n = Number.isInteger(e.data.pending) && e.data.pending > 0 ? Math.min(e.data.pending, 99) : 0;
      badge.textContent = n ? String(n) : "";
      badge.hidden = !n;
      document.title = n ? `(${n}) bedrock-now` : "bedrock-now";
    });
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
      line = el("p", { class: "note code-line" }, "Or in the browser with a chat: ", el("a", { href: "#settings", text: "Settings → Code page" }),
        " (on this computer) or ", el("code", { text: "./stack code enable" }),
        " adds a Code tab (Claude Code in the terminal's sandbox, with permission prompts and your files).");
    }
    card.append(line);
  }

  if (here) { addTab(); addSheetLink(); listen(); }
  cardLine();
})();
