// Phones and tablets: the bottom tab bar's "More" sheet, keyboard-aware height for Chat, the iOS dictation tip,
// Home's compact health line and status chips, and the service worker that makes the portal installable.
// Loaded after app.js (both deferred); app.js asks window.bnMobile which tab a phone may show and which comes first.
"use strict";

(() => {
  const PHONE = window.matchMedia("(max-width: 767.98px)");
  const DESKTOP_ONLY = new Set(["admin", "files"]);
  const HINT_KEY = "bn.voiceHint";
  let current = null;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* storage blocked: the tip shows again, fine */ } },
  };

  // iPhone, iPod, and iPad (which reports itself as a Mac with a touch screen since iPadOS 13).
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  window.bnMobile = {
    // Admin and Files are desktop apps: on a phone they open from the More sheet in a new tab instead.
    allowTab: (tab) => (PHONE.matches && DESKTOP_ONLY.has(tab) ? "chat" : tab),
    defaultTab: () => (PHONE.matches ? "chat" : "home"),
  };

  // --- keyboard-aware height: the shell follows the visual viewport, so the iOS keyboard never hides Chat's input.
  const vv = window.visualViewport;
  let fullHeight = 0;
  function fit() {
    const root = document.documentElement;
    if (!vv) return;
    // Pinch-zoomed: the visual viewport is a magnified part of the page, not the space the keyboard leaves.
    if (Math.abs(vv.scale - 1) > 0.01) return;
    fullHeight = Math.max(fullHeight, window.innerHeight, vv.height);
    root.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
    root.style.setProperty("--app-top", `${Math.round(vv.offsetTop)}px`);
    // A visual viewport much shorter than the screen means the on-screen keyboard is up: give Chat the room.
    root.classList.toggle("kb-open", fullHeight - vv.height > 150);
  }
  if (vv) {
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    window.addEventListener("orientationchange", () => { fullHeight = 0; setTimeout(fit, 300); });
    // A desktop window made shorter: no keyboard is involved (visual and layout viewport agree), so forget the
    // old tallest height instead of reading the difference as an open keyboard.
    window.addEventListener("resize", () => { if (Math.round(vv.height) === window.innerHeight) { fullHeight = 0; fit(); } });
  }

  // --- the More sheet (phones): Admin and Files in a new tab, and Sign out.
  function sheet() {
    const box = $("#more-sheet"), btn = $("#more-btn");
    if (!box || !btn) return;
    for (const a of box.querySelectorAll(".sheet-link[data-app]")) a.href = appUrl(a.dataset.app);
    const focusables = () => [...box.querySelectorAll("a[href], button")];
    const open = () => {
      box.hidden = false; btn.setAttribute("aria-expanded", "true");
      requestAnimationFrame(() => box.classList.add("open"));
      focusables()[0].focus();
    };
    const close = () => {
      box.classList.remove("open"); box.hidden = true; btn.setAttribute("aria-expanded", "false"); btn.focus();
    };
    btn.addEventListener("click", open);
    $("#more-close").addEventListener("click", close);
    box.addEventListener("click", (e) => { if (e.target === box) close(); });
    for (const a of box.querySelectorAll(".sheet-link")) a.addEventListener("click", () => setTimeout(close, 0));
    document.addEventListener("keydown", (e) => {
      if (box.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      const f = focusables(), first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    PHONE.addEventListener("change", () => { if (!PHONE.matches && !box.hidden) close(); });
  }

  // --- iOS: the keyboard's own dictation works in any text field, with or without HTTPS (Open WebUI's mic needs it).
  function voiceHint() {
    if (!isIOS() || store.get(HINT_KEY) === "dismissed") return null;
    const device = /iPhone|iPod/.test(navigator.userAgent) ? "iPhone" : "iPad";
    const close = el("button", { type: "button", class: "hint-close", "aria-label": "Dismiss tip" }, "✕");
    const hint = el("div", { class: "voice-hint", role: "note" },
      el("span", { text: `Tip: use the 🎤 on your keyboard for dictation — it runs on your ${device}.` }), close);
    close.addEventListener("click", () => {
      store.set(HINT_KEY, "dismissed");
      hint.remove(); $("#frames").classList.remove("hint-on");
    });
    $("#frames").prepend(hint);
    return hint;
  }

  // --- Home on a phone: one health line that opens the full service list.
  function healthLine() {
    const list = $("#services");
    if (!list) return;
    const btn = el("button", { type: "button", class: "health-line", "aria-expanded": "false", "aria-controls": "services" },
      el("span", { class: "dot", "aria-hidden": "true" }), el("span", { class: "health-text", text: "Checking services…" }),
      el("span", { class: "chev", "aria-hidden": "true" }));
    list.before(btn);
    const section = list.closest("section");
    btn.addEventListener("click", () => {
      const open = btn.getAttribute("aria-expanded") !== "true";
      btn.setAttribute("aria-expanded", String(open)); section.classList.toggle("expanded", open);
    });
    const update = () => {
      const all = list.querySelectorAll("li"), down = list.querySelectorAll("li.down");
      if (!all.length) return;
      const names = [...down].map((li) => li.querySelector(".svc-name").textContent);
      btn.classList.toggle("down", down.length > 0);
      $(".health-text", btn).textContent = down.length
        ? `${down.length} of ${all.length} services down: ${names.join(", ")}`
        : `All ${all.length} services running`;
    };
    new MutationObserver(update).observe(list, { childList: true });
    update();
  }

  // --- Models: an "Enabled only" toggle (on by default on phones). Rows are hidden by CSS, so it combines with
  // app.js's provider chips without touching them.
  function statusFilter() {
    const btn = $("#enabled-only"), body = $("#models");
    if (!btn || !body) return;
    const section = btn.closest("section");
    const set = (on) => { btn.setAttribute("aria-pressed", String(on)); section.classList.toggle("only-enabled", on); };
    const count = () => {
      let c = btn.querySelector(".count"); if (!c) { c = el("span", { class: "count" }); btn.append(c); }
      c.textContent = String(body.querySelectorAll(".status-on").length);
    };
    // When the chips together leave no row: say so, and how to get rows back.
    const empty = el("p", { class: "note models-empty", role: "status", hidden: "" });
    section.querySelector(".table-wrap").after(empty);
    let rendered = false;
    const checkEmpty = () => {
      const on = section.classList.contains("only-enabled");
      const visible = [...body.rows].filter((r) => !on || r.querySelector(".status-on")).length;
      empty.hidden = !rendered || visible > 0;
      empty.textContent = on ? "No enabled models match this filter. Turn off Enabled only to see the rest."
        : "No models match this filter.";
    };
    btn.addEventListener("click", () => { set(btn.getAttribute("aria-pressed") !== "true"); checkEmpty(); });
    new MutationObserver(() => { rendered = true; count(); checkEmpty(); }).observe(body, { childList: true });
    set(PHONE.matches); count();
  }

  // --- Update card and Maintenance on a phone: the one-click buttons only when this device may use them
  // (remote access has them off unless REMOTE_ADMIN_ACTIONS=true; the API answers 403 anyway).
  let lastAdmin = null;
  document.addEventListener("bn:admin", (e) => { lastAdmin = e.detail || {}; phoneWording(lastAdmin); });
  function phoneWording(a) {
    const usable = Boolean(a.running && a.allowed);
    document.body.classList.toggle("admin-off", !usable);
    if (!PHONE.matches || usable) return;
    const where = "on the computer running bedrock-now";
    if (a.running) $("#maint-state").textContent = `Update, Rollback and Clean are off on this device: use a desktop browser ${where}.`;
    $("#update-hint").textContent = `To update, run ./stack update ${where}, or use Home in a desktop browser there.`;
  }
  // Rotating or resizing across the phone width: app.js redraws the desktop wording, then this adds the phone's.
  PHONE.addEventListener("change", () => {
    if (!lastAdmin) return;
    if (PHONE.matches) phoneWording(lastAdmin);
    else if (typeof renderAdmin === "function") renderAdmin(lastAdmin);
  });

  document.addEventListener("bn:tab", (e) => {
    current = e.detail;
    const hint = $("#frames .voice-hint");
    if (hint) { hint.hidden = current !== "chat"; $("#frames").classList.toggle("hint-on", current === "chat"); }
  });

  document.addEventListener("DOMContentLoaded", () => {
    // Icon rail on tablets: the label is hidden, so the tooltip carries it (elsewhere the label is visible).
    const TABLET = window.matchMedia("(min-width: 768px) and (max-width: 1099.98px)");
    const titles = () => {
      for (const b of document.querySelectorAll(".tab")) {
        if (TABLET.matches) b.title = b.textContent.trim(); else b.removeAttribute("title");
      }
    };
    titles(); TABLET.addEventListener("change", titles);
    // From an iPhone/iPad Home Screen app, Admin and Files open in Safari, which has its own cookies.
    if (isIOS() && navigator.standalone) {
      const n = $("#more-sheet .note");
      if (n) n.textContent += " From this Home Screen app they open in Safari, which asks for the portal password once.";
    }
    sheet(); healthLine(); statusFilter(); fit();
    const hint = voiceHint();
    if (hint) { hint.hidden = current !== "chat"; $("#frames").classList.toggle("hint-on", current === "chat"); }
    // Rotating a tablet down to phone width while Admin or Files is open: fall back to Chat.
    PHONE.addEventListener("change", () => { if (PHONE.matches && DESKTOP_ONLY.has(current)) showTab("chat"); });
    // Installability on Android Chrome. Needs a secure context (HTTPS, or *.localhost); plain-http LAN skips it.
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => { /* not installable here: fine */ });
    }
  });
})();
