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
// The server puts each app's URL for this site into <meta name="bn-apps"> (app host names differ per site:
// remote Tailscale names are <name>-chat.<tailnet>.ts.net, not chat.<portal host>).
const APP_URLS = (() => {
  try { return JSON.parse(document.querySelector('meta[name="bn-apps"]').content); } catch (e) { return {}; }
})();
const appUrl = (app) => APP_URLS[app] || `${location.protocol}//${app}.${location.host}${APPS[app]}`;

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

const PAGES = ["home", "settings"];  // the portal's own pages; everything else is an app in a frame
// appFrame TAB -> its frame: created (hidden) on first need and kept, so switching tabs never reloads an app
function appFrame(tab) {
  let f = $(`#frames iframe[data-app="${tab}"]`);
  if (!f) {
    f = el("iframe", { src: appUrl(tab), "data-app": tab, title: tab[0].toUpperCase() + tab.slice(1),
      allow: "clipboard-read; clipboard-write; microphone; screen-wake-lock" });
    f.hidden = true;
    $("#frames").append(f);
  }
  return f;
}
function showTab(tab) {
  // not "constructor" etc.; the terminal and the Code page only where the server offers them (APP_URLS: ./stack
  // terminal / ./stack code; terminal.js, code.js)
  if (!PAGES.includes(tab) && !Object.prototype.hasOwnProperty.call(APPS, tab) && !(["terminal", "code"].includes(tab) && APP_URLS[tab])) tab = "home";
  if (window.bnMobile) tab = window.bnMobile.allowTab(tab);  // phones: Home and Chat only (mobile.js)
  for (const b of document.querySelectorAll(".tab")) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  $("#home").hidden = tab !== "home";
  if ($("#settings")) $("#settings").hidden = tab !== "settings";
  for (const f of document.querySelectorAll("#frames iframe")) f.hidden = f.dataset.app !== tab;
  if (!PAGES.includes(tab)) appFrame(tab).hidden = false;
  remember(tab);
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  if (tab === "home") refresh();
  document.dispatchEvent(new CustomEvent("bn:tab", { detail: tab }));
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
// since ISO -> "12 min ago" / "3 h ago" / "Oct 14" (failures of the last 24 hours cross midnight)
function since(iso) {
  const ms = Date.now() - new Date(iso);
  if (isNaN(ms)) return "";
  if (ms < 3600000) return `${Math.max(1, Math.round(ms / 60000))} min ago`;
  return ms < 86400000 ? `${Math.round(ms / 3600000)} h ago` : day(iso);
}
function ago(iso) {
  const d = new Date(iso); if (isNaN(d)) return iso || "";
  const days = Math.floor((Date.now() - d) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

// --- rendering (textContent only: nothing from the API is parsed as HTML) ---
// Two cost views while OpenRouter is on (spend.equivalent; null otherwise): Actual (what is charged; budgets
// count it) and Equivalent (free OpenRouter models priced at their paid version). Remembered per browser.
const VIEW_NOTE = {
  actual: "Actual: what you are charged — Bedrock at its on-demand list prices (your AWS bill can differ with discounts or credits), paid OpenRouter models at their prices, free models $0; budgets always count this.",
  equivalent: "Equivalent: what the same usage would have cost if every request had been paid — free OpenRouter models priced at their paid version, everything else unchanged.",
};
function savedView() { try { return localStorage.getItem("bn.costView") === "equivalent" ? "equivalent" : "actual"; } catch (_) { return "actual"; } }
let costView = savedView();
function setCostView(view) {
  costView = view;
  try { localStorage.setItem("bn.costView", view); } catch (_) { /* storage blocked: fine */ }
  if (lastSummary) { renderSpend(lastSummary.spend); renderOpenRouter(lastSummary.spend.openrouter, lastSummary.spend.openrouter_usage); }
}
const paidZero = (v) => `of which ${usd(v)} is free-model usage you paid $0 for`;

function renderSpend(spend) {
  const alert = Number.isInteger(spend.alert_pct) ? spend.alert_pct : 80;   // BUDGET_ALERT_PCT (Settings)
  const eq = spend.equivalent || null;
  const view = eq ? costView : "actual";
  const useEq = view === "equivalent" && eq && !eq.error;
  $("#cost-view").hidden = !eq;
  for (const b of document.querySelectorAll("#cost-view .chip")) b.setAttribute("aria-pressed", String(b.dataset.view === view));
  const vn = $("#cost-view-note"); vn.hidden = !eq; vn.textContent = eq ? VIEW_NOTE[view] : "";
  $("#total").textContent = spend.total_error ? "–" : usd(useEq && eq.total_30d != null ? eq.total_30d : spend.total_30d);
  let tf = "";
  if (view === "equivalent" && eq) {
    if (eq.error) tf = `Equivalent unavailable (${eq.error}): showing actual spend.`;
    else {
      const none = eq.no_paid_variant || [];
      if (eq.extra_30d > 0) tf = `${paidZero(eq.extra_30d)}${none.length ? `; no paid version, so $0 here too: ${none.join(", ")}` : ""}`;
      else if (eq.free_requests_30d) tf = `${plural(eq.free_requests_30d, "free-model request")}, none with a paid version to price them at`;
      else tf = "No free-model usage in the last 30 days";
      tf += ". Budgets count actual spend.";
    }
  }
  const tfe = $("#total-foot"); tfe.hidden = !tf; tfe.textContent = tf;
  const list = $("#meters"); list.replaceChildren();
  for (const k of spend.keys) {
    const li = el("li", { class: "meter" });
    const head = el("div", { class: "meter-head" }, el("span", { text: k.label }));
    if (k.error) {
      head.append(el("span", { class: "amount", text: "unavailable" }));
      li.append(head, el("div", { class: "meter-foot", text: k.error }));
    } else {
      const ek = useEq ? (eq.keys || {})[k.alias] : null;
      const pct = k.max_budget ? (k.spend / k.max_budget) * 100 : 0;   // budgets count actual spend
      if (pct >= 100) li.classList.add("over"); else if (pct >= alert) li.classList.add("warn");
      const budget = k.max_budget != null ? ` of ${usd(k.max_budget)}` : ", no budget";
      // Equivalent with free-model usage: both figures, the bold one (actual) is what the bar shows
      const amount = ek && ek.spend != null && ek.extra > 0
        ? el("span", { class: "amount" }, `≈ ${usd(ek.spend)} equivalent · `, el("b", { text: usd(k.spend) }), `${budget} actual`)
        : el("span", { class: "amount" }, el("b", { text: usd(k.spend) }), budget);
      head.append(amount);
      const bar = el("i"); bar.style.width = `${Math.min(pct, 100)}%`;
      const gauge = el("div", { class: "gauge", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100",
        "aria-valuenow": String(Math.round(pct)), "aria-label": `${k.label}: ${Math.round(pct)}% of budget` }, bar);
      gauge.style.setProperty("--alert", `${alert}%`);
      let foot = k.max_budget ? `${Math.round(pct)}% of the monthly budget` : "no budget set";
      if (pct >= 100) foot = "Budget used up: requests with this key are refused until it resets";
      else if (pct >= alert) foot = `${Math.round(pct)}% used: close to the budget`;
      if (k.reset_at) foot += ` · resets ${day(k.reset_at)}`;
      if (ek && ek.free_requests) foot += ek.extra > 0 ? ` · ${paidZero(ek.extra)}` : ` · ${count(ek.free_requests)} free-model requests with no paid version ($0)`;
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

// Optional OpenRouter block under the spend meters: the key's account line, OpenRouter's free daily request
// count as a gauge, usage through this stack (today / 30 days, free / paid), top models and recent failures.
function count(n) { return Number(n || 0).toLocaleString("en-US"); }
function toks(n) {
  n = Number(n || 0);
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;
// What a free model's usage cost: $0, or in the Equivalent view its price at the paid version's rates.
function freeCost(equivalent, eqView) { return eqView && equivalent > 0 ? `≈ ${usd(equivalent)} at paid rates` : "$0"; }

function orCell(b, free, eqView) {
  if (!b || !b.requests) return el("td", { class: "none", text: "–" });
  return el("td", {}, el("span", { class: "n", text: plural(b.requests, "request") }),
    el("span", { class: "sub", text: `${toks(b.tokens_in)} in · ${toks(b.tokens_out)} out` }),
    el("span", { class: "sub", text: free ? freeCost(b.equivalent, eqView) : usd(b.cost) }));
}

function renderOpenRouter(acct, use) {
  const box = $("#openrouter");
  box.hidden = !(acct && acct.enabled);
  $("#spend-title").textContent = box.hidden ? "Bedrock spend" : "Spend";
  if (box.hidden) return;
  box.replaceChildren();
  const eqView = costView === "equivalent";
  const head = el("div", { class: "meter-head" }, el("span", { class: "or-title", text: `OpenRouter${acct.label ? ` (${acct.label})` : ""}` }));
  const foot = [];
  if (acct.error) {
    head.append(el("span", { class: "amount", text: "unavailable" })); foot.push(acct.error);
  } else {
    head.append(el("span", { class: "amount" }, el("b", { text: usd(acct.usage_monthly) }), " this month"));
    foot.push(`${usd(acct.usage)} in total on this key`);
    if (acct.limit != null) foot.push(`key limit ${usd(acct.limit)}, ${usd(acct.limit_remaining)} left`);
    if (acct.credits) foot.push(`credits ${usd(acct.credits.remaining)} left of ${usd(acct.credits.total)}`);
    else if (acct.credits_note) foot.push(acct.credits_note);
    if (acct.is_free_tier) foot.push("free tier (no credits bought yet)");
  }
  box.append(head, el("div", { class: "meter-foot", text: foot.join(" · ") }));

  const fr = acct.free_requests;
  if (fr && fr.limit) {
    const pct = (fr.used / fr.limit) * 100;
    const m = el("div", { class: "meter or-free" });
    if (pct >= 100) m.classList.add("over"); else if (pct >= 80) m.classList.add("warn");
    const bar = el("i"); bar.style.width = `${Math.min(pct, 100)}%`;
    let ff = "OpenRouter's count for this key, per UTC day";
    if (pct >= 100) ff = "Limit reached: free models are refused until the next UTC day";
    if (fr.limit < 1000) ff += " · buying $10 of credits raises it to 1,000 a day";
    m.append(el("div", { class: "meter-head" }, el("span", { text: "Free-model requests today" }),
      el("span", { class: "amount" }, el("b", { text: count(fr.used) }), ` of ${count(fr.limit)}`)),
      el("div", { class: "gauge", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(Math.min(pct, 100))),
        "aria-label": `Free-model requests today: ${count(fr.used)} of ${count(fr.limit)}` }, bar),
      el("div", { class: "meter-foot", text: ff }));
    box.append(m);
  }
  if (!use) return;
  if (use.error) { box.append(el("p", { class: "note", text: `Usage of OpenRouter models: unavailable (${use.error}).` })); }
  else {
    const t = use.today, d = use.days_30;
    box.append(el("table", { class: "or-usage" },
      el("thead", {}, el("tr", {}, el("th", { scope: "col" }, el("span", { class: "sr", text: "Models" })),
        el("th", { scope: "col", text: "Today" }), el("th", { scope: "col", text: "Last 30 days" }))),
      el("tbody", {},
        el("tr", {}, el("th", { scope: "row", text: "Free" }), orCell(t.free, true, eqView), orCell(d.free, true, eqView)),
        el("tr", {}, el("th", { scope: "row", text: "Paid" }), orCell(t.paid, false, eqView), orCell(d.paid, false, eqView)))));
    if (use.top && use.top.length) {
      const ol = el("ol", { class: "or-top" });
      for (const m of use.top) {
        const cost = m.access === "free" ? (m.no_paid_variant ? "$0 (no paid version)" : freeCost(m.equivalent, eqView)) : usd(m.cost);
        ol.append(el("li", {}, el("span", { class: "or-name", title: m.id, text: m.name }),
          el("span", { class: "tier", text: m.access === "free" ? "Free" : "Paid" }),
          el("span", { class: "or-stats", text: `${plural(m.requests, "request")} · ${toks(m.tokens_in + m.tokens_out)} tokens · ${cost}` })));
      }
      box.append(el("h3", { class: "or-sub", text: "Top models, last 30 days" }), ol);
    }
  }
  const f = use.failures;
  if (!f) return;
  box.append(el("h3", { class: "or-sub", text: `Failed requests, last ${f.hours || 24} hours` }));
  if (f.error) { box.append(el("p", { class: "note", text: `Unavailable (${f.error}).` })); return; }
  if (!f.groups || !f.groups.length) { box.append(el("p", { class: "note", text: "None." })); return; }
  const ul = el("ul", { class: "or-fails" });
  for (const g of f.groups) {
    ul.append(el("li", {}, el("span", { class: "or-fail" }, el("b", { text: `${count(g.count)}×` }), ` ${g.label}`,
      g.last_at && since(g.last_at) ? el("span", { class: "or-when", text: ` · last ${since(g.last_at)}` }) : null),
      g.fix ? el("span", { class: "or-fix", text: g.fix }) : null));
  }
  box.append(ul);
  if (f.more) box.append(el("p", { class: "note", text: "Only the newest failed requests are counted here; Admin → Logs has all of them." }));
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

// Which speech-to-text the microphone and Call use (Bedrock Voxtral: an estimated price per minute).
function renderVoice(v) {
  const box = $("#voice-note");
  if (!v) { box.hidden = true; return; }
  box.hidden = false;
  if (!v.on) {
    box.textContent = "Voice: browser speech recognition (Call is unavailable). ./stack stt set bedrock turns on Bedrock speech-to-text (no extra key).";
    return;
  }
  const price = v.per_minute != null ? ` (~$${v.per_minute.toPrecision(2)} per minute of audio${v.estimated ? ", estimated" : ""})` : "";
  box.textContent = `Voice: ${v.label}${price} — audio goes to ${v.where}; spend counts on the Open WebUI key. ./stack stt status for details.`;
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

// --- the installed version: under the brand (desktop), a tiny label on the tablet rail, Home's header on phones ---
// "v0.3.0-7-g1a2b3c4" (7 commits after v0.3.0) reads "v0.3.0 +7 (1a2b3c4)"; the tooltip has the whole story.
const BUILD = /^(v\d+\.\d+\.\d+)(?:-(\d+)-g([0-9a-f]{4,40}))?$/;
function renderVersion(u) {
  if (!u) return;
  const v = u.installed || "", m = BUILD.exec(v), avail = Boolean(u.available);
  const tip = [`bedrock-now ${v || "(version unknown: ./stack up records it)"}`];
  if (m && m[2]) tip.push(`${m[2]} commit${m[2] === "1" ? "" : "s"} after the release ${m[1]}${u.branch ? `, branch ${u.branch}` : ""}`);
  else if (u.branch) tip.push(`branch ${u.branch}`);
  const when = u.commit_date ? new Date(u.commit_date) : null;
  if (when && !isNaN(when)) tip.push(`committed ${when.toLocaleString()}`);
  if (avail) tip.push(`update available: ${u.latest}`);
  tip.push(avail ? "Click for its release notes" : m && !m[2] ? "Click for this version's release notes" : "Click for the changelog");
  for (const a of document.querySelectorAll(".version-label")) {
    a.replaceChildren(...[avail ? el("i", { class: "v-dot", "aria-hidden": "true" }) : null,
      el("span", { class: "v-tag", text: m ? m[1] : v || "version unknown" }),
      m && m[2] ? el("span", { class: "v-plus", text: `+${m[2]}` }) : null,
      m && m[3] ? el("span", { class: "v-commit", text: `(${m[3].slice(0, 7)})` }) : null].filter(Boolean));
    a.title = tip.join("\n");
    a.setAttribute("aria-label", tip.join(". "));
    a.href = avail ? "#home" : /^https:\/\/github\.com\//.test(u.release_url || "") ? u.release_url : "#home";
    if (a.href.endsWith("#home")) a.removeAttribute("target"); else a.target = "_blank";
    a.classList.toggle("has-update", avail);
    a.hidden = false;
  }
  $(".sidebar .brand").title = `${tip[0]}${avail ? " · update available" : ""}`;  // the logo on the tablet rail
}

// With an update available the label leads to the update card and its release notes; otherwise the link opens this
// version's release page (or the changelog) on GitHub.
function openVersion(ev) {
  if (!(lastUpdate && lastUpdate.available)) return;
  ev.preventDefault();
  showTab("home");
  $(".update-notes").open = true;
  $("#update-card").scrollIntoView({ block: "start" });
}

function renderUpdate(u) {
  lastUpdate = u;  // placeHelperOff (below) puts the "one-click updates are off" hint where it is seen
  renderVersion(u);
  const card = $("#update-card");
  card.hidden = !(u && u.available);
  if (card.hidden) { placeHelperOff(); return; }
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
  placeHelperOff();
}

// --- one-click Update / Rollback / Clean and automatic updates through the host helper (see /api/admin/*) ---
const PHASES = {
  update: [["backing-up", "Backup"], ["downloading", "Download"], ["restarting", "Restart and check"], ["done", "Done"]],
  rollback: [["restoring", "Restore code and data"], ["restarting", "Restart"], ["done", "Done"]],
  clean: [["cleaning", "Remove old images"], ["done", "Done"]],
  "auto-on": [], "auto-off": [],
};
const pad2 = (n) => String(n).padStart(2, "0");
const autoHour = (a) => (a && a.auto && Number.isInteger(a.auto.hour) ? a.auto.hour : 3);
// The nightly window on the helper's computer: its own clock, whatever time zone this browser is in.
const autoWindow = (a) => [`${pad2(autoHour(a))}:00`, `${pad2((autoHour(a) + 3) % 24)}:00`];
const ASLEEP = "If this computer is asleep then, it misses the window and tries the next night.";
const REMOTE_OFF = "Update, Rollback, Clean and the automatic-updates switch are off for remote access (REMOTE_ADMIN_ACTIONS in .env).";
const ACTION_TEXT = {
  update: (a) => {
    // A checkout on a branch (vX.Y.Z-N-g… versions) updates to whatever that branch has now, not to the release.
    const onBranch = (a.branch || (lastUpdate && lastUpdate.branch)) && /-\d+-g[0-9a-f]+$/.test(a.version || "");
    const target = onBranch ? `the tip of branch ${a.branch || lastUpdate.branch} (not a release)` : (lastUpdate && lastUpdate.latest ? lastUpdate.latest : "the newest release");
    return `Update to ${target}: a backup first, then the new code and images; Chat, Admin and Files are down for a few minutes while the services restart. This page reconnects by itself.`;
  },
  rollback: (a) => `Go back to ${a.rollback.to ? (/-\d+-g[0-9a-f]+$/.test(a.rollback.to) ? `${a.rollback.to} (a commit after the release ${a.rollback.to.replace(/-\d+-g[0-9a-f]+$/, "")})` : a.rollback.to) : "the previous version"}: its code, its images and the data from ${a.rollback.backup || "the pre-update backup"}. Chats, files and spend recorded since the update are replaced (a backup of the current state is taken first).`,
  clean: () => "Remove this install's old images. The ones in use and one previous version (for rollback) stay.",
  "auto-on": (a) => `New releases then install by themselves between ${autoWindow(a).join(" and ")} (this computer's time), the same way as Update now: a backup first, then a few minutes of downtime. Releases only, never a branch. A release that fails is not retried automatically, and Roll back is offered here. ${ASLEEP}`,
  "auto-off": () => "New releases then wait for you: Home shows them, and Update now (or ./stack update) installs them.",
};
const CONFIRM = {
  update: ["Update now?", "Update"], rollback: ["Roll back?", "Roll back"], clean: ["Clean up old images?", "Clean up"],
  "auto-on": ["Turn on automatic updates?", "Turn on"], "auto-off": ["Turn off automatic updates?", "Turn off"],
};
let adminState = null, lastUpdate = null, adminTimer = null, pendingAction = null, reconnecting = false;
// A request the helper has not answered yet ({id, at}): it polls every few seconds, so until its job shows up Home
// keeps "Waiting for the update helper…" and asks again soon (at most a minute; then it shows what the helper says).
let awaiting = null;

function fmtBytes(b) { return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${b || 0} B`; }

function sinceText(t) {
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 5400 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
}

// Without the helper (and when this device may use it): how to turn it on, in the update card while an update is
// available, else in Maintenance. Remote viewers keep the remote wording instead.
function placeHelperOff() {
  const a = adminState;
  if (!a) return;
  const off = !a.running && a.allowed;
  const inUpdate = off && Boolean(lastUpdate && lastUpdate.available);
  const box = $("#helper-off");
  box.hidden = !off;
  (inUpdate ? $("#update-helper-slot") : $("#maint-helper-slot")).append(box);
  $("#maint").hidden = !(a.running || (off && !inUpdate));
  $("#helper-off-title").textContent = a.heartbeat_at
    ? `One-click updates are off: the update helper is not running (last seen ${sinceText(a.heartbeat_at)})` : "One-click updates are off";
}

function renderAuto(a, usable) {
  const auto = a.auto || {};
  const row = $("#auto-row");
  row.hidden = !(a.running && auto.supported);
  if (row.hidden) return;
  $("#auto-window").textContent = autoWindow(a).join("–");
  const changing = Boolean(awaiting && awaiting.toggle);
  for (const b of document.querySelectorAll("#auto-toggle .chip")) {
    b.setAttribute("aria-pressed", String((b.dataset.auto === "on") === Boolean(auto.on)));
    b.disabled = !usable || a.in_progress || changing;
  }
  // the last switch change, if it failed (a Busy refusal, say): said here, never in place of the last job
  const sw = auto.switch || {};
  const failed = sw.result === "failed" && sw.at && (Date.now() / 1000 - sw.at) < 600 ? ` Not changed: ${sw.message}` : "";
  const reason = a.in_progress && auto.state === "unfinished" ? "On." : auto.reason || "On.";   // (see updateHint)
  $("#auto-state").textContent = changing ? "Changing…" : auto.on ? `${reason} ${ASLEEP}${failed}`
    : `Off: new releases wait for you. Nightly installs a new release by itself, with a backup first.${failed}`;
}

// The update card's line while automatic updates are on. The helper reads the portal's release check only inside its
// window, so Home combines what the helper says (switch, state, what it tried) with the release this card shows.
function updateHint(a, usable) {
  if (!a.allowed) return `Run it in your bedrock-now folder. ${REMOTE_OFF}`;
  if (!usable) return "Run it in your bedrock-now folder.";
  const auto = a.auto || {}, latest = lastUpdate && lastUpdate.latest, last = auto.last || {};
  // while a job runs, the update it is doing looks "unfinished" to the helper: the progress card speaks then
  if (auto.supported && auto.on && !(a.in_progress && auto.state === "unfinished")) {
    const [from, to] = autoWindow(a), h = autoHour(a);
    if (["branch", "not-release", "unfinished", "run", "running", "busy"].includes(auto.state)) {
      return /Update now/.test(auto.reason || "") || auto.state === "run" || auto.state === "running" ? auto.reason : `${auto.reason} Or click Update now.`;
    }
    if (latest && auto.rolled_back === latest) return `You rolled back ${latest}, so it is not installed automatically: Update now installs it.`;
    if (latest && last.version === latest && last.result && last.result !== "done") {
      return `${latest} ${last.result === "interrupted" ? "was interrupted" : "failed"} when it installed automatically and is not retried automatically: Update now tries again.`;
    }
    const sk = auto.skipped || {};
    const skipped = sk.at && (Date.now() / 1000 - sk.at) < 86400 && sk.reason ? ` The last window was skipped: ${sk.reason}.` : "";
    return `Will install automatically ${h >= 18 || h < 6 ? "tonight" : "today or tomorrow"} between ${from} and ${to} (this computer's time) — or Update now.${skipped}`;
  }
  return "Or click Update now: the update helper runs it for you (asks for the portal password).";
}

function renderAdmin(a) {
  adminState = a;
  const usable = a.running && a.allowed;
  $("#maint-state").textContent = !a.allowed ? REMOTE_OFF
    : `The update helper is running on this computer${a.version ? ` (installed version ${a.version})` : ""}.`;
  $("#maint-state").hidden = $("#maint-actions").hidden = $("#maint-note").hidden = !a.running;
  for (const b of document.querySelectorAll("button.action[data-action]")) b.disabled = !usable || a.in_progress;
  const rb = $("#rollback-now");
  rb.hidden = !(a.rollback && a.rollback.available);
  rb.textContent = a.rollback && a.rollback.to ? `Roll back to ${a.rollback.to}` : "Roll back";
  $("#job-rollback").textContent = rb.textContent;
  $("#update-now").hidden = !usable;
  renderAuto(a, usable);
  placeHelperOff();
  $("#update-hint").textContent = updateHint(a, usable);
  renderJob(a.job, a.in_progress);
  document.dispatchEvent(new CustomEvent("bn:admin", { detail: a }));  // mobile.js: phone wording
}

function dismissed(id) { try { return localStorage.getItem("bn.job.dismissed") === id; } catch (_) { return false; } }

function renderJob(job, inProgress) {
  const box = $("#job");
  const recent = job && job.finished_at && (Date.now() / 1000 - job.finished_at) < 86400;
  box.hidden = !job || !job.phase || (!inProgress && (!recent || dismissed(job.id || String(job.finished_at))));
  if (box.hidden) return;
  const steps = PHASES[job.action] || [];
  const at = steps.findIndex(([p]) => p === job.phase);
  const auto = job.trigger === "auto";
  const name = auto ? "Automatic update" : { update: "Update", rollback: "Rollback", clean: "Clean-up", settings: "Settings change",
    backup: "Backup", "backup-nightly": "Nightly backup", test: "Smoke test", "check-aws": "AWS key check", "models-recheck": "Model check", report: "Status report" }[job.action]
    || (/^restart-/.test(job.action || "") ? `Restart of ${job.action.slice(8)}` : "Request");
  $("#job-title").textContent = `${name}${{ failed: " failed", done: " finished", skipped: " skipped" }[job.phase] || " in progress"}`;
  const list = $("#job-steps"); list.replaceChildren();
  steps.forEach(([p, label], i) => {
    const state = job.phase === "failed" || job.phase === "skipped" ? (i < Math.max(at, 0) ? "ok" : "") : i < at || job.phase === "done" ? "ok" : i === at ? "now" : "";
    list.append(el("li", { class: state, text: label }));
  });
  let msg = job.message || "";
  if (job.phase === "done" && job.action === "update" && job.version && !msg) msg = `Updated to ${job.version}`;
  // "Already up to date (…)": the helper's update found nothing new — no step ran, and Home did not change either
  const nothingNew = job.phase === "done" && msg.startsWith("Already up to date");
  list.hidden = !steps.length || nothingNew || job.phase === "skipped";
  $("#job-message").textContent = msg;
  $("#job-message").className = `job-message ${job.phase === "failed" ? "bad" : job.phase === "done" ? "good" : ""}`;
  let note = "";
  if (reconnecting) note = "The portal is restarting as part of the update — reconnecting…";
  else if (inProgress) note = `Started ${job.started_at ? new Date(job.started_at * 1000).toLocaleTimeString() : ""}. You can leave this page; it is carried out on your computer.`;
  else if (job.phase === "done" && (job.action === "update" || job.action === "rollback") && !nothingNew) note = "Reload this page to use the new version of Home.";
  else if (job.phase === "failed" && auto) note = "This release is not retried automatically: Update now tries again, and a newer release is tried as usual.";
  else if (job.phase === "skipped") note = "Nothing was changed. It tries again in the next window, or Update now runs it.";
  $("#job-note").textContent = note;
  $("#job-dismiss").hidden = inProgress;
  // A failed update that moved the code: Roll back right here (the button in Maintenance does the same)
  const rb = adminState && adminState.rollback;
  $("#job-actions").hidden = inProgress || job.phase !== "failed" || job.action !== "update" || !(rb && rb.available && rb.unfinished);
}

async function pollAdmin() {
  clearTimeout(adminTimer);
  try {
    const a = await api("/api/admin/status");
    reconnecting = false;
    if (awaiting) {
      // a job answers in the job status (its id is the request's nonce; a refusal is newer than the request), a switch
      // change in the heartbeat's "switch"
      const sw = (a.auto && a.auto.switch) || {};
      const answered = awaiting.toggle ? sw.id === awaiting.id
        : a.job && (a.job.id === awaiting.id || (a.job.started_at || 0) * 1000 >= awaiting.at - 5000);
      if (answered && awaiting.toggle) toast(sw.result !== "done" ? "Automatic updates: not changed" : a.auto.on ? "Automatic updates are on" : "Automatic updates are off");
      if (answered || Date.now() - awaiting.at > 60000) awaiting = null;
    }
    if (awaiting && !awaiting.toggle && adminState) { a.in_progress = true; a.job = adminState.job; }
    renderAdmin(a);
    adminTimer = setTimeout(pollAdmin, a.in_progress || awaiting ? 2500 : REFRESH_MS);
  } catch (e) {
    if (e.message === "signed out") return;
    // The portal restarts during an update: keep asking, show where things stood.
    reconnecting = !!(adminState && adminState.in_progress);
    if (adminState) renderJob(adminState.job, adminState.in_progress);
    adminTimer = setTimeout(pollAdmin, 3000);
  }
}

function openConfirm(action) {
  if (!adminState) return;
  pendingAction = action;
  $("#confirm-title").textContent = CONFIRM[action][0];
  $("#confirm-text").textContent = ACTION_TEXT[action](adminState);
  $("#confirm-error").hidden = true;
  $("#confirm-password").value = "";
  $("#confirm-ok").textContent = CONFIRM[action][1];
  $("#confirm").showModal();
  $("#confirm-password").focus();
}

async function submitConfirm(ev) {
  ev.preventDefault();
  const pw = $("#confirm-password").value;
  if (!pw || !pendingAction) return;
  $("#confirm-ok").disabled = true;
  try {
    const r = await fetch("/api/admin/request", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { ...API_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ action: pendingAction, password: pw }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { location.assign("/login"); return; }
    if (!r.ok) { const e = $("#confirm-error"); e.textContent = d.error || `HTTP ${r.status}`; e.hidden = false; return; }
    $("#confirm-password").value = "";
    $("#confirm").close();
    toast("Request sent to the update helper");
    const toggle = pendingAction === "auto-on" || pendingAction === "auto-off";
    awaiting = { id: d.id, at: Date.now(), toggle };
    if (adminState && !toggle) { adminState.in_progress = true; adminState.job = { action: pendingAction, phase: "queued", message: "Waiting for the update helper…", started_at: Math.floor(Date.now() / 1000) }; }
    if (adminState) renderAdmin(adminState);
    setTimeout(pollAdmin, 1500);
  } catch (e) {
    const er = $("#confirm-error"); er.textContent = `Could not reach the portal (${e.message}).`; er.hidden = false;
  } finally {
    $("#confirm-ok").disabled = false;
  }
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
    renderSpend(d.spend); renderOpenRouter(d.spend.openrouter, d.spend.openrouter_usage); renderServices(d.services); renderModels(d.models, d.prices); renderVoice(d.voice);
    renderUpdate(d.update); lastUpdate = d.update;
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
    // each app's own sign-in form, without the automatic sign-in (?sso=off): the fallback
    for (const a of document.querySelectorAll("a.form-link[data-form]")) a.href = logins[a.dataset.form].manual || "";
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
  for (const b of document.querySelectorAll("#cost-view .chip")) b.addEventListener("click", () => setCostView(b.dataset.view));
  for (const b of document.querySelectorAll("#model-filter .chip")) {
    b.addEventListener("click", () => { modelFilter = b.dataset.filter; if (lastSummary) renderModels(lastSummary.models, lastSummary.prices); });
  }
  $("#copy-claude").addEventListener("click", () => copy($("#claude-cmd").textContent, "the command"));
  $("#copy-update").addEventListener("click", () => copy($("#update-cmd").textContent, "the command"));
  for (const b of document.querySelectorAll("button.action[data-action]")) b.addEventListener("click", () => openConfirm(b.dataset.action));
  $("#copy-helper").addEventListener("click", () => copy($("#helper-cmd").textContent, "the command"));
  for (const a of document.querySelectorAll(".version-label")) a.addEventListener("click", openVersion);
  for (const b of document.querySelectorAll("#auto-toggle .chip")) {
    b.addEventListener("click", () => { if (b.getAttribute("aria-pressed") !== "true") openConfirm(`auto-${b.dataset.auto}`); });
  }
  $("#confirm-form").addEventListener("submit", submitConfirm);
  $("#confirm-cancel").addEventListener("click", () => { $("#confirm-password").value = ""; $("#confirm").close(); });
  $("#job-dismiss").addEventListener("click", () => {
    const j = adminState && adminState.job;
    if (j) { try { localStorage.setItem("bn.job.dismissed", j.id || String(j.finished_at)); } catch (_) { /* fine */ } }
    $("#job").hidden = true;
  });
  pollAdmin();
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
  showTab(location.hash.slice(1) || recalled() || (window.bnMobile ? window.bnMobile.defaultTab() : "home"));
  if ($("#home").hidden) refresh();  // once, for the version label: Home refreshes itself only while it is shown
});
