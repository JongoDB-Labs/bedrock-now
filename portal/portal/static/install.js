// "Install app" and "Open in the app". Chrome and Edge (desktop and Android) install the portal as a real app with its
// own window, Dock/taskbar icon and Cmd-Tab entry. What a page shows (a sidebar button and a note on Home):
//   inside the installed app                  nothing
//   a tab, and this site's app is installed   "Open in the app": launches it (desktop) or says where it is (Android)
//   a tab, and the browser can install it     "Install app" (beforeinstallprompt)
//   anything else                             nothing (Safari has no such event: iPhone and iPad use Share → Add to
//                                             Home Screen, macOS Safari File → Add to Dock; see the README)
// Both stay hidden until that is known, so neither flashes.
//
// Is this site's app installed? (Each copy, and the remote site, is an app of its own, with storage of its own.)
//   1. This page runs in it (display-mode standalone, window-controls-overlay or minimal-ui; iOS
//      navigator.standalone). The app then sets bn.app in localStorage, which Chrome and Edge share between the
//      app and the browser's tabs of the same site.
//   2. beforeinstallprompt fired: no (the browser only offers what this profile has not installed). It clears
//      bn.app, which is how an uninstall is noticed, and wins even when it comes after the others.
//   3. navigator.getInstalledRelatedApps() lists the manifest's related_applications entry (the app itself): yes;
//      an empty list: no (and bn.app goes). Only Google Chrome and Microsoft Edge 140+ are asked: they answer for
//      web apps (desktop and Android); older and other browsers return an empty list, which means nothing.
//   4. Something just happened: appinstalled in this tab (yes, shown once Chrome has had SETTLE_MS to move the tab
//      into the new app window), bn.app written by the app in another window (yes), this page leaving the app
//      window for a browser tab (yes).
//   5. bn.app is set: yes, once beforeinstallprompt has had DECIDE_MS to say otherwise.
// A tab asks again (3.) whenever it comes back into view, and follows bn.app changes from other windows, so one left
// open while the app is installed or uninstalled elsewhere catches up.
//
// Opening it from a tab (desktop Chrome/Edge): the link <scheme>://open?tab=<tab>&n=<nonce>, where <scheme> is this
// site's own protocol_handlers entry (webapp.py; the portal puts it into the page as <meta name="bn-app-scheme">).
// The first time, the browser asks whether the site may open the app, and the app whether it may open such links.
// The operating system then starts the app at /?open=<link>, or (launch_handler focus-existing) brings its open
// window forward and hands it the link through launchQueue. The app shows <tab> and answers the nonce on the
// BroadcastChannel "bn.app"; the tab then says it can be closed. No answer while this tab still has the focus
// ANSWER_MS later (no dialog, no app window took it), or once it gets it back (a dialog was cancelled): the note
// names the other ways in. Android has no such launch (protocol_handlers are desktop only, and Chrome keeps a
// site's own links in the tab), so there the note says where the app is.
"use strict";

