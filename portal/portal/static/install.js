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
//   3. navigator.getInstalledRelatedApps() lists the manifest's related_applications entry (the app itself): yes.
//      Chrome/Edge 140+ on desktop and Chrome on Android answer for web apps, so their empty list is a no (and
//      clears bn.app); older ones return an empty list for every web app, which means nothing.
//   4. appinstalled fired in this tab: yes.
//   5. bn.app is set: yes, once beforeinstallprompt has had DECIDE_MS to say otherwise.
//
// Opening it from a tab (desktop Chrome/Edge): the link <scheme>://open?tab=<tab>&n=<nonce>, where <scheme> is this
// site's own protocol_handlers entry (webapp.py). The first time, the browser asks whether the site may open the
// app, and the app whether it may open such links. The operating system then starts the app at /?open=<link>, or
// (launch_handler focus-existing) brings its open window forward and hands it the link through launchQueue. The app
// shows <tab> and answers the nonce on the BroadcastChannel "bn.app"; the tab then says it can be closed. No answer
// while this tab still has the focus ANSWER_MS later (no dialog, no app window took it), or once it gets it back (a
// dialog was cancelled): the note names the other ways in. Android has no such launch (protocol_handlers are
// desktop only, and Chrome keeps a site's own links in the tab), so there the note says where the app is.
"use strict";

