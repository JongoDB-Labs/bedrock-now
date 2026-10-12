// Portal shell: sidebar tabs (Home + three apps in iframes) and the Home dashboard.
// No framework, no build step, nothing loaded from the internet. Data comes from /api/* only.
"use strict";

const APPS = { chat: "/", admin: "/ui/", files: "/rustfs/console/" };
const API_HEADERS = { "X-Requested-With": "bedrock-now" };
const REFRESH_MS = 30000;
let logins = null;
let timer = null;

const $ = (sel, root = document) => root.querySelector(sel);
const appUrl = (app) => `${location.protocol}//${app}.${location.host}${APPS[app]}`;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v; else if (k === "text") node.textContent = v; else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function remember(tab) { try { localStorage.setItem("bn.tab", tab); } catch (_) { /* storage blocked: fine */ } }
function recalled() { try { return localStorage.getItem("bn.tab"); } catch (_) { return null; } }

function showTab(tab) {
  if (tab !== "home" && !APPS[tab]) tab = "home";
  for (const b of document.querySelectorAll(".tab")) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  $("#home").hidden = tab !== "home";
  for (const f of document.querySelectorAll("#frames iframe")) f.hidden = f.dataset.app !== tab;
  if (tab !== "home" && !$(`#frames iframe[data-app="${tab}"]`)) {
    // Created on first visit and kept, so switching tabs never reloads an app.
    $("#frames").append(el("iframe", { src: appUrl(tab), "data-app": tab, title: tab[0].toUpperCase() + tab.slice(1),
      allow: "clipboard-read; clipboard-write; microphone" }));
  }
  remember(tab);
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  if (tab === "home") refresh();
}

// --- formatting ---
function usd(v) {
  if (v == null) return "–";
  if (v > 0 && v < 0.00005) return "<$0.0001";
  if (v > 0 && Math.round(v * 100) / 100 < 1) return `$${v.toFixed(4)}`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function day(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? iso.slice(0, 10) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function ago(iso) {
  const d = new Date(iso); if (isNaN(d)) return iso || "";
  const days = Math.floor((Date.now() - d) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

// --- rendering (textContent only: nothing from the API is parsed as HTML) ---
function renderSpend(spend) {
  $("#total").textContent = spend.total_error ? "–" : usd(spend.total_30d);
  const list = $("#meters"); list.replaceChildren();
  for (const k of spend.keys) {
    const li = el("li", { class: "meter" });
    const head = el("div", { class: "meter-head" }, el("span", { text: k.label }));
    if (k.error) {
      head.append(el("span", { class: "amount", text: "unavailable" }));
      li.append(head, el("div", { class: "meter-foot", text: k.error }));
    } else {
      const pct = k.max_budget ? (k.spend / k.max_budget) * 100 : 0;
      if (pct >= 100) li.classList.add("over"); else if (pct >= 80) li.classList.add("warn");
      const amount = el("span", { class: "amount" }, el("b", { text: usd(k.spend) }), k.max_budget != null ? ` of ${usd(k.max_budget)}` : ", no budget");
      head.append(amount);
      const bar = el("i"); bar.style.width = `${Math.min(pct, 100)}%`;
      const gauge = el("div", { class: "gauge", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100",
        "aria-valuenow": String(Math.round(pct)), "aria-label": `${k.label}: ${Math.round(pct)}% of budget` }, bar);
      let foot = k.max_budget ? `${Math.round(pct)}% of the monthly budget` : "no budget set";
      if (pct >= 100) foot = "Budget used up: requests with this key are refused until it resets";
      else if (pct >= 80) foot = `${Math.round(pct)}% used: close to the budget`;
      if (k.reset_at) foot += ` · resets ${day(k.reset_at)}`;
      li.append(head, gauge, el("div", { class: "meter-foot", text: foot }));
    }
    list.append(li);
  }
}

function renderServices(services) {
  const list = $("#services"); list.replaceChildren();
  for (const s of services) {
    list.append(el("li", { class: s.ok ? "up" : "down" },
      el("span", { class: "dot", "aria-hidden": "true" }),
      el("span", {}, el("span", { class: "svc-name", text: s.name }), " ", el("span", { class: "svc-role", text: s.role })),
      el("span", { class: "svc-detail", text: s.ok ? s.detail : `down: ${s.detail}` })));
  }
}

function renderModels(models, prices) {
  const body = $("#models"); body.replaceChildren();
  for (const m of models.rows) {
    body.append(el("tr", {},
      el("td", { class: "name", title: m.name, text: m.tier ? `${m.display || m.name} · ${m.tier}` : (m.display || m.name) }),
      el("td", { text: m.kind }),
      el("td", { class: m.enabled ? "status-on" : "status-off", text: m.enabled ? "Enabled" : "Not available" }),
      el("td", { class: "price", text: m.price }),
      el("td", { class: "why", title: m.reason, text: m.why })));
  }
  const bits = [];
  if (models.error) bits.push(models.error);
  else if (models.checked_at) bits.push(`Checked ${ago(models.checked_at)}; ./stack models --recheck checks again (< $0.01).`);
  if (prices.as_of) bits.push(`Prices are Bedrock on-demand rates per 1M tokens as of ${prices.as_of}.`);
  $("#models-note").textContent = bits.join(" ");
}

async function api(path) {
  const r = await fetch(path, { headers: API_HEADERS, credentials: "same-origin", cache: "no-store" });
  if (r.status === 401) { location.assign("/login"); throw new Error("signed out"); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function refresh() {
  clearTimeout(timer);
  try {
    const d = await api("/api/summary");
    renderSpend(d.spend); renderServices(d.services); renderModels(d.models, d.prices);
    const cb = d.claude && d.claude.command; if (cb) $("#claude-cmd").textContent = cb;
    $("#load-error").hidden = true;
    $("#updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    if (e.message === "signed out") return;
    const b = $("#load-error"); b.hidden = false;
    b.textContent = `Could not load the latest numbers (${e.message}). The portal keeps trying every 30 seconds; ./stack status shows what is running.`;
  }
  if (!$("#home").hidden) timer = setTimeout(() => { if (!document.hidden) refresh(); else timer = setTimeout(refresh, REFRESH_MS); }, REFRESH_MS);
}

async function loadLogins() {
  try {
    logins = await api("/api/logins");
    for (const s of document.querySelectorAll(".cred")) s.textContent = logins[s.dataset.login][s.dataset.field] || "–";
  } catch (_) { /* the copy buttons explain it */ }
}

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 1800);
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = el("textarea", { readonly: "", "aria-hidden": "true" }); ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.append(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove();
    if (!ok) { toast("Copy is blocked by the browser"); return; }
  }
  toast(`Copied ${what}`);
}

document.addEventListener("DOMContentLoaded", () => {
  for (const a of document.querySelectorAll(".popout")) a.href = appUrl(a.dataset.app);
  for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => showTab(b.dataset.tab));
  $("#refresh").addEventListener("click", refresh);
  $("#copy-claude").addEventListener("click", () => copy($("#claude-cmd").textContent, "the command"));
  for (const b of document.querySelectorAll(".copy[data-login]")) {
    b.addEventListener("click", async () => {
      if (!logins) await loadLogins();
      const v = logins && logins[b.dataset.login][b.dataset.field];
      if (v) copy(v, b.textContent.replace(/^Copy /, "")); else toast("Not available yet: run ./stack setup");
    });
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("#home").hidden) refresh(); });
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
  loadLogins();
  showTab(location.hash.slice(1) || recalled() || "home");
});