(() => {
  const LATER_KEY = "bn.installLater";      // Home's install note dismissed
  const APP_LATER_KEY = "bn.appNoteLater";  // Home's "installed" note dismissed
  const APP_KEY = "bn.app";                 // written by the installed app (1. above)
  const DECIDE_MS = 2000, SETTLE_MS = 1500;
  const ANSWER_MS = 5000, ANSWER_MAX_MS = 120000;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* storage blocked: the notes show again, fine */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* fine */ } },
  };
  const inApp = () => ["standalone", "window-controls-overlay", "minimal-ui"].some((m) => matchMedia(`(display-mode: ${m})`).matches)
    || navigator.standalone === true;
  const uaData = navigator.userAgentData;
  const chromium = "BeforeInstallPromptEvent" in window;   // the browsers that install apps this way
  // Android also in "desktop site" mode, whose user agent string drops the word.
  const android = /Android/i.test(navigator.userAgent) || Boolean(uaData && (uaData.platform === "Android" || uaData.mobile));
  const canLaunch = chromium && !android;
  const trusted = Boolean(uaData && (uaData.brands || []).some((b) => /^(Google Chrome|Microsoft Edge)$/.test(b.brand) && Number(b.version) >= 140));
  const scheme = (() => {   // this site's link scheme (webapp.protocol), from the portal (index())
    const m = document.querySelector('meta[name="bn-app-scheme"]');
    return m && /^web\+[a-z]+$/.test(m.content) ? m.content : "";
  })();
  const tell = (msg) => { if (typeof toast === "function") toast(msg); };

  let deferred = null;     // the beforeinstallprompt event, until it is used
  let known = null;        // installed? true / false from 3. and 4., else null (then 5.)
  let settling = false;    // just installed: Chrome is moving this tab into the app window
  let waited = false, waiting = false;
  let pending = "";        // the nonce of the launch waiting for the app's answer
  let answerTimer = 0, channel = null, focusToast = "";
  let noteText = "", noteForced = false;
  let state = "";
  const answeredNonces = new Set();

  function decide() {
    if (inApp()) return "app";
    if (deferred) return "install";
    if (!chromium || settling) return "none";
    if (known !== null) return known ? "open" : "none";
    return waited && store.get(APP_KEY) ? "open" : "none";
  }

  // Where the app is, for when no link opens it.
  const elsewhere = () => (android ? "Open it from your home screen or app list, or with ⋮ → Open in app."
    : "Open bedrock-now from your Dock, Launchpad, Start menu or applications menu"
      + (location.protocol === "http:" ? ", run ./stack open" : "") + ", or use Open in app in the address bar.");
  const currentTab = () => { const t = location.hash.slice(1); return /^[a-z]+$/.test(t) ? t : "home"; };
  const nonce = () => Array.from(crypto.getRandomValues(new Uint32Array(2)), (x) => x.toString(36)).join("");

  function render() {
    const next = decide();
    const install = next === "install", open = next === "open", link = open && canLaunch && Boolean(scheme);
    document.documentElement.classList.toggle("installed-app", next === "app");
    document.documentElement.dataset.appState = next;
    for (const b of document.querySelectorAll("[data-install]")) b.hidden = !install;
    const note = document.getElementById("install-note");
    if (note) note.hidden = !install || store.get(LATER_KEY) === "1";
    for (const a of document.querySelectorAll("[data-open-app]")) {
      a.hidden = !link;
      if (link && !a.getAttribute("href")) a.href = `${scheme}://open?tab=${currentTab()}&n=${nonce()}`;
    }
    const appNote = document.getElementById("app-note");
    if (appNote) appNote.hidden = !open || (store.get(APP_LATER_KEY) === "1" && !noteForced);
    const text = document.getElementById("app-note-text");
    if (text) text.textContent = noteText || (link ? "Use it in its own window instead of this tab." : elsewhere());
    if (next !== state) {
      state = next;
      document.dispatchEvent(new CustomEvent("bn:app", { detail: state }));
    }
  }

  // 3. (and the clock for 5.): at load, whenever the tab comes back into view, when an app window becomes a tab.
  function probe() {
    if (inApp() || !chromium) return;
    if (!waiting) { waiting = true; setTimeout(() => { waited = true; render(); }, DECIDE_MS); }
    if (!trusted || typeof navigator.getInstalledRelatedApps !== "function") { render(); return; }
    navigator.getInstalledRelatedApps().then((apps) => {
      known = (apps || []).some((a) => a.platform === "webapp");
      if (known) { deferred = null; store.set(APP_KEY, "1"); } else store.del(APP_KEY);
      render();
    }, () => { /* no answer: bn.app decides */ });
  }

  // --- Install app ---

  async function install() {
    const prompt = deferred;
    if (!prompt) return;
    deferred = null; render();   // a prompt can be used once; Chrome fires the event again if it is declined
    prompt.prompt();
    try { await prompt.userChoice; } catch (_) { /* the dialog went away: nothing to do */ }
  }

  // --- Open in the app ---

  function say(msg) { noteText = msg; render(); }

  function answered(e) {
    if (!pending || !e.data || e.data.opened !== pending) return;
    pending = ""; clearTimeout(answerTimer);
    const done = "Opened in the app. You can close this tab.";
    say(done); tell(done);
    focusToast = done;   // and once more when coming back to this tab
  }
  window.addEventListener("focus", () => { if (focusToast) { tell(focusToast); focusToast = ""; } });

  function launch(e) {
    pending = nonce();
    e.currentTarget.href = `${scheme}://open?tab=${currentTab()}&n=${pending}`;   // the link's default action follows it
    if (!channel && typeof BroadcastChannel === "function") {
      channel = new BroadcastChannel("bn.app");
      channel.onmessage = answered;
    }
    say("Opening bedrock-now… The first time, your browser asks twice: choose Open, then Allow (tick the box each time and it stops asking).");
    clearTimeout(answerTimer);
    const until = Date.now() + ANSWER_MAX_MS;
    const check = () => {
      if (!pending) return;
      if (!document.hasFocus() && Date.now() < until) { answerTimer = setTimeout(check, 1000); return; }   // a dialog or the app has it
      noteForced = true;   // a late answer still counts: answered() keeps listening
      say(`Didn't open? ${elsewhere()}`);
      const home = document.getElementById("home");
      if (home && home.hidden) tell("The app did not answer: Home lists other ways to open it.");
    };
    answerTimer = setTimeout(check, ANSWER_MS);
  }

  // In the app: a launch names a tab (a shortcut's #chat, or ?open=<link> from a tab's "Open in the app"). Answers
  // the link's nonce (once: a cold start sees it both in the URL and in launchQueue) and returns the tab, or "".
  function launched(url) {
    let u;
    try { u = new URL(url, location.href); } catch (_) { return ""; }
    let tab = u.hash.slice(1), n = "";
    const link = u.searchParams.get("open");
    if (link) {
      try { const q = new URL(link).searchParams; tab = q.get("tab") || tab; n = q.get("n") || ""; } catch (_) { /* not ours */ }
    }
    if (!/^[a-z0-9]{1,32}$/.test(n)) n = "";
    if (n && inApp() && !answeredNonces.has(n) && typeof BroadcastChannel === "function") {
      answeredNonces.add(n);
      const c = new BroadcastChannel("bn.app");
      c.postMessage({ opened: n });
      setTimeout(() => c.close(), 1000);
    }
    return /^[a-z]+$/.test(tab) ? tab : "";
  }

  // A cold start lands on /?open=<link>: make it /#<tab> before app.js picks the first tab (on DOMContentLoaded).
  // A signed-out app sees the login first, which brings it back to plain / (index() asks for "/"): it then opens on
  // its last tab, and the tab that launched it falls back to the other ways in.
  if (new URLSearchParams(location.search).has("open")) {
    const tab = launched(location.href);
    history.replaceState(null, "", location.pathname + (tab ? `#${tab}` : location.hash));
  }

  // An app window that is already open (focus-existing) gets the Dock icon's, the shortcuts' and the links' launches
  // here instead of as a navigation.
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer((params) => {
      if (!params.targetURL) return;
      const tab = launched(params.targetURL);
      if (tab && typeof showTab === "function") showTab(tab);
    });
  }

  // --- what is installed ---

  // Chrome moves the tab into the new app window on install, without a reload, and "Open in Chrome" moves an app
  // window into a tab: follow the display mode.
  let wasInApp = inApp();
  const follow = () => {
    const now = inApp();
    if (now) { deferred = null; store.set(APP_KEY, "1"); }
    else if (wasInApp) { known = true; probe(); }   // it was the app a moment ago
    wasInApp = now;
    render();
  };
  follow();
  probe();
  const standalone = matchMedia("(display-mode: standalone)");
  if (standalone.addEventListener) standalone.addEventListener("change", follow);
  else if (standalone.addListener) standalone.addListener(follow);   // Safari before 14
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") probe(); });
  // Another window of this site: the app wrote its mark (it runs, so it is installed), or a tab found it gone.
  window.addEventListener("storage", (e) => {
    if (e.key !== APP_KEY && e.key !== null) return;   // null: all of the site's storage was cleared
    if (e.newValue === "1") { deferred = null; known = true; render(); } else { known = null; render(); probe(); }
  });

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();             // no mini-infobar: our own button asks instead
    if (inApp()) return;
    deferred = e; known = false; store.del(APP_KEY); render();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null; store.set(APP_KEY, "1");
    settling = true; render();
    setTimeout(() => { settling = false; known = true; render(); }, SETTLE_MS);
    tell("Installed: bedrock-now now opens in its own window.");
  });

  for (const b of document.querySelectorAll("[data-install]")) b.addEventListener("click", install);
  for (const a of document.querySelectorAll("[data-open-app]")) a.addEventListener("click", launch);
  const later = document.getElementById("install-later");
  if (later) later.addEventListener("click", () => { store.set(LATER_KEY, "1"); render(); });
  const appLater = document.getElementById("app-note-later");
  if (appLater) appLater.addEventListener("click", () => { store.set(APP_LATER_KEY, "1"); noteForced = false; render(); });
})();
