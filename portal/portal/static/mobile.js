// Phones and tablets: the bottom tab bar's "Desktop" sheet, keyboard-aware height for Chat, the iOS dictation tip,
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
    // Admin and Files are desktop apps: on a phone they open from the Desktop sheet in a new tab instead.
    allowTab: (tab) => (PHONE.matches && DESKTOP_ONLY.has(tab) ? "chat" : tab),
    defaultTab: () => (PHONE.matches ? "chat" : "home"),
  };

  // --- keyboard-aware height: the shell follows the visual viewport, so the iOS keyboard never hides Chat's input.
  const vv = window.visualViewport;
  let fullHeight = 0;
  function fit() {
    const root = document.documentElement;
    if (!vv) return;
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
  }

  // --- the Desktop sheet (phones): Admin and Files in a new tab, and Sign out.
  function sheet() {
    const box = $("#more-sheet"), btn = $("#more-btn");
    if (!box || !btn) return;
    for (const a of box.querySelectorAll(".sheet-link")) a.href = appUrl(a.dataset.app);
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
    btn.addEventListener("click", () => set(btn.getAttribute("aria-pressed") !== "true"));
    new MutationObserver(count).observe(body, { childList: true });
    set(PHONE.matches); count();
  }

  document.addEventListener("bn:tab", (e) => {
    current = e.detail;
    const hint = $("#frames .voice-hint");
    if (hint) { hint.hidden = current !== "chat"; $("#frames").classList.toggle("hint-on", current === "chat"); }
  });

  document.addEventListener("DOMContentLoaded", () => {
    // Icon rail on tablets: the label is hidden, so the tooltip carries it.
    for (const b of document.querySelectorAll(".tab")) b.title = b.textContent.trim();
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
