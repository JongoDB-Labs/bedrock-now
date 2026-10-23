// Walkthrough: takes a developer through all of bedrock-now — setting it up (AWS models, OpenRouter, voice, Claude Code,
// a git host, budgets), its apps behind the one portal sign-in, Chat, coding with Claude on the Code page (modes, models,
// the workspace, @-mentions, clone, review and push, run and preview, what the sandbox reaches, plugins), the models from
// your own tools (claude-bedrock, the LiteLLM API, the shared store) and keeping it running (Home, Activity and search,
// spend, updates and backups, your phone). It lives at the bottom of the sidebar: on desktops a section of the widened
// sidebar (the apps' frames just get narrower), on tablets — and on a desktop whose sidebar is collapsed to its icons
// (nav.js) — a card next to the icon rail, on phones a sheet above the tab bar opened from More.
// Loaded after app.js, mobile.js and code.js (all deferred); uses app.js's globals ($, el, api, showTab, appUrl, copy,
// toast, usd, loadLogins, logins, lastSummary). Progress is a per-browser convenience in localStorage (bn.tour), with the
// steps this browser has opened (seen): a browser that went through an older walkthrough sees the steps it never opened
// marked New, and the Walkthrough button says how many ("16 new") until they are opened — a first visit
// sees none. With storage blocked it works for the session. Every node is built with el()/textContent: nothing is
// parsed as HTML. What it reads: /api/summary (as Home does) and, for a few steps, /api/settings (the same masked
// snapshot the Settings page shows: the LiteLLM port, the workspace folder, the sandbox's internet, the update helper) —
// it shows no secret, and the API step's snippets carry YOUR_KEY, never a key.
"use strict";

