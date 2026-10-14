// Walkthrough: takes someone who has never used these apps through all of bedrock-now — what it needs (AWS models,
// OpenRouter, voice, Claude Code, budgets), signing in to each app, then using them together. It lives at the bottom
// of the sidebar: on desktops a section of the widened sidebar (the apps' frames just get narrower), on tablets a
// card next to the icon rail, on phones a sheet above the tab bar opened from More.
// Loaded after app.js and mobile.js (all deferred); uses app.js's globals ($, el, api, showTab, appUrl, copy, toast,
// usd, loadLogins, logins, lastSummary). Progress is a per-browser convenience in localStorage (bn.tour); with
// storage blocked it works for the session. Every node is built with el()/textContent: nothing is parsed as HTML.
"use strict";

(() => {
  const KEY = "bn.tour";
  const POLL_MS = 30000;
  const PHONE = window.matchMedia("(max-width: 767.98px)");
  const TABLET = window.matchMedia("(min-width: 768px) and (max-width: 1099.98px)");
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");
  const REPO = "https://github.com/JongoDB-Labs/bedrock-now";
  const NAMES = { chat: "Chat", admin: "Admin", files: "Files" };
  const PROMPT = 'Write notes/hello.md to the shared store with a two-line summary of this folder, and ingest it into knowledge base "Claude Code".';
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const CHECK_FAILED = "Could not check: Home says why; trying again every 30 s.";

  // --- small builders ---
  const p = (...c) => el("p", {}, ...c);
  const note = (...c) => el("p", { class: "note" }, ...c);
  const b = (t) => el("strong", { text: t });
  const code = (t) => el("code", { text: t });
  const list = (tag, items) => el(tag, { class: "tour-list" }, ...items.map((i) => el("li", {}, ...[].concat(i))));
  const ext = (href, text) => el("a", { href, target: "_blank", rel: "noopener noreferrer", "data-k": `link:${href}`, text });

  function button(label, k, fn, cls = "action") {
    const n = el("button", { type: "button", class: cls, "data-k": k, text: label });
    n.addEventListener("click", fn);
    return n;
  }
  function cmd(text, what = "the command") {
    return el("div", { class: "tour-cmd" }, el("code", { text }), button("Copy", `copy:${text}`, () => copy(text, what), "copy"));
  }
  // An app's "Open" button: its tab, or on a phone (Admin and Files are no tabs there) a link to a new browser tab.
  function openApp(app) {
    const label = `Open ${NAMES[app]}`;
    if (window.bnMobile && window.bnMobile.allowTab(app) !== app) {
      return el("a", { class: "action", href: appUrl(app), target: "_blank", rel: "noopener", "data-k": `open-${app}` },
        label, el("span", { "aria-hidden": "true", text: " ↗" }), el("span", { class: "tour-sr", text: " (opens in a new tab)" }));
    }
    return button(label, `open-${app}`, () => { showTab(app); away(); });
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
  // Admin / Files sign-in: the user name as text (masked in the e2e screenshots), the password only through Copy;
  // its Open button next to the Copy buttons. app.js loads the sign-ins at start-up (the panel redraws once they are
  // in, see "wiring"); Copy asks for them only if that failed.
  function signIn(app, nameLabel, userCopy, passCopy) {
    const user = logins && logins[app] && logins[app].username;
    const grab = (field, what) => async () => {
      if (!logins) await loadLogins();
      const v = logins && logins[app] && logins[app][field];
      if (v) copy(v, what); else toast("Not available yet: run ./stack setup");
    };
    return [
      el("p", { class: "tour-login" }, `${nameLabel} `, el("span", { class: "tour-cred", text: user || "–" })),
      el("div", { class: "tour-actions" },
        button(userCopy, `copy-${app}-user`, grab("username", userCopy.replace(/^Copy /, "")), "copy"),
        button(passCopy, `copy-${app}-pass`, grab("password", passCopy.replace(/^Copy /, "")), "copy"), openApp(app)),
    ];
  }
  const spendOf = (alias) => {
    const k = sum && sum.spend && (sum.spend.keys || []).find((r) => r.alias === alias);
    return k && !k.error && typeof k.spend === "number" ? k.spend : null;
  };
  const command = () => (sum && sum.claude && sum.claude.command) || "claude-bedrock";

  // --- the steps. info: Next marks it done. optional: Skip. skipOnly: no "Mark as done" (it is detected).
  // live: needs /api/summary while shown. detect(summary) → {ok, text, warn} or null. spendKey: done once that
  // LiteLLM key spends more than when the step was first shown.
  const STEPS = {
    welcome: {
      title: "Welcome", info: true,
      body: () => [
        p("How the pieces fit together:"),
        list("ul", [
          [b("Chat"), " (Open WebUI): conversations, voice and your documents."],
          [b("Claude Code"), " in your terminal (", code("claude-bedrock"), "): coding."],
          [b("Files"), " (RustFS): the shared store both of them use."],
          [b("Admin"), " (LiteLLM): keys, budgets, logs."]]),
        p("Every model call goes through one gateway to your AWS Bedrock account (plus OpenRouter, if you add it), and every answer shows what it cost."),
        note("About 20 minutes; trying everything costs a few cents. Commands here run in a terminal, in your bedrock-now folder."),
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
        p("For more models, ask your AWS admin for model access (", ext(`${REPO}#asking-your-aws-admin-for-model-access`, "what to ask for"),
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
          ["Create a key at ", ext("https://openrouter.ai/settings/keys", "openrouter.ai/settings/keys"),
            " (name it e.g. bedrock-now; a credit limit is optional). It is shown once: copy it then."],
          ["Add it: run", cmd("./stack openrouter set"), "(it asks for the key, hidden), or paste the key into ", code(".env"),
            " after ", code("OPENROUTER_API_KEY="), " and run", cmd("./stack openrouter apply"),
            "Either way the key is checked with OpenRouter and what needs it restarts (~30 s)."],
          ["Without credits only free models work: set and apply notice this and offer the free ones (",
            code("OPENROUTER_MODELS=free"), "). ", code("./stack openrouter models all|free|paid"), " changes it later."],
          ["On openrouter.ai, Settings → ", ext("https://openrouter.ai/settings/privacy", "Privacy"),
            ": most free models need ", b("Allow free endpoints that train on request data"),
            " (they may keep and train on your prompts: the price of free). Endpoints that publish prompts are optional and make them public. ",
            b("Filter the model catalog for API keys"), " lists only the models your key can use."],
          ["To watch it: the Spend card on Home gets an OpenRouter block (free and paid requests, top models, the daily free-request limit, recent failures with fixes) and the Actual/Equivalent switch; Admin → Logs has every request."]]),
        note("The key goes in through your terminal or .env, never through this page."),
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
      title: "Claude Code", optional: true,
      body: () => [
        p(code("claude-bedrock"), " is Claude Code pointed at this stack, so Claude Code (", code("claude"), ") must be installed (",
          ext(`${REPO}#quickstart`, "prerequisites"), ")."),
        p("Setup offers to link it into ", code("~/.local/bin"), ". If your terminal says “command not found”, run ",
          code("./bin/claude-bedrock"), " from your bedrock-now folder, or re-run ", code("./stack setup"), " and answer y."),
        cmd(command()),
      ],
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
          p("To change them, set ", code("BUDGET_CLAUDE_CODE"), ", ", code("BUDGET_OPENWEBUI"), " or ", code("BUDGET_SETUP"),
            " in ", code(".env"), ", then run ", code("./stack setup"), "."),
        ];
      },
    },
    extras: {
      title: "Extras", optional: true,
      body: () => {
        const install = [...document.querySelectorAll("[data-install]")].find((n) => !n.hidden);
        const how = PHONE.matches ? "iPhone and iPad: Share → Add to Home Screen. Android: Chrome's ⋮ → Install app."
          : "Chrome: ⋮ → Cast, save and share → Install page as app. Edge: ⋯ → Apps → Install this site as an app. Safari on a Mac: File → Add to Dock.";
        return [
          p(b("Desktop app"), ": the portal in its own window, with its own icon."),
          install ? el("div", { class: "tour-actions" }, button("Install app", "install", () => install.click())) : note(how),
          p(b("One-click Update, Rollback and Clean"), " on Home:"), cmd("./stack helper install"),
          p(b("From your phone"), ": remote access over Tailscale (", ext(`${REPO}/blob/main/docs/remote.md`, "how it works"), "):"),
          cmd("./stack remote enable tailscale"),
        ];
      },
    },
    "signin-portal": {
      title: "The portal", badges: ["Sign-in: Done"], info: true,
      body: () => [
        p("You're signed in with the portal password (", code("PORTAL_PASSWORD"), " in ", code(".env"), "; ",
          code("./stack password --show"), " prints it)."),
        p("It keeps you signed in for 30 days. ", b("Sign out"), PHONE.matches ? " (under More)" : " at the bottom of the sidebar",
          " ends every session."),
      ],
    },
    "signin-chat": {
      title: "Chat (Open WebUI)", badges: ["Sign-in: Automatic"],
      body: () => [p("Chat signs you in with your portal session: no second password.")],
      actions: () => [openApp("chat")],
    },
    "signin-admin": {
      title: "Admin (LiteLLM)", badges: ["Sign-in: Own sign-in"],
      body: () => [
        ...signIn("admin", "Username", "Copy username", "Copy password"),
        p("Paste them into LiteLLM's sign-in form (", b("Username"), ", ", b("Password"), ") and click ", b("Login"), "."),
        note("If you change the password inside LiteLLM, Home still shows the initial one."),
      ],
    },
    "signin-files": {
      title: "Files (RustFS)", badges: ["Sign-in: Own sign-in"],
      body: () => [
        ...signIn("files", "Access key", "Copy access key", "Copy secret key"),
        p("Paste the access key into ", b("Account"), " and the secret key into ", b("Key"), ", then click ", b("Login"), "."),
        note("A “Your session has expired” notice on the very first visit is RustFS's own quirk and harmless."),
      ],
    },
    home: {
      title: "Home: your dashboard", info: true,
      body: () => [
        list("ul", [
          [b("Services"), ": green means running."],
          [b("Spend"), ": each app's key against its monthly budget, and the total of the last 30 days."],
          [b("Models"), ": status, price, and why a model is not available."]]),
        note("If you use free OpenRouter models, the cost switch on the Spend card shows what you were actually charged ($0 for free models) or what the same usage would have cost at paid rates."),
      ],
      actions: () => [showOnHome("spend", "Show spend"), showOnHome("services", "Show services"), showOnHome("models", "Show models")],
    },
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
    claude: {
      title: "Claude Code in your terminal", optional: true, live: true, spendKey: "claude-code",
      waiting: "Not detected yet: spend can take a minute to show.",
      body: () => [
        p("In a terminal, in a project folder:"), cmd(command()),
        p("Its first line shows the model's price and your budget; when you exit, it prints what the session cost."),
        p("Type ", code("/mcp"), ": ", code("bedrock-shared"), " is connected. Then ask:"),
        cmd(PROMPT, "the prompt"),
        PHONE.matches ? note("From a phone, ", code("./stack ssh-info"), " shows how to reach Claude Code over SSH.") : null,
      ],
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
    admin: {
      title: "Admin: where the money went",
      body: () => [
        list("ul", [
          [b("Virtual Keys"), ": one key per app (claude-code, open-webui, setup) with its spend and budget."],
          [b("Usage"), ": spend by model and day."],
          [b("Logs"), ": every request with its tokens and cost."]]),
        p(code("./stack costs"), " prints the same in a terminal:"), cmd("./stack costs"),
      ],
      actions: () => [openApp("admin")],
    },
    done: {
      title: "You're set", info: true,
      body: () => [
        p("Back on Home, the spend now includes what you just did."),
        p("Next ideas: install the app, try it from your phone, and ", code("./stack help"), " for every command."),
      ],
      actions: () => [showOnHome(null, "Back to Home")],
    },
  };
  const SECTIONS = [
    { title: "Set up", steps: ["welcome", "aws", "openrouter", "voice", "claude-setup", "budgets", "extras"] },
    { title: "Sign in to each app", steps: ["signin-portal", "signin-chat", "signin-admin", "signin-files"] },
    { title: "Use it together", steps: ["home", "chat", "voice-use", "docs", "claude", "shared", "admin", "done"] },
  ];
  const ORDER = SECTIONS.flatMap((s) => s.steps);
  const secOf = (id) => SECTIONS.findIndex((s) => s.steps.includes(id));

  // --- state: {open, cur ("" = the finished view), done, skipped, base: {key alias: spend when first shown}} ---
  function load() {
    const s = { open: null, cur: "welcome", done: [], skipped: [], base: {} };
    let text = null;
    try { text = localStorage.getItem(KEY); } catch (_) { /* storage blocked: start fresh */ }
    try {
      const raw = JSON.parse(text || "null");
      if (raw && typeof raw === "object") {
        if (typeof raw.open === "boolean") s.open = raw.open;
        if (raw.cur === "" || (typeof raw.cur === "string" && has(STEPS, raw.cur))) s.cur = raw.cur;
        for (const k of ["done", "skipped"]) {
          if (Array.isArray(raw[k])) s[k] = [...new Set(raw[k].filter((id) => typeof id === "string" && has(STEPS, id)))];
        }
        for (const a of ["open-webui", "claude-code"]) {
          if (raw.base && Number.isFinite(raw.base[a])) s.base[a] = raw.base[a];
        }
      }
    } catch (_) { /* unreadable: start fresh */ }
    return s;
  }
  // false when storage is blocked: progress then lasts for this page only
  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); return true; } catch (_) { return false; } }

  let st = load();
  let sum = null, sumAt = 0, askedAt = 0, failedAt = 0, pollT = null, shown = "";
  let openSecs = new Set();
  const isDone = (id) => st.done.includes(id);
  const isSkipped = (id) => st.skipped.includes(id);
  const handled = (id) => isDone(id) || isSkipped(id);
  function mark(id, how) {   // how: "done" | "skipped" | null (undo)
    st.done = st.done.filter((x) => x !== id);
    st.skipped = st.skipped.filter((x) => x !== id);
    if (how === "done") st.done.push(id); else if (how === "skipped") st.skipped.push(id);
  }

  function detection(id) {
    const s = STEPS[id];
    if (!s || !sum) return null;
    if (s.spendKey) {
      const base = st.base[s.spendKey], now = spendOf(s.spendKey);
      if (base == null || now == null) return null;
      return now > base + 1e-9 ? { ok: true, text: `Detected ✓ (${usd(now - base)} more on the ${s.spendKey} key)` } : { ok: false, text: s.waiting };
    }
    return s.detect ? s.detect(sum) : null;
  }
  // The spend a "did it work?" step compares against: taken from a summary at most 30 s old.
  function noteBaseline() {
    const s = STEPS[st.cur];
    if (!s || !s.spendKey || st.base[s.spendKey] != null || Date.now() - sumAt > POLL_MS) return;
    const v = spendOf(s.spendKey);
    if (v != null) st.base[s.spendKey] = v;
  }
  function detectAll() {
    const flipped = [];
    for (const id of ORDER) {
      const r = detection(id);
      if (r && r.ok && !isDone(id)) { mark(id, "done"); flipped.push(id); }
    }
    return flipped;
  }
  // What the current card shows from the summary.
  const digest = () => JSON.stringify([st.cur, detection(st.cur) || null, Boolean(sum), sum && sum.voice && sum.voice.on,
    sum && sum.claude && sum.claude.command, sum && sum.spend && (sum.spend.keys || []).map((k) => [k.label, k.max_budget, k.error])]);
  function announce(text) { live.textContent = ""; setTimeout(() => { live.textContent = text; }, 50); }

  function onSummary(d) {
    if (!d || d === sum) return;
    sum = d; sumAt = Date.now(); failedAt = 0;
    for (const a of Object.keys(st.base)) {
      const v = spendOf(a);
      if (v != null && v < st.base[a]) st.base[a] = v;
    }
    noteBaseline();
    const flipped = detectAll();
    save();
    if (st.open && flipped.includes(st.cur)) announce(`${STEPS[st.cur].title}: detected, done.`);
    // Re-drawn only when something it shows changed (a rebuild every 30 s would disturb reading and selecting).
    if (st.open && (flipped.length || digest() !== shown)) render(); else renderButtons();
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

  // --- rendering ---
  const panel = $("#tour"), opener = $("#tour-btn"), moreEntry = $("#more-tour");
  if (!panel || !opener) return;
  const head = el("div", { class: "tour-head" });
  const scroller = el("div", { class: "tour-scroll" });
  const live = el("p", { class: "tour-sr", "aria-live": "polite" });
  panel.append(head, scroller, live);

  function progress() { return ORDER.filter(handled).length; }

  function renderButtons() {
    const n = progress(), all = n === ORDER.length;
    $("#tour-count").textContent = all ? "✓" : `· ${n}/${ORDER.length}`;
    $(".tour-btn-bar i", opener).style.width = `${(n / ORDER.length) * 100}%`;
    opener.setAttribute("aria-expanded", String(Boolean(st.open)));
    const words = all ? "Walkthrough: finished" : `Walkthrough: ${n} of ${ORDER.length} steps done`;
    if (TABLET.matches) opener.title = words; else opener.removeAttribute("title");
    if (moreEntry) $("#more-tour-note").textContent = all ? "Finished ✓ · read it again" : `Set up, sign in, try each app · ${n}/${ORDER.length}`;
  }

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
      el("span", { text: STEPS[id].title }));
    if (handled(id)) go.append(el("span", { class: "tour-sr", text: isDone(id) ? " (done)" : " (skipped)" }));
    li.append(go);
    return li;
  }

  function card(id) {
    const s = STEPS[id], det = detection(id), i = ORDER.indexOf(id);
    const n = el("div", { class: "tour-card" },
      el("h4", { id: "tour-cur", tabindex: "-1", "data-k": "heading" }, el("span", { class: "tour-mark", "aria-hidden": "true", text: isDone(id) ? "✓" : "●" }),
        el("span", { text: s.title })));
    const tags = [...(s.badges || []), ...(s.optional ? ["Optional"] : [])];
    if (tags.length) n.append(el("p", { class: "tour-badges" }, ...tags.map((t) => el("span", { class: "tour-badge", text: t }))));
    if (det && det.text) {
      n.append(el("p", { class: `tour-status${det.ok ? " ok" : det.warn ? " warn" : ""}`,
        text: det.ok && !det.text.startsWith("Detected") ? `✓ ${det.text}` : det.text }));
    } else if ((s.detect || s.spendKey) && !sum) n.append(el("p", { class: `tour-status${failedAt ? " warn" : ""}`, text: failedAt ? CHECK_FAILED : "Checking…" }));
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

  function finishedCard() {
    const left = ORDER.filter((id) => !handled(id)).length;
    return el("div", { class: "tour-card tour-finished" },
      el("h4", { id: "tour-cur", tabindex: "-1", "data-k": "heading", text: left ? `${left} step${left === 1 ? "" : "s"} still open` : "You're all set" }),
      p(left ? "Pick one below to finish or skip it." : "Every step is done or skipped. Click any step below to read it again."),
      el("div", { class: "tour-nav" }, button("Start over", "restart", restart, "tour-link"),
        button("Close", "close-done", () => setOpen(false), "action primary")));
  }

  function render(opts = {}) {
    renderButtons();
    const n = progress();
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
        "aria-valuemax": String(ORDER.length), "aria-valuenow": String(n) }, bar));

    const parts = st.cur === "" ? [finishedCard()] : [];
    SECTIONS.forEach((sec, si) => {
      const open = openSecs.has(si);
      const toggle = button("", `sec-${si}`, () => { if (openSecs.has(si)) openSecs.delete(si); else openSecs.add(si); render(); }, "tour-sec-btn");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-controls", `tour-sec-${si}`);
      toggle.append(el("span", { class: "tour-chev", "aria-hidden": "true" }), el("span", { class: "tour-sec-name", text: `${si + 1}. ${sec.title}` }),
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
  }
  function advance() {   // after Mark as done / Skip
    const i = ORDER.indexOf(st.cur);
    nav(ORDER.every(handled) || i === ORDER.length - 1 ? "" : ORDER[i + 1]);
  }
  function finish() { mark("done", "done"); nav(""); }
  function restart() {
    st = { open: true, cur: "welcome", done: ["signin-portal"], skipped: [], base: {} };
    if (sum) detectAll();
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
  }
  // Phones and tablets: the sheet or card would cover the app (or the card on Home) it just opened — it steps aside,
  // and focus goes to what opens it again (the compass button, or More).
  function away() {
    if (!(PHONE.matches || TABLET.matches) || !st.open) return;
    setOpen(false);
    toast(PHONE.matches ? "The walkthrough is under More" : "The walkthrough is under the compass button");
  }

  // --- wiring ---
  // First visit: open, except on phones (it would cover Chat; it is under More) and when storage is blocked (it
  // would open again on every load). Phones also start closed after a visit that left it open.
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

  document.addEventListener("bn:tab", (e) => {
    if (e.detail !== "chat" || isDone("signin-chat")) return;
    mark("signin-chat", "done");
    if (st.open && st.cur === "signin-chat") announce("Chat opened: signed in, done.");
    commit();
  });
  document.addEventListener("DOMContentLoaded", () => setTimeout(poll, homeOwns() ? 10000 : 0));   // after app.js's
  // Back on the page: with Home on screen, app.js refreshes it at once and the #updated observer hands that over (the
  // panel asks only if it did not come); otherwise the panel asks itself if its summary is old.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(pollT); return; }
    if (homeOwns()) askedAt = Date.now();
    poll();
  });
  // app.js's sign-ins arrive: the Admin / Files step shows the user name.
  const signins = $("#logins");
  if (signins) {
    new MutationObserver(() => { if (st.open && (st.cur === "signin-admin" || st.cur === "signin-files")) render(); })
      .observe(signins, { childList: true, characterData: true, subtree: true });
  }
  document.addEventListener("keydown", (e) => {
    // Escape closes the floating card (tablets) and the sheet (phones); on desktops it is part of the page.
    if (e.key !== "Escape" || !st.open || !(PHONE.matches || TABLET.matches)) return;
    const more = $("#more-sheet"), confirm = $("#confirm");
    if ((more && !more.hidden) || (confirm && confirm.open)) return;
    e.preventDefault();
    setOpen(false);
  });
  const relayout = () => { if (st.open) render(); else renderButtons(); };
  PHONE.addEventListener("change", relayout);
  TABLET.addEventListener("change", relayout);
  // The Extras step offers the Install button once the browser does.
  for (const ev of ["beforeinstallprompt", "appinstalled"]) {
    window.addEventListener(ev, () => setTimeout(() => { if (st.open && st.cur === "extras") render(); }, 0));
  }
})();
