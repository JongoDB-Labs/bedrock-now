// "Install app": Chrome and Edge (desktop and Android) can install the portal as a real app with its own window,
// Dock/taskbar icon and Cmd-Tab entry. The browser says when that is possible (beforeinstallprompt); until then,
// and inside the installed app itself, the buttons stay hidden. Safari has no such event: iPhone and iPad use
// Share → Add to Home Screen (README), macOS Safari File → Add to Dock.
"use strict";

(() => {
  const LATER_KEY = "bn.installLater";
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* storage blocked: the note shows again, fine */ } },
  };
  const installed = () => ["standalone", "window-controls-overlay", "minimal-ui"].some((m) => matchMedia(`(display-mode: ${m})`).matches)
    || navigator.standalone === true;
  let deferred = null;

  function show(on) {
    for (const b of document.querySelectorAll("[data-install]")) b.hidden = !on;
    const note = document.getElementById("install-note");
    if (note) note.hidden = !on || store.get(LATER_KEY) === "1";
  }

  async function install() {
    const prompt = deferred;
    if (!prompt) return;
    deferred = null; show(false);   // a prompt can be used once; Chrome fires the event again if it is declined
    prompt.prompt();
    try { await prompt.userChoice; } catch (_) { /* the dialog went away: nothing to do */ }
  }

  // Chrome moves the tab into the new app window on install, without a reload: follow the display mode.
  const mark = () => {
    document.documentElement.classList.toggle("installed-app", installed());
    if (installed()) { deferred = null; show(false); }
  };
  mark();
  const standalone = matchMedia("(display-mode: standalone)");
  if (standalone.addEventListener) standalone.addEventListener("change", mark);
  else if (standalone.addListener) standalone.addListener(mark);   // Safari before 14

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();             // no mini-infobar: our own button asks instead
    if (installed()) return;
    deferred = e; show(true);
  });
  window.addEventListener("appinstalled", () => {
    deferred = null; show(false);
    if (typeof toast === "function") toast("Installed: bedrock-now now opens in its own window.");
  });
  for (const b of document.querySelectorAll("[data-install]")) b.addEventListener("click", install);
  const later = document.getElementById("install-later");
  if (later) later.addEventListener("click", () => { store.set(LATER_KEY, "1"); show(Boolean(deferred)); });

  // The installed app opens its existing window (manifest launch_handler: focus-existing) for the Dock icon and
  // the Chat/Home shortcuts; the shortcut's #tab arrives here instead of as a navigation.
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer((params) => {
      if (!params.targetURL) return;
      const tab = new URL(params.targetURL).hash.slice(1);
      if (tab && typeof showTab === "function") showTab(tab);
    });
  }
})();
