// Portal shell: sidebar tabs (Home + three apps in iframes) and the Home dashboard.
// No framework, no build step, nothing loaded from the internet. Data comes from /api/* only.
"use strict";

const APPS = { chat: "/", admin: "/ui/", files: "/rustfs/console/" };
const API_HEADERS = { "X-Requested-With": "bedrock-now" };
const REFRESH_MS = 30000;
let logins = null;
let timer = null;
let lastSummary = null;
let lastNotes = null;

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
  if (tab !== "home" && !Object.prototype.hasOwnProperty.call(APPS, tab)) tab = "home";  // not "constructor" etc.
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

// Optional OpenRouter account line under the spend meters (usage of the key; credits when readable).
function renderOpenRouter(acct) {
  const box = $("#openrouter");
  box.hidden = !(acct && acct.enabled);
  $("#spend-title").textContent = box.hidden ? "Bedrock spend" : "Spend";
  if (box.hidden) return;
  box.replaceChildren();
  const head = el("div", { class: "meter-head" }, el("span", { text: `OpenRouter${acct.label ? ` (${acct.label})` : ""}` }));
  const foot = [];
  if (acct.error) {
    head.append(el("span", { class: "amount", text: "unavailable" })); foot.push(acct.error);
  } else {
    head.append(el("span", { class: "amount" }, el("b", { text: usd(acct.usage_monthly) }), " this month"));
    foot.push(`${usd(acct.usage)} in total on this key`);
    if (acct.limit != null) foot.push(`key limit ${usd(acct.limit)}, ${usd(acct.limit_remaining)} left`);
    if (acct.credits) foot.push(`credits ${usd(acct.credits.remaining)} left of ${usd(acct.credits.total)}`);
    else if (acct.credits_note) foot.push(acct.credits_note);
    if (acct.free_requests) foot.push(`free models: ${acct.free_requests.used} of ${acct.free_requests.limit} requests today`);
    if (acct.is_free_tier) foot.push("free tier (no credits bought yet)");
  }
  box.append(head, el("div", { class: "meter-foot", text: foot.join(" · ") }));
}

let modelFilter = "all";
const matchesFilter = (m) => modelFilter === "all" || (modelFilter === "bedrock" ? (m.provider || "Bedrock") === "Bedrock" : m.access === modelFilter);

function renderModels(models, prices) {
  const body = $("#models"); body.replaceChildren();
  const or = models.openrouter;
  $("#model-filter").hidden = !or;
  $("#models-title").textContent = or ? "Models" : "Models your AWS key can use";
  if (!or) modelFilter = "all";
  const counts = { all: models.rows.length, bedrock: 0, free: 0, paid: 0 };
  for (const m of models.rows) counts[(m.provider || "Bedrock") === "Bedrock" ? "bedrock" : m.access] += 1;
  for (const b of document.querySelectorAll("#model-filter .chip")) {
    b.setAttribute("aria-pressed", String(b.dataset.filter === modelFilter));
    let c = b.querySelector(".count"); if (!c) { c = el("span", { class: "count" }); b.append(c); }
    c.textContent = String(counts[b.dataset.filter] || 0);
  }
  for (const m of models.rows) {
    if (!matchesFilter(m)) continue;
    const provider = el("td", { class: "provider", text: m.provider || "Bedrock" });
    if (m.provider === "OpenRouter") provider.append(el("span", { class: "tier", text: m.access === "free" ? "Free" : "Paid" }));
    body.append(el("tr", {},
      el("td", { class: "name", title: m.name },
        m.icon ? el("img", { class: "logo", src: m.icon, alt: "", width: "16", height: "16", loading: "lazy" }) : null,
        m.tier ? `${m.display || m.name} · ${m.tier}` : (m.display || m.name)),
      provider, el("td", { text: m.kind }),
      el("td", { class: m.enabled ? "status-on" : "status-off", text: m.enabled ? "Enabled" : "Not available" }),
      el("td", { class: "price", text: m.price }),
      el("td", { class: "why", title: m.reason, text: m.why })));
  }
  const bits = [];
  if (models.error) bits.push(models.error);
  else if (models.checked_at) bits.push(`Checked ${ago(models.checked_at)}; ./stack models --recheck checks again (< $0.01).`);
  bits.push("Prices are Bedrock on-demand rates in USD per 1M tokens.");
  if (or) bits.push(`OpenRouter models (or/…) send prompts to openrouter.ai; prices as of ${ago(or.fetched_at)}. ./stack openrouter changes which ones are offered.`);
  $("#models-note").textContent = bits.join(" ");
  renderPrices(prices);
}

const FIELD = { in: "input", out: "output", cache_read: "cache read", cache_write: "cache write", per_image: "per image", per_query: "per query" };

