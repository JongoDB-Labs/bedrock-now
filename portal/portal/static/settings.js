// Settings: every .env value (secrets masked), changed through the update helper (/api/settings/*).
// Loaded after app.js (el, $, api, toast, copy, usd, day, showTab, appUrl come from there). DOM built with el() and
// textContent only; nothing from the API is ever parsed as HTML. Every change asks for the portal password again.
"use strict";

(() => {
  const GROUPS = [
    ["account", "Account & security", "Sign-ins and sessions."],
    ["aws", "AWS & models", "The AWS key LiteLLM calls Bedrock with, and which models are used."],
    ["budgets", "Budgets & alerts", "Monthly budgets of the three LiteLLM keys. A change takes effect at once, without a restart."],
    ["voice", "Voice", "Speech-to-text for Chat's microphone and voice calls."],
    ["openrouter", "OpenRouter", "Optional: hundreds of other models next to Bedrock. Prompts to them go to openrouter.ai."],
    ["files", "Files", "The file store (RustFS) and the shared file server Claude Code uses."],
    ["code", "Code page", "Claude Code in the browser: the Code tab, with a chat, permission prompts and your workspace's files. It runs in the browser terminal's sandbox."],
    ["updates", "Updates & backups", "Release checks, automatic updates and backups."],
    ["remote", "Remote access", "The portal from your phone or laptop over Tailscale (docs/remote.md)."],
    ["diagnostics", "Diagnostics", "Checks and restarts, carried out on this computer by the update helper."],
    ["advanced", "Advanced", "Every other setting, read-only here: why, and the command that changes it."],
  ];
  const CARD_KEYS = {
    account: ["PORTAL_PASSWORD", "OPENWEBUI_ADMIN_EMAIL", "LITELLM_UI_USER", "LITELLM_UI_PASSWORD", "PORTAL_SESSION_DAYS",
      "LITELLM_STORE_PROMPTS"],
    aws: ["AWS_ACCESS_KEY_ID", "AWS_REGION_NAME", "AWS_AUTH", "CHAT_DEFAULT_MODEL", "CHAT_TASK_MODEL", "CLAUDE_MODEL_OPUS",
      "CLAUDE_MODEL_SONNET", "CLAUDE_MODEL_HAIKU", "MODELS_HIDDEN"],
    budgets: ["BUDGET_CLAUDE_CODE", "BUDGET_OPENWEBUI", "BUDGET_SETUP", "BUDGET_ALERT_PCT", "ALERT_WEBHOOK_URL"],
    voice: ["STT_PROVIDER"],
    openrouter: ["OPENROUTER_API_KEY", "OPENROUTER_MODELS", "OPENROUTER_MAX_MODELS", "OPENROUTER_INCLUDE_ALIASES"],
    files: ["RUSTFS_ACCESS_KEY", "RUSTFS_SECRET_KEY", "SHARED_MCP_TOKEN"],
    code: ["CODE_ENABLED", "CODE_ALLOW_BYPASS", "CODE_AUTO_MODE", "TERMINAL_AUTO_MODE"],
    updates: ["UPDATE_CHECK", "PRICE_UPDATES", "AUTO_UPDATE", "UPDATE_REQUIRE_SIGNED_TAGS", "BACKUP_NIGHTLY"],
    remote: ["REMOTE_MODE", "REMOTE_ADMIN_ACTIONS", "TAILSCALE_ALLOWED_LOGIN", "REMOTE_PREVIEW"],
  };
  // shown with another key's row (a pair, or a part of a larger form)
  const WITH = { AWS_SECRET_ACCESS_KEY: "AWS_ACCESS_KEY_ID", STT_API_KEY: "STT_PROVIDER", STT_MODEL: "STT_PROVIDER",
    AUTO_UPDATE_HOUR: "AUTO_UPDATE", PORTAL_PASSWORD_HASH: "PORTAL_PASSWORD", BACKUP_HOUR: "BACKUP_NIGHTLY",
    BACKUP_KEEP: "BACKUP_NIGHTLY", OWUI_DEFAULT_MODEL: "CHAT_DEFAULT_MODEL", OWUI_TASK_MODEL: "CHAT_TASK_MODEL",
    CLAUDE_BEDROCK_OPUS_MODEL: "CLAUDE_MODEL_OPUS", CLAUDE_BEDROCK_SONNET_MODEL: "CLAUDE_MODEL_SONNET",
    CLAUDE_BEDROCK_HAIKU_MODEL: "CLAUDE_MODEL_HAIKU" };
  // a pin and the setting setup derives from it (shown in the pin's row)
  const PIN_OF = { CHAT_DEFAULT_MODEL: "OWUI_DEFAULT_MODEL", CHAT_TASK_MODEL: "OWUI_TASK_MODEL", CLAUDE_MODEL_OPUS: "CLAUDE_BEDROCK_OPUS_MODEL",
    CLAUDE_MODEL_SONNET: "CLAUDE_BEDROCK_SONNET_MODEL", CLAUDE_MODEL_HAIKU: "CLAUDE_BEDROCK_HAIKU_MODEL" };
  const BUDGET_KEY = { BUDGET_CLAUDE_CODE: ["claude-code", "LITELLM_KEY_CLAUDE_CODE"], BUDGET_OPENWEBUI: ["open-webui", "LITELLM_KEY_OPENWEBUI"],
    BUDGET_SETUP: ["setup", "LITELLM_KEY_SETUP"] };
  const REVEALABLE = new Set(["LITELLM_UI_PASSWORD", "RUSTFS_ACCESS_KEY", "RUSTFS_SECRET_KEY", "LITELLM_KEY_CLAUDE_CODE",
    "LITELLM_KEY_OPENWEBUI", "LITELLM_KEY_SETUP", "SHARED_MCP_TOKEN"]);
  const DIAG_PHASES = ["check-aws", "models-recheck", "backup", "test", "report"];
  const STT_LABEL = { bedrock: "Bedrock (Mistral Voxtral, in your AWS account)", openai: "OpenAI", groq: "Groq", "": "Browser speech recognition (no voice calls)" };

  let data = null;          // GET /api/settings
  let spend = null;         // /api/summary's spend (budget rows)
  let keys = {};            // KEY -> snapshot row
  let pending = null;       // {kind: "apply"|"reveal"|"action"|"signout", ...} waiting for the password
  let watching = null;      // {id, kind, label, keys, at} a request the helper has not finished
  let pollTimer = null;
  let reconnecting = false;
  // the page's search box and "Changed from default" (P-5): kept across a re-render
  const find = { q: "", changed: false };

  const page = () => $("#settings");
  const hasHelper = () => Boolean(data && data.helper.running && data.helper.settings);
  const canChange = () => hasHelper() && data.here.allowed;
  const pad2 = (n) => String(n).padStart(2, "0");

  // --- data ---
  async function load() {
    try {
      data = await api("/api/settings");
    } catch (e) {
      if (e.message === "signed out") return;
      showError(`Could not load the settings (${e.message}). ./stack status shows what is running.`);
      return;
    }
    keys = {};
    for (const k of (data.snapshot && data.snapshot.keys) || []) keys[k.key] = k;
    render();
    renderNotice();
    const j = data.helper.job;   // a change or diagnostic still running (updates show on Home)
    if (data.helper.in_progress && j && !watching && (j.action === "settings" || DIAG_PHASES.includes(j.action) || /^restart-/.test(j.action))) {
      watch({ id: j.id, kind: j.action, at: Date.now() - 60000 });
    }
    // this month's spend per key (next to the budgets): only while Settings is shown (the Home notice needs none)
    if (page() && !page().hidden) try { spend = (await api("/api/summary")).spend; renderSpend(); } catch (_) { /* budgets still show */ }
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
    const when = data.snapshot && data.snapshot.written_at ? new Date(data.snapshot.written_at * 1000).toLocaleString() : "";
    p.append(el("header", { class: "home-head set-head" },
      el("h1", { id: "settings-title", text: "Settings" }),
      el("p", { class: "updated" }, when ? `From .env as of ${when} ` : "", el("button", { type: "button", class: "quiet", id: "set-reload", text: "Reload" }))));
    $("#set-reload", p).addEventListener("click", load);
    if (!data.available) {
      p.append(el("p", { class: "banner", text: "Settings are not available yet: run ./stack up once (it writes .state/status/settings.json, the masked copy of .env this page shows)." }));
      return;
    }
    p.append(helperBox(), jobBox());
    const nav = el("nav", { class: "chips set-nav", "aria-label": "Settings sections" });
    for (const [g, title] of GROUPS) {
      const b = el("button", { type: "button", class: "chip", text: title });
      b.addEventListener("click", () => { const c = $(`#set-${g}`, p); if (c) c.scrollIntoView({ block: "start", behavior: "smooth" }); });
      nav.append(b);
    }
    p.append(nav, findBar());
    const cards = el("div", { class: "set-cards" });
    for (const [g, title, lede] of GROUPS) cards.append(card(g, title, lede));
    p.append(cards);
    renderSpend();
    renderJob();
    applyFind();
    p.scrollTop = scrollY;
  }

  // --- search and "Changed from default": rows (and the Advanced list's items) that do not match are hidden, and so is
  // a card left without any (its title matching the search keeps it whole). Plain substring matching, any case.
  function changedFromDefault(k) {
    if (!k || !("value" in k) || !("default" in k) || !(k.secret === "-" || k.secret === "s")) return false;
    const v = String(k.value).trim();
    return v !== "" && v !== String(k.default).trim();
  }
  function findBar() {
    const input = el("input", { type: "search", id: "set-find", class: "set-find-input", placeholder: "Search settings", "aria-label": "Search settings",
      maxlength: "100", value: find.q });
    input.value = find.q;
    input.addEventListener("input", () => { find.q = input.value.slice(0, 100); applyFind(); });
    const chip = el("button", { type: "button", class: "chip", id: "set-changed", "aria-pressed": String(find.changed), text: "Changed from default" });
    chip.addEventListener("click", () => { find.changed = !find.changed; chip.setAttribute("aria-pressed", String(find.changed)); applyFind(); });
    const known = Object.values(keys).some((k) => "default" in k);
    return el("div", { class: "set-find" }, input, chip,
      el("span", { class: "note set-find-note", id: "set-find-note", text: known ? "" : "Defaults are not known yet: ./stack up writes them." }));
  }
  function applyFind() {
    const p = page();
    if (!p) return;
    const q = find.q.trim().toLowerCase();
    p.classList.toggle("set-finding", Boolean(q) || find.changed);
    let shownRows = 0;
    for (const c of p.querySelectorAll(".set-card")) {
      const title = ($("h2", c) || {}).textContent || "";
      const whole = Boolean(q) && title.toLowerCase().includes(q) && !find.changed;
      let left = 0;
      for (const r of c.querySelectorAll(".set-row[data-key], .set-adv-item")) {
        const key = r.dataset.key || (r.querySelector("code") || {}).textContent || "";
        const okChanged = !find.changed || changedFromDefault(keys[key]);
        const okText = !q || whole || r.textContent.toLowerCase().includes(q);
        r.hidden = !(okChanged && okText);
        if (!r.hidden) left++;
      }
      // cards without rows of their own (Diagnostics, the voice and backup forms) show only for their title
      const rowsHere = c.querySelectorAll(".set-row[data-key], .set-adv-item").length;
      c.hidden = (Boolean(q) || find.changed) && !(left > 0 || (whole && !rowsHere));
      if (!c.hidden) shownRows += left;
    }
    const note = $("#set-find-note", p);
    if (note && Object.values(keys).some((k) => "default" in k)) {
      note.textContent = (q || find.changed) ? (shownRows ? `${shownRows} setting${shownRows === 1 ? "" : "s"}` : "No setting matches.") : "";
    }
  }

  function helperBox() {
    const box = el("div", { class: "set-helper" });
    if (!data.here.allowed) {
      box.append(el("p", { class: "helper-off-title", text: "Changes are off for remote access" }),
        el("p", { class: "note", text: "Settings, Reveal and Diagnostics work from the computer running bedrock-now. To use them from your devices too, set REMOTE_ADMIN_ACTIONS=true there (Remote access below)." }));
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

  function card(g, title, lede) {
    const c = el("section", { class: "set-card", id: `set-${g}`, "aria-labelledby": `set-${g}-title` },
      el("h2", { id: `set-${g}-title`, text: title }), el("p", { class: "note set-lede", text: lede }));
    const body = el("div", { class: "set-rows" });
    c.append(body);
    if (g === "advanced") { advanced(body); return c; }
    if (g === "diagnostics") { diagnostics(body); return c; }
    if (g === "voice") { voiceRow(body); return c; }
    if (g === "code") { codeRow(body); return c; }
    for (const k of CARD_KEYS[g] || []) {
      if (!keys[k]) continue;
      if (k === "TAILSCALE_ALLOWED_LOGIN" && !(data.remote && data.remote.on)) continue;
      body.append(row(keys[k]));
    }
    if (g === "account") body.append(sessionsRow());
    if (g === "aws") body.append(modelsRow());
    if (g === "updates") body.append(backupRow());
    if (g === "remote") body.prepend(remoteStatus());
    return c;
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
  const ON_VALUES = ["true", "1", "yes", "on"], OFF_VALUES = ["false", "0", "no", "off"];
  const lower = (x) => String(x || "").trim().toLowerCase();
  function remotePreviewOn() { return Boolean(keys.REMOTE_PREVIEW_HOST && keys.REMOTE_PREVIEW_HOST.value); }
  function remotePreviewMayBeOn(v) {
    if (ON_VALUES.includes(lower(v))) return true;
    if (OFF_VALUES.includes(lower(v))) return false;
    return Boolean(keys.REMOTE_MODE && keys.REMOTE_MODE.value === "domain" && keys.REMOTE_PREVIEW_DOMAIN && keys.REMOTE_PREVIEW_DOMAIN.value);
  }
  function display(k) {
    const v = shown(k);
    if (k.key === "REMOTE_PREVIEW") return remotePreviewOn() ? "On" : "Off";
    if (k.validator === "bool" || k.validator === "true_blank") return v === "true" ? "On" : "Off";
    if (k.validator === "on_off") return v === "on" ? "On" : "Off";
    if (k.secret === "S") return k.set ? "••••••••" : "not set";
    return v;
  }

  function editable(k) { return ["edit", "local", "on-only", "widen-local"].includes(k.policy); }
  // lib/settings.sh setting_weakens: the less protective direction of a widen-local key
  function weakens(k, v) {
    const old = "value" in k ? k.value : "";
    const n = (x, lo, hi, d) => (/^\d{1,3}$/.test(x || "") && Number(x) >= lo && Number(x) <= hi ? Number(x) : d);   // _eff_int
    const usd = (x) => (/^(\d*\.?\d+|\d+\.)$/.test(x || "") ? Number(x) : { BUDGET_CLAUDE_CODE: 200, BUDGET_OPENWEBUI: 50 }[k.key] || 5);
    if (k.key === "BACKUP_KEEP") return n(v, 1, 60, 7) < n(old, 1, 60, 7);
    if (k.key === "PORTAL_SESSION_DAYS") return n(v, 1, 90, 30) > n(old, 1, 90, 30);
    if (k.key === "BUDGET_ALERT_PCT") return n(v, 50, 99, 80) > n(old, 50, 99, 80);
    if (/^BUDGET_(CLAUDE_CODE|OPENWEBUI|SETUP)$/.test(k.key)) return usd(v) > usd(old);
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

  function cliLine(k) {
    const cmd = k.cli || `./stack config set ${k.key}`;
    const b = el("button", { type: "button", class: "copy", text: "Copy" });
    b.addEventListener("click", () => copy(cmd.replace(/\s+\(.*\)$/, ""), "the command"));
    return el("p", { class: "set-cli" }, el("span", { class: "note", text: editable(k) ? "In a terminal: " : "Read-only here: " }), el("code", { text: cmd }), " ", b);
  }

  function row(k) {
    const r = el("div", { class: "set-row", "data-key": k.key });
    if (changedFromDefault(k)) {
      r.dataset.changed = "1";
      r.title = `Changed from the default (${String(k.default).trim() === "" ? "blank" : k.default})`;
    }
    const main = el("div", { class: "set-main" },
      el("div", { class: "set-label" }, el("span", { text: k.label }), el("code", { class: "set-key", text: k.key })),
      el("div", { class: `set-value${k.secret !== "-" && k.secret !== "s" ? " masked" : ""}`, text: display(k) }),
      el("p", { class: "note set-note", text: k.note }));
    const actions = el("div", { class: "set-actions" });
    r.append(main, actions);
    if (BUDGET_KEY[k.key]) main.append(el("p", { class: "set-spend note", "data-alias": BUDGET_KEY[k.key][0] }));
    if (k.key === "AWS_ACCESS_KEY_ID" && keys.AWS_AUTH && shown(keys.AWS_AUTH) === "instance-role") {
      main.querySelector(".set-value").textContent = "this computer's IAM role (no key in .env)";
    }
    // reveal / copy for what the portal holds anyway
    if (REVEALABLE.has(k.key) && k.set) actions.append(revealButton(k.key, "Reveal"));
    if (BUDGET_KEY[k.key] && keys[BUDGET_KEY[k.key][1]] && keys[BUDGET_KEY[k.key][1]].set) actions.append(revealButton(BUDGET_KEY[k.key][1], "Copy key"));
    if (k.key === "AWS_ACCESS_KEY_ID") actions.append(actionButton("check-aws", "Check (free)"));
    if (PIN_OF[k.key]) {
      const d = keys[PIN_OF[k.key]];
      main.querySelector(".set-value").textContent = shown(k) === "blank" || !k.set ? `automatic: ${modelName(d ? shown(d) : "")}` : `pinned: ${modelName(shown(k))}`;
    }
    if (k.key === "REMOTE_PREVIEW" && ON_VALUES.includes(lower(k.value)) && !remotePreviewOn()) {
      main.append(el("p", { class: "note", text: "Switched on, not in effect: the Code page is not reachable over remote access (REMOTE_TERMINAL=true), or remote access has no names yet (./stack up)." }));
    }
    if (k.key === "MODELS_HIDDEN") main.querySelector(".set-value").textContent = k.value ? k.value.split(",").map(modelName).join(", ") : "none";
    if (k.policy === "regen") {
      const b = el("button", { type: "button", class: "action", text: "Regenerate" });
      b.disabled = !canChange();
      b.addEventListener("click", () => askPassword({ kind: "apply", values: {}, regen: [k.key], keys: [k.key] },
        `Regenerate ${k.key === "SHARED_MCP_TOKEN" ? "the MCP token" : "the Files key pair"}?`, k.note, "Regenerate",
        k.key === "SHARED_MCP_TOKEN" ? ["SHARED_MCP_TOKEN"] : ["RUSTFS_ACCESS_KEY", "RUSTFS_SECRET_KEY"]));
      actions.append(b);
      if (!canChange()) r.append(cliLine(k));
      return r;
    }
    if (!editable(k)) { r.append(cliLine(k)); return r; }
    if (localOnlyHere(k, "true") && k.policy === "local") {
      r.append(el("p", { class: "note set-remote", text: "Change this from the computer running bedrock-now: from your devices it could send your data elsewhere." }));
      r.append(cliLine(k));
      return r;
    }
    const v = shown(k);
    if (["bool", "on_off", "true_blank"].includes(k.validator)) {
      actions.append(toggle(k, v));
      if (k.key === "AUTO_UPDATE" && keys.AUTO_UPDATE_HOUR) actions.append(hourSelect(keys.AUTO_UPDATE_HOUR, 3, "Change the nightly window?"));
      if (k.key === "BACKUP_NIGHTLY") {
        if (keys.BACKUP_HOUR) actions.append(hourSelect(keys.BACKUP_HOUR, 2, "Change the nightly backup window?"));
        if (keys.BACKUP_KEEP) actions.append(keepSelect(keys.BACKUP_KEEP));
      }
    } else {
      const b = el("button", { type: "button", class: "action", text: k.set || ("value" in k && k.value) ? "Change" : "Set" });
      b.disabled = !canChange();
      b.addEventListener("click", () => openForm(r, k));
      actions.append(b);
    }
    if (!canChange()) r.append(cliLine(k));
    return r;
  }

  function toggle(k, v) {
    const on = k.validator === "on_off" ? "on" : "true", off = k.validator === "on_off" ? "off" : (k.validator === "true_blank" ? "" : "false");
    const cur = k.key === "REMOTE_PREVIEW" ? (remotePreviewOn() ? on : off) : v === on ? on : off;
    const g = el("div", { class: "chips", role: "group", "aria-label": k.label });
    for (const [val, label] of [[off, "Off"], [on, "On"]]) {
      const b = el("button", { type: "button", class: "chip", "aria-pressed": String(val === cur), text: label });
      b.disabled = !canChange() || (val !== cur && ((k.policy === "on-only" && val !== on) || localOnlyHere(k, val)));
      const what = k.key === "CODE_ENABLED" ? codeSwitch(val) : k.note;
      b.addEventListener("click", () => { if (val !== cur) confirmApply({ [k.key]: val }, `${k.label}: ${label}`, what, [k.key]); });
      g.append(b);
    }
    const wrap = el("div", { class: "set-toggle" }, g);
    if (k.policy === "on-only" && cur === on) wrap.append(el("span", { class: "note", text: "Turning it off is a terminal step." }));
    const other = cur === on ? off : on;
    if (k.policy === "widen-local" && data.here.remote && weakens(k, other)) {
      wrap.append(el("span", { class: "note", text: `${other === on ? "On" : "Off"} only from the computer running bedrock-now.` }));
    }
    return wrap;
  }

  // --- the Code page (./stack code enable | disable, run by the update helper) ---
  function codeSwitch(val) {
    if (val !== "true") return "The helper runs ./stack code disable: the code container goes; the terminal (and its tmux session), its folder and Claude Code's history stay.";
    const ws = codeFolder() || "the default folder";
    return terminalOn()
      ? `The helper runs ./stack code enable: it builds the Code page's image (a few minutes the first time) and restarts the portal and Caddy; the terminal keeps running. Claude sees the terminal's folder ${ws}.`
      : `The helper runs ./stack code enable: it turns the browser terminal on too, with the folder ${ws} as its workspace (created if it is not there; Claude sees only that folder), then builds the Code page's image (a few minutes the first time) and restarts the portal and Caddy.`;
  }
  function codeRow(body) {
    const k = keys.CODE_ENABLED;
    if (!k) return;
    const r = row(k);
    const main = r.querySelector(".set-main");
    const ws = codeFolder();
    const egress = !(keys.TERMINAL_EGRESS && keys.TERMINAL_EGRESS.value === "off");
    main.append(el("p", { class: "set-code-ws" }, el("span", { class: "note", text: "Workspace (read-only here): " }),
      el("code", { text: ws || (terminalOn() ? "the terminal's" : "the default folder") })));
    if (terminalOn()) {
      main.append(el("p", { class: "note", text: `Claude sees only that folder (at /workspace), uses the terminal's key and budget, and ${egress ? "can reach the internet (TERMINAL_EGRESS=off in .env turns that off)" : "has no internet (TERMINAL_EGRESS=off)"}.` }));
    } else if (shown(k) !== "true") {
      main.append(el("p", { class: "note", text: "The browser terminal is off: turning this on turns it on too, with the folder above as its workspace (Claude sees only that folder, at /workspace). Another folder: in a terminal, with the command below." }));
    }
    const cmd = terminalOn() ? "./stack terminal enable --workspace DIR" : "./stack code enable --workspace DIR";
    const b = el("button", { type: "button", class: "copy", text: "Copy" });
    b.addEventListener("click", () => copy(cmd, "the command"));
    r.append(el("p", { class: "set-cli" }, el("span", { class: "note", text: terminalOn() ? "Another folder, in a terminal: " : "In a terminal: " }), el("code", { text: cmd }), " ", b));
    body.append(r);
    // Bypass permissions in the Code page's mode picker: on only from this computer (widen-local), off from anywhere
    if (keys.CODE_ALLOW_BYPASS) body.append(row(keys.CODE_ALLOW_BYPASS));
    // Auto mode (a reviewer model instead of you) in the Code page, and in the terminal: the same rule
    if (keys.CODE_AUTO_MODE) body.append(row(keys.CODE_AUTO_MODE));
    if (keys.TERMINAL_AUTO_MODE) body.append(row(keys.TERMINAL_AUTO_MODE));
  }

  function modelName(id) {
    const m = ((data.snapshot && data.snapshot.choices.chat_models) || []).find((x) => x[0] === id);
    return m ? m[1] : id || "none";
  }

  function keepSelect(kk) {
    const cur = "value" in kk && /^\d+$/.test(kk.value) ? Number(kk.value) : 7;
    const sel = el("select", { "aria-label": "Nightly backups kept" });
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
    const sel = el("select", { "aria-label": "Nightly window (this computer's time)" });
    for (let h = 0; h < 24; h++) {
      const o = el("option", { value: String(h), text: `${pad2(h)}:00–${pad2((h + 3) % 24)}:00` });
      if (h === cur) o.selected = true;
      sel.append(o);
    }
    sel.disabled = !canChange();
    sel.addEventListener("change", () => confirmApply({ [hk.key]: sel.value }, title, hk.note, [hk.key]));
    return sel;
  }

  function revealButton(key, label) {
    const b = el("button", { type: "button", class: "copy", text: label });
    b.disabled = !data.here.allowed;
    b.addEventListener("click", () => askPassword({ kind: "reveal", key },
      "Show and copy?", `${key} goes on your clipboard${label === "Reveal" ? " and shows here" : ""}. The portal already holds this value; nothing else can be revealed.`, "Copy"));
    return b;
  }

  // --- forms ---
  function field(id, label, type, attrs = {}) {
    const input = el("input", { id, type, autocomplete: type === "password" ? "new-password" : "off", spellcheck: "false", ...attrs });
    return [el("label", { for: id, text: label }), input];
  }

  function openForm(r, k) {
    for (const f of document.querySelectorAll("#settings .set-form")) f.remove();
    const form = el("form", { class: "set-form", novalidate: "" });
    const id = `f-${k.key}`;
    const vals = () => ({});
    let collect = vals;
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
      form.append(...field(id, "Monthly budget in USD", "text", { inputmode: "decimal", value: v, maxlength: "12" }));
      const warn = el("p", { class: "note", hidden: "" });
      form.append(warn);
      const check = () => {
        const n = Number($(`#${id}`, form).value.trim()), row = spend && (spend.keys || []).find((x) => x.alias === BUDGET_KEY[k.key][0]);
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
    } else if (k.validator === "hour") {
      collect = () => ({ [k.key]: $(`#${id}`, form).value });
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
      form.append(...field(id, "New value", type, { value: v, maxlength: "2000" }));
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
    r.append(form);
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
  function voiceRow(body) {
    const pk = keys.STT_PROVIDER, mk = keys.STT_MODEL || {}, kk = keys.STT_API_KEY || {};
    if (!pk) return;
    const prov = "value" in pk ? pk.value : "";
    const model = "value" in mk ? mk.value : "";
    const r = el("div", { class: "set-row", "data-key": "STT_PROVIDER" });
    const label = STT_LABEL[prov] || prov;
    const now = prov ? `${label}${model ? ` · ${model}` : prov === "bedrock" ? " · voxtral-small" : ""}${kk.set && prov !== "bedrock" ? ` · key ${kk.hint || "set"}` : ""}` : label;
    r.append(el("div", { class: "set-main" },
      el("div", { class: "set-label" }, el("span", { text: "Speech-to-text" }), el("code", { class: "set-key", text: "STT_PROVIDER · STT_MODEL · STT_API_KEY" })),
      el("div", { class: "set-value", text: now }), el("p", { class: "note set-note", text: pk.note })));
    const actions = el("div", { class: "set-actions" });
    r.append(actions);
    if (data.here.remote) {
      r.append(el("p", { class: "note set-remote", text: "Change this from the computer running bedrock-now: from your devices it could send your voice elsewhere." }), cliLine(pk));
      body.append(r); return;
    }
    const b = el("button", { type: "button", class: "action", text: "Change" });
    b.disabled = !canChange();
    actions.append(b);
    if (!canChange()) r.append(cliLine(pk));
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
      const sync = () => {
        const p = form.querySelector("input[name=stt-provider]:checked").value;
        msel.replaceChildren(el("option", { value: "", text: "the provider's default" }));
        for (const m of choices.stt_models[p] || []) {
          const o = el("option", { value: m, text: m });
          if (p === "bedrock" && !choices.stt_bedrock_ready.includes(m)) o.disabled = true;
          if (m === model && p === prov) o.selected = true;
          msel.append(o);
        }
        msel.disabled = !p;
        keyRow.hidden = !(p === "openai" || p === "groq");
        privacy.textContent = p === "openai" || p === "groq" ? `Your speech (microphone and calls) goes to ${p === "openai" ? "api.openai.com" : "api.groq.com"}. The key is checked with ${STT_LABEL[p]} first (free).`
          : p === "bedrock" ? "Your speech stays in your AWS account; it counts on Chat's budget (about $0.002 a minute)." : "The browser's own speech recognition; voice calls are unavailable.";
      };
      radios.addEventListener("change", sync);
      form.append(radios, el("div", { class: "set-sub" }, el("label", { for: "stt-model", text: "Model" }), msel), keyRow, privacy);
      const err = el("p", { class: "error", role: "alert", hidden: "" });
      const cancel = el("button", { type: "button", class: "quiet", text: "Cancel" });
      form.append(err, el("p", { class: "confirm-buttons" }, cancel, el("button", { type: "submit", class: "action primary", text: "Save" })));
      cancel.addEventListener("click", () => form.remove());
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const p = form.querySelector("input[name=stt-provider]:checked").value;
        const values = { STT_PROVIDER: p, STT_MODEL: p ? msel.value : "" };
        if (keyIn.value.trim()) values.STT_API_KEY = keyIn.value.trim();
        if (p === "bedrock" || p === "") { if (kk.set) values.STT_API_KEY = ""; }
        confirmApply(values, "Save speech-to-text?", "Chat restarts (about 30 s).", Object.keys(values), form);
      });
      sync();
      r.append(form);
    });
    body.append(r);
  }

  // --- extra rows ---
  function sessionDays() { const k = keys.PORTAL_SESSION_DAYS; return k && /^\d+$/.test(k.value || "") ? Number(k.value) : 30; }

  function sessionsRow() {
    const r = el("div", { class: "set-row" },
      el("div", { class: "set-main" }, el("div", { class: "set-label" }, el("span", { text: "Signed-in devices" })),
        el("p", { class: "note set-note", text: `Every browser, phone and installed app that signed in with the portal password stays signed in for ${sessionDays()} days.` })));
    const a = el("div", { class: "set-actions" });
    const others = el("button", { type: "button", class: "action", text: "Sign out other devices" });
    others.disabled = !data.here.allowed;
    others.addEventListener("click", () => askPassword({ kind: "signout" }, "Sign out every other device?",
      "Every other browser, phone and installed app signs in again with the portal password. This browser stays signed in.", "Sign them out"));
    const all = el("form", { method: "post", action: "/logout", class: "set-inline" }, el("button", { type: "submit", class: "action", text: "Sign out everywhere" }));
    a.append(others, all);
    r.append(a);
    return r;
  }

  function modelsRow() {
    const r = el("div", { class: "set-row" },
      el("div", { class: "set-main" }, el("div", { class: "set-label" }, el("span", { text: "Models" })),
        el("p", { class: "note set-note", text: "Re-checking asks Bedrock which models your key can use (1-token requests, < $0.01; at most once an hour). LiteLLM restarts twice and setup picks the defaults again; about 2 minutes." }),
        el("p", { class: "note set-note" }, "Which models appear in Chat's picker: ",
          el("a", { href: `${(data.apps && data.apps.chat) || appUrl("chat")}admin/settings/models`, target: "_blank", rel: "noopener", text: "Chat › Admin settings › Models" }),
          ". Hiding a model there does not block it for the API or Claude Code.")));
    r.append(el("div", { class: "set-actions" }, actionButton("models-recheck", "Re-check models")));
    return r;
  }

  function fmtBytes(b) { return b == null ? "" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`; }

  function backupRow() {
    const main = el("div", { class: "set-main" }, el("div", { class: "set-label" }, el("span", { text: "Backups" })),
      el("p", { class: "note set-note", text: "A backup holds both databases, every stored file and a copy of .env (backups/<time>-portal/, readable only by you; the newest 5 made here are kept). It takes seconds and no service stops; it is refused when the disk could not hold it twice." }),
      el("p", { class: "note set-note", text: "Restoring stays in the terminal (./stack restore backups/<time>): it replaces every chat, key and file with an older state, so it asks twice and should never be one click away from a browser." }));
    const r = el("div", { class: "set-row" }, main, el("div", { class: "set-actions" }, actionButton("backup", "Back up now")));
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
      main.append(el("div", { class: "set-backups" }, el("table", {},
        el("thead", {}, el("tr", {}, ...["Backup", "Kind", "Size", "Made", ""].map((h) => el("th", { scope: "col", text: h })))), tbody)));
    } else {
      main.append(el("p", { class: "note set-note", text: "No backups yet." }));
    }
    return r;
  }

  function remoteStatus() {
    const on = data.remote && data.remote.on;
    return el("div", { class: "set-row" }, el("div", { class: "set-main" },
      el("div", { class: "set-label" }, el("span", { text: "Remote access" })),
      el("div", { class: "set-value", text: on ? `${data.remote.mode}: ${data.remote.url}` : "off" }),
      el("p", { class: "note set-note", text: on ? `This page is open ${data.here.remote ? "remotely" : "on this computer"}.` : "./stack remote enable tailscale turns it on (it needs a Tailscale auth key and steps in your tailnet's admin console)." })));
  }

  function diagnostics(body) {
    const items = [
      ["test", "Run the smoke test", "Every service end to end, like ./stack test: two tiny Bedrock requests (~$0.0001)."],
      ["report", "Create a status report", "Versions, services and settings without secrets (your home folder shown as ~), to copy into an issue."],
    ];
    for (const [act, label, note] of items) {
      const r = el("div", { class: "set-row" }, el("div", { class: "set-main" }, el("div", { class: "set-label" }, el("span", { text: label })), el("p", { class: "note set-note", text: note })));
      r.append(el("div", { class: "set-actions" }, actionButton(act, label.replace(/^Run the |^Create a /, (m) => (m.startsWith("Run") ? "Run " : "Create ")))));
      body.append(r);
    }
    const sel = el("select", { id: "set-restart", "aria-label": "Service to restart" });
    for (const s of (data.snapshot.choices.restart || [])) sel.append(el("option", { value: s, text: s }));
    const rb = el("button", { type: "button", class: "action", text: "Restart" });
    rb.disabled = !canChange();
    rb.addEventListener("click", () => openAction(`restart-${sel.value}`));
    body.append(el("div", { class: "set-row" },
      el("div", { class: "set-main" }, el("div", { class: "set-label" }, el("span", { text: "Restart a service" })),
        el("p", { class: "note set-note", text: "Recreates it with its current settings (10-30 s; requests in flight fail). The portal and Postgres are not restarted on their own." })),
      el("div", { class: "set-actions" }, sel, rb)));
    const out = el("div", { class: "set-report", id: "set-report", hidden: "" });
    body.append(out);
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

  // --- Advanced: every other key ---
  function advanced(body) {
    const used = new Set([...Object.values(CARD_KEYS).flat(), ...Object.keys(WITH), "STT_PROVIDER"]);
    const rest = Object.values(keys).filter((k) => !used.has(k.key));
    const filter = el("input", { type: "search", class: "set-filter", placeholder: "Find a setting", "aria-label": "Find a setting" });
    const list = el("dl", { class: "set-adv" });
    for (const k of rest) {
      list.append(el("div", { class: "set-adv-item", "data-key": k.key, "data-find": `${k.key} ${k.label} ${k.note}`.toLowerCase() },
        el("dt", {}, el("code", { text: k.key }), el("span", { class: `set-adv-value${k.secret !== "-" && k.secret !== "s" ? " masked" : ""}`, text: display(k) })),
        el("dd", {}, el("span", { text: `${k.label}. ${k.note}` }), el("code", { class: "set-adv-cli", text: k.cli }))));
    }
    filter.addEventListener("input", () => {
      const q = filter.value.trim().toLowerCase();
      for (const it of list.children) it.hidden = Boolean(q) && !it.dataset.find.includes(q);
    });
    body.append(filter, list);
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
      if (what.kind === "reveal") { showRevealed(what.key, d.value); return; }
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

  function showRevealed(key, value) {
    const r = document.querySelector(`#settings .set-row[data-key="${key}"]`) || document.querySelector(`#settings .set-row[data-key="BUDGET_${{ LITELLM_KEY_CLAUDE_CODE: "CLAUDE_CODE", LITELLM_KEY_OPENWEBUI: "OPENWEBUI", LITELLM_KEY_SETUP: "SETUP" }[key] || ""}"]`);
    copy(value, key);
    if (r && key !== "LITELLM_KEY_CLAUDE_CODE" && key !== "LITELLM_KEY_OPENWEBUI" && key !== "LITELLM_KEY_SETUP") {
      const v = r.querySelector(".set-value");
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
    n.replaceChildren(`Settings changed: ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` and ${names.length - 4} more` : ""} at ${new Date(at).toLocaleString()}${lc.via === "cli" ? " (in a terminal)" : lc.via === "portal-remote" ? " (from a remote device)" : ""}. `,
      el("a", { href: "#settings", text: "Settings" }));
    n.hidden = false;
  }

  document.addEventListener("bn:tab", (e) => {
    if (e.detail === "settings") load();
    else if (e.detail === "home" && data) renderNotice();
  });
  document.addEventListener("DOMContentLoaded", () => {
    // the More sheet on phones: Settings is a page of the portal, not a new tab
    for (const b of document.querySelectorAll(".sheet-link[data-page]")) {
      b.removeAttribute("href");
      b.addEventListener("click", () => showTab(b.dataset.page));
    }
    if (!data) load();
  });
})();
