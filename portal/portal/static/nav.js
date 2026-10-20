// The sidebar on a desktop (1100 px and wider): expanded (icons and names) or collapsed to the tablets' icon rail, the
// apps' frames taking the room. The button at its top, or Ctrl+\ (⌘\ on a Mac) with the focus in the portal, switches
// it; this browser keeps the choice (localStorage bn.nav). Tablets always have the rail and phones the tab bar: neither
// has the button. Loaded in <head> without defer, so a collapsed sidebar is collapsed from the first paint: <html> gets
// its class at once, the button is wired once the page is parsed.
// window.bnNav.rail(): whether the sidebar is the icon rail now (a tablet, or a collapsed desktop), for the tabs'
// tooltips (mobile.js) and the walkthrough's card (tour.js); "bn:nav" on document whenever that may have changed.
(function (root) {
  "use strict";
  const KEY = "bn.nav";
  // parse(stored) -> whether the stored choice is collapsed (anything else, or nothing stored: expanded)
  const parse = (v) => v === "collapsed";
  // isToggleKey(e) -> Ctrl+\ or ⌘\ (the key itself, or the key where "\" is on a US keyboard: a layout that types "\"
  // with Shift or AltGr still works), not a key held down
  const isToggleKey = (e) => Boolean(e && !e.repeat && (e.ctrlKey || e.metaKey) && (e.key === "\\" || e.code === "Backslash"));
  // labels(collapsed, mac) -> the button's tooltip and aria-keyshortcuts
  const labels = (collapsed, mac) => ({
    title: `${collapsed ? "Expand" : "Collapse"} the sidebar (${mac ? "⌘\\" : "Ctrl+\\"})`,
    keys: mac ? "Meta+\\" : "Control+\\",
  });

  root.bnNav = { _pure: { KEY, parse, isToggleKey, labels } };
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return;

  const DESKTOP = root.matchMedia("(min-width: 1100px)");
  const TABLET = root.matchMedia("(min-width: 768px) and (max-width: 1099.98px)");
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const html = document.documentElement;
  let collapsed = false;
  try { collapsed = parse(localStorage.getItem(KEY)); } catch (_) { /* storage blocked: expanded */ }
  html.classList.toggle("nav-collapsed", collapsed);

  const rail = () => TABLET.matches || (DESKTOP.matches && collapsed);
  const changed = () => document.dispatchEvent(new CustomEvent("bn:nav", { detail: { rail: rail(), collapsed } }));

  function paint() {
    const b = document.getElementById("nav-toggle");
    if (!b) return;
    const l = labels(collapsed, MAC);
    b.setAttribute("aria-expanded", String(!collapsed));
    b.setAttribute("aria-keyshortcuts", l.keys);
    b.title = l.title;
  }
  function set(on) {
    collapsed = on;
    html.classList.toggle("nav-collapsed", on);
    try { if (on) localStorage.setItem(KEY, "collapsed"); else localStorage.removeItem(KEY); } catch (_) { /* this page only */ }
    paint();
    // Focus stays where it is; on something the rail does not show (a pop-out arrow), it goes to the button.
    const a = document.activeElement, side = document.querySelector(".sidebar");
    if (a && side && side.contains(a) && !a.getClientRects().length) document.getElementById("nav-toggle").focus();
    changed();
  }

  document.addEventListener("DOMContentLoaded", () => {
    const b = document.getElementById("nav-toggle");
    if (!b) return;
    paint();
    b.hidden = false;
    b.addEventListener("click", () => set(!collapsed));
    // The width animates only after the first paint (no slide on page load), and not with reduced motion (CSS).
    requestAnimationFrame(() => requestAnimationFrame(() => html.classList.add("nav-anim")));
  });
  document.addEventListener("keydown", (e) => {
    if (!DESKTOP.matches || !isToggleKey(e) || document.querySelector("dialog[open]")) return;
    e.preventDefault();
    set(!collapsed);
  });
  DESKTOP.addEventListener("change", changed);
  TABLET.addEventListener("change", changed);
  root.bnNav.rail = rail;
  root.bnNav.collapsed = () => collapsed;
  root.bnNav.set = set;
})(typeof window !== "undefined" ? window : globalThis);