function renderPrices(p) {
  const bits = [];
  if (p.source === "auto") {
    bits.push(`Prices: LiteLLM's public price list, checked ${ago(p.fetched_at)}`);
    if (p.crosscheck_error) bits.push(`AWS cross-check failed (${p.crosscheck_error})`);
    else if (p.crosscheck_compared) {
      const na = p.crosscheck_na && p.crosscheck_na.length ? `; no AWS data for ${p.crosscheck_na.join(", ")}` : "";
      bits.push(`cross-checked against the AWS Price List (${p.crosscheck_compared} prices${na})`);
    }
  } else {
    let why = "automatic updates are off (PRICE_UPDATES=false)";
    if (p.updates_enabled) why = p.stale_auto ? "it is newer than the last automatic update" : "no automatic update has succeeded yet";
    bits.push(`Prices: catalog/prices.tsv${p.as_of ? ` as of ${p.as_of}` : ""} (${why})`);
  }
  let text = bits.join("; ") + ".";
  if (p.pending) text += " New prices reach LiteLLM at the next ./stack up or ./stack setup.";
  if (p.error) text += ` Last update failed ${ago(p.error_at)}: ${p.error}. The last known prices stay in use.`;
  $("#prices-note").textContent = text;

  const list = $("#price-warnings"); list.replaceChildren();
  for (const w of p.warnings || []) list.append(el("li", { class: "warn", text: `⚠ ${w}` }));
  const recent = p.changed_at && (Date.now() - new Date(p.changed_at)) < 7 * 86400000;
  if (recent) {
    for (const c of (p.changed || []).slice(0, 8)) {
      list.append(el("li", { text: `Changed ${ago(p.changed_at)}: ${c.name} ${FIELD[c.field] || c.field} $${c.old} → $${c.new}` }));
    }
  }
  list.hidden = !list.children.length;
}

// --- update card (release notes: a tiny, safe subset of Markdown, built with DOM nodes; never parsed as HTML) ---
function inline(text) {
  // **bold**, `code`, [label](https://…) — everything else stays plain text.
  const frag = document.createDocumentFragment();
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) frag.append(el("strong", { text: t.slice(2, -2) }));
    else if (t.startsWith("`")) frag.append(el("code", { text: t.slice(1, -1) }));
    else {
      const label = t.slice(1, t.indexOf("]("));
      const href = t.slice(t.indexOf("](") + 2, -1);
      if (/^https:\/\/[^\s"'<>]+$/.test(href)) frag.append(el("a", { href, target: "_blank", rel: "noopener noreferrer", text: label }));
      else frag.append(label);
    }
    last = m.index + t.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function renderNotes(md) {
  // Headings, "- " lists (wrapped continuation lines included) and paragraphs; inline() for the text.
  const box = $("#update-notes"); box.replaceChildren();
  let list = null, item = null, para = [];
  const endItem = () => { if (item) { list.append(el("li", {}, inline(item.join(" ")))); item = null; } };
  const flush = () => { endItem(); if (para.length) { box.append(el("p", {}, inline(para.join(" ")))); para = []; } };
  for (const raw of String(md || "").replace(/\r/g, "").split("\n").slice(0, 400)) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(line), li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (h) { flush(); list = null; box.append(el(h[1].length <= 2 ? "h4" : "h5", { text: h[2].replace(/[*`]/g, "") })); }
    else if (li) { flush(); if (!list) { list = el("ul"); box.append(list); } item = [li[1]]; }
    else if (!line.trim()) { flush(); list = null; }
    else if (item && /^\s/.test(line)) item.push(line.trim());
    else { endItem(); list = null; para.push(line.trim()); }
  }
  flush();
  if (!box.children.length) box.append(el("p", { class: "note", text: "No release notes." }));
}

function gb(mb) { return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`; }

function renderUpdate(u) {
  const card = $("#update-card");
  card.hidden = !(u && u.available);
  if (card.hidden) return;
  $("#update-title").textContent = `${u.latest} available`;
  const bits = [`You have ${u.installed}.`];
  if (u.published_at) bits.push(`Released ${day(u.published_at)}.`);
  if (u.checked_at) bits.push(`Checked ${ago(u.checked_at)}.`);
  $("#update-meta").textContent = bits.join(" ");
  if (lastNotes !== u.notes) { renderNotes(u.notes); lastNotes = u.notes; }
  const link = $("#update-link");
  if (u.url && /^https:\/\/github\.com\//.test(u.url)) { link.href = u.url; link.hidden = false; } else link.hidden = true;
  const e = u.estimate || {};
  let dl = "a few hundred MB of images, roughly";
  if (e.download_mb === 0) dl = "no new images, only small local rebuilds";
  else if (e.download_mb) dl = `about ${gb(e.download_mb)} of new images${e.images && e.images.length ? ` (${e.images.map((i) => i.split("/").pop()).join(", ")})` : ""}${e.rough ? ", roughly" : ""}`;
  const steps = $("#update-steps"); steps.replaceChildren(
    el("li", { text: "A backup of your data first (backups/…-auto; the newest 5 are kept)." }),
    el("li", { text: `New code and ${dl} download while everything keeps running.` }),
    el("li", { text: `About ${e.downtime_min || 3} minutes of downtime while setup restarts the services and checks them (< $0.01 Bedrock).` }),
    el("li", { text: "The previous version's images stay, so going back needs no download." }));
  $("#update-cmd").textContent = u.command || "./stack update";
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
    renderSpend(d.spend); renderOpenRouter(d.spend.openrouter); renderServices(d.services); renderModels(d.models, d.prices);
    renderUpdate(d.update);
    lastSummary = d;
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
  for (const b of document.querySelectorAll("#model-filter .chip")) {
    b.addEventListener("click", () => { modelFilter = b.dataset.filter; if (lastSummary) renderModels(lastSummary.models, lastSummary.prices); });
  }
  $("#copy-claude").addEventListener("click", () => copy($("#claude-cmd").textContent, "the command"));
  $("#copy-update").addEventListener("click", () => copy($("#update-cmd").textContent, "the command"));
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
