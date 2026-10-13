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

function showTab(tab) {
  if (tab !== "home" && !Object.prototype.hasOwnProperty.call(APPS, tab)) tab = "home";  // not "constructor" etc.
  if (window.bnMobile) tab = window.bnMobile.allowTab(tab);  // phones: Home and Chat only (mobile.js)
  for (const b of document.querySelectorAll(".tab")) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  $("#home").hidden = tab !== "home";
  for (const f of document.querySelectorAll("#frames iframe")) f.hidden = f.dataset.app !== tab;
  if (tab !== "home" && !$(`#frames iframe[data-app="${tab}"]`)) {
    // Created on first visit and kept, so switching tabs never reloads an app.
    $("#frames").append(el("iframe", { src: appUrl(tab), "data-app": tab, title: tab[0].toUpperCase() + tab.slice(1),
      allow: "clipboard-read; clipboard-write; microphone; screen-wake-lock" }));
  }
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

// --- one-click Update / Rollback / Clean through the host helper (see /api/admin/*) ---
const PHASES = {
  update: [["backing-up", "Backup"], ["downloading", "Download"], ["restarting", "Restart and check"], ["done", "Done"]],
  rollback: [["restoring", "Restore code and data"], ["restarting", "Restart"], ["done", "Done"]],
  clean: [["cleaning", "Remove old images"], ["done", "Done"]],
};
const ACTION_TEXT = {
  update: (a) => {
    // A checkout on a branch (vX.Y.Z-N-g… versions) updates to whatever that branch has now, not to the release.
    const onBranch = (a.branch || (lastUpdate && lastUpdate.branch)) && /-\d+-g[0-9a-f]+$/.test(a.version || "");
    const target = onBranch ? `the tip of branch ${a.branch || lastUpdate.branch} (not a release)` : (lastUpdate && lastUpdate.latest ? lastUpdate.latest : "the newest release");
    return `Update to ${target}: a backup first, then the new code and images; Chat, Admin and Files are down for a few minutes while the services restart. This page reconnects by itself.`;
  },
  rollback: (a) => `Go back to ${a.rollback.to ? (/-\d+-g[0-9a-f]+$/.test(a.rollback.to) ? `${a.rollback.to} (a commit after the release ${a.rollback.to.replace(/-\d+-g[0-9a-f]+$/, "")})` : a.rollback.to) : "the previous version"}: its code, its images and the data from ${a.rollback.backup || "the pre-update backup"}. Chats, files and spend recorded since the update are replaced (a backup of the current state is taken first).`,
  clean: () => "Remove this install's old images. The ones in use and one previous version (for rollback) stay.",
};
let adminState = null, lastUpdate = null, adminTimer = null, pendingAction = null, reconnecting = false;

function fmtBytes(b) { return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${b || 0} B`; }

function renderAdmin(a) {
  adminState = a;
  const usable = a.running && a.allowed;
  $("#maint").hidden = !a.running;
  $("#maint-state").textContent = !a.allowed ? "Update, Rollback and Clean are off for remote access (REMOTE_ADMIN_ACTIONS in .env)."
    : `The update helper is running on this computer${a.version ? ` (installed version ${a.version})` : ""}.`;
  for (const b of document.querySelectorAll("button.action[data-action]")) b.disabled = !usable || a.in_progress;
  const rb = $("#rollback-now");
  rb.hidden = !(a.rollback && a.rollback.available);
  rb.textContent = a.rollback && a.rollback.to ? `Roll back to ${a.rollback.to}` : "Roll back";
  $("#update-now").hidden = !usable;
  $("#update-hint").textContent = usable ? "Or click Update now: the update helper runs it for you (asks for the portal password)."
    : "Run it in your bedrock-now folder. (./stack helper install adds a one-click button here.)";
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
  $("#job-title").textContent = `${{ update: "Update", rollback: "Rollback", clean: "Clean-up" }[job.action] || "Request"}${job.phase === "failed" ? " failed" : job.phase === "done" ? " finished" : " in progress"}`;
  const list = $("#job-steps"); list.replaceChildren();
  steps.forEach(([p, label], i) => {
    const state = job.phase === "failed" ? (i < Math.max(at, 0) ? "ok" : "") : i < at || job.phase === "done" ? "ok" : i === at ? "now" : "";
    list.append(el("li", { class: state, text: label }));
  });
  list.hidden = !steps.length;
  let msg = job.message || "";
  if (job.phase === "done" && job.action === "update" && job.version && !msg) msg = `Updated to ${job.version}`;
  $("#job-message").textContent = msg;
  $("#job-message").className = `job-message ${job.phase === "failed" ? "bad" : job.phase === "done" ? "good" : ""}`;
  let note = "";
  if (reconnecting) note = "The portal is restarting as part of the update — reconnecting…";
  else if (inProgress) note = `Started ${job.started_at ? new Date(job.started_at * 1000).toLocaleTimeString() : ""}. You can leave this page; it is carried out on your computer.`;
  // "Already up to date (…)": the helper's update found nothing new, so Home did not change either
  else if (job.phase === "done" && job.action !== "clean" && !msg.startsWith("Already up to date")) note = "Reload this page to use the new version of Home.";
  $("#job-note").textContent = note;
  $("#job-dismiss").hidden = inProgress;
}

async function pollAdmin() {
  clearTimeout(adminTimer);
  try {
    const a = await api("/api/admin/status");
    reconnecting = false;
    renderAdmin(a);
    adminTimer = setTimeout(pollAdmin, a.in_progress ? 2500 : REFRESH_MS);
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
  $("#confirm-title").textContent = { update: "Update now?", rollback: "Roll back?", clean: "Clean up old images?" }[action];
  $("#confirm-text").textContent = ACTION_TEXT[action](adminState);
  $("#confirm-error").hidden = true;
  $("#confirm-password").value = "";
  $("#confirm-ok").textContent = { update: "Update", rollback: "Roll back", clean: "Clean up" }[action];
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
    if (adminState) { adminState.in_progress = true; adminState.job = { action: pendingAction, phase: "queued", message: "Waiting for the update helper…", started_at: Math.floor(Date.now() / 1000) }; renderAdmin(adminState); }
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
    renderSpend(d.spend); renderOpenRouter(d.spend.openrouter); renderServices(d.services); renderModels(d.models, d.prices); renderVoice(d.voice);
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
  for (const b of document.querySelectorAll("button.action[data-action]")) b.addEventListener("click", () => openConfirm(b.dataset.action));
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
});