(function (root) {
  const KEY = "bn.tour";
  // The step ids of every walkthrough before this one (v0.4.0 to v0.12.x): a browser that went through one of them has
  // seen these; the rest are new to it.
  const BEFORE = ["welcome", "aws", "openrouter", "voice", "claude-setup", "budgets", "extras", "signin-portal", "signin-chat",
    "signin-admin", "signin-files", "home", "chat", "voice-use", "docs", "claude", "terminal", "code", "shared", "admin", "done"];
  const KEYS_SPENT = ["open-webui", "claude-code", "claude-code-terminal"];
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // --- pure parts (portal/tests/js/tour.test.mjs runs these in Node) ---

  // parse(TEXT, KNOWN) -> the saved state, every field checked against KNOWN (the step ids there are):
  // {first, open, cur, done, skipped, base, seen}. first: nothing (readable) was stored — a first visit. seen: the steps
  // this browser opened (a step stays New until it is opened, whatever else happens to it); a state saved before there
  // was such a list went through an older walkthrough: its steps (BEFORE), and what it did or skipped, count as seen.
  // base: each step's spend baseline (STEP:ALIAS, see spendState); an older state's per-key baselines become the Chat and
  // Claude Code steps' (the old Claude Code step's terminal key one is dropped: Open Code and ask takes its own).
  function parse(text, known) {
    const ok = (id) => typeof id === "string" && known.includes(id);
    const s = { first: true, open: null, cur: "welcome", done: [], skipped: [], base: {}, seen: [] };
    let raw = null;
    try { raw = JSON.parse(text || "null"); } catch (_) { raw = null; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return s;
    s.first = false;
    if (typeof raw.open === "boolean") s.open = raw.open;
    if (raw.cur === "" || ok(raw.cur)) s.cur = raw.cur;
    for (const k of ["done", "skipped"]) if (Array.isArray(raw[k])) s[k] = [...new Set(raw[k].filter(ok))];
    const base = raw.base && typeof raw.base === "object" && !Array.isArray(raw.base) ? raw.base : {};
    const OLD = { "open-webui": "chat", "claude-code": "claude" };
    for (const [k, v] of Object.entries(base)) {
      if (!Number.isFinite(v)) continue;
      const m = /^([a-z][a-z-]*):([a-z-]+)$/.exec(k);
      if (m && ok(m[1]) && KEYS_SPENT.includes(m[2])) s.base[k] = v;
      else if (Array.isArray(raw.seen) || !has(OLD, k)) continue;
      else if (ok(OLD[k])) s.base[baseKey(OLD[k], k)] = v;
    }
    s.seen = Array.isArray(raw.seen) ? [...new Set(raw.seen.filter(ok))] : [...new Set([...BEFORE.filter(ok), ...s.done, ...s.skipped])];
    return s;
  }
  // resolve(STATE, ORDER) -> STATE as this page starts with it: a first visit has seen every step listed now (nothing
  // is New); a current step this site does not list (the Code page or the terminal off here) falls back to the first.
  function resolve(s, order) {
    const out = { ...s, seen: s.first ? [...new Set([...s.seen, ...order])] : s.seen };
    if (out.cur !== "" && !order.includes(out.cur)) out.cur = order[0] || "";
    return out;
  }
  // unseen(ORDER, SEEN) -> the steps of ORDER this browser has not opened yet
  const unseen = (order, seen) => order.filter((id) => !seen.includes(id));

  // A step's spend baseline: what ALIAS's key had spent when STEP was first shown (each step its own, never shared).
  const baseKey = (step, alias) => `${step}:${alias}`;
  // spendState(BASE, STEP, ALIASES, NOW) -> {ok: true, alias, more} once one of the keys spent more than STEP's baseline,
  // {ok: false} while none did, null without a baseline (STEP not shown yet, or no spend known). NOW: {alias: spend}.
  function spendState(base, step, aliases, now) {
    let seen = false;
    for (const a of aliases) {
      const b = base[baseKey(step, a)], n = now[a];
      if (!Number.isFinite(b) || !Number.isFinite(n)) continue;
      if (n > b + 1e-9) return { ok: true, alias: a, more: n - b };
      seen = true;
    }
    return seen ? { ok: false } : null;
  }
  // withBaseline(BASE, STEP, ALIASES, NOW) -> BASE with STEP's baselines taken from NOW where it has none yet; a baseline
  // above what the key has spent now (a new budget period) comes down to it.
  function withBaseline(base, step, aliases, now) {
    const out = { ...base };
    for (const a of aliases) {
      const k = baseKey(step, a), n = now[a];
      if (Number.isFinite(n) && (!Number.isFinite(out[k]) || n < out[k])) out[k] = n;
    }
    return out;
  }

  // What the walkthrough takes from /api/settings (the masked snapshot): plain values only, each checked; what the
  // snapshot does not have stays unknown ("" / null), never a default the stack may not be using.
  function cfgFrom(d) {
    const keys = {};
    for (const k of (d && d.snapshot && Array.isArray(d.snapshot.keys) ? d.snapshot.keys : [])) {
      if (k && typeof k.key === "string" && typeof k.value === "string") keys[k.key] = k.value;
    }
    const port = /^[0-9]{1,5}$/.test(keys.LITELLM_PORT || "") && Number(keys.LITELLM_PORT) > 0 && Number(keys.LITELLM_PORT) < 65536 ? keys.LITELLM_PORT : "";
    const egress = has(keys, "TERMINAL_EGRESS") ? keys.TERMINAL_EGRESS.trim().toLowerCase() : null;
    return {
      port,
      workspace: typeof keys.TERMINAL_WORKSPACE === "string" ? keys.TERMINAL_WORKSPACE.slice(0, 300) : "",
      // (blank, and the old on values, read as internet, as ./stack reads them)
      egress: egress === null ? null : ["host", "off"].includes(egress) ? egress : ["false", "0", "no"].includes(egress) ? "off"
        : ["", "internet", "true", "1", "yes", "on"].includes(egress) ? "internet" : null,
      helper: Boolean(d && d.helper && d.helper.running === true),
      auto: keys.AUTO_UPDATE === "on",
      nightly: keys.BACKUP_NIGHTLY === "on",
    };
  }

  // The model the API step's snippets name: Haiku when it is enabled (the cheapest Claude), else another enabled chat
  // model of Bedrock, else Haiku's id anyway.
  function snippetModel(summary) {
    const rows = (summary && summary.models && Array.isArray(summary.models.rows) ? summary.models.rows : [])
      .filter((r) => r && r.enabled && r.kind === "chat" && (r.provider || "Bedrock") === "Bedrock" && /^[a-z0-9.-]{1,64}$/.test(r.name || ""));
    for (const pref of ["claude-haiku-5-5", "claude-sonnet-5-5"]) if (rows.some((r) => r.name === pref)) return pref;
    return rows.length ? rows[0].name : "claude-haiku-5-5";
  }
  // snippets(BASE, MODEL) -> short, copyable examples for the LiteLLM API at BASE (http://127.0.0.1:<port>), with the
  // placeholder YOUR_KEY: OpenAI-style with curl and the openai SDK, Anthropic-style with the anthropic SDK
  function snippets(base, model) {
    return {
      curl: `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n` +
        `  -d '{"model": "${model}", "messages": [{"role": "user", "content": "Hello"}]}'`,
      openai: `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}/v1", api_key="YOUR_KEY")\n` +
        `r = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(r.choices[0].message.content)`,
      anthropic: `import anthropic\n\nclient = anthropic.Anthropic(base_url="${base}", api_key="YOUR_KEY")\n` +
        `m = client.messages.create(\n    model="${model}",\n    max_tokens=512,\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(m.content[0].text)`,
    };
  }

  root.bnTour = { _pure: { BEFORE, parse, resolve, unseen, baseKey, spendState, withBaseline, cfgFrom, snippetModel, snippets } };
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return;

  const POLL_MS = 30000;
  const CFG_MS = 300000;   // the settings snapshot, asked again after 5 minutes (at most once a minute)
  const PHONE = window.matchMedia("(max-width: 767.98px)");
  const TABLET = window.matchMedia("(min-width: 768px) and (max-width: 1099.98px)");
  // the sidebar is the icon rail (a tablet, or a collapsed desktop sidebar: nav.js) — the panel is then the card
  // beside it
  const rail = () => (root.bnNav && root.bnNav.rail ? root.bnNav.rail() : TABLET.matches);
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");
  const REPO = "https://github.com/JongoDB-Labs/bedrock-now";
  const NAMES = { chat: "Chat", admin: "Admin", files: "Files" };
  const PROMPT = 'Write notes/hello.md to the shared store with a two-line summary of this folder, and ingest it into knowledge base "Claude Code".';
  // The Code page (code.js reads the same): {enabled, here} — on at all, and usable on this site (remote access needs
  // REMOTE_TERMINAL). Its steps show while it is here; while it is off, one step says what it is and how to turn it on.
  const CODE = (() => {
    try { const c = JSON.parse(document.querySelector('meta[name="bn-code"]').content) || {}; return { enabled: c.enabled === true, here: c.here === true && Boolean(APP_URLS.code) }; } catch (_) { return { enabled: false, here: false }; }
  })();
  // The browser terminal (terminal.js reads the same): usable on this site — its steps are left out where it is not.
  const TERM = (() => {
    try { const t = JSON.parse(document.querySelector('meta[name="bn-terminal"]').content) || {}; return { here: t.here === true && Boolean(APP_URLS.terminal) }; } catch (_) { return { here: false }; }
  })();
  const CHECK_FAILED = "Could not check: Home says why; trying again every 30 s.";
  const CFG_FAILED = "Could not read Settings: trying again every 30 s.";

  // --- small builders ---
  const p = (...c) => el("p", {}, ...c);
  const note = (...c) => el("p", { class: "note" }, ...c);
  const b = (t) => el("strong", { text: t });
  const code = (t) => el("code", { text: t });
  const kbd = (t) => el("kbd", { text: t });
  // the portal's Settings tab, opened at a section or a setting (settings.js: #settings/<section> or #settings/<KEY>):
  // settings(WHERE, PLACE), or settings(WHERE) for the places named here
  const PLACES = { "Claude Code": "code", "Account & security": "account", "Spending & budgets": "spending", "Updates & backups": "updates",
    "Remote access": "remote" };
  const settings = (where, place) => el("a", { href: `#settings/${place || PLACES[where] || ""}`, text: `Settings → ${where}` });
  const list = (tag, items) => el(tag, { class: "tour-list" }, ...items.map((i) => el("li", {}, ...[].concat(i))));
  const ext = (href, text) => el("a", { href, target: "_blank", rel: "noopener noreferrer", "data-k": `link:${href}`, text });
  const doc = (anchor, text) => ext(`${REPO}#${anchor}`, text);

  function button(label, k, fn, cls = "action") {
    const n = el("button", { type: "button", class: cls, "data-k": k, text: label });
    n.addEventListener("click", fn);
    return n;
  }
  function cmd(text, what = "the command", k = `copy:${text}`) {
    return el("div", { class: "tour-cmd" }, el("code", { text }), button("Copy", k, () => copy(text, what), "copy"));
  }
  // An app's "Open" button: its tab, or on a phone (Admin and Files are no tabs there) a link to a new browser tab.
  function openApp(app) {
    const label = `Open ${NAMES[app]}`;
    if (window.bnMobile && window.bnMobile.allowTab(app) !== app) {
      const a = el("a", { class: "action", href: appUrl(app), target: "_blank", rel: "noopener", "data-k": `open-${app}` },
        label, el("span", { "aria-hidden": "true", text: " ↗" }), el("span", { class: "tour-sr", text: " (opens in a new tab)" }));
      a.addEventListener("click", () => opened(app));
      return a;
    }
    return button(label, `open-${app}`, () => { showTab(app); away(); });
  }
  // The Code tab (on a phone: full screen in a new browser tab, as under More). While the Code page is off here, the
  // tab is still there: its page (the portal's own, on a phone too) says what it is and how to turn it on.
  function openCode() {
    if (!CODE.here) return button("About the Code tab", "open-code", () => { showTab("code"); away(); });
    if (PHONE.matches) {
      return el("a", { class: "action", href: appUrl("code"), target: "_blank", rel: "noopener", "data-k": "open-code" },
        "Open Code", el("span", { "aria-hidden": "true", text: " ↗" }), el("span", { class: "tour-sr", text: " (opens in a new tab)" }));
    }
    return button("Open Code", "open-code", () => { showTab("code"); away(); });
  }
  // The Code page at one of its Git panel's dialogs — Git hosts, or Clone (empty: a link clones nothing) — as Settings ›
  // Claude Code › Git hosts opens it: through the Code tab (code.js), else the Code page's address in a new tab.
  function openGit(what) {
    const k = what === "hosts" ? "open-git-hosts" : "open-clone";
    return button(what === "hosts" ? "Open Git hosts" : "Clone a repository", k, () => {
      const c = window.bnCode;
      if (c && what === "hosts" && c.openGitHosts) c.openGitHosts();
      else if (c && what === "clone" && c.openClone) c.openClone();
      else { try { const u = new URL(appUrl("code")); u.searchParams.set("git", what); window.open(u.href, "_blank", "noopener"); } catch (_) { /* no Code page */ } }
      away();
    });
  }
  // The Terminal tab (on a phone: full screen in a new browser tab, as under More)
  function openTerminal() {
    if (PHONE.matches) {
      return el("a", { class: "action", href: appUrl("terminal"), target: "_blank", rel: "noopener", "data-k": "open-terminal" },
        "Open the terminal", el("span", { "aria-hidden": "true", text: " ↗" }), el("span", { class: "tour-sr", text: " (opens in a new tab)" }));
    }
    return button("Open the terminal", "open-terminal", () => { showTab("terminal"); away(); });
  }
  // Activity's panel and the portal's Search (activity.js, search.js)
  function openPanel(which) {
    const label = which === "activity" ? "Open Activity" : "Open Search";
    return button(label, `open-${which}`, () => {
      const o = which === "activity" ? window.bnActivity : window.bnSearch;
      if (!o || !o.open) return;
      if (PHONE.matches || rail()) setOpen(false, false);
      o.open();
    });
  }
  // Where Claude Code also runs: the Code tab when it is on here, else the tab's own page (how to turn it on)
  function codeLine(use) {
    if (CODE.here) {
      return use ? p("Or in the ", b("Code"), " tab: start a session and paste the same prompt. In its Manual mode (the picker next to Send) it shows each command and edit for your OK first; unlock it with the portal password.")
        : p("Or nothing to install: the ", b("Code"), " tab is Claude Code in the browser, with a chat, your workspace's files and permission prompts, in the browser terminal's sandbox.");
    }
    if (CODE.enabled) return note("The ", b("Code"), " tab is off for remote access (", code("REMOTE_TERMINAL=true"), " in ", code(".env"), " turns it on with the terminal).");
    return note(use ? "Prefer the browser? The " : "Claude Code in the browser, nothing to install: the ", b("Code"), " tab, off for now, says what it does; ",
      settings("Claude Code", "CODE_ENABLED"), " turns it on (from the computer running bedrock-now; it turns the browser terminal on too, as ", code("./stack code enable"), " does).");
  }
  // Chat, Admin and Files sign you in by themselves: opening one (its tab, or on a phone its new-tab link) is the step.
  function opened(app) {
    const id = `signin-${app}`;
    if (!has(NAMES, app) || isDone(id)) return;
    mark(id, "done");
    if (st.open && st.cur === id) announce(`${NAMES[app]} opened: signed in, done.`);
    commit();
  }
  // "Show spend/services/models": Home, scrolled to that card, which lights up briefly.
  function showOnHome(where, label) {
    return button(label, `show-${where || "home"}`, () => {
      showTab("home");
      away();
      const card = where && $(`#home section.${where}`);
      if (!card) return;
      if (where === "services" && PHONE.matches) {
        const h = $(".health-line");
        if (h && h.getAttribute("aria-expanded") !== "true") h.click();
      }
      requestAnimationFrame(() => {
        card.scrollIntoView({ behavior: REDUCED.matches ? "auto" : "smooth", block: "start" });
        card.classList.remove("tour-flash"); void card.offsetWidth; card.classList.add("tour-flash");
        clearTimeout(card.tourT); card.tourT = setTimeout(() => card.classList.remove("tour-flash"), 1800);
      });
    });
  }
  // Admin / Files sign you in automatically (the portal signs in for you); their own sign-in stays for the API and in
  // case that fails, folded away as on Home: the user name as text (masked in the e2e screenshots), the password only
  // through Copy, and the app's own form (?sso=off). app.js loads the sign-ins at start-up (the panel redraws once
  // they are in, see "wiring"); Copy asks for them only if that failed. A redraw keeps a fold open.
  const unfolded = new Set();
  function folds(n, k) {
    n.open = unfolded.has(k);
    n.addEventListener("toggle", () => { if (n.open) unfolded.add(k); else unfolded.delete(k); });
    return n;
  }
  function fallback(app, nameLabel, userCopy, passCopy, hint) {
    const user = logins && logins[app] && logins[app].username;
    const form = logins && logins[app] && logins[app].manual;
    const grab = (field, what) => async () => {
      if (!logins) await loadLogins();
      const v = logins && logins[app] && logins[app][field];
      if (v) copy(v, what); else toast("Not available yet: run ./stack setup");
    };
    return folds(el("details", { class: "tour-fallback", "data-k": `fallback-${app}` },
      el("summary", { text: "Credentials (for the API or if automatic sign-in fails)" }),
      el("p", { class: "tour-login" }, `${nameLabel} `, el("span", { class: "tour-cred", text: user || "–" })),
      el("div", { class: "tour-actions" },
        button(userCopy, `copy-${app}-user`, grab("username", userCopy.replace(/^Copy /, "")), "copy"),
        button(passCopy, `copy-${app}-pass`, grab("password", passCopy.replace(/^Copy /, "")), "copy"),
        form ? el("a", { class: "copy", href: form, target: "_blank", rel: "noopener", "data-k": `form-${app}` },
          "Its sign-in form", el("span", { "aria-hidden": "true", text: " ↗" }), el("span", { class: "tour-sr", text: " (opens in a new tab)" })) : null),
      note(...hint)), app);
  }
  // A code snippet, folded (curl's starts open), with Copy
  unfolded.add("curl");
  function snippet(k, title, text) {
    return folds(el("details", { class: "tour-snip", "data-k": `snip-${k}` }, el("summary", { text: title }),
      el("pre", {}, el("code", { text })),
      el("div", { class: "tour-actions" }, button("Copy", `copy-snip-${k}`, () => copy(text, `the ${title} example`), "copy"))), k);
  }
  const spendOf = (alias) => {
    const k = sum && sum.spend && (sum.spend.keys || []).find((r) => r.alias === alias);
    return k && !k.error && typeof k.spend === "number" ? k.spend : null;
  };
  const command = () => (sum && sum.claude && sum.claude.command) || "claude-bedrock";
  const remote = () => Boolean(sum && sum.remote && sum.remote.here);
  const onlyHere = () => (remote() ? " — you are on another device now, so open it there for that" : "");

  // --- the steps. info: Next marks it done. optional: Skip. skipOnly: no "Mark as done" (it is detected).
  // live: needs /api/summary while shown. detect(summary) → {ok, text, warn} or null. spendKey: done once that
  // LiteLLM key spends more than when this step was first shown (its own baseline: spendState). cfg: needs /api/settings while shown (detectCfg(cfg)
  // like detect). local(): detected from this page (the Code tab's report), no summary needed. when: only where it
  // applies (the Code page or the terminal on here).
  const STEPS = {
    // ---------------- Set up
    welcome: {
      title: "Welcome", info: true,
      body: () => [
        p("bedrock-now is your AI workbench: models run on Amazon Bedrock in your own AWS account (and on OpenRouter, if you turn it on). Where you work:"),
        list("ul", [
          CODE.here ? [b("Code"), ": Claude Code in the browser — a chat beside your files, Git, previews, Run & test — in a sandbox that sees one folder."]
            : [b("Code"), ": Claude Code in the browser, once it is on (its step says how)."],
          [b("Claude Code"), " in your own terminal (", code("claude-bedrock"), ")", TERM.here ? ", and the browser terminal." : "."],
          [b("Chat"), " (Open WebUI): conversations, voice and your documents."],
          [b("Your own tools"), ": scripts and apps use the same models through one OpenAI- and Anthropic-compatible API."],
          [b("Admin"), " (keys, budgets, logs) and ", b("Files"), " (the store Claude Code and Chat share)."]]),
        p("One sign-in, the portal's, opens all of them, and every answer shows what it cost."),
        note("Six parts; skip what you do not need (each part folds away). Trying everything costs a few cents. Commands here run in a terminal, in your bedrock-now folder."),
      ],
    },
    aws: {
      title: "Your AWS key and Bedrock models", live: true,
      detect: (d) => {
        const m = d.models || {};
        const bed = (m.rows || []).filter((r) => (r.provider || "Bedrock") === "Bedrock");
        if (!bed.length) return { ok: false, warn: true, text: m.error || "No model check yet: run ./stack models --recheck." };
        const chat = bed.filter((r) => r.enabled && r.kind === "chat").length;
        const off = bed.filter((r) => !r.enabled).length;
        const rest = off ? ` · ${off} not available` : "";
        if (!chat) return { ok: false, warn: true, text: `No chat model is enabled on your AWS key yet${rest}.` };
        return { ok: true, text: `${chat} chat model${chat === 1 ? "" : "s"} enabled on your AWS key${rest}` };
      },
      body: () => [
        p("The Models table on Home shows each model's status, its price and, under ", el("em", { text: "Why" }), ", why a model is not available."),
        p("For more models, ask your AWS admin for model access (", doc("asking-your-aws-admin-for-model-access", "what to ask for"),
          "), then check again (< $0.01):"),
        cmd("./stack models --recheck"),
      ],
      actions: () => [showOnHome("models", "Show models")],
    },
    openrouter: {
      title: "More models with OpenRouter", optional: true, skipOnly: true, live: true,
      detect: (d) => {
        const on = (d.models && d.models.openrouter) || (d.spend && d.spend.openrouter && d.spend.openrouter.enabled);
        if (!on) return null;
        const rows = ((d.models && d.models.rows) || []).filter((r) => r.provider === "OpenRouter");
        const free = rows.filter((r) => r.access === "free").length;
        return { ok: true, text: `OpenRouter is on: ${free} free, ${rows.length - free} paid models` };
      },
      body: () => [
        p("Hundreds of other models, some free. Prompts to them go to openrouter.ai and the model's provider, not to your AWS account."),
        list("ol", [
          ["Create a key at ", ext("https://openrouter.ai/settings/keys", "openrouter.ai › Settings › API Keys"),
            ". Name it bedrock-now; a credit limit is optional (it caps what the key can spend). It is shown once: copy it then."],
          ["Paste it into ", code(".env"), " after ", code("OPENROUTER_API_KEY="), " and run", cmd("./stack openrouter apply"),
            "or run", cmd("./stack openrouter set"), "(it asks for the key, hidden), or paste it in ", settings("Chat & voice", "OPENROUTER_API_KEY"), " on this computer. Either way the key is checked with OpenRouter and what needs it restarts (~30 s)."],
          ["An account without credits can only use free models, so apply and set then offer just those (",
            code("OPENROUTER_MODELS=free"), "). After buying credits, apply again or run ", code("./stack openrouter models all"), "."],
          ["On ", ext("https://openrouter.ai/settings/privacy", "Settings › Privacy"), ": most free models need ",
            b("Allow free endpoints that train on request data"),
            " (those providers may keep your prompts and train on them; without it free models answer 404). Leave ",
            b("Allow free endpoints that publish prompts"), " off. ", b("Filter the model catalog for API keys"),
            " (recommended) makes Chat list only the models your key can use."],
          ["Nothing to turn on at OpenRouter to watch it: the Spend card on Home gets an OpenRouter block (free and paid requests, top models, the daily free-request limit, recent failures with fixes) and the Actual/Equivalent switch; Admin → Logs has every request."]]),
        note("The key goes in through your terminal, .env or Settings on this computer, never through this walkthrough."),
      ],
    },
    voice: {
      title: "Voice", optional: true, live: true,
      detect: (d) => {
        const v = d.voice;
        if (!v) return null;
        if (!v.on) return { ok: false, text: "Voice uses your browser's speech recognition (Chrome and Edge send the audio to Google or Microsoft), and Call is unavailable." };
        const price = v.per_minute != null ? ` (~$${v.per_minute.toPrecision(2)} per minute${v.estimated ? ", estimated" : ""})` : "";
        const where = v.provider === "bedrock" ? "audio stays in your AWS account" : `audio goes to ${v.where}`;
        return { ok: true, text: `Voice is on: ${v.label}${price}; ${where}` };
      },
      body: (d) => {
        const on = d && d.voice && d.voice.on;
        const out = on ? [p(code("./stack stt status"), " shows the details.")]
          : [p("Bedrock speech-to-text (no extra key) turns on the microphone and Call:"), cmd("./stack stt set bedrock"),
            note("Or ", code("./stack stt set openai"), " / ", code("groq"), ": their key, and the audio goes to them.")];
        out.push(p("The first time you use the microphone, the browser asks for permission: choose Allow."));
        return out;
      },
    },
    "claude-setup": {
      title: "Claude Code on your computer", optional: true,
      body: () => [
        p(code("claude-bedrock"), " is Claude Code pointed at this stack, so Claude Code (", code("claude"), ") must be installed (",
          doc("quickstart", "prerequisites"), ")."),
        p("Setup offers to link it into ", code("~/.local/bin"), ". If your terminal says “command not found”, run ",
          code("./bin/claude-bedrock"), " from your bedrock-now folder, or re-run ", code("./stack setup"), " and answer y."),
        cmd(command()),
        p("It keeps its own config folder, ", code("~/.claude-bedrock"), ": your ", code("~/.claude"),
          " plugins, hooks and MCP servers are not loaded, which makes a prompt on Bedrock about 100× cheaper (",
          doc("a-lean-config-folder-for-bedrock", "why"), "). Add only what you want with ",
          code("claude-bedrock plugin install …"), " or ", code("claude-bedrock mcp add …"), "; ",
          code("CLAUDE_BEDROCK_USE_MY_CONFIG=1"), " loads your whole setup."),
        codeLine(false),
      ],
      actions: () => [openCode()],   // (while it is off here: its tab's page, how to turn it on)
    },
    "git-hosts": {
      title: "Connect a git host", optional: true, when: () => CODE.here,
      // (how many hosts the Code tab last reported — a number only; null while it has not: Mark as done)
      local: () => {
        const n = window.bnCode && window.bnCode.gitHosts ? window.bnCode.gitHosts() : null;
        if (n == null) return null;
        return n ? { ok: true, text: `${n} git host${n === 1 ? "" : "s"} connected` } : { ok: false, text: "No git host is connected yet." };
      },
      body: () => [
        p("For private repositories, and to push: GitHub, GitLab or any git server over https or ssh, connected once on the Code page."),
        list("ol", [
          [b("Open Git hosts"), " → ", b("Connect a git host…"), ": GitHub, GitLab or another server."],
          [b("Sign in with GitHub"), " (no setup: bedrock-now's own GitHub App) or ", b("Sign in with GitLab"), " (an app of yours): the dialog shows a code — open the host's page it links to, enter the code there and approve (the page never opens it for you). ",
            "On GitHub it reaches only the repositories you install the app on (", b("Choose repositories"), ", or github.com/apps/bedrock-now), with ", b("Contents: Read and write"), "; its token renews itself."],
          ["Or an ", b("access token"), " for https:// URLs (the dialog links to where you make one): on GitHub a fine-grained token for only the repositories you need, with ",
            b("Contents: Read and write"), "; on GitLab ", code("read_repository"), " and ", code("write_repository"), ". Paste it once: it is never shown again."],
          ["Or an ", b("SSH key"), " the Code page makes, for git@… URLs: add its public half to your account, or as a deploy key of the repository (",
            b("Allow write access"), " to push)."],
          ["Already use gh or glab on this computer? ", code("./stack git-host import gh"), " (or ", code("glab"), "), in the bedrock-now folder, imports that login as the token (glab: a personal access token only)."],
          [b("Test connection"), " lists a repository's branches with it."]]),
        note("Claude's own git gets nothing from it unless you turn on ", b("Let Claude use this host"), " (off by default; each use shows in Activity). Adding a host, a sign-in, a token or a key works only from the computer running bedrock-now",
          onlyHere(), ". ", doc("remote-repositories-git-hosts-clone-push-and-pull", "More")),
      ],
      actions: () => [openGit("hosts")],
    },
    budgets: {
      title: "Budgets", info: true, live: true,
      body: (d) => {
        const keys = (d && d.spend && d.spend.keys) || [];
        return [
          p("Each app has its own LiteLLM key with a monthly budget:"),
          keys.length ? list("ul", keys.map((k) => [`${k.label}: `, b(k.error ? "unavailable" : k.max_budget != null ? `${usd(k.max_budget)} a month` : "no budget")]))
            : note(failedAt ? CHECK_FAILED : "Loading…"),
          p("Once a key's budget is used up, LiteLLM refuses its requests until the budget resets (Home shows the date)."),
          p("Change them in ", settings("Spending & budgets"), " (at once, no restart), or with ", code("./stack config set BUDGET_OPENWEBUI"), "."),
        ];
      },
    },
    extras: {
      title: "Extras", optional: true,
      body: () => {
        const install = [...document.querySelectorAll("[data-install]")].find((n) => !n.hidden);
        const open = [...document.querySelectorAll("[data-open-app]")].find((n) => !n.hidden);
        const where = document.documentElement.dataset.appState;   // install.js: app, open (installed), install or none
        const app = where === "app" ? "You are using it now." : where === "open" ? $("#app-note-text").textContent : "";
        const how = PHONE.matches ? "iPhone and iPad: Share → Add to Home Screen. Android: Chrome's ⋮ → Install app."
          : "Chrome: ⋮ → Cast, save and share → Install page as app. Edge: ⋯ → Apps → Install this site as an app. Safari on a Mac: File → Add to Dock.";
        return [
          p(b("Desktop app"), ": the portal in its own window, with its own icon."),
          open ? el("div", { class: "tour-actions" }, button("Open in the app", "open-app", () => open.click()))
            : install ? el("div", { class: "tour-actions" }, button("Install app", "install", () => install.click()))
              : note(app || how),
          p(b("One-click Update, Rollback and Clean"), " on Home, and Settings you can change in the portal: the update helper (",
            doc("updating", "how it works"), "):"), cmd("./stack helper install"),
        ];
      },
    },
    // ---------------- Your apps (one sign-in)
    "signin-portal": {
      title: "The portal: your one sign-in", badges: ["Sign-in: Done"], info: true,
      body: () => [
        p("The portal password (", code("PORTAL_PASSWORD"), " in ", code(".env"), "; ", code("./stack password --show"),
          " prints it) is the only one you type: Chat, Admin and Files sign you in with it, and the Terminal and the Code page (when they are on) ask for it once more to unlock, because they run commands. Change it in ", settings("Account & security", "PORTAL_PASSWORD"), "."),
        p("A sign-in lasts 30 days (", code("PORTAL_SESSION_DAYS"), ", also in Account & security). ", b("Sign out"),
          PHONE.matches ? " (under More)" : " at the bottom of the sidebar", " ends it everywhere, and Admin's and Files' with it."),
      ],
    },
    "signin-chat": {
      title: "Chat (Open WebUI)", badges: ["Sign-in: Automatic"],
      body: () => [p("Chat opens signed in as you: no second password.")],
      actions: () => [openApp("chat")],
    },
    "signin-admin": {
      title: "Admin (LiteLLM)", badges: ["Sign-in: Automatic"],
      body: () => [
        p("Admin opens LiteLLM already signed in, on ", b("Virtual Keys"), ": the portal signs in for you."),
        fallback("admin", "Username", "Copy username", "Copy password",
          ["For LiteLLM's API, or its own form (", b("Username"), ", ", b("Password"), ", ", b("Login"),
            ") if the automatic sign-in ever fails. A password changed inside LiteLLM is not known here: set it in ",
            settings("Account & security", "LITELLM_UI_PASSWORD"), " too, or the automatic sign-in stops."]),
      ],
      actions: () => [openApp("admin")],
    },
    "signin-files": {
      title: "Files (RustFS)", badges: ["Sign-in: Automatic"],
      body: () => [
        p("Files opens RustFS's console already signed in, on the list of buckets: the portal signs in for you."),
        fallback("files", "Access key", "Copy access key", "Copy secret key",
          ["For S3 tools, or the console's own form (the access key under ", b("Account"), ", the secret key under ",
            b("Key"), ", ", b("Login"), ") if the automatic sign-in ever fails."]),
      ],
      actions: () => [openApp("files")],
    },
    // ---------------- Chat
    chat: {
      title: "Chat: pick a model and ask", live: true, spendKey: "open-webui",
      waiting: "Not detected yet: spend can take a minute to show, and free models add none.",
      body: () => [
        p("The model dropdown at the top of Chat lists your Bedrock models by name with a price tier ($ cheapest, $$, $$$) and, with OpenRouter on, “… · OpenRouter” models tagged Free or Paid."),
        p("Pick one, type a question, send. The italic line under each answer is what it cost, and what the whole chat has cost so far."),
      ],
      actions: () => [openApp("chat")],
    },
    "voice-use": {
      title: "Talk instead of type", optional: true,
      body: (d) => [
        list("ul", [
          ["🎤 in the message box dictates."],
          ["The sound-wave button (Call) starts a spoken back-and-forth", d && d.voice && !d.voice.on ? " (needs server speech-to-text: see Voice above)." : "."],
          ["The speaker icon under an answer reads it aloud with your system's voice."]]),
      ],
      actions: () => [openApp("chat")],
    },
    docs: {
      title: "Your documents",
      body: () => [
        list("ul", [
          ["Drop a file (PDF, Word, text) into the message box to ask about it in that chat."],
          ["Or ", b("Workspace → Knowledge → +"), " to make a knowledge base and upload documents; then type ", code("#"), " in any chat to use it."]]),
        note("Uploads are kept in Files (bucket ", code("openwebui"), ") and indexed with a Bedrock embedding model (a tiny cost)."),
      ],
      actions: () => [openApp("chat")],
    },
    // ---------------- Code with Claude (the Code page; where it is off here, one step on how to turn it on)
    "code-off": {
      title: CODE.enabled ? "The Code page from this device" : "Turn on the Code page", optional: true, when: () => !CODE.here,
      body: () => CODE.enabled ? [
        p("The Code page — Claude Code in the browser, with a chat, your files, Git and previews — is on, on the computer running bedrock-now. Over remote access it stays off unless you allow it, because Claude runs commands there:"),
        list("ol", [
          ["On that computer, set ", code("REMOTE_TERMINAL=true"), " in ", code(".env"), ", then run ", code("./stack up"), " (it shares the browser terminal too)."],
          ["With Tailscale, approve its new Services (", code("…-terminal"), ", ", code("…-code"), "); ", code("./stack remote status"), " lists them."]]),
        note("Or open the portal on that computer: its steps then show here."),
      ] : [
        p("Claude Code in the browser, like its desktop app: a chat beside your project's files, Git with your git hosts, previews of dev servers, Run & test — and every command and file change shown to you first."),
        list("ul", [
          ["It runs in a sandbox that sees one folder of yours, with its own key and budget."],
          [settings("Claude Code", "CODE_ENABLED"), " › ", b("Code page: On"), " (from the computer running bedrock-now), or in a terminal:"]]),
        cmd("./stack code enable"),
        note("Once it is on, reload the portal: this part of the walkthrough then shows its steps (", doc("the-code-page", "the Code page"), ")."),
      ],
      actions: () => [openCode()],
    },
    "code-open": {
      title: "Open Code and ask", optional: true, when: () => CODE.here, live: true, spendKey: "claude-code-terminal",
      waiting: "Not detected yet: send a prompt (its spend can take a minute to show).",
      body: () => [
        list("ol", [
          [b("Open Code"), " and unlock it with the portal password (it stays unlocked for 12 hours in this browser)."],
          ["Type in the prompt box and press ", kbd("Enter"), ": the answer streams in, each command and file change as a card; ", b("Stop"), " (or ", kbd("Esc"), ") interrupts."],
          [b("New session"), " (+) starts another; the ", b("Projects"), " tab lists them by project, the open ones as ", b("Needs you"), ", ", b("Working"), " and ", b("Done"),
            ". A session keeps working when you close the tab, and Home's Code card lists the ones that need you."]]),
        note("Every prompt is billed on the terminal's key (", code("claude-code-terminal"), "). A new session first writes Claude Code's prompt cache: about $0.004 on Haiku 5.5, $0.08 on Sonnet 5.5, $0.16 on Opus 5.5."),
      ],
      actions: () => [openCode()],
    },
    "code-modes": {
      title: "Modes and permission cards", optional: true, when: () => CODE.here,
      body: () => [
        p("The mode next to Send decides what Claude may do without asking (", kbd("Shift+Tab"), " cycles, ", kbd("Alt+M"), " opens the menu):"),
        list("ul", [
          [b("Read only"), ": it reads and searches; anything else is denied."],
          [b("Plan"), ": it reads, then shows a plan for you to approve — or to send back with your comments."],
          [b("Manual"), ": every file edit and command waits for your OK."],
          [b("Accept edits"), ": file edits in the workspace go ahead; other commands ask."]]),
        p("A card says exactly what would run or change: ", b("Allow once"), ", ", b("Always"), " (the rule is shown first) or ", b("Deny"),
          " (with a note for Claude). ⋯ › ", b("Permissions"), " lists the rules, with Remove."),
        note(b("Auto"), " (a reviewer model decides; about $0.13 per 5 minutes in use) and ", b("Bypass permissions"), " stay off until ",
          settings("Claude Code", "CODE_AUTO_MODE"), " allows them, from the computer running bedrock-now (", doc("permissions-and-modes", "details"), ")."),
      ],
      actions: () => [openCode()],
    },
    "code-models": {
      title: "Pick a model", optional: true, when: () => CODE.here,
      body: () => [
        p("The model picker (top bar, or the model in the status bar) lists every enabled chat model: Claude, Bedrock's other providers and, with OpenRouter, the models you enabled — with prices, a search and ☆ to star the ones you use."),
        list("ul", [
          ["Claude (no badge): tools, thinking, prompt caching."],
          [b("works"), ": its tool calls round-trip (GPT-6, Grok, Mistral Large 3)."],
          [b("chat only"), ": it answers, but cannot read, edit or run anything (Llama 3.3 70B)."],
          [b("not tested"), ": OpenRouter models nobody checked yet."]]),
        p(settings("Claude Code", "CODE_MODELS"), " › ", b("Models for Claude Code"), " picks what the picker lists, and ", b("Default model for new sessions"),
          " which one they start on. In your terminal, ", code("claude-bedrock --models"), " lists them and ", code("claude-bedrock --model mistral-large-3"), " starts on one."),
        note("Switching writes the prompt cache for that model again (the picker says how much). ⋯ › ", b("Budget for this session"),
          " warns at 50 % and 80 % of an amount you choose, and can stop Claude at it."),
      ],
      actions: () => [openCode()],
    },
    "code-workspace": {
      title: "Your workspace: files, search, previews", optional: true, when: () => CODE.here, cfg: true,
      body: () => [
        cfg && cfg.workspace ? p("Claude sees one folder of this computer: ", code(cfg.workspace), " (", code("/workspace"), " in the sandbox) — nothing else of yours.")
          : p("Claude sees one folder of this computer, its workspace (", code("/workspace"), " in the sandbox; ", code("./stack code status"), " names it) — nothing else of yours."),
        list("ul", [
          [b("Projects"), ": a folder of the workspace each. The project chip at the top switches; ", b("New project"), " makes one (an empty folder with git init, a clone, or a folder already there). New sessions, the explorer, search, Git and Run & test follow it."],
          ["The explorer: new file or folder, rename, delete (into ", code(".bedrock-now-trash/"), "), drag files in to upload them."],
          [kbd("Ctrl/⌘+P"), " goes to a file, ", kbd("Ctrl/⌘+Shift+F"), " searches in files, ", kbd("Ctrl/⌘+K"), " opens the command palette (every action, session and file)."],
          [b("Preview"), " shows Markdown (with Mermaid diagrams), PDF, Word, Excel, CSV, notebooks, images, and HTML in a sandboxed viewer; ", b("Source"), " is the editor."],
          ["⋯ › ", b("Memory (CLAUDE.md)"), ": the workspace's standing instructions for Claude."]]),
        note("Another folder: ", code("./stack code enable --workspace DIR"), ". What Claude writes there may run on your computer later (git hooks, package scripts): the page flags those files after each turn, with Revert."),
      ],
      actions: () => [openCode()],
    },
    "code-context": {
      title: "Ask with context", optional: true, when: () => CODE.here,
      body: () => [
        p("Type ", code("@"), " in the prompt box:"),
        list("ul", [
          [code("@file"), " picks a file anywhere in the workspace; ", code("@file#L5-10"), " those lines — or select lines in the editor and press ", kbd("Alt+K"), "."],
          [code("@terminal"), ": the terminal panel's last 200 lines; ", code("@diff"), ": the changes in Review; ", code("@problems"), ": Run & test's failed runs."],
          ["Each becomes a chip: click it to see exactly what goes, × to drop it."],
          ["On a plan, ", b("Comment on lines"), ": a note on any line goes back with ", b("Keep planning"), "."],
          ["Paste or drop an image to send it; other files are uploaded into the workspace and mentioned."]]),
        note("A chip carries the workspace's text as part of your message: in Auto or Bypass mode, read the chips before you send."),
      ],
      actions: () => [openCode()],
    },
    "code-clone": {
      title: "Clone a repository", optional: true, when: () => CODE.here,
      body: () => [
        p(b("Clone a repository"), " below, a new session's ", b("Clone a repository"), ", or the command palette's ", b("Git: clone a repository…"), " (", kbd("Ctrl/⌘+K"),
          "; the Git panel, ", kbd("Ctrl/⌘+Shift+G"), ", has it too while the workspace is not a repository yet): the URL, a new folder of the workspace (named after the repository) and, if you like, only the latest commit."),
        list("ul", [
          ["A public repository needs no git host; a private one needs its host connected (", b("Connect a git host"), ", above)."],
          ["Nothing is fetched before you confirm where it clones from, and with which credential."],
          ["Submodules are not cloned, and no hook of the repository runs."],
          ["The clone becomes a project of its own: the project chip at the top switches between it, your other projects and the Workspace."]]),
      ],
      actions: () => [openGit("clone")],
    },
    "code-review": {
      title: "Review, commit, push", optional: true, when: () => CODE.here,
      body: () => [
        list("ul", [
          [b("Review"), " in the top bar (", kbd("Ctrl/⌘+Shift+D"), ") lists every changed file: ", b("Keep"), " or ", b("Undo"), " each change; a comment on a line goes with your next prompt."],
          ["The ", b("Git"), " panel: ", b("Stage"), ", then ", b("Commit"), " (", kbd("Ctrl/⌘+Enter"), "); ", b("Write message"),
            " drafts one from the staged diff. Commits made here run no git hooks."],
          [b("Fetch"), ", ", b("Pull"), " (fast-forward only) and ", b("Push"), " — or ", b("Publish branch"),
            " for a new one: the page shows where it goes, and with which credential, before anything is sent."],
          ["After a push to GitHub or GitLab, ", b("Open a pull request"), " opens the host's page for it. The branch button switches and creates branches."]]),
      ],
      actions: () => [openCode()],
    },
    "code-run": {
      title: "Run, test, preview", optional: true, when: () => CODE.here,
      body: () => [
        list("ul", [
          [b("Run & test"), " (", kbd("Alt+R"), ", or Run in the status bar): the workspace's ", code("package.json"), " scripts, Makefile targets and ",
            code("pyproject.toml"), " entry points. ", b("Run"), " shows exactly what runs, then runs it in a terminal window; failures go to ",
            b("Problems"), ", and ", b("Ask Claude"), " drafts a prompt to fix them."],
          [b("Ports & previews"), " (", kbd("Alt+P"), "): every server listening in the sandbox. When Claude starts a dev server, ", b("Preview :5173"),
            " shows it beside the chat; ", b("Open in a new tab"), " gives it the browser's developer tools."],
          [code(".claude/launch.json"), "'s dev servers are listed there too, with ", b("Start"), "."]]),
        note("All of it runs in the sandbox, not on your computer. Previews over remote access stay off unless you turn them on (",
          doc("previews-of-dev-servers", "how"), ")."),
      ],
      actions: () => [openCode()],
    },
    terminal: {
      title: "The browser terminal", optional: true, when: () => TERM.here,
      body: () => [
        p("Claude Code in a sandbox that sees only your workspace folder: in the ", b("Terminal"), " tab, ", code("claude-bedrock"),
          " starts by itself in its first window. It asks for the portal password again."),
        list("ul", [
          ["Closing the tab keeps it running: come back later, or from your phone, and it is where you left it."],
          [code("Ctrl-b c"), " opens a shell beside it; ", code("Ctrl-b n"), " goes to the next window."],
          ["The Code page's ", b("Open in the terminal"), " continues one of its sessions here, in a window of its own."]]),
      ],
      actions: () => [openTerminal()],
    },
    sandbox: {
      title: "What the sandbox can reach", info: true, when: () => CODE.here || TERM.here, cfg: true,
      body: () => {
        const now = cfg && cfg.egress ? { internet: "Internet only (the default)", host: "+ this computer", off: "Off" }[cfg.egress] : "";
        return [
          now ? el("p", { class: "tour-status" }, "Now: ", b(now)) : null,
          p(settings("Claude Code", "TERMINAL_EGRESS"), " › ", b("Sandbox internet access"), ":"),
          list("ul", [
            [b("Internet only"), ": public addresses on ports 80, 443 and 22 — git, npm, pip, web pages — through the sandbox's egress proxy; never this computer's own services or your network."],
            [b("+ this computer"), ": also what runs on this computer (a dev server, a database) and your local network."],
            [b("Off"), ": only LiteLLM and the shared MCP server."]]),
          p("Narrower, in ", code(".env"), " and then ", code("./stack up"), ": ", code("TERMINAL_EGRESS_ALLOW"), " (only these names) and ",
            code("TERMINAL_EGRESS_DENY"), " (never these). What the proxy refused: ", code("./stack logs terminal-egress"), "."),
          note("Opening it further works only from the computer running bedrock-now; a change restarts the terminal (its shells and open Code sessions end)."),
        ];
      },
    },
    "code-plugins": {
      title: "Plugins and MCP servers", optional: true, when: () => CODE.here,
      body: () => [
        list("ul", [
          ["⋯ › ", b("Plugins & marketplaces"), ": add a marketplace (", code("owner/repo"), ", a git URL or a folder of the workspace), install, update or turn off plugins. One that installs by running a command shows it, with its SHA-256, before ",
            b("Run this command and install"), "."],
          ["⋯ › ", b("MCP servers"), ": each server of the session with its tools, ", b("Reconnect"), ", and your own (stdio, HTTP or SSE). A stdio server runs inside the sandbox, never on your computer."],
          [code("bedrock-shared"), " is always there: the shared store and Chat's knowledge bases (", b("One store for both"), ", below)."]]),
        note("Every plugin and MCP server adds its definitions to each request, billed per token: add what you use."),
      ],
      actions: () => [openCode()],
    },
    // ---------------- Your own tools
    claude: {
      title: "Claude Code in your terminal", optional: true, live: true,
      spendKey: "claude-code",   // (claude-bedrock's key; the Code tab's spend is Open Code and ask's, on the terminal's key)
      waiting: "Not detected yet: spend can take a minute to show.",
      body: () => [
        p("In a terminal, in a project folder:"), cmd(command()),
        p("Its first line shows the model's price and your budget; when you exit, it prints what the session cost and how to come back: ",
          code("resume: claude-bedrock --resume <id>"), "."),
        p("Type ", code("/mcp"), ": ", code("bedrock-shared"), " is connected. Then ask:"),
        cmd(PROMPT, "the prompt"),
        PHONE.matches && !CODE.here ? note("From a phone, ", code("./stack ssh-info"), " shows how to reach Claude Code over SSH.") : null,
        codeLine(true),
      ],
      actions: () => [openCode()],   // (while it is off here: its tab's page, how to turn it on)
    },
    api: {
      title: "The models from your own code", optional: true, cfg: true, live: true,
      body: (d) => {
        const base = cfg && cfg.port ? `http://127.0.0.1:${cfg.port}` : "";
        const shown = base || "http://127.0.0.1:PORT";
        const ex = snippets(shown, snippetModel(d));
        return [
          p("Scripts, notebooks and other tools can use the same models, on the same budgets and logs, through LiteLLM's API on this computer:"),
          base ? cmd(base, "the API's address", "copy-api-base")
            : note("PORT below: the port on the LiteLLM API line ", code("./stack status"), " prints (", code("LITELLM_PORT"), " in ", code(".env"), ")."),
          list("ul", [
            ["OpenAI-compatible: ", code(`${shown}/v1`), " (", code("/chat/completions"), ", ", code("/models"), ")."],
            ["Anthropic-compatible: ", code(shown), " (", code("/v1/messages"), ")."],
            ["A key for each tool: ", b("Admin"), " › ", b("Virtual Keys"), " › ", b("+ Create New Key"),
              ": a name, the models it may use and, under Optional Settings, its own budget. Its spend then shows in Admin, apart from the apps'."],
            ["Model names: the Models card on Home, or ", code("./stack models"), "."]]),
          snippet("curl", "curl", ex.curl),
          snippet("openai", "Python: openai", ex.openai),
          snippet("anthropic", "Python: anthropic", ex.anthropic),
          note("Put the key in place of YOUR_KEY (or ", code("OPENAI_API_KEY"), " / ", code("ANTHROPIC_API_KEY"), " with ", code("OPENAI_BASE_URL"), " / ",
            code("ANTHROPIC_BASE_URL"), "). LiteLLM's port listens on ", code("127.0.0.1"), " only: tools on other devices cannot reach it. Over remote access LiteLLM is the ",
            b("Admin"), " site, behind your portal sign-in — not an endpoint for tools (", doc("the-models-from-your-own-code", "more"), ")."),
        ];
      },
      actions: () => [openApp("admin"), showOnHome("models", "Show models")],
    },
    // Your AI subscriptions' own tools in the sandbox (answers.js, lib/subscriptions.sh), and keys
    subscriptions: {
      title: "Your AI subscriptions and keys", optional: true,
      body: () => [
        p("Your own plans work here too — each through its provider's own app, in the sandbox, signed in with that app's own sign-in:"),
        list("ul", [
          [b("Claude Code"), " on your Claude plan (", code("claude-sub"), "), ", b("Codex"), " on your ChatGPT plan, ", b("Copilot"), ", ", b("Cursor"), ", ",
            b("Grok"), " (SuperGrok or the X Subscription) and ", b("Gemini CLI"), " (an organisation's Gemini Code Assist, or your own Gemini API key — Google AI Pro and Ultra no longer work in it)."],
          [b("Signing in"), ": pick the tool in the terminal's ", b("Open"), " menu (or type its name there). It shows a link (and for most a code): open the link in your browser and sign in with the provider. Codex, Copilot, Cursor and Grok then finish by themselves; ",
            b("Claude Code"), " and ", b("Gemini CLI"), " show a code in your browser that you paste back into the terminal. Codex needs ", b("device code login"), " turned on in ChatGPT's Security settings first."],
          ["Each login stays in that tool's own file in the sandbox: ", b("bedrock-now never sees it"), ", and backups leave it out. Anything running in the sandbox could read it: sign out and revoke it at the provider if that ever worries you — Settings' ",
            b("Sign out"), " for Claude Code, Codex, Cursor and Grok; Gemini CLI and Copilot sign out inside themselves (", code("/auth signout"), ", ", code("/logout"), ")."]]),
        p(b("Who answers"), ", on each page:"),
        list("ul", [
          [b("Terminal"), ": the ", b("Open"), " menu above it — Claude Code on Bedrock, a tool of yours, or a shell, each in a window of its own (the Code page's terminal panel has the same)."],
          [b("Chat"), ": the ", b("Who answers"), " menu above it — a Bedrock or OpenRouter model in Open WebUI, or one of your tools ", b("itself"), ", right there, in the folder you pick. As Chat ", b("models"), " in the same conversation view, your subscriptions are planned — greyed out until then, each saying how and under which of its provider's terms (Google's plans no longer work in Gemini CLI: your own Gemini key instead); so are your own API keys (OpenAI, Anthropic, xAI, Google, Mistral)."]]),
        note("Usage counts against each plan's own limits; bedrock-now shows no $ for it. ", settings("Claude Code", "+subscriptions"), " › ",
          b("Your AI subscriptions"), " lists each tool, whether it says it is signed in, ", b("Sign out"), " and ", b("Check again"), "; ", code("./stack subscriptions"), " in a terminal."),
      ],
      actions: () => (TERM.here ? [openTerminal()] : []),
    },
    shared: {
      title: "One store for both", optional: true,
      body: () => [
        p("Open Files → bucket ", code("shared"), " → ", code("notes/hello.md"), ": the file Claude Code just wrote (bucket ",
          code("openwebui"), " holds Chat's uploads)."),
        p("Then in Chat type ", code("#"), ", pick the knowledge base ", b("Claude Code"), " and ask “What does hello.md say?”: Chat answers from the file Claude Code wrote."),
        p("The other way round, files you upload to ", code("shared"), " in Files can be read by Claude Code (", code("read_file"), ")."),
      ],
      actions: () => [openApp("files"), openApp("chat")],
    },
    // ---------------- Keep it running
    home: {
      title: "Home: your dashboard", info: true,
      body: () => [
        list("ul", [
          [b("Services"), ": green means running."],
          [b("Spend"), ": each app's key against its monthly budget, and the total of the last 30 days."],
          [b("Models"), ": status, price, and why a model is not available."],
          CODE.here ? [b("Code"), ": the sessions that need you, with Answer and Resume, and a box to start a prompt in Code."] : null].filter(Boolean)),
        note("If you use free OpenRouter models, the cost switch on the Spend card shows what you were actually charged ($0 for free models) or what the same usage would have cost at paid rates."),
        // (desktops: tablets always have the icon rail, phones the tab bar)
        !PHONE.matches && !TABLET.matches ? note("More room for an app: the button at the top of the sidebar (or ", kbd("Ctrl/⌘+\\"),
          ") folds it to its icons, and back; this browser remembers it.") : null,
      ],
      actions: () => [showOnHome("spend", "Show spend"), showOnHome("services", "Show services"), showOnHome("models", "Show models")],
    },
    activity: {
      title: "Activity and search", info: true,
      body: () => [
        list("ul", [
          [b("Activity"), PHONE.matches ? " (More → Activity)" : " (the bell at the top of the sidebar)",
            ": budget alerts, an update, Code sessions that need you, jobs, and each use Claude's git made of a host. Mark as read, or ✕."],
          [b("Search"), " (", kbd("Ctrl/⌘+K"), " with the focus in the portal, or the box at the top of the sidebar): pages, settings by name or key, Code sessions and workspace files, Chat conversations, these steps and the docs."],
          ["Browser notifications are off until you turn them on in Activity's panel; they never show a prompt or a title."]]),
      ],
      actions: () => [openPanel("activity"), openPanel("search")],
    },
    admin: {
      title: "Admin: where the money went",
      body: () => [
        list("ul", [
          [b("Virtual Keys"), ": one key per app (claude-code, open-webui, ", CODE.here || TERM.here ? "claude-code-terminal, " : "", "setup) and the ones you made for your tools, each with its spend and budget."],
          [b("Usage"), ": spend by model and day."],
          [b("Logs"), ": every request with its tokens and cost."]]),
        p(code("./stack costs"), " prints the same in a terminal:"), cmd("./stack costs"),
      ],
      actions: () => [openApp("admin")],
    },
    updates: {
      title: "Updates, backups and rollback", optional: true, cfg: true,
      detectCfg: (c) => c.helper ? { ok: true, text: `One-click updates are on${c.auto ? ", automatic at night" : ""}${c.nightly ? "; nightly backups on" : ""}` }
        : { ok: false, text: "One-click updates are off: the update helper is not running." },
      body: () => [
        list("ul", [
          ["When a release is out, Home shows an ", b("update card"), " with each release's notes; ", b("Update now"), " backs up, updates and restarts (a few minutes)."],
          [b("Check for updates"), " at the top of Home (and in ", settings("Updates & backups", "UPDATE_CHECK"), ") asks GitHub now instead of waiting for the daily check."],
          [settings("Updates & backups"), ": ", b("Automatic updates"), " at night, ", b("Nightly backups"), ", ", b("Back up now"), " and the list of backups."],
          ["A new version misbehaves? ", b("Roll back"), " on Home, or ", code("./stack rollback"), ", goes back to the version before, with its data."]]),
        cfg && !cfg.helper ? p("These buttons, and changes in Settings, need the update helper:") : p("In a terminal, the same:"),
        cfg && !cfg.helper ? cmd("./stack helper install") : cmd("./stack update"),
        note("Your data stays across updates; a backup is taken before each one (", doc("updating", "Updating"), ")."),
      ],
      actions: () => [showOnHome(null, "Show Home")],
    },
    phone: {
      title: "From your phone", optional: true, live: true,
      detect: (d) => (d.remote && d.remote.on ? { ok: true, text: `Remote access is on (${d.remote.mode === "domain" ? "your own domain" : "Tailscale"})` } : null),
      body: () => [
        p("Remote access serves the portal over HTTPS to your own devices, through Tailscale, with no port opened to the internet:"),
        cmd("./stack remote enable tailscale"),
        list("ul", [
          ["On the phone: Safari's Share › ", b("Add to Home Screen"), " (Android: Chrome's ⋮ › Install app). Chat opens first; the rest is under ", b("More"), "."],
          ["The Terminal and the Code page stay off there unless ", code("REMOTE_TERMINAL=true"), "; updates and Settings changes unless ", code("REMOTE_ADMIN_ACTIONS=true"), "."],
          ["Claude Code over SSH instead: ", code("./stack ssh-info"), "."]]),
        note(ext(`${REPO}/blob/main/docs/remote.md`, "How remote access works"), ", and ", doc("using-it-on-your-phone", "using it on your phone"), "."),
      ],
    },
    done: {
      title: "You're set", info: true,
      body: () => [
        p("Back on Home, the spend now includes what you just did."),
        p("Every step stays here: click one to read it again. ", code("./stack help"), " lists every command, and the README every feature (",
          ext(REPO, "on GitHub"), ")."),
      ],
      actions: () => [showOnHome(null, "Back to Home")],
    },
  };
  const SECTIONS = [
    { title: "Set up", steps: ["welcome", "aws", "openrouter", "voice", "claude-setup", "git-hosts", "budgets", "extras"] },
    { title: "Your apps (one sign-in)", steps: ["signin-portal", "signin-chat", "signin-admin", "signin-files"] },
    { title: "Chat", steps: ["chat", "voice-use", "docs"] },
    { title: "Code with Claude", steps: ["code-off", "code-open", "code-modes", "code-models", "code-workspace", "code-context", "code-clone", "code-review", "code-run", "terminal", "sandbox", "code-plugins"] },
    { title: "Your own tools", steps: ["claude", "api", "subscriptions", "shared"] },
    { title: "Keep it running", steps: ["home", "activity", "admin", "updates", "phone", "done"] },
  ];
  // steps of apps this site does not offer (the terminal, the Code page) are left out, not shown as open
  for (const sec of SECTIONS) sec.steps = sec.steps.filter((id) => !STEPS[id].when || STEPS[id].when());
  const ORDER = SECTIONS.flatMap((s) => s.steps);
  const secOf = (id) => SECTIONS.findIndex((s) => s.steps.includes(id));

  // --- state: {open, cur ("" = the finished view), done, skipped, base: {key alias: spend when first shown}, seen} ---
  function load() {
    let text = null;
    try { text = localStorage.getItem(KEY); } catch (_) { /* storage blocked: start fresh */ }
    return parse(text, Object.keys(STEPS));
  }
  // false when storage is blocked: progress then lasts for this page only
  function save() {
    const { open, cur, done, skipped, base, seen } = st;
    try { localStorage.setItem(KEY, JSON.stringify({ open, cur, done, skipped, base, seen })); return true; } catch (_) { return false; }
  }

  // (a first visit has seen everything listed now; the steps new to this browser are marked New while it reads them)
  let st = resolve(load(), ORDER);
  let sum = null, sumAt = 0, askedAt = 0, failedAt = 0, pollT = null, shown = "";
  let cfg = null, cfgAt = 0, cfgAsked = 0, cfgFailed = 0, cfgT = null;
  let openSecs = new Set();
  const freshAtLoad = new Set(unseen(ORDER, st.seen));
  const isDone = (id) => st.done.includes(id);
  const isSkipped = (id) => st.skipped.includes(id);
  const handled = (id) => isDone(id) || isSkipped(id);
  const isNew = (id) => !st.seen.includes(id);
  const newCount = () => unseen(ORDER, st.seen).length;
  function mark(id, how) {   // how: "done" | "skipped" | null (undo)
    st.done = st.done.filter((x) => x !== id);
    st.skipped = st.skipped.filter((x) => x !== id);
    if (how === "done") st.done.push(id); else if (how === "skipped") st.skipped.push(id);
  }

  // what each LiteLLM key has spent, from the summary: {alias: spend}
  function spentNow() {
    const out = {};
    for (const a of ["open-webui", "claude-code", "claude-code-terminal"]) { const v = spendOf(a); if (v != null) out[a] = v; }
    return out;
  }
  function detection(id) {
    const s = STEPS[id];
    if (!s) return null;
    if (s.local) return s.local();
    if (s.detectCfg) return cfg ? s.detectCfg(cfg) : null;
    if (!sum) return null;
    if (s.spendKey) {
      const r = spendState(st.base, id, [s.spendKey], spentNow());
      return !r ? null : r.ok ? { ok: true, text: `Detected ✓ (${usd(r.more)} more on the ${r.alias} key)` } : { ok: false, text: s.waiting };
    }
    return s.detect ? s.detect(sum) : null;
  }
  // The spend a "did it work?" step compares against: its own, taken when it is first shown, from a summary at most
  // 30 s old (never another step's, nor one an older walkthrough left).
  function noteBaseline() {
    const s = STEPS[st.cur];
    if (!s || !s.spendKey || Date.now() - sumAt > POLL_MS) return;
    st.base = withBaseline(st.base, st.cur, [s.spendKey], spentNow());
  }
  function detectAll() {
    const flipped = [];
    for (const id of ORDER) {
      const r = detection(id);
      if (r && r.ok && !isDone(id)) { mark(id, "done"); flipped.push(id); }
    }
    return flipped;
  }
  // What the current card shows from the summary, the settings and the Code tab's report.
  const digest = () => JSON.stringify([st.cur, detection(st.cur) || null, Boolean(sum), sum && sum.voice && sum.voice.on,
    sum && sum.claude && sum.claude.command, sum && sum.spend && (sum.spend.keys || []).map((k) => [k.label, k.max_budget, k.error]),
    STEPS[st.cur] && STEPS[st.cur].cfg ? [cfg, Boolean(cfgFailed)] : null, st.cur === "api" ? snippetModel(sum) : ""]);
  function announce(text) { live.textContent = ""; setTimeout(() => { live.textContent = text; }, 50); }
  // after new data: steps detected as done, the panel drawn again only when what it shows changed (a rebuild every 30 s
  // would disturb reading and selecting)
  function settle(store = false) {
    const flipped = detectAll();
    if (store || flipped.length) save();
    if (st.open && flipped.includes(st.cur)) announce(`${STEPS[st.cur].title}: detected, done.`);
    if (st.open && (flipped.length || digest() !== shown)) render(); else renderButtons();
  }

  function onSummary(d) {
    if (!d || d === sum) return;
    sum = d; sumAt = Date.now(); failedAt = 0;
    // a key's spend below a baseline: a new budget period — the baseline comes down to it
    for (const k of Object.keys(st.base)) {
      const v = spendOf(k.slice(k.indexOf(":") + 1));
      if (v != null && v < st.base[k]) st.base[k] = v;
    }
    noteBaseline();
    settle(true);
    poll();
  }

  // At most one /api/summary every 30 s, only while the panel shows a step that needs it. While Home is on screen,
  // app.js refreshes it every 30 s and the MutationObserver below hands each one over: this waits 10 s longer, so it
  // only asks when Home's refresh did not come.
  const homeOwns = () => !$("#home").hidden && !document.hidden;
  function poll() {
    clearTimeout(pollT); pollT = null;
    const s = STEPS[st.cur];
    if (!st.open || !s || !s.live || document.hidden) return;
    const wait = Math.max(sumAt, askedAt) + POLL_MS + (homeOwns() ? 10000 : 0) - Date.now();
    if (wait > 0) { pollT = setTimeout(poll, wait); return; }
    askedAt = Date.now();   // also when it fails: the next try is 30 s away
    api("/api/summary").then(onSummary, (e) => {
      if (e.message === "signed out") return;
      failedAt = Date.now();
      if (st.open && !sum) render();   // an earlier summary stays on screen: no redraw every 30 s during an outage
    }).finally(() => { clearTimeout(pollT); pollT = setTimeout(poll, POLL_MS); });
  }
  // The settings snapshot (the LiteLLM port, the workspace folder, the sandbox's internet, the update helper): asked
  // while the panel shows a step that needs it, kept 5 minutes; when it cannot be read, the step says so and it is
  // asked again every 30 s while such a step is shown.
  function askCfg() {
    clearTimeout(cfgT); cfgT = null;
    const s = STEPS[st.cur];
    if (!st.open || !s || !s.cfg || document.hidden) return;
    if (cfg && Date.now() - cfgAt < CFG_MS) return;
    const wait = cfgAsked + POLL_MS - Date.now();   // (at most every 30 s: asked again when that is up)
    if (wait > 0) { cfgT = setTimeout(askCfg, wait); return; }
    cfgAsked = Date.now();
    api("/api/settings").then((d) => { cfg = cfgFrom(d); cfgAt = Date.now(); cfgFailed = 0; settle(); }, (e) => {
      if (e && e.message === "signed out") return;
      cfgFailed = Date.now();
      if (st.open) render();
      clearTimeout(cfgT); cfgT = setTimeout(askCfg, POLL_MS);
    });
  }

  // --- rendering ---
  const panel = $("#tour"), opener = $("#tour-btn"), moreEntry = $("#more-tour");
  if (!panel || !opener) return;
  const head = el("div", { class: "tour-head" });
  const scroller = el("div", { class: "tour-scroll" });
  const live = el("p", { class: "tour-sr", "aria-live": "polite" });
  panel.append(head, scroller, live);

  function progress() { return ORDER.filter(handled).length; }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function renderButtons() {
    const n = progress(), all = n === ORDER.length, fresh = newCount();
    $("#tour-count").textContent = fresh ? `${fresh} new` : all ? "✓" : `· ${n}/${ORDER.length}`;
    $(".tour-btn-bar i", opener).style.width = `${(n / ORDER.length) * 100}%`;
    opener.setAttribute("aria-expanded", String(Boolean(st.open)));
    opener.classList.toggle("has-new", fresh > 0);
    const words = (fresh ? `Walkthrough: ${plural(fresh, "new step", "new steps")} · ` : "Walkthrough: ") + (all ? "finished" : `${n} of ${ORDER.length} steps done`);
    if (rail()) opener.title = words; else opener.removeAttribute("title");
    if (moreEntry) {
      $("#more-tour-note").textContent = fresh ? `${plural(fresh, "new step", "new steps")} since you last looked · ${n}/${ORDER.length}`
        : all ? "Finished ✓ · read it again" : `Set up, Chat, Code, your own tools · ${n}/${ORDER.length}`;
    }
  }

  const newPill = () => el("span", { class: "tour-new", text: "New" });
  function stepItem(id) {
    const li = el("li", { class: "tour-step", "data-step": id });
    if (isDone(id)) li.classList.add("done"); else if (isSkipped(id)) li.classList.add("skipped");
    if (id === st.cur) {
      li.classList.add("cur"); li.setAttribute("aria-current", "step");
      li.append(card(id));
      return li;
    }
    const go = button("", `go-${id}`, () => nav(id), "tour-step-btn");
    go.append(el("span", { class: "tour-mark", "aria-hidden": "true", text: isDone(id) ? "✓" : isSkipped(id) ? "–" : "○" }),
      el("span", { class: "tour-step-title", text: STEPS[id].title }));
    if (isNew(id)) go.append(newPill());
    if (handled(id)) go.append(el("span", { class: "tour-sr", text: isDone(id) ? " (done)" : " (skipped)" }));
    li.append(go);
    return li;
  }

  function card(id) {
    const s = STEPS[id], det = detection(id), i = ORDER.indexOf(id);
    const n = el("div", { class: "tour-card" },
      el("h4", { id: "tour-cur", tabindex: "-1", "data-k": "heading" }, el("span", { class: "tour-mark", "aria-hidden": "true", text: isDone(id) ? "✓" : "●" }),
        el("span", { text: s.title })));
    const tags = [...(freshAtLoad.has(id) ? ["New"] : []), ...(s.badges || []), ...(s.optional ? ["Optional"] : [])];
    if (tags.length) n.append(el("p", { class: "tour-badges" }, ...tags.map((t) => el("span", { class: `tour-badge${t === "New" ? " new" : ""}`, text: t }))));
    if (det && det.text) {
      n.append(el("p", { class: `tour-status${det.ok ? " ok" : det.warn ? " warn" : ""}`,
        text: det.ok && !det.text.startsWith("Detected") ? `✓ ${det.text}` : det.text }));
    } else if ((s.detect || s.spendKey) && !sum) n.append(el("p", { class: `tour-status${failedAt ? " warn" : ""}`, text: failedAt ? CHECK_FAILED : "Checking…" }));
    else if (s.cfg && !cfg) n.append(el("p", { class: `tour-status${cfgFailed ? " warn" : ""}`, text: cfgFailed ? CFG_FAILED : "Checking…" }));
    n.append(...s.body(sum).filter(Boolean));
    const acts = s.actions ? s.actions(sum).filter(Boolean) : [];
    if (acts.length) n.append(el("div", { class: "tour-actions" }, ...acts));

    const row = el("div", { class: "tour-done-row" });
    if (isDone(id)) {
      row.append(el("span", { class: "tour-state ok", text: "✓ Done" }));
      if (!(det && det.ok) && id !== "signin-portal") row.append(button("Undo", "undo", () => { mark(id, null); commit(); }, "quiet"));
    } else if (isSkipped(id)) {
      row.append(el("span", { class: "tour-state", text: "Skipped" }), button("Undo", "undo", () => { mark(id, null); commit(); }, "quiet"));
    } else if (!s.info) {
      if (!s.skipOnly) row.append(button("Mark as done", "mark", () => { mark(id, "done"); advance(); }));
      if (s.optional) row.append(button("Skip", "skip", () => { mark(id, "skipped"); advance(); }, "quiet"));
    }
    if (row.children.length) n.append(row);

    const back = button("Back", "back", () => nav(ORDER[i - 1]), "quiet");
    back.disabled = i === 0;
    const last = i === ORDER.length - 1;
    const fwd = button(last ? "Finish" : "Next", "next", () => {
      if (s.info) mark(id, "done");
      if (last) { finish(); return; }
      nav(ORDER[i + 1]);
    }, "action primary");
    n.append(el("div", { class: "tour-nav" }, back, fwd));
    return n;
  }

  const firstNew = () => ORDER.find(isNew) || "";
  function finishedCard() {
    const left = ORDER.filter((id) => !handled(id)).length, fresh = newCount();
    return el("div", { class: "tour-card tour-finished" },
      el("h4", { id: "tour-cur", tabindex: "-1", "data-k": "heading",
        text: fresh ? `${plural(fresh, "new step", "new steps")} since you last looked` : left ? `${left} step${left === 1 ? "" : "s"} still open` : "You're all set" }),
      p(fresh ? "They are marked New below. " : left ? "Pick one below to finish or skip it." : "Every step is done or skipped. Click any step below to read it again.",
        fresh ? button("Show the first new one", "first-new-card", () => nav(firstNew()), "tour-link") : ""),
      el("div", { class: "tour-nav" }, button("Start over", "restart", restart, "tour-link"),
        button("Close", "close-done", () => setOpen(false), "action primary")));
  }

  function render(opts = {}) {
    // the step on screen has been opened: no longer new (its card keeps its New badge until the next load)
    if (st.cur && isNew(st.cur)) { st.seen.push(st.cur); save(); }
    renderButtons();
    const n = progress(), fresh = newCount();
    const k = !opts.focus && panel.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    const top = scroller.scrollTop;
    const close = button("", "close", () => setOpen(false), "tour-x");
    close.setAttribute("aria-label", "Close walkthrough");
    close.title = "Close (the Walkthrough button opens it again)";
    close.append(el("span", { "aria-hidden": "true", text: "✕" }));
    const bar = el("i"); bar.style.width = `${(n / ORDER.length) * 100}%`;
    head.replaceChildren(
      el("h2", { id: "tour-title", text: "Walkthrough" }),
      el("p", { class: "tour-prog", text: n === ORDER.length ? `All ${ORDER.length} steps done` : `${n} of ${ORDER.length} steps done` }),
      close,
      el("div", { class: "tour-bar", role: "progressbar", "aria-label": "Walkthrough progress", "aria-valuemin": "0",
        "aria-valuemax": String(ORDER.length), "aria-valuenow": String(n) }, bar),
      fresh && st.cur !== "" ? el("p", { class: "tour-newline", "data-k": "newline" }, `${plural(fresh, "step is", "steps are")} new since you last looked. `,
        button("Show the first", "first-new", () => nav(firstNew()), "tour-link")) : "");

    const parts = st.cur === "" ? [finishedCard()] : [];
    SECTIONS.forEach((sec, si) => {
      if (!sec.steps.length) return;
      const open = openSecs.has(si);
      const toggle = button("", `sec-${si}`, () => { if (openSecs.has(si)) openSecs.delete(si); else openSecs.add(si); render(); }, "tour-sec-btn");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-controls", `tour-sec-${si}`);
      const freshHere = sec.steps.filter(isNew).length;
      toggle.append(el("span", { class: "tour-chev", "aria-hidden": "true" }), el("span", { class: "tour-sec-name", text: `${si + 1}. ${sec.title}` }),
        freshHere ? el("span", { class: "tour-new", text: `${freshHere} new` }) : "",
        el("span", { class: "tour-sec-count", text: `${sec.steps.filter(handled).length}/${sec.steps.length}` }));
      const ol = el("ol", { class: "tour-steps", id: `tour-sec-${si}` }, ...sec.steps.map(stepItem));
      ol.hidden = !open;
      parts.push(el("section", { class: "tour-sec" }, el("h3", {}, toggle), ol));
    });
    scroller.replaceChildren(...parts);

    shown = digest();
    if (opts.focus) {
      const h = $("#tour-cur", panel);
      if (h) {
        // Scrolled so the section's heading is at the top, or, when the card would not fit below it, the card.
        const c = h.closest(".tour-card"), sec = c.closest(".tour-sec"), view = scroller.getBoundingClientRect();
        const card = c.getBoundingClientRect();
        let delta = (sec || c).getBoundingClientRect().top - view.top - 4;
        if (card.bottom - delta > view.top + scroller.clientHeight) delta = card.top - view.top - 4;
        scroller.scrollTop += delta;
        if (opts.focus === "heading") h.focus({ preventScroll: true });
      }
    } else {
      scroller.scrollTop = top;
      const again = k && panel.querySelector(`[data-k="${CSS.escape(k)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  function commit(opts) { save(); if (st.open) render(opts); else renderButtons(); }

  // The sections shown open: the current step's; on the finished view, those with steps still open.
  function sectionsFor(id) {
    if (id !== "") return new Set([secOf(id)]);
    return new Set(SECTIONS.map((s, i) => (s.steps.every(handled) ? -1 : i)).filter((i) => i >= 0));
  }
  function nav(id) {
    st.cur = id;
    openSecs = sectionsFor(id);
    noteBaseline();
    commit({ focus: "heading" });
    poll();
    askCfg();
  }
  function advance() {   // after Mark as done / Skip
    const i = ORDER.indexOf(st.cur);
    nav(ORDER.every(handled) || i === ORDER.length - 1 ? "" : ORDER[i + 1]);
  }
  function finish() { mark("done", "done"); nav(""); }
  function restart() {
    st = { open: true, cur: "welcome", done: ["signin-portal"], skipped: [], base: {}, seen: st.seen };
    if (sum || cfg) detectAll();
    nav("welcome");
  }

  function setOpen(on, focus = true) {
    st.open = on;
    save();
    document.body.classList.toggle("tour-open", on);
    panel.hidden = !on;
    if (on) {
      openSecs = sectionsFor(st.cur);
      noteBaseline();
      render({ focus: focus ? "heading" : "scroll" });
      requestAnimationFrame(() => panel.classList.add("in"));
    } else {
      panel.classList.remove("in");
      renderButtons();
      if (focus) (PHONE.matches ? $("#more-btn") : opener).focus();
    }
    poll();
    askCfg();
  }
  // Phones and the rail: the sheet or card would cover the app (or the card on Home) it just opened — it steps aside,
  // and focus goes to what opens it again (the compass button, or More).
  function away() {
    if (!(PHONE.matches || rail()) || !st.open) return;
    setOpen(false);
    toast(PHONE.matches ? "The walkthrough is under More" : "The walkthrough is under the compass button");
  }

  // --- wiring ---
  // First visit: open, except on phones (it would cover Chat; it is under More) and when storage is blocked (it
  // would open again on every load). Phones also start closed after a visit that left it open. A browser that went
  // through an older walkthrough is not opened for what is new: the button says how many steps are.
  if (!isDone("signin-portal")) mark("signin-portal", "done");
  const first = st.open === null;
  if (first || PHONE.matches) st.open = !PHONE.matches && first;
  if (!save() && first) st.open = false;
  opener.hidden = false;
  if (moreEntry) moreEntry.hidden = false;
  opener.addEventListener("click", () => setOpen(!st.open));
  if (moreEntry) moreEntry.addEventListener("click", () => { const c = $("#more-close"); if (c) c.click(); setOpen(true); });
  document.body.classList.toggle("tour-open", st.open);
  panel.hidden = !st.open;
  openSecs = sectionsFor(st.cur);
  if (st.open) { render({ focus: "scroll" }); panel.classList.add("in"); } else renderButtons();
  // The sidebar animates its width only after the first paint (no slide on page load).
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add("tour-anim")));

  // app.js refreshes Home's numbers every 30 s and then writes #updated: take its summary from there.
  const updated = $("#updated");
  if (updated) new MutationObserver(() => onSummary(lastSummary)).observe(updated, { childList: true, characterData: true, subtree: true });

  document.addEventListener("bn:tab", (e) => opened(e.detail));
  // the Code tab reported (code.js): how many Git hosts are connected may have changed
  document.addEventListener("bn:code-status", () => settle());
  document.addEventListener("DOMContentLoaded", () => { setTimeout(poll, homeOwns() ? 10000 : 0); askCfg(); });   // after app.js's
  // Back on the page: with Home on screen, app.js refreshes it at once and the #updated observer hands that over (the
  // panel asks only if it did not come); otherwise the panel asks itself if its summary is old.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(pollT); return; }
    if (homeOwns()) askedAt = Date.now();
    poll();
    askCfg();
  });
  // app.js's sign-ins arrive: the Admin / Files step shows the user name.
  const signins = $("#logins");
  if (signins) {
    new MutationObserver(() => { if (st.open && (st.cur === "signin-admin" || st.cur === "signin-files")) render(); })
      .observe(signins, { childList: true, characterData: true, subtree: true });
  }
  document.addEventListener("keydown", (e) => {
    // Escape closes the floating card (the rail) and the sheet (phones); in an expanded sidebar it is part of the page.
    if (e.key !== "Escape" || !st.open || !(PHONE.matches || rail())) return;
    const more = $("#more-sheet"), confirm = $("#confirm");
    if ((more && !more.hidden) || (confirm && confirm.open)) return;
    e.preventDefault();
    setOpen(false);
  });
  const relayout = () => { if (st.open) render(); else renderButtons(); };
  PHONE.addEventListener("change", relayout);
  TABLET.addEventListener("change", relayout);
  document.addEventListener("bn:nav", relayout);   // (collapsed or expanded: the card, or the sidebar's section)
  // The Extras step offers Install app or Open in the app once install.js knows which.
  document.addEventListener("bn:app", () => { if (st.open && st.cur === "extras") render(); });
  // The global search (search.js): the steps by title, and the walkthrough opened at one (or where it was)
  Object.assign(root.bnTour, {
    steps: () => SECTIONS.flatMap((sec) => sec.steps.map((id) => ({ id, title: STEPS[id].title, section: sec.title }))),
    open: (id) => {
      if (id && has(STEPS, id) && ORDER.includes(id)) { if (!st.open) setOpen(true, false); nav(id); return; }
      if (!st.open) setOpen(true); else { const h = $("#tour-cur", panel); if (h) h.focus(); }
    },
  });
})(typeof window !== "undefined" ? window : globalThis);
