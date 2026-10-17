// Settings: every .env value (secrets masked), changed through the update helper (/api/settings/*).
// Loaded after app.js (el, $, api, toast, copy, usd, day, showTab, appUrl come from there). DOM built with el() and
// textContent only; nothing from the API is ever parsed as HTML. Every change asks for the portal password again.
//
// Layout (catalog/settings-layout.tsv, from /api/settings): task sections shown one at a time (a list on the left; a
// picker on phones), each with its common settings, a folded "More settings", and settings that belong to a switch
// indented under it and hidden while it is off. Search and "Changed from default" look through every section.
// Addresses: #settings/<section>, #settings/<KEY>, #settings/<section>/<KEY> (app.js keeps the part after the slash).
"use strict";

(() => {
  const REPO = "https://github.com/JongoDB-Labs/bedrock-now/blob/main/";
  // a budget and the alias of its LiteLLM key (this period's spend under it); the key itself is the row's "with" key
  const BUDGET_ALIAS = { BUDGET_CLAUDE_CODE: "claude-code", BUDGET_OPENWEBUI: "open-webui", BUDGET_SETUP: "setup",
    BUDGET_TERMINAL: "claude-code-terminal" };
  const REVEALABLE = new Set(["LITELLM_UI_PASSWORD", "RUSTFS_ACCESS_KEY", "RUSTFS_SECRET_KEY", "LITELLM_KEY_CLAUDE_CODE",
    "LITELLM_KEY_OPENWEBUI", "LITELLM_KEY_SETUP", "SHARED_MCP_TOKEN"]);
  const DIAG_PHASES = ["check-aws", "models-recheck", "backup", "test", "report"];
  const STT_LABEL = { bedrock: "Bedrock (Mistral Voxtral, in your AWS account)", openai: "OpenAI", groq: "Groq", "": "Browser speech recognition (no voice calls)" };
  // what a change restarts, by settings.tsv's apply column (lib/settings.sh _cfg_post): the badge next to a setting
  const RESTARTS = { "portal-pw": ["portal"], email: ["Chat", "portal"], "litellm-pw": ["portal"], portal: ["portal"],
    "litellm-cfg": ["LiteLLM"], aws: ["LiteLLM"], pins: ["Chat", "portal"], "alert-pct": ["portal"], stt: ["LiteLLM", "Chat", "portal"],
    openrouter: ["LiteLLM", "portal"], rustfs: ["Files", "Chat", "shared-mcp", "portal"], mcp: ["shared-mcp", "portal"],
    code: ["portal", "Caddy"], "code-env": ["Code page"], "terminal-env": ["Terminal"], "remote-preview": ["portal", "Caddy"] };
  const ON_VALUES = ["true", "1", "yes", "on"], OFF_VALUES = ["false", "0", "no", "off"];
  const KEY_NAME = /^[A-Z][A-Z0-9_]{1,40}$/;
  const SECTION_MEMO = "bn.settings.section";
  // a row that stands for more than its key: named for what it shows
  const ROW_LABEL = { RUSTFS_ACCESS_KEY: "Files (RustFS) key pair", STT_PROVIDER: "Speech-to-text", TERMINAL_ENABLED: "Browser terminal",
    REMOTE_MODE: "Remote access" };

  let data = null;          // GET /api/settings
  let spend = null;         // /api/summary's spend (budget rows)
  let keys = {};            // KEY -> snapshot row
  let sections = [];        // [{id, title, lede, doc}]
  let rowOf = {};           // KEY or +own -> layout row {key, section, place, parent, summary}
  let withOf = {};          // KEY -> [the keys shown inside its row]
  let current = "";         // the section shown
  let pending = null;       // {kind: "apply"|"reveal"|"action"|"signout", ...} waiting for the password
  let watching = null;      // {id, kind, label, keys, at} a request the helper has not finished
  let pollTimer = null;
  let reconnecting = false;
  let findText = new Map(); // row element -> what the search looks through (lower case)
  // the page's search box and "Changed from default" (P-5): kept across a re-render
  const find = { q: "", changed: false };

  const page = () => $("#settings");
  const hasHelper = () => Boolean(data && data.helper.running && data.helper.settings);
  const canChange = () => hasHelper() && data.here.allowed;
  const pad2 = (n) => String(n).padStart(2, "0");
  const lower = (x) => String(x || "").trim().toLowerCase();
  const hourRange = (h) => `${pad2(h)}:00–${pad2((h + 3) % 24)}:00`;
  const plain = (k) => k.secret === "-" || k.secret === "s";
  const sectionOf = (id) => sections.find((s) => s.id === id);

  // --- data ---
  let loading = null;
  function load() {   // one request at a time: the tab switch and the page's own start may both ask
    if (!loading) loading = loadNow().finally(() => { loading = null; });
    return loading;
  }
  async function loadNow() {
    try {
      data = await api("/api/settings");
    } catch (e) {
      if (e.message === "signed out") return;
      showError(`Could not load the settings (${e.message}). ./stack status shows what is running.`);
      return;
    }
    keys = {};
    for (const k of (data.snapshot && data.snapshot.keys) || []) keys[k.key] = k;
    buildLayout();
    render();
    renderNotice();
    const j = data.helper.job;   // a change or diagnostic still running (updates show on Home)
    if (data.helper.in_progress && j && !watching && (j.action === "settings" || DIAG_PHASES.includes(j.action) || /^restart-/.test(j.action))) {
      watch({ id: j.id, kind: j.action, at: Date.now() - 60000 });
    }
    // this month's spend per key (next to the budgets): only while Settings is shown (the Home notice needs none)
    if (page() && !page().hidden) try { spend = (await api("/api/summary")).spend; renderSpend(); } catch (_) { /* budgets still show */ }
  }

  // The layout from catalog/settings-layout.tsv; a key it does not name (one of yours in .env) goes to Advanced.
  function buildLayout() {
    const l = data.layout || {};
    sections = (l.sections || []).slice();
    if (!sections.length) sections = [{ id: "advanced", title: "All settings", lede: "", doc: "" }];
    rowOf = {}; withOf = {};
    for (const r of l.rows || []) if (sectionOf(r.section)) rowOf[r.key] = r;
    const fallback = sectionOf("advanced") ? "advanced" : sections[sections.length - 1].id;
    for (const k of Object.keys(keys)) if (!rowOf[k]) rowOf[k] = { key: k, section: fallback, place: "main", parent: "", summary: "" };
    for (const r of Object.values(rowOf)) if (r.place === "with" && r.parent) (withOf[r.parent] = withOf[r.parent] || []).push(r.key);
  }
  const rowsIn = (id) => Object.values(rowOf).filter((r) => r.section === id && r.place !== "with");

  // A switch that is on: true or on; for other values, set and not off (REMOTE_MODE: tailscale or domain)
  function isOn(key) {
    const k = keys[key];
    if (!k) return false;
    if (key === "REMOTE_PREVIEW") return remotePreviewOn();
    if (!plain(k)) return Boolean(k.set);
    const v = lower(k.value);
    return v !== "" && !OFF_VALUES.includes(v);
  }
  // a switch's own value is on (true or on), whatever it shows
  const switchedOn = (k) => Boolean(k && ["bool", "on_off", "true_blank"].includes(k.validator) && ON_VALUES.includes(lower(k.value)));
  // shown in its section: its parent switch (and that one's parent) is on
  function parentsOn(r, depth = 0) {
    if (!r || !r.parent || depth > 5) return true;
    return isOn(r.parent) && parentsOn(rowOf[r.parent], depth + 1);
  }
  function offParent(r, depth = 0) {   // -> the first switch above r that is off, else null
    if (!r || !r.parent || depth > 5) return null;
    if (!isOn(r.parent)) return r.parent;
    return offParent(rowOf[r.parent], depth + 1);
  }

  function showError(msg) {
    const p = page(); if (!p) return;
    let b = $("#set-error", p);
    if (!b) { b = el("p", { id: "set-error", class: "banner", role: "alert" }); p.prepend(b); }
    b.textContent = msg; b.hidden = !msg;
  }

  // --- the page ---
  function render() {
    const p = page();
    const scrollY = p.scrollTop;
    p.replaceChildren();
    findText = new Map();
    const when = data.snapshot && data.snapshot.written_at ? new Date(data.snapshot.written_at * 1000).toLocaleString() : "";
    p.append(el("header", { class: "home-head set-head" },
      el("h1", { id: "settings-title", text: "Settings" }),
      el("p", { class: "updated" }, when ? `From .env as of ${when} ` : "", el("button", { type: "button", class: "quiet", id: "set-reload", text: "Reload" }))));
    $("#set-reload", p).addEventListener("click", load);
    if (!data.available) {
      p.append(el("p", { class: "banner", text: "Settings are not available yet: run ./stack up once (it writes .state/status/settings.json, the masked copy of .env this page shows)." }));
      return;
    }
    p.append(helperBox(), jobBox(), findBar(), picker());
    const cards = el("div", { class: "set-cards" });
    for (const s of sections) cards.append(card(s));
    p.append(el("div", { class: "set-layout" }, sectionNav(), cards));
    if (!current || !sectionOf(current)) current = initialSection();
    renderSpend();
    renderJob();
    applyView();
    p.scrollTop = scrollY;
  }

  function initialSection() {
    let memo = null;
    try { memo = localStorage.getItem(SECTION_MEMO); } catch (_) { /* storage blocked: the first section */ }
    return sectionOf(memo) ? memo : sections[0].id;
  }

  // the section list (desktop): Diagnostics, Advanced and About apart from the rest
  function sectionNav() {
    const list = el("ul", {});
    for (const s of sections) {
      if (s.id === "diagnostics") list.append(el("li", { class: "set-nav-sep", role: "presentation" }));
      const b = el("button", { type: "button", class: "set-nav-item", "data-section": s.id, text: s.title });
      b.addEventListener("click", (ev) => showSection(s.id, { focus: ev.detail === 0 }));
      list.append(el("li", {}, b));
    }
    return el("nav", { class: "set-nav", "aria-label": "Settings sections" }, list);
  }
  // the section picker (phones): the system's own list
  function picker() {
    const sel = el("select", { id: "set-picker", class: "set-picker-select" });
    for (const s of sections) sel.append(el("option", { value: s.id, text: s.title }));
    sel.addEventListener("change", () => showSection(sel.value));
    return el("div", { class: "set-picker" }, el("label", { for: "set-picker", text: "Section" }), sel);
  }

  // showSection ID — that section alone (and the address: #settings/ and its id); a search in progress is cleared
  function showSection(id, opts = {}) {
    if (!sectionOf(id)) return;
    current = id;
    try { localStorage.setItem(SECTION_MEMO, id); } catch (_) { /* fine */ }
    for (const d of document.querySelectorAll("#settings .set-forced")) d.classList.remove("set-forced");   // (goTo's)
    if (find.q || find.changed) {
      find.q = ""; find.changed = false;
      const input = $("#set-find"); if (input) input.value = "";
      const chip = $("#set-changed"); if (chip) chip.setAttribute("aria-pressed", "false");
    }
    applyView();
    const p = page();
    if (p && !p.hidden && opts.address !== false && location.hash.startsWith("#settings")) history.replaceState(null, "", `#settings/${id}`);
    if (p && opts.scroll !== false) p.scrollTop = 0;
    if (opts.focus) { const h = $(`#set-${id}-title`); if (h) h.focus({ preventScroll: true }); }
  }

  // goTo PLACE — "section", "KEY" or "section/KEY" from the address: the section, and the setting opened (More
  // unfolded, a setting whose switch is off shown anyway), scrolled to and highlighted
  function goTo(place) {
    let sec = null, key = null;
    for (const part of String(place || "").split("/")) {
      if (sectionOf(part)) sec = part;
      else if ((KEY_NAME.test(part) || /^\+[a-z-]{2,20}$/.test(part)) && rowOf[part]) key = part;
    }
    if (key && rowOf[key].place === "with" && rowOf[rowOf[key].parent]) key = rowOf[key].parent;
    if (key) sec = rowOf[key].section;
    if (!sec) return;
    showSection(sec, { address: false, scroll: !key });
    if (!key) return;
    const r = $(`#settings .set-card .set-row[data-key="${key}"], #settings .set-card .set-adv-item[data-key="${key}"], #settings .set-card .set-row[data-own="${key}"]`);
    if (!r) return;
    const more = r.closest("details.set-more");
    if (more) more.open = true;
    for (let d = r.closest(".set-dep"); d; d = d.parentElement.closest(".set-dep")) d.classList.add("set-forced");
    applyView();
    r.setAttribute("tabindex", "-1");
    r.scrollIntoView({ block: "center" });
    r.focus({ preventScroll: true });
    r.classList.add("set-flash");
    setTimeout(() => r.classList.remove("set-flash"), 2400);
  }

  // --- what is shown: one section, or every match of the search / "Changed from default" with its section ---
  function changedFromDefault(k) {
    if (!k || !("value" in k) || !("default" in k) || !(k.secret === "-" || k.secret === "s")) return false;
    const v = String(k.value).trim();
    return v !== "" && v !== String(k.default).trim();
  }
  function findBar() {
    const input = el("input", { type: "search", id: "set-find", class: "set-find-input", placeholder: "Search settings", "aria-label": "Search settings",
      maxlength: "100", value: find.q });
    input.value = find.q;
    input.addEventListener("input", () => { find.q = input.value.slice(0, 100); applyView(); });
    const chip = el("button", { type: "button", class: "chip", id: "set-changed", "aria-pressed": String(find.changed), text: "Changed from default" });
    chip.addEventListener("click", () => { find.changed = !find.changed; chip.setAttribute("aria-pressed", String(find.changed)); applyView(); });
    const clear = el("button", { type: "button", class: "quiet", id: "set-find-clear", text: "Clear", hidden: "" });
    clear.addEventListener("click", () => showSection(current, { scroll: false }));
    const known = Object.values(keys).some((k) => "default" in k);
    return el("div", { class: "set-find", role: "search" }, input, chip,
      el("span", { class: "note set-find-note", id: "set-find-note", "aria-live": "polite", text: known ? "" : "Defaults are not known yet: ./stack up writes them." }), clear);
  }
  function rowMatches(r, q) {
    // the row's key and the ones shown inside it, except values ./stack derives (setup's model choices differ from
    // .env.example's blank on every install: they are no change of yours)
    const keyNames = [r.dataset.key, ...(withOf[r.dataset.key] || []).filter((w) => keys[w] && keys[w].policy !== "derived")].filter(Boolean);
    const okChanged = !find.changed || keyNames.some((n) => changedFromDefault(keys[n]));
    return okChanged && (!q || (findText.get(r) || "").includes(q));
  }
  function applyView() {
    const p = page();
    if (!p || !data || !data.available) return;
    const q = find.q.trim().toLowerCase();
    const finding = Boolean(q) || find.changed;
    p.classList.toggle("set-finding", finding);
    let shownRows = 0, shownCards = 0;
    for (const c of p.querySelectorAll(".set-card")) {
      let left = 0;
      // a block: one setting and the ones that belong to it. Innermost first: a block shows when its setting matches
      // or one inside it does (its setting then dimmed, as context). A setting whose switch is off: hidden, unless
      // searching or opened by an address (then "Applies while … is on" says why it does nothing now).
      for (const d of [...c.querySelectorAll(".set-dep")].reverse()) {
        const own = d.querySelector(":scope > .set-row, :scope > .set-adv-item");
        const off = Boolean(d.dataset.parent) && !parentsOn(rowOf[d.dataset.key]);
        // a switch of its own that is on stays in sight while its parent is off (Bypass allowed, the Code page off):
        // it takes effect again the moment the parent is on
        const selfOn = off && switchedOn(keys[d.dataset.key]);
        d.classList.toggle("set-dep-off", off);
        d.classList.toggle("set-dep-on", selfOn);
        if (!finding) {
          d.hidden = off && !selfOn && !d.classList.contains("set-forced");
          if (own) own.classList.remove("set-ghost");
          continue;
        }
        const hit = Boolean(own) && rowMatches(own, q);
        const inner = [...d.querySelectorAll(":scope > .set-children > .set-dep")].some((x) => !x.hidden);
        if (hit) left++;
        d.hidden = !(hit || inner);
        if (own) own.classList.toggle("set-ghost", !hit && inner);
      }
      for (const m of c.querySelectorAll("details.set-more")) {
        const n = [...m.querySelectorAll(".set-dep")].filter((d) => !d.hidden && !d.parentElement.closest(".set-dep[hidden]")).length;
        $(".set-more-count", m).textContent = finding ? "" : `(${n})`;
        m.hidden = n === 0;
        if (finding && n) {
          if (!("wasOpen" in m.dataset)) m.dataset.wasOpen = m.open ? "1" : "";
          m.open = true;
        } else if (!finding && "wasOpen" in m.dataset) {
          m.open = m.dataset.wasOpen === "1";
          delete m.dataset.wasOpen;
        }
      }
      const show = finding ? left > 0 : c.dataset.section === current;
      c.hidden = !show;
      if (show) shownCards++;
      shownRows += left;
    }
    for (const b of p.querySelectorAll(".set-nav-item")) {
      if (!finding && b.dataset.section === current) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
    }
    const sel = $("#set-picker", p); if (sel) sel.value = current;
    const note = $("#set-find-note", p), clear = $("#set-find-clear", p);
    if (note && Object.values(keys).some((k) => "default" in k)) {
      note.textContent = finding ? (shownRows ? `${shownRows} setting${shownRows === 1 ? "" : "s"} in ${shownCards} section${shownCards === 1 ? "" : "s"}` : "No setting matches.") : "";
    }
    if (clear) clear.hidden = !finding;
  }

  function helperBox() {
    const box = el("div", { class: "set-helper" });
    if (!data.here.allowed) {
      box.append(el("p", { class: "helper-off-title", text: "Changes are off for remote access" }),
        el("p", { class: "note" }, "Settings, Reveal and Diagnostics work from the computer running bedrock-now. To use them from your devices too, turn on ",
          el("a", { href: "#settings/REMOTE_ADMIN_ACTIONS", text: "Remote access › Update, settings and diagnostics from your devices" }), " there."));
      box.classList.add("helper-off");
      return box;
    }
    if (hasHelper()) {
      box.hidden = true;
      return box;
    }
    const cmd = "./stack helper install";
    const seen = data.helper.heartbeat_at ? ` (last seen ${new Date(data.helper.heartbeat_at * 1000).toLocaleString()})` : "";
    const title = data.helper.running ? "The update helper needs a refresh to change settings" : `One-click updates are off${seen}`;
    const copyBtn = el("button", { type: "button", class: "copy", text: "Copy" });
    copyBtn.addEventListener("click", () => copy(cmd, "the command"));
    box.classList.add("helper-off");
    box.append(el("p", { class: "helper-off-title", text: title }),
      el("p", { class: "cmdline" }, el("code", { text: cmd }), " ", copyBtn),
      el("p", { class: "note", text: "Everything below is read-only until then: the portal never writes .env itself. The update helper (a small job under your user, outside Docker) applies changes, after checking each one again. Or change a setting in a terminal with the command shown next to it." }));
    return box;
  }

  // --- a section ---
  function card(s) {
    const c = el("section", { class: "set-card", id: `set-${s.id}`, "data-section": s.id, "aria-labelledby": `set-${s.id}-title`, hidden: "" });
    const lede = el("p", { class: "note set-lede", text: s.lede });
    if (s.doc) lede.append(" ", el("a", { href: REPO + s.doc, target: "_blank", rel: "noopener", class: "set-learn", text: "Learn more" }));
    c.append(el("div", { class: "set-card-head" }, el("h2", { id: `set-${s.id}-title`, tabindex: "-1", text: s.title }), lede));
    const all = rowsIn(s.id);
    const main = all.filter((r) => r.place === "main"), more = all.filter((r) => r.place === "more");
    const list = s.id === "advanced" || s.id === "about";
    const body = el("div", { class: list ? "set-rows set-list" : "set-rows" });
    blocks(body, main, list);
    c.append(body);
    if (s.id === "diagnostics") c.append(el("div", { class: "set-report", id: "set-report", hidden: "" }));
    if (more.length) {
      const inner = el("div", { class: "set-rows" });
      blocks(inner, more, list);
      c.append(el("details", { class: "set-more" }, el("summary", {}, "More settings ", el("span", { class: "set-more-count" })), inner));
    }
    c.append(pager(s.id));
    return c;
  }

  // blocks CONTAINER ROWS — each row in a block of its own, followed by the rows that belong to it (indented)
  function blocks(container, rows, list) {
    const here = new Set(rows.map((r) => r.key));
    const made = {};
    for (const r of rows) {
      const node = list ? listItem(r) : rowFor(r);
      if (!node) continue;
      const block = el("div", { class: "set-dep", "data-key": r.key });
      if (r.parent) block.dataset.parent = r.parent;
      if (r.parent && offParent(r)) {   // shown only by a search or an address: why it does nothing now
        const p = keys[offParent(r)] || { label: offParent(r), secret: "-" };
        const name = ROW_LABEL[p.key] || p.label;
        block.append(el("p", { class: "note set-applies", text: plain(p) ? `Applies while ${name} is on.` : `Applies once ${name} is set.` }));
      }
      block.append(node);
      made[r.key] = block;
      const host = r.parent && here.has(r.parent) && made[r.parent];
      if (host) {
        let kids = host.querySelector(":scope > .set-children");
        if (!kids) { kids = el("div", { class: "set-children" }); host.append(kids); }
        kids.append(block);
      } else {
        container.append(block);
      }
      const k = keys[r.key] || {};
      // its name, summary, note and key, and those of the keys shown inside it (not the section's title: "budget" would
      // then list every setting of Spending & budgets)
      findText.set(node, [k.label || "", ROW_LABEL[r.key] || "", r.summary, k.note || "", r.key.startsWith("+") ? "" : r.key, node.dataset.findExtra || "",
        ...(withOf[r.key] || []).flatMap((w) => [w, (keys[w] || {}).label || ""])].join(" ").toLowerCase());
    }
  }

  function pager(id) {
    const i = sections.findIndex((s) => s.id === id);
    const nav = el("nav", { class: "set-pager", "aria-label": "Other sections" });
    for (const [j, cls, txt] of [[i - 1, "set-prev", (t) => `← ${t}`], [i + 1, "set-next", (t) => `${t} →`]]) {
      const s = sections[j];
      if (!s) { nav.append(el("span", {})); continue; }
      const b = el("button", { type: "button", class: `quiet ${cls}`, text: txt(s.title) });
      b.addEventListener("click", (ev) => showSection(s.id, { focus: ev.detail === 0 }));
      nav.append(b);
    }
    return nav;
  }

  // rowFor LAYOUT-ROW -> the row of one setting (or of one of the page's own rows), or null
  function rowFor(r) {
    const own = { "+devices": sessionsRow, "+models": modelsRow, "+backups": backupRow, "+test": actionRow, "+check-aws": actionRow,
      "+report": actionRow, "+restart": restartRow };
    if (r.key.startsWith("+")) return own[r.key] ? own[r.key](r) : null;
    const k = keys[r.key];
    if (!k) return null;
    if (r.key === "STT_PROVIDER") return voiceRow(r);
    if (r.key === "CODE_ENABLED") return codeRow(r);
    if (r.key === "TERMINAL_ENABLED") return terminalRow(r);
    if (r.key === "REMOTE_MODE") return remoteStatus(r);
    return row(k, r);
  }

  // --- one setting ---
  function shown(k) {
    if (!k.present && !k.set) return "not set";
    if ("value" in k) return k.value === "" ? "blank" : k.value;
    if (k.hint) return k.hint;
    return k.set ? "set" : "not set";
  }

  // REMOTE_PREVIEW shown as it takes effect: On only while the stack serves previews over remote access — it wrote their
  // address, REMOTE_PREVIEW_HOST (lib/code.sh code_remote_sync, which also checks a REMOTE_PREVIEW_DOMAIN) — so never On
  // while they are off. A change that may turn them on (true; or blank in own-domain mode with a preview domain of its
  // own) is less protection: lib/settings.sh setting_weakens.
  function remotePreviewOn() { return Boolean(keys.REMOTE_PREVIEW_HOST && keys.REMOTE_PREVIEW_HOST.value); }
  function remotePreviewMayBeOn(v) {
    if (ON_VALUES.includes(lower(v))) return true;
    if (OFF_VALUES.includes(lower(v))) return false;
    return Boolean(keys.REMOTE_MODE && keys.REMOTE_MODE.value === "domain" && keys.REMOTE_PREVIEW_DOMAIN && keys.REMOTE_PREVIEW_DOMAIN.value);
  }
  // what a blank value means (the stack's own default), for the keys whose default is not .env.example's value
  const BLANK = { PORTAL_SESSION_DAYS: "30 days", BUDGET_ALERT_PCT: "80%", BACKUP_HOUR: hourRange(2), BACKUP_KEEP: "7",
    AUTO_UPDATE_HOUR: hourRange(3), OPENROUTER_MODELS: "all", OPENROUTER_MAX_MODELS: "1000", TERMINAL_EGRESS: "on",
    TERMINAL_MEM_LIMIT: "4g", REMOTE_MODE: "off", AWS_AUTH: "an access key", REMOTE_SUBNET: "10.255.255.248/29",
    PORTAL_HOST: "bedrock-now.localhost", PORTAL_PORT: "80, else 8800", CHAT_HOST: "chat. + the portal's address",
    ADMIN_HOST: "admin. + the portal's address", FILES_HOST: "files. + the portal's address",
    TERMINAL_HOST: "terminal. + the portal's address", CODE_HOST: "code. + the portal's address" };
  // display K -> the value in words: "$50 a month", "30 days (default)", "On", "Not set", "••••••••"
  function display(k) {
    const v = shown(k);
    if (k.key === "REMOTE_PREVIEW") return remotePreviewOn() ? "On" : "Off";
    if (k.validator === "bool" || k.validator === "true_blank") return v === "true" ? "On" : "Off";
    if (k.validator === "on_off") return v === "on" ? "On" : "Off";
    if (k.secret === "S") return k.set ? "••••••••" : "Not set";
    if (!plain(k)) return v === "not set" ? "Not set" : v === "set" ? "Set" : v;
    if (v === "blank" || v === "not set") return BLANK[k.key] ? `${BLANK[k.key]} (default)` : "Not set";
    if (["TERMINAL_ENABLED", "REMOTE_TERMINAL", "OWUI_HYBRID_SEARCH", "OWUI_ENABLE_IMAGES", "LITELLM_DB_ADMIN_READY"].includes(k.key)) return v === "true" ? "On" : "Off";
    if (k.validator === "budget") return `$${v} a month`;
    if (k.validator === "days") return `${v} day${v === "1" ? "" : "s"}`;
    if (k.validator === "pct") return `${v}%`;
    if (k.validator === "hour" && /^\d+$/.test(v)) return hourRange(Number(v));
    return v;
  }

  function editable(k) { return ["edit", "local", "on-only", "widen-local"].includes(k.policy); }
  // lib/settings.sh setting_weakens: the less protective direction of a widen-local key
  function weakens(k, v) {
    const old = "value" in k ? k.value : "";
    const n = (x, lo, hi, d) => (/^\d{1,3}$/.test(x || "") && Number(x) >= lo && Number(x) <= hi ? Number(x) : d);   // _eff_int
    const usd = (x) => (/^(\d*\.?\d+|\d+\.)$/.test(x || "") ? Number(x) : { BUDGET_CLAUDE_CODE: 200, BUDGET_OPENWEBUI: 50, BUDGET_TERMINAL: 50 }[k.key] || 5);
    if (k.key === "BACKUP_KEEP") return n(v, 1, 60, 7) < n(old, 1, 60, 7);
    if (k.key === "PORTAL_SESSION_DAYS") return n(v, 1, 90, 30) > n(old, 1, 90, 30);
    if (k.key === "BUDGET_ALERT_PCT") return n(v, 50, 99, 80) > n(old, 50, 99, 80);
    if (/^BUDGET_(CLAUDE_CODE|OPENWEBUI|SETUP|TERMINAL)$/.test(k.key)) return usd(v) > usd(old);
    if (k.key === "BACKUP_NIGHTLY" || k.key === "AUTO_UPDATE") return v !== "on" && old === "on";
    if (k.key === "UPDATE_CHECK") return v === "false" && old !== "false";
    if (k.key === "REMOTE_PREVIEW") return remotePreviewMayBeOn(v) && !ON_VALUES.includes(lower(old));
    return v === "true" && old !== "true";
  }
  function localOnlyHere(k, value) {
    if (!data.here.remote) return false;
    return k.policy === "local" || (k.policy === "widen-local" && weakens(k, value));
  }
  // The Code page runs in the browser terminal's sandbox: with the terminal off, turning it on turns the terminal on
  // too, with the folder ./stack names in the snapshot (choices.code_workspace; settings_check_batch checks it)
  const terminalOn = () => Boolean(keys.TERMINAL_ENABLED && keys.TERMINAL_ENABLED.value === "true");
  const codeFolder = () => terminalOn() ? (keys.TERMINAL_WORKSPACE && keys.TERMINAL_WORKSPACE.value) || ""
    : (data.snapshot && data.snapshot.choices.code_workspace) || "";

  function copyButton(cmd) {
    const b = el("button", { type: "button", class: "copy", text: "Copy" });
    b.addEventListener("click", () => copy(cmd.replace(/\s+\(.*\)$/, ""), "the command"));
    return b;
  }
  function cliLine(k, lead) {
    const cmd = k.cli || `./stack config set ${k.key}`;
    return el("p", { class: "set-cli" }, el("span", { class: "note", text: lead || (editable(k) ? "In a terminal: " : "Change it in a terminal: ") }),
      el("code", { text: cmd }), " ", copyButton(cmd));
  }

  // the badges next to a setting's name: from where it may change, that it is secret or read-only, what it restarts
  function badges(k) {
    const out = el("span", { class: "set-badges" });
    const add = (text, cls, title) => out.append(el("span", { class: `badge ${cls}`, text, ...(title ? { title } : {}) }));
    if (k.policy === "local") add("This computer only", "badge-local", "Changed only from the computer running bedrock-now: from your devices it could send your data elsewhere.");
    if (k.policy === "on-only") add("On only", "badge-local", "Can be turned on here; turning it off is a terminal step.");
    if (k.secret === "S" || k.secret === "h") add("Secret", "badge-secret");
    if (k.policy === "ro" || k.policy === "derived") add("Read-only", "badge-ro");
    if (editable(k) || k.policy === "regen") {
      const what = [...new Set(String(k.apply || "").split(",").flatMap((a) => RESTARTS[a] || []))];
      if (k.key === "CODE_ENABLED") add("Builds the Code page", "badge-restart");
      else if (what.length) add(`Restarts ${what.join(", ")}`, "badge-restart", "What a change restarts (about 10-40 s)");
    }
    return out;
  }

  // the frame of a row: name and badges, the summary, the value, and the full note folded under Details
  function frame(k, r, opts = {}) {
    const row = el("div", { class: "set-row", "data-key": k.key, id: `set-row-${k.key}` });
    if (changedFromDefault(k)) {
      row.dataset.changed = "1";
      row.title = `Changed from the default (${String(k.default).trim() === "" ? "blank" : k.default})`;
    }
    const nameId = `set-name-${k.key}`, sumId = `set-sum-${k.key}`;
    const main = el("div", { class: "set-main" },
      el("div", { class: "set-label" }, el("span", { class: "set-name", id: nameId, text: opts.label || ROW_LABEL[k.key] || k.label }), badges(k)),
      el("p", { class: "set-sum", id: sumId, text: (r && r.summary) || "" }));
    if (opts.value !== false) {
      const text = opts.value || display(k);
      const v = el("p", { class: `set-value${plain(k) ? "" : " masked"}${text === "Not set" ? " set-unset" : ""}`, text });
      if (plain(k) && "value" in k) v.dataset.value = k.value;
      main.append(v);
    }
    const actions = el("div", { class: "set-actions" });
    row.append(main, actions);
    const details = el("details", { class: "set-details" }, el("summary", {}, "Details"),
      el("p", { class: "note", text: k.note }),
      el("p", { class: "note set-envkey" }, "In .env: ", el("code", { text: [k.key, ...(withOf[k.key] || [])].join(" · ") })));
    if (opts.cli !== false && editable(k) && canChange()) details.append(cliLine(k));
    row._details = details;
    row._main = main;
    row._actions = actions;
    return row;
  }
  // finish ROW: the terminal command inline where the page cannot change it, then the Details, last
  function finish(row, k, inlineCli) {
    if (inlineCli) row.append(inlineCli === true ? cliLine(k) : inlineCli);
    row.append(row._details);
    return row;
  }

  function row(k, r) {
    const rw = frame(k, r);
    const main = rw._main, actions = rw._actions;
    const setValue = (text) => { const v = $(".set-value", main); v.textContent = text; v.classList.remove("set-unset"); };
    const alias = BUDGET_ALIAS[k.key];
    if (alias) main.append(el("p", { class: "set-spend note", "data-alias": alias }));
    if (k.key === "AWS_ACCESS_KEY_ID" && keys.AWS_AUTH && shown(keys.AWS_AUTH) === "instance-role") {
      setValue("this computer's IAM role (no key in .env)");
    }
    if (k.key === "OPENWEBUI_ADMIN_EMAIL" && keys.LITELLM_UI_USER && "value" in keys.LITELLM_UI_USER && keys.LITELLM_UI_USER.value !== k.value) {
      main.append(el("p", { class: "note set-extra", text: `Admin (LiteLLM) sign-in name until the next setup: ${keys.LITELLM_UI_USER.value || "admin"}` }));
    }
    // reveal / copy for what the portal holds anyway
    if (REVEALABLE.has(k.key) && k.set) actions.append(revealButton(k.key, "Reveal", true));
    if (k.key === "RUSTFS_ACCESS_KEY" && keys.RUSTFS_SECRET_KEY && keys.RUSTFS_SECRET_KEY.set) actions.append(revealButton("RUSTFS_SECRET_KEY", "Copy secret", false));
    const ownKey = (withOf[k.key] || []).find((w) => /^LITELLM_KEY_/.test(w));
    if (alias && ownKey && keys[ownKey] && keys[ownKey].set && REVEALABLE.has(ownKey)) actions.append(revealButton(ownKey, "Copy key", false));
    if (k.key === "AWS_ACCESS_KEY_ID") actions.append(actionButton("check-aws", "Check (free)"));
    if (k.validator === "model_pin") {   // a pin, and the model setup chose (shown while there is no pin)
      const d = keys[(withOf[k.key] || [])[0]];
      setValue(shown(k) === "blank" || !k.set ? `Automatic: ${modelName(d ? shown(d) : "")}` : `Pinned: ${modelName(shown(k))}`);
    }
    if (k.key === "REMOTE_PREVIEW" && ON_VALUES.includes(lower(k.value)) && !remotePreviewOn()) {
      main.append(el("p", { class: "note", text: "Switched on, not in effect: the Code page is not reachable over remote access (REMOTE_TERMINAL=true), or remote access has no names yet (./stack up)." }));
    }
    if (k.key === "MODELS_HIDDEN") setValue(k.value ? k.value.split(",").map(modelName).join(", ") : "None hidden");
    if (k.key === "BACKUP_HOUR" && keys.AUTO_UPDATE && keys.AUTO_UPDATE.value === "on") {
      const h = keys.AUTO_UPDATE_HOUR && /^\d+$/.test(keys.AUTO_UPDATE_HOUR.value || "") ? Number(keys.AUTO_UPDATE_HOUR.value) : 3;
      main.append(el("p", { class: "note set-extra", text: `Automatic updates are on: nightly backups use their window (${hourRange(h)}) instead.` }));
    }
    if (k.policy === "regen") {
      const b = el("button", { type: "button", class: "action", text: "Regenerate" });
      b.disabled = !canChange();
      b.addEventListener("click", () => askPassword({ kind: "apply", values: {}, regen: [k.key], keys: [k.key] },
        `Regenerate ${k.key === "SHARED_MCP_TOKEN" ? "the MCP token" : "the Files key pair"}?`, k.note, "Regenerate",
        k.key === "SHARED_MCP_TOKEN" ? ["SHARED_MCP_TOKEN"] : ["RUSTFS_ACCESS_KEY", "RUSTFS_SECRET_KEY"]));
      actions.append(b);
      return finish(rw, k, !canChange());
    }
    if (!editable(k)) return finish(rw, k, true);
    if (localOnlyHere(k, "true") && k.policy === "local") {
      rw.append(el("p", { class: "note set-remote", text: "Change this from the computer running bedrock-now: from your devices it could send your data elsewhere." }));
      return finish(rw, k, true);
    }
    const v = shown(k);
    if (["bool", "on_off", "true_blank"].includes(k.validator)) {
      $(".set-value", main).remove();
      actions.append(toggle(k, v, `set-name-${k.key}`));
      rw.classList.add("set-has-switch");
    } else if (k.validator === "hour") {   // the select shows the value
      $(".set-value", main).remove();
      actions.append(hourSelect(k, k.key === "AUTO_UPDATE_HOUR" ? 3 : 2, k.key === "AUTO_UPDATE_HOUR" ? "Change the nightly window?" : "Change the nightly backup window?"));
    } else if (k.validator === "keep") {
      $(".set-value", main).remove();
      actions.append(keepSelect(k));
    } else if (k.validator === "or_mode") {
      if (["all", "free", "paid", ""].includes(lower(k.value))) $(".set-value", main).remove();
      actions.append(segmented(k, rw));
    } else {
      const b = el("button", { type: "button", class: "action", text: plain(k) || k.set ? "Change" : "Set",
        "aria-describedby": `set-name-${k.key}` });
      b.disabled = !canChange();
      b.addEventListener("click", () => openForm(rw, k));
      actions.append(b);
    }
    return finish(rw, k, !canChange());
  }

  // a switch: one button (role switch), its state in words next to it; a change asks for the password like any other
  function toggle(k, v, labelId) {
    const on = k.validator === "on_off" ? "on" : "true", off = k.validator === "on_off" ? "off" : (k.validator === "true_blank" ? "" : "false");
    const cur = k.key === "REMOTE_PREVIEW" ? (remotePreviewOn() ? on : off) : v === on ? on : off;
    const other = cur === on ? off : on;
    const b = el("button", { type: "button", class: "switch", role: "switch", "aria-checked": String(cur === on), "aria-labelledby": labelId,
      "aria-describedby": `set-sum-${k.key}`, "data-state": cur === on ? "on" : "off" }, el("span", { class: "switch-track", "aria-hidden": "true" }, el("span", { class: "switch-thumb" })),
    el("span", { class: "switch-text", text: cur === on ? "On" : "Off" }));
    b.disabled = !canChange() || (k.policy === "on-only" && other !== on) || localOnlyHere(k, other);
    const what = k.key === "CODE_ENABLED" ? codeSwitch(other) : k.note;
    b.addEventListener("click", () => confirmApply({ [k.key]: other }, `${k.label}: ${other === on ? "On" : "Off"}`, what, [k.key]));
    const wrap = el("div", { class: "set-toggle" }, b);
    if (k.policy === "on-only" && cur === on) wrap.append(el("span", { class: "note", text: "Turning it off is a terminal step." }));
    if (k.policy === "widen-local" && data.here.remote && weakens(k, other)) {
      wrap.append(el("span", { class: "note", text: `${other === on ? "On" : "Off"} only from the computer running bedrock-now.` }));
    }
    return wrap;
  }

  // OpenRouter's model set: All · Free · Paid, or a list of model ids (the form)
  function segmented(k, rw) {
    const v = lower(k.value) || "all";
    const cur = ["all", "free", "paid"].includes(v) ? v : "list";
    const g = el("div", { class: "chips seg set-seg", role: "group", "aria-labelledby": `set-name-${k.key}` });
    for (const [val, label] of [["all", "All"], ["free", "Free"], ["paid", "Paid"], ["list", "List…"]]) {
      const b = el("button", { type: "button", class: "chip", "aria-pressed": String(val === cur), text: label });
      b.disabled = !canChange();
      b.addEventListener("click", () => {
        if (val === "list") openForm(rw, k);
        else if (val !== cur) confirmApply({ [k.key]: val }, `${k.label}: ${label}`, k.note, [k.key]);
      });
      g.append(b);
    }
    return g;
  }

  // --- the Code page (./stack code enable | disable, run by the update helper) and the browser terminal ---
  function codeSwitch(val) {
    if (val !== "true") return "The helper runs ./stack code disable: the code container goes; the terminal (and its tmux session), its folder and Claude Code's history stay.";
    const ws = codeFolder() || "the default folder";
    return terminalOn()
      ? `The helper runs ./stack code enable: it builds the Code page's image (a few minutes the first time) and restarts the portal and Caddy; the terminal keeps running. Claude sees the terminal's folder ${ws}.`
      : `The helper runs ./stack code enable: it turns the browser terminal on too, with the folder ${ws} as its workspace (created if it is not there; Claude sees only that folder), then builds the Code page's image (a few minutes the first time) and restarts the portal and Caddy.`;
  }
  function codeRow(r) {
    const k = keys.CODE_ENABLED;
    const rw = row(k, r);
    const ws = codeFolder();
    const egress = !(keys.TERMINAL_EGRESS && keys.TERMINAL_EGRESS.value === "off");
    const extra = [el("p", { class: "set-code-ws" }, el("span", { class: "note", text: "Workspace: " }),
      el("code", { text: ws || (terminalOn() ? "the terminal's" : "the default folder") }))];
    if (terminalOn()) {
      extra.push(el("p", { class: "note", text: `Claude sees only that folder (at /workspace), uses the terminal's key and budget, and ${egress ? "can reach the internet" : "has no internet (TERMINAL_EGRESS=off)"}.` }));
    } else if (shown(k) !== "true") {
      extra.push(el("p", { class: "note", text: "The browser terminal is off: turning this on turns it on too, with the folder above as its workspace (Claude sees only that folder, at /workspace). Another folder: in a terminal, with the command below." }));
    }
    rw._main.append(...extra);
    rw.querySelector(":scope > .set-details").remove();
    const cmd = terminalOn() ? "./stack terminal enable --workspace DIR" : "./stack code enable --workspace DIR";
    rw.insertBefore(el("p", { class: "set-cli" }, el("span", { class: "note", text: terminalOn() ? "Another folder, in a terminal: " : "In a terminal: " }), el("code", { text: cmd }), " ", copyButton(cmd)), null);
    rw.append(rw._details);
    return rw;
  }
  function terminalRow(r) {
    const k = keys.TERMINAL_ENABLED;
    const rw = frame(k, r);
    if (terminalOn()) {
      const ws = (keys.TERMINAL_WORKSPACE && keys.TERMINAL_WORKSPACE.value) || "";
      rw._main.append(el("p", { class: "set-code-ws" }, el("span", { class: "note", text: "Folder: " }), el("code", { text: ws || "the default folder" })));
    }
    return finish(rw, k, cliLine(k, terminalOn() ? "Turned off, or another folder, in a terminal: " : "Turned on in a terminal (it builds an image and checks the folder): "));
  }

  function remoteStatus(r) {
    const k = keys.REMOTE_MODE;
    const on = data.remote && data.remote.on;
    const rw = frame(k, r, { value: on ? `${data.remote.mode}: ${data.remote.url}` : "Off" });
    rw._main.append(el("p", { class: "note set-extra", text: on ? `This page is open ${data.here.remote ? "remotely" : "on this computer"}.` : "It needs a Tailscale auth key and a few steps in your tailnet's admin console (Learn more above)." }));
    return finish(rw, k, cliLine(k, on ? "Turned off in a terminal: " : "Turned on in a terminal: "));
  }

  function modelName(id) {
    const m = ((data.snapshot && data.snapshot.choices.chat_models) || []).find((x) => x[0] === id);
    return m ? m[1] : id || "none";
  }

  function keepSelect(kk) {
    const cur = "value" in kk && /^\d+$/.test(kk.value) ? Number(kk.value) : 7;
    const sel = el("select", { "aria-labelledby": `set-name-${kk.key}` });
    const ns = [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60];
    if (!ns.includes(cur)) ns.push(cur);   // a value set in a terminal shows as it is
    for (const n of ns.sort((a, b) => a - b)) {
      const o = el("option", { value: String(n), text: `keep ${n}` });
      if (n === cur) o.selected = true;
      if (n !== cur && localOnlyHere(kk, String(n))) o.disabled = true;   // fewer: only from this computer
      sel.append(o);
    }
    sel.disabled = !canChange();
    sel.addEventListener("change", () => confirmApply({ BACKUP_KEEP: sel.value }, "Change how many nightly backups are kept?", kk.note, ["BACKUP_KEEP"]));
    return sel;
  }

  function hourSelect(hk, def, title) {
    const cur = "value" in hk && /^\d+$/.test(hk.value) ? Number(hk.value) : def;
    const sel = el("select", { "aria-labelledby": `set-name-${hk.key}` });
    for (let h = 0; h < 24; h++) {
      const o = el("option", { value: String(h), text: hourRange(h) });
      if (h === cur) o.selected = true;
      sel.append(o);
    }
    sel.disabled = !canChange();
    sel.addEventListener("change", () => confirmApply({ [hk.key]: sel.value }, title, hk.note, [hk.key]));
    return sel;
  }

  function revealButton(key, label, show) {
    const b = el("button", { type: "button", class: "copy", text: label });
    b.disabled = !data.here.allowed;
    b.addEventListener("click", () => askPassword({ kind: "reveal", key, show },
      "Show and copy?", `${key} goes on your clipboard${show ? " and shows here" : ""}. The portal already holds this value; nothing else can be revealed.`, "Copy"));
    return b;
  }

  // --- forms ---
  function field(id, label, type, attrs = {}, unit = "") {
    const input = el("input", { id, type, autocomplete: type === "password" ? "new-password" : "off", spellcheck: "false", ...attrs });
    return [el("label", { for: id, text: label }), unit ? el("span", { class: "set-unit" }, input, el("span", { class: "note", text: unit })) : input];
  }

  function openForm(r, k) {
    for (const f of document.querySelectorAll("#settings .set-form")) f.remove();
    const form = el("form", { class: "set-form", novalidate: "" });
    const id = `f-${k.key}`;
    let collect = () => ({});
    const v = "value" in k ? k.value : "";
    if (k.validator === "portal_password" || k.validator === "litellm_password") {
      form.append(...field(`${id}-a`, "New password", "password", { minlength: "12", maxlength: "128" }),
        ...field(`${id}-b`, "Again", "password", { maxlength: "128" }));
      if (k.validator === "litellm_password") {
        const g = el("button", { type: "button", class: "quiet", text: "Generate one" });
        g.addEventListener("click", () => { const p = genPassword(); $(`#${id}-a`, form).value = p; $(`#${id}-b`, form).value = p; $(`#${id}-a`, form).type = "text"; });
        form.append(el("p", { class: "set-gen" }, g));
      }
      collect = () => {
        const a = $(`#${id}-a`, form).value, b = $(`#${id}-b`, form).value;
        if (a !== b) throw new Error("The two passwords differ.");
        return { [k.key]: a };
      };
    } else if (k.key === "AWS_ACCESS_KEY_ID") {
      form.append(...field(`${id}-a`, "New access key ID (AKIA…)", "text", { maxlength: "20", autocapitalize: "characters" }),
        ...field(`${id}-b`, "New secret access key", "password", { maxlength: "40" }),
        el("p", { class: "note", text: "Checked with AWS before anything changes (free), including Bedrock access. Then LiteLLM restarts (about 15 s) and a smoke test runs (~$0.0001); if it fails, the old key comes back. Deactivate the old key in IAM afterwards." }));
      const other = el("input", { type: "checkbox", id: `${id}-other` });
      form.append(el("label", { for: `${id}-other`, class: "set-radio" }, other, " The new key belongs to another AWS account (its models, quotas and bill are its own)"));
      collect = () => ({ AWS_ACCESS_KEY_ID: $(`#${id}-a`, form).value.trim(), AWS_SECRET_ACCESS_KEY: $(`#${id}-b`, form).value.trim() });
      form.dataset.confirm = "";
      other.addEventListener("change", () => { form.dataset.confirm = other.checked ? "other-aws-account" : ""; });
    } else if (k.validator === "budget") {
      form.append(...field(id, "Monthly budget", "text", { inputmode: "decimal", value: v, maxlength: "12" }, "USD a month"));
      const warn = el("p", { class: "note", hidden: "" });
      form.append(warn);
      const check = () => {
        const n = Number($(`#${id}`, form).value.trim()), row = spend && (spend.keys || []).find((x) => x.alias === BUDGET_ALIAS[k.key]);
        let w = "";
        if (row && !row.error && n > 0 && n < row.spend) w = `Below this period's spend (${usd(row.spend)}): requests with this key are refused until the reset.`;
        else if (k.key === "BUDGET_SETUP" && n > 0 && n < 0.05) w = "Setup's model check and smoke test cost up to about $0.05: a lower budget can make ./stack setup and Re-check models fail.";
        warn.textContent = w; warn.hidden = !w;
      };
      $(`#${id}`, form).addEventListener("input", check);
      check();
      collect = () => ({ [k.key]: $(`#${id}`, form).value.trim() });
    } else if (k.validator === "model_pin") {
      const sel = el("select", { id });
      sel.append(el("option", { value: "", text: "automatic (setup picks one)" }));
      for (const [m, name] of data.snapshot.choices.chat_models) {
        if (k.key.startsWith("CLAUDE_MODEL_") && !m.startsWith("claude-")) continue;   // Claude Code speaks Anthropic's API
        const o = el("option", { value: m, text: `${name} (${m})` });
        if (m === v) o.selected = true;
        sel.append(o);
      }
      form.append(el("label", { for: id, text: "Model" }), sel);
      collect = () => ({ [k.key]: sel.value });
    } else if (k.validator === "models_list") {
      const chosen = new Set((v || "").split(",").filter(Boolean));
      const box = el("fieldset", { class: "set-radios" }, el("legend", { text: "Leave out of Chat's model picker" }));
      for (const [m, name] of data.snapshot.choices.chat_models) {
        const cb = el("input", { type: "checkbox", id: `${id}-${m}`, value: m });
        if (chosen.has(m)) cb.checked = true;
        box.append(el("label", { for: `${id}-${m}`, class: "set-radio" }, cb, " ", name));
      }
      form.append(box, el("p", { class: "note", text: "Hidden models stay usable through the API and Claude Code: this only tidies the picker." }));
      collect = () => ({ [k.key]: [...box.querySelectorAll("input:checked")].map((c) => c.value).join(",") });
    } else if (k.validator === "or_key" || k.validator === "stt_key") {
      form.append(...field(id, "New key", "password", { maxlength: "512" }));
      collect = () => ({ [k.key]: $(`#${id}`, form).value.trim() });
      if (k.set) {
        const rm = el("button", { type: "button", class: "quiet", text: "Remove the key" });
        rm.addEventListener("click", () => confirmApply({ [k.key]: "" }, `Remove ${k.label}?`, "OpenRouter's models disappear from Chat and the API; LiteLLM and the portal restart (about 40 s).", [k.key]));
        form.append(el("p", { class: "set-gen" }, rm));
      }
    } else if (k.validator === "webhook") {
      form.append(...field(id, "URL", "url", { maxlength: "2000" }));
      collect = () => {
        const u = $(`#${id}`, form).value.trim();
        if (!u) throw new Error(k.set ? "Enter the new URL, or use Remove the webhook." : "Enter the URL.");
        return { [k.key]: u };
      };
      if (k.set) {
        const rm = el("button", { type: "button", class: "quiet", text: "Remove the webhook" });
        rm.addEventListener("click", () => confirmApply({ [k.key]: "" }, "Remove the budget alert webhook?", "No more alerts are sent; LiteLLM restarts (about 15 s).", [k.key]));
        form.append(el("p", { class: "set-gen" }, rm));
      }
    } else {
      const type = k.validator === "email" ? "email" : "text";
      const unit = { days: "days (1-90; blank = 30)", pct: "% (50-99; blank = 80)", int_1_5000: "models (blank = 1000)" }[k.validator] || "";
      const label = { or_mode: "all, free, paid, or model ids separated by commas" }[k.validator] || "New value";
      form.append(...field(id, label, type, { value: v, maxlength: "2000", ...(unit ? { inputmode: "numeric" } : {}) }, unit));
      // emails in lowercase, as Chat keeps them
      collect = () => ({ [k.key]: k.validator === "email" ? $(`#${id}`, form).value.trim().toLowerCase() : $(`#${id}`, form).value.trim() });
    }
    const err = el("p", { class: "error", role: "alert", hidden: "" });
    const cancel = el("button", { type: "button", class: "quiet", text: "Cancel" });
    const save = el("button", { type: "submit", class: "action primary", text: "Save" });
    form.append(err, el("p", { class: "confirm-buttons" }, cancel, save));
    cancel.addEventListener("click", () => form.remove());
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      let values;
      try { values = collect(); } catch (e) { err.textContent = e.message; err.hidden = false; return; }
      confirmApply(values, `Save ${k.label}?`, k.note, Object.keys(values), form, form.dataset.confirm ? [form.dataset.confirm] : []);
    });
    r.insertBefore(form, r.querySelector(":scope > .set-details"));
    const first = form.querySelector("input, select");
    if (first) first.focus();
  }

  function genPassword() {
    const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "-_.!@%+="];
    const all = sets.join(""), r = new Uint32Array(24);
    crypto.getRandomValues(r);
    const out = sets.map((s, i) => s[r[i] % s.length]);
    for (let i = 4; i < 24; i++) out.push(all[r[i] % all.length]);
    return out.join("");
  }

  // --- voice: provider, model and key in one form ---
  function voiceRow(lr) {
    const pk = keys.STT_PROVIDER, mk = keys.STT_MODEL || {}, kk = keys.STT_API_KEY || {};
    const prov = "value" in pk ? pk.value : "";
    const model = "value" in mk ? mk.value : "";
    const label = STT_LABEL[prov] || prov;
    const now = prov ? `${label}${model ? ` · ${model}` : prov === "bedrock" ? " · voxtral-small" : ""}${kk.set && prov !== "bedrock" ? ` · key ${kk.hint || "set"}` : ""}` : label;
    const r = frame(pk, lr, { value: now });
    const actions = r._actions;
    if (data.here.remote) {
      r.append(el("p", { class: "note set-remote", text: "Change this from the computer running bedrock-now: from your devices it could send your voice elsewhere." }));
      return finish(r, pk, true);
    }
    const b = el("button", { type: "button", class: "action", text: "Change", "aria-describedby": `set-name-${pk.key}` });
    b.disabled = !canChange();
    actions.append(b);
    b.addEventListener("click", () => {
      for (const f of document.querySelectorAll("#settings .set-form")) f.remove();
      const form = el("form", { class: "set-form" });
      const choices = data.snapshot.choices;
      const radios = el("fieldset", { class: "set-radios" }, el("legend", { text: "Provider" }));
      for (const p of ["bedrock", "openai", "groq", ""]) {
        const id = `stt-p-${p || "browser"}`;
        const input = el("input", { type: "radio", name: "stt-provider", id, value: p });
        if (p === prov) input.checked = true;
        if (p === "bedrock" && !choices.stt_bedrock_ready.length) input.disabled = true;
        radios.append(el("label", { for: id, class: "set-radio" }, input, " ", STT_LABEL[p]));
      }
      const msel = el("select", { id: "stt-model" });
      const keyIn = el("input", { id: "stt-key", type: "password", autocomplete: "new-password", maxlength: "512", placeholder: kk.set ? "keep the current key" : "" });
      const keyRow = el("div", { class: "set-sub" }, el("label", { for: "stt-key", text: "API key" }), keyIn);
      const privacy = el("p", { class: "note" });
      const provider = () => form.querySelector("input[name=stt-provider]:checked").value;
      const describe = () => {   // what happens to your speech, and what it costs (docs/voice.md, lib/stt.sh)
        const p = provider();
        privacy.textContent = p === "openai" || p === "groq" ? `Your speech (microphone and calls) goes to ${p === "openai" ? "api.openai.com" : "api.groq.com"}. The key is checked with ${STT_LABEL[p]} first (free).`
          : p === "bedrock" ? `Your speech stays in your AWS account; it counts on Chat's budget (an estimated ${msel.value === "voxtral-mini" ? "~$0.00004" : "~$0.00014"} a minute of speech).`
            : "The browser's own speech recognition; voice calls are unavailable.";
      };
      const sync = () => {
        const p = provider();
        msel.replaceChildren(el("option", { value: "", text: "the provider's default" }));
        for (const m of choices.stt_models[p] || []) {
          const o = el("option", { value: m, text: m });
          if (p === "bedrock" && !choices.stt_bedrock_ready.includes(m)) o.disabled = true;
          if (m === model && p === prov) o.selected = true;
          msel.append(o);
        }
        msel.disabled = !p;
        keyRow.hidden = !(p === "openai" || p === "groq");
        describe();
      };
      radios.addEventListener("change", sync);
      msel.addEventListener("change", describe);
      form.append(radios, el("div", { class: "set-sub" }, el("label", { for: "stt-model", text: "Model" }), msel), keyRow, privacy);
      const err = el("p", { class: "error", role: "alert", hidden: "" });
      const cancel = el("button", { type: "button", class: "quiet", text: "Cancel" });
      form.append(err, el("p", { class: "confirm-buttons" }, cancel, el("button", { type: "submit", class: "action primary", text: "Save" })));
      cancel.addEventListener("click", () => form.remove());
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const p = provider();
        const values = { STT_PROVIDER: p, STT_MODEL: p ? msel.value : "" };
        if (keyIn.value.trim()) values.STT_API_KEY = keyIn.value.trim();
        if (p === "bedrock" || p === "") { if (kk.set) values.STT_API_KEY = ""; }
        confirmApply(values, "Save speech-to-text?", "Chat restarts (about 30 s).", Object.keys(values), form);
      });
      sync();
      r.insertBefore(form, r.querySelector(":scope > .set-details"));
    });
    return finish(r, pk, !canChange());
  }

  // --- the page's own rows ---
  function ownFrame(r, label) {
    const rw = el("div", { class: "set-row", "data-own": r.key, id: `set-row-${r.key.slice(1)}` });
    const main = el("div", { class: "set-main" }, el("div", { class: "set-label" }, el("span", { class: "set-name", id: `set-name-${r.key.slice(1)}`, text: label })),
      el("p", { class: "set-sum", text: r.summary }));
    rw.dataset.findExtra = label;
    const actions = el("div", { class: "set-actions" });
    rw.append(main, actions);
    rw._main = main; rw._actions = actions;
    return rw;
  }

  function sessionDays() { const k = keys.PORTAL_SESSION_DAYS; return k && /^\d+$/.test(k.value || "") ? Number(k.value) : 30; }

  function sessionsRow(r) {
    const rw = ownFrame(r, "Signed-in devices");
    rw._main.append(el("p", { class: "note set-extra", text: `Each stays signed in for ${sessionDays()} days.` }));
    const others = el("button", { type: "button", class: "action", text: "Sign out other devices" });
    others.disabled = !data.here.allowed;
    others.addEventListener("click", () => askPassword({ kind: "signout" }, "Sign out every other device?",
      "Every other browser, phone and installed app signs in again with the portal password. This browser stays signed in.", "Sign them out"));
    const all = el("form", { method: "post", action: "/logout", class: "set-inline" }, el("button", { type: "submit", class: "action", text: "Sign out everywhere" }));
    rw._actions.append(others, all);
    return rw;
  }

  function modelsRow(r) {
    const rw = ownFrame(r, "Models your key can use");
    const link = (place, text) => el("a", { href: `#settings/${place}`, text });
    rw._main.append(
      el("p", { class: "note set-extra" }, "Which model each app uses: ", link("CHAT_DEFAULT_MODEL", "Chat & voice"), " · ",
        link("CLAUDE_MODEL_OPUS", "Claude Code"), ". Which ones Chat's picker lists: ",
        el("a", { href: `${(data.apps && data.apps.chat) || appUrl("chat")}admin/settings/models`, target: "_blank", rel: "noopener", text: "Chat › Admin settings › Models" }), "."),
      el("details", { class: "set-details" }, el("summary", {}, "Details"),
        el("p", { class: "note", text: "Re-checking asks Bedrock which models your key can use (1-token requests, < $0.01; at most once an hour). LiteLLM restarts twice and setup picks the defaults again; about 2 minutes. Hiding a model in Chat's own admin settings does not block it for the API or Claude Code." })));
    rw._actions.append(actionButton("models-recheck", "Re-check models"));
    return rw;
  }

  function fmtBytes(b) { return b == null ? "" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`; }

  function backupRow(r) {
    const rw = ownFrame(r, "Backups");
    const main = rw._main;
    const list = (data.backups && data.backups.backups) || [];
    if (list.length) {
      const KIND = { manual: "yours", auto: "before an update", nightly: "nightly", portal: "Back up now" };
      const tbody = el("tbody");
      for (const b of list.slice().reverse()) {
        tbody.append(el("tr", {}, el("td", { class: "set-bk-name", text: b.name }),
          el("td", { text: KIND[b.kind] || b.kind }), el("td", { class: "set-bk-size", text: fmtBytes(b.bytes) }),
          el("td", { text: b.at ? new Date(b.at * 1000).toLocaleString() : "" }),
          el("td", { text: b.rollback ? "needed for Roll back" : "" })));
      }
      rw.append(el("div", { class: "set-backups" }, el("table", {},
        el("thead", {}, el("tr", {}, ...["Backup", "Kind", "Size", "Made", ""].map((h) => el("th", { scope: "col", text: h })))), tbody)));
    } else {
      main.append(el("p", { class: "note set-extra", text: "No backups yet." }));
    }
    rw.append(el("details", { class: "set-details" }, el("summary", {}, "Details"),
      el("p", { class: "note", text: "A backup holds both databases, every stored file and a copy of .env (backups/<time>-portal/, readable only by you; the newest 5 made here are kept). It takes seconds and no service stops; it is refused when the disk could not hold it twice." }),
      el("p", { class: "note", text: "Restoring stays in the terminal (./stack restore backups/<time>): it replaces every chat, key and file with an older state, so it asks twice and should never be one click away from a browser." })));
    rw._actions.append(actionButton("backup", "Back up now"));
    return rw;
  }

  function actionRow(r) {
    const act = r.key.slice(1);
    const [label, button] = { test: ["Smoke test", "Run smoke test"], "check-aws": ["Check the AWS key", "Check (free)"],
      report: ["Status report", "Create status report"] }[act];
    const rw = ownFrame(r, label);
    rw._actions.append(actionButton(act, button));
    return rw;
  }

  function restartRow(r) {
    const rw = ownFrame(r, "Restart a service");
    rw._main.append(el("p", { class: "note set-extra", text: "The portal and Postgres are not restarted on their own." }));
    const sel = el("select", { id: "set-restart", "aria-label": "Service to restart" });
    for (const s of (data.snapshot.choices.restart || [])) sel.append(el("option", { value: s, text: s }));
    const rb = el("button", { type: "button", class: "action", text: "Restart" });
    rb.disabled = !canChange();
    rb.addEventListener("click", () => openAction(`restart-${sel.value}`));
    rw._actions.append(sel, rb);
    return rw;
  }

  function actionButton(act, label) {
    const b = el("button", { type: "button", class: "action", text: label });
    b.disabled = !canChange() || !(data.helper.diagnostics || []).includes(act);
    b.addEventListener("click", () => openAction(act));
    return b;
  }

  const ACTION_TEXT = {
    "check-aws": ["Check the AWS key?", "Asks AWS who the key belongs to and whether it may call Bedrock (free: no model runs)."],
    "models-recheck": ["Re-check the models?", "About 2 minutes, < $0.01. LiteLLM restarts twice; Chat and Claude Code requests in flight may fail."],
    backup: ["Back up now?", "Databases, stored files and .env into backups/<time>/. No service stops."],
    test: ["Run the smoke test?", "About 10 seconds, ~$0.0001 of Bedrock."],
    report: ["Create a status report?", "Runs read-only ./stack commands on this computer and shows the result here."],
  };
  function openAction(act) {
    const t = ACTION_TEXT[act] || [`Restart ${act.slice(8)}?`, "It is recreated with its current settings (10-30 s); requests in flight fail."];
    askPassword({ kind: "action", action: act }, t[0], t[1], "Go");
  }

  // --- Advanced and About this install: read-only values in a compact list, each with why and how it changes ---
  function listItem(r) {
    const k = keys[r.key];
    if (!k) return null;
    const it = el("div", { class: "set-adv-item", "data-key": k.key, id: `set-row-${k.key}` },
      el("div", { class: "set-adv-head" }, el("span", { class: "set-adv-label", text: k.unknown ? k.key : k.label }),
        el("span", { class: `set-adv-value${plain(k) ? "" : " masked"}`, text: display(k) })),
      el("p", { class: "set-sum", text: r.summary || k.note }),
      el("details", { class: "set-details" }, el("summary", {}, "Details"),
        ...(r.summary && k.note ? [el("p", { class: "note", text: k.note })] : []),
        el("p", { class: "note set-envkey" }, "In .env: ", el("code", { text: k.key })),
        el("p", { class: "set-cli" }, el("span", { class: "note", text: "Changes with: " }), el("code", { class: "set-adv-cli", text: k.cli }), " ", copyButton(k.cli))));
    if (changedFromDefault(k)) it.dataset.changed = "1";
    return it;
  }

  // --- spend under the budgets ---
  function renderSpend() {
    if (!spend) return;
    for (const p of document.querySelectorAll("#settings .set-spend")) {
      const k = (spend.keys || []).find((x) => x.alias === p.dataset.alias);
      if (!k || k.error) { p.textContent = k ? k.error : ""; continue; }
      p.textContent = `${usd(k.spend)} spent this period${k.reset_at ? ` · resets ${day(k.reset_at)}` : ""}`;
    }
  }

  // --- the password dialog (own element: the Home dialog belongs to app.js) ---
  function dialog() {
    let d = $("#set-confirm");
    if (d) return d;
    d = el("dialog", { id: "set-confirm", class: "confirm", "aria-labelledby": "set-confirm-title" });
    const form = el("form", { method: "dialog" },
      el("h2", { id: "set-confirm-title" }), el("p", { id: "set-confirm-text" }), el("ul", { id: "set-confirm-keys", class: "set-keys" }),
      el("label", { for: "set-confirm-password", text: "Portal password" }),
      el("input", { id: "set-confirm-password", type: "password", autocomplete: "current-password", required: "" }),
      el("p", { id: "set-confirm-error", class: "error", role: "alert", hidden: "" }),
      el("p", { class: "confirm-buttons" }, el("button", { type: "button", class: "quiet", id: "set-confirm-cancel", text: "Cancel" }),
        el("button", { type: "submit", class: "action primary", id: "set-confirm-ok", text: "Confirm" })));
    d.append(form);
    document.body.append(d);
    form.addEventListener("submit", submit);
    $("#set-confirm-cancel").addEventListener("click", () => {
      const p = pending;
      $("#set-confirm-password").value = ""; pending = null; d.close();
      if (data && p && p.kind === "apply" && !p.form) render();   // a switch or a select goes back to the saved value
    });
    return d;
  }

  function askPassword(what, title, text, ok, keyNames) {
    pending = what;
    const d = dialog();
    $("#set-confirm-title").textContent = title;
    $("#set-confirm-text").textContent = text || "";
    const ul = $("#set-confirm-keys"); ul.replaceChildren(...(keyNames || []).map((n) => el("li", {}, el("code", { text: n }))));
    ul.hidden = !(keyNames && keyNames.length);
    $("#set-confirm-error").hidden = true;
    $("#set-confirm-password").value = "";
    $("#set-confirm-ok").textContent = ok;
    d.showModal();
    $("#set-confirm-password").focus();
  }

  function confirmApply(values, title, note, keyNames, form, confirm = []) {
    askPassword({ kind: "apply", values, form, confirm, keys: keyNames, label: title.replace(/^Save |\?$/g, "") }, title,
      `${note || ""} Applied on this computer by the update helper, which checks it again first.`, "Save", keyNames);
  }

  async function post(path, body) {
    const r = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { ...API_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { location.assign("/login"); throw new Error("signed out"); }
    return [r, d];
  }

  async function submit(ev) {
    ev.preventDefault();
    const pw = $("#set-confirm-password").value, what = pending;
    if (!pw || !what) return;
    const ok = $("#set-confirm-ok"), err = $("#set-confirm-error");
    ok.disabled = true;
    try {
      let r, d;
      if (what.kind === "apply") [r, d] = await post("/api/settings/apply", { password: pw, base: data.snapshot.base, set: what.values, regen: what.regen || [], confirm: what.confirm || [] });
      else if (what.kind === "reveal") [r, d] = await post("/api/settings/reveal", { password: pw, key: what.key });
      else if (what.kind === "action") [r, d] = await post("/api/settings/action", { password: pw, action: what.action });
      else [r, d] = await post("/api/settings/signout-others", { password: pw });
      if (r.status === 400 && d.fields && what.form) {
        closeDialog();
        showFieldErrors(what.form, d.fields);
        return;
      }
      if (!r.ok) {
        err.textContent = d.fields ? `${d.error} ${Object.entries(d.fields).map(([k, m]) => `${k} ${m}`).join("; ")}` : (d.error || `HTTP ${r.status}`);
        err.hidden = false;
        return;
      }
      closeDialog();
      if (what.kind === "reveal") { showRevealed(what.key, d.value, what.show); return; }
      if (what.kind === "signout") { toast("Every other device is signed out"); return; }
      if (what.form) what.form.remove();
      const label = what.kind === "action" ? what.action : "settings";
      watch({ id: d.id, kind: label, keys: d.keys, password: Boolean(what.values && "PORTAL_PASSWORD" in what.values), at: Date.now() });
      toast("Sent to the update helper");
    } catch (e) {
      if (e.message === "signed out") return;
      err.textContent = `Could not reach the portal (${e.message}).`; err.hidden = false;
    } finally {
      ok.disabled = false;
    }
  }

  function closeDialog() { $("#set-confirm-password").value = ""; pending = null; $("#set-confirm").close(); }

  function showFieldErrors(form, fields) {
    const e = form.querySelector(".error");
    e.textContent = Object.entries(fields).map(([k, m]) => `${(keys[k] && keys[k].label) || k} ${m}.`).join(" ");
    e.hidden = false;
  }

  function showRevealed(key, value, show) {
    copy(value, key);
    const r = document.querySelector(`#settings .set-row[data-key="${key}"]`);
    if (show && r) {
      const v = r.querySelector(".set-value");
      if (!v) return;
      v.textContent = value; v.classList.remove("masked"); v.classList.add("revealed");
      setTimeout(() => { if (data) render(); }, 30000);   // shown for 30 s
    }
  }

  // --- progress of a change or a diagnostic (the helper's status file, across portal restarts) ---
  function jobBox() {
    return el("section", { class: "job set-job", id: "set-job", "aria-live": "polite", hidden: "" },
      el("div", { class: "job-head" }, el("h2", { id: "set-job-title" }), el("button", { type: "button", class: "quiet", id: "set-job-dismiss", text: "Dismiss" })),
      el("ol", { class: "job-steps", id: "set-job-steps" }), el("p", { class: "job-message", id: "set-job-message" }), el("p", { class: "note", id: "set-job-note" }));
  }

  const STEPS = [["checking", "Check"], ["applying", "Save"], ["restarting", "Restart"], ["verifying", "Verify"], ["done", "Done"]];
  function watch(w) {
    watching = w;
    renderJob();
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, 1500);
  }

  async function poll() {
    clearTimeout(pollTimer);
    let a;
    try {
      a = await api("/api/admin/status");
      reconnecting = false;
    } catch (e) {
      if (e.message === "signed out") return;
      reconnecting = true; renderJob();
      pollTimer = setTimeout(poll, 2000);
      return;
    }
    const job = a.job;
    const mine = Boolean(job && watching && watching.id && job.id === watching.id);   // the helper names each job after its request
    if (watching) watching.job = mine ? job : watching.job;
    const finished = mine && (job.phase === "done" || job.phase === "failed");
    renderJob();
    if (watching && !finished && Date.now() - watching.at < 15 * 60000) { pollTimer = setTimeout(poll, 2000); return; }
    if (finished) {
      if (job.action === "report" && job.phase === "done") showReport();
      await load();
    }
  }

  function renderJob() {
    const box = $("#set-job");
    if (!box) return;
    const w = watching;
    box.hidden = !w;
    if (!w) return;
    const job = w.job || { phase: "queued", message: "Waiting for the update helper…" };
    const settingsJob = w.kind === "settings";
    $("#set-job-title").textContent = settingsJob ? `Settings change${job.phase === "failed" ? " failed" : job.phase === "done" ? " saved" : ""}`
      : { "check-aws": "AWS key check", "models-recheck": "Model check", backup: "Backup", test: "Smoke test", report: "Status report" }[w.kind] || `Restart of ${String(w.kind).slice(8)}`;
    const steps = $("#set-job-steps"); steps.replaceChildren();
    steps.hidden = !settingsJob;
    if (settingsJob) {
      const at = STEPS.findIndex(([p]) => p === job.phase);
      STEPS.forEach(([p, label], i) => {
        const state = job.phase === "failed" ? "" : i < at || job.phase === "done" ? "ok" : i === at ? "now" : "";
        steps.append(el("li", { class: state, text: label }));
      });
    }
    const msg = $("#set-job-message");
    msg.textContent = job.message || "";
    msg.className = `job-message ${job.phase === "failed" ? "bad" : job.phase === "done" ? "good" : ""}`;
    let note = "";
    if (reconnecting) note = "The portal is restarting as part of the change — reconnecting…";
    else if (job.phase === "done" && w.password) note = "This browser stays signed in; every other browser and device signs in again with the new password.";
    else if (!w.job && Date.now() - w.at > 60000) note = "The update helper has not picked this up yet: is it still running? (./stack helper status)";
    else if (job.phase !== "done" && job.phase !== "failed") note = "You can leave this page; the change is carried out on your computer.";
    $("#set-job-note").textContent = note;
    $("#set-job-dismiss").hidden = !(job.phase === "done" || job.phase === "failed");
    $("#set-job-dismiss").onclick = () => { watching = null; renderJob(); };
  }

  async function showReport() {
    try {
      const r = await api("/api/settings/report");
      const box = $("#set-report");
      if (!box || !r.text) return;
      const pre = el("pre", { class: "set-report-text", text: r.text });
      const b = el("button", { type: "button", class: "copy", text: "Copy the report" });
      b.addEventListener("click", () => copy(r.text, "the report"));
      box.replaceChildren(el("p", { class: "cmdline" }, b), pre);
      box.hidden = false;
      box.scrollIntoView({ block: "nearest" });
    } catch (_) { /* the job message says it is ready; ./stack config report prints it too */ }
  }

  // --- Home: "Settings changed: … at …" for a day ---
  function renderNotice() {
    const home = $("#home");
    if (!home || !data || !data.snapshot) return;
    let n = $("#settings-notice");
    const lc = data.snapshot.last_change;
    const at = lc && Date.parse(lc.at);
    const recent = lc && lc.result === "ok" && at && Date.now() - at < 86400000;
    if (!recent) { if (n) n.hidden = true; return; }
    if (!n) {
      n = el("p", { id: "settings-notice", class: "banner settings-notice", role: "status" });
      home.querySelector(".home-head").after(n);
    }
    const names = lc.keys.map((k) => (keys[k] && keys[k].label) || k);
    const first = lc.keys.find((k) => rowOf[k]);
    n.replaceChildren(`Settings changed: ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` and ${names.length - 4} more` : ""} at ${new Date(at).toLocaleString()}${lc.via === "cli" ? " (in a terminal)" : lc.via === "portal-remote" ? " (from a remote device)" : ""}. `,
      el("a", { href: first ? `#settings/${first}` : "#settings", text: "Settings" }));
    n.hidden = false;
  }

  // the place in the address (#settings/<section>[/<KEY>]) once the page is drawn
  function placeFromAddress() {
    const m = /^#settings\/(.+)$/.exec(location.hash);
    if (m) { try { goTo(decodeURIComponent(m[1])); } catch (_) { goTo(m[1]); } }
  }

  document.addEventListener("bn:tab", (e) => {
    if (e.detail === "settings") load().then(placeFromAddress);
    else if (e.detail === "home" && data) renderNotice();
  });
  document.addEventListener("DOMContentLoaded", () => {
    // the More sheet on phones: Settings is a page of the portal, not a new tab
    for (const b of document.querySelectorAll(".sheet-link[data-page]")) {
      b.removeAttribute("href");
      b.addEventListener("click", () => showTab(b.dataset.page));
    }
    if (!data) load().then(() => { if (location.hash.startsWith("#settings/")) placeFromAddress(); });
  });
})();