(() => {
  const LATER_KEY = "bn.installLater";      // Home's install note dismissed
  const APP_LATER_KEY = "bn.appNoteLater";  // Home's "installed" note dismissed
  const APP_KEY = "bn.app";                 // written by the installed app (1. above)
  const DECIDE_MS = 2000;
  const ANSWER_MS = 5000, ANSWER_MAX_MS = 120000;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* storage blocked: the notes show again, fine */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* fine */ } },
  };
  const inApp = () => ["standalone", "window-controls-overlay", "minimal-ui"].some((m) => matchMedia(`(display-mode: ${m})`).matches)
    || navigator.standalone === true;
  const chromium = "BeforeInstallPromptEvent" in window;   // the browsers that install apps this way
  const android = /Android/i.test(navigator.userAgent);
  const canLaunch = chromium && !android;
  const answersForWebApps = android || (() => {
    const c = ((navigator.userAgentData && navigator.userAgentData.brands) || []).find((b) => b.brand === "Chromium");
    return Boolean(c) && Number(c.version) >= 140;
  })();
  const tell = (msg) => { if (typeof toast === "function") toast(msg); };

  let deferred = null;     // the beforeinstallprompt event, until it is used
  let related = null;      // getInstalledRelatedApps: true, false (a real no) or null (no answer)
  let justInstalled = false;
  let waited = false;      // DECIDE_MS is over
  let scheme = "", schemeAsked = false, schemeKnown = false;   // known: the manifest answered (or failed)
  let pending = "";        // the nonce of the launch waiting for the app's answer
  let answerTimer = 0, channel = null;
  let noteText = "", noteForced = false;
  let state = "";

  function decide() {
    if (inApp()) return "app";
    if (deferred) return "install";
    if (related === true || justInstalled) return "open";
    if (related === null && waited && chromium && store.get(APP_KEY)) return "open";
    return "none";
  }

  // Where the app is, for when no link opens it.
  const elsewhere = () => (android ? "Open it from your home screen or app list, or with ⋮\u00a0→ Open in app."
    : "Open bedrock-now from your Dock, Launchpad, Start menu or applications menu"
      + (location.protocol === "http:" ? ", run ./stack open" : "") + ", or use Open in app in the address bar.");
  const currentTab = () => { const t = location.hash.slice(1); return /^[a-z]+$/.test(t) ? t : "home"; };
  const nonce = () => Array.from(crypto.getRandomValues(new Uint32Array(2)), (x) => x.toString(36)).join("");

  function render() {
    const next = decide();
    const install = next === "install", open = next === "open", link = open && canLaunch && Boolean(scheme);
    document.documentElement.classList.toggle("installed-app", next === "app");
    document.documentElement.dataset.app = next;
    for (const b of document.querySelectorAll("[data-install]")) b.hidden = !install;
    const note = document.getElementById("install-note");
    if (note) note.hidden = !install || store.get(LATER_KEY) === "1";
    for (const a of document.querySelectorAll("[data-open-app]")) {
      a.hidden = !link;
      if (link && !a.getAttribute("href")) a.href = `${scheme}://open?tab=${currentTab()}&n=${nonce()}`;
    }
    const appNote = document.getElementById("app-note");   // once its text is final (link or no link)
    if (appNote) appNote.hidden = !open || (canLaunch && !schemeKnown) || (store.get(APP_LATER_KEY) === "1" && !noteForced);
    const text = document.getElementById("app-note-text");
    if (text) text.textContent = noteText || (link ? "Use it in its own window instead of this tab." : elsewhere());
    if (open && canLaunch && !scheme) loadScheme();
    if (next !== state) {
      state = next;
      document.dispatchEvent(new CustomEvent("bn:app", { detail: state }));
    }
  }

  // The link scheme comes from the manifest, like everything else that names this site's app.
  function loadScheme() {
    if (schemeAsked) return;
    schemeAsked = true;
    const m = document.querySelector('link[rel="manifest"]');
    fetch(m ? m.href : "/manifest.webmanifest", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((j) => {
        const h = (j.protocol_handlers || [])[0];
        if (h && /^web\+[a-z]+$/.test(h.protocol)) scheme = h.protocol;
      })
      .catch(() => { /* no link then: the note says where the app is */ })
      .then(() => { schemeKnown = true; render(); });
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
    window.addEventListener("focus", () => tell(done), { once: true });   // seen again when coming back to this tab
  }

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
  // the link's nonce and returns the tab, or "".
  function launched(url) {
    let u;
    try { u = new URL(url, location.href); } catch (_) { return ""; }
    let tab = u.hash.slice(1), n = "";
    const link = u.searchParams.get("open");
    if (link) {
      try { const q = new URL(link).searchParams; tab = q.get("tab") || tab; n = q.get("n") || ""; } catch (_) { /* not ours */ }
    }
    if (n && inApp() && typeof BroadcastChannel === "function") {
      const c = new BroadcastChannel("bn.app");
      c.postMessage({ opened: n });
      setTimeout(() => c.close(), 1000);
    }
    return /^[a-z]+$/.test(tab) ? tab : "";
  }

  // A cold start lands on /?open=<link>: make it /#<tab> before app.js picks the first tab (on DOMContentLoaded).
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

  // Chrome moves the tab into the new app window on install, without a reload: follow the display mode.
  const follow = () => {
    if (inApp()) { deferred = null; store.set(APP_KEY, "1"); }
    render();
  };
  follow();
  const standalone = matchMedia("(display-mode: standalone)");
  if (standalone.addEventListener) standalone.addEventListener("change", follow);
  else if (standalone.addListener) standalone.addListener(follow);   // Safari before 14

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();             // no mini-infobar: our own button asks instead
    if (inApp()) return;
    deferred = e; justInstalled = false; store.del(APP_KEY); render();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null; justInstalled = true; store.set(APP_KEY, "1"); render();
    tell("Installed: bedrock-now now opens in its own window.");
  });
  if (!inApp() && chromium) {
    setTimeout(() => { waited = true; render(); }, DECIDE_MS);
    if (typeof navigator.getInstalledRelatedApps === "function") {
      navigator.getInstalledRelatedApps().then((apps) => {
        related = (apps || []).some((a) => a.platform === "webapp") ? true : answersForWebApps ? false : null;
        if (related) store.set(APP_KEY, "1"); else if (related === false) store.del(APP_KEY);
        render();
      }, () => { /* no answer: bn.app decides */ });
    }
  }

  for (const b of document.querySelectorAll("[data-install]")) b.addEventListener("click", install);
  for (const a of document.querySelectorAll("[data-open-app]")) a.addEventListener("click", launch);
  const later = document.getElementById("install-later");
  if (later) later.addEventListener("click", () => { store.set(LATER_KEY, "1"); render(); });
  const appLater = document.getElementById("app-note-later");
  if (appLater) appLater.addEventListener("click", () => { store.set(APP_LATER_KEY, "1"); noteForced = false; render(); });
})();
