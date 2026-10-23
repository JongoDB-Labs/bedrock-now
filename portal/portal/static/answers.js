// Who answers: one picker, above the Terminal tab and the Chat tab (and the same JSON in the Code page's terminal
// panel): Claude Code on Bedrock, your own AI subscriptions' tools — each the provider's own client in the sandbox,
// signed in there with its own flow — and, in Chat, the models of Bedrock and OpenRouter (your own API keys next).
// GET /api/answers (answers.py): the tools of catalog/ai-tools.tsv with what each said of its own login at ./stack's
// last check (never a login), the chat models, the project folders. Built with el()/textContent only.
//   Terminal tab: "Open" makes (or selects) a window of that tool in the terminal's tmux session — on that click the
//   portal makes a launch token for exactly those words (POST /api/terminal/launch) and the terminal frame loads
//   ?arg=open&arg=TOOL&arg=TOKEN, which ttyd hands to bn-session (it checks the words again). An address with words and
//   no valid token starts nothing (the terminal host asks "Open … here?").
//   Chat tab: a model keeps Open WebUI (?models=ID: a new chat with it); a subscription's tool replaces Open WebUI's
//   frame with the tool's own screen — the terminal frame with ?arg=chat&…: a session of its own grouped with the
//   terminal's, in the folder chosen beside it. You type into the real, unmodified client. "Open WebUI" brings it back.
// The choice is a per-browser convenience in localStorage (bn.answers). Loaded after app.js, mobile.js and terminal.js.
"use strict";

(function (root) {
  const KEY = "bn.answers";

  // --- pure parts (portal/tests/js/answers.test.mjs runs these in Node) ---

  // toolState(TOOL, TERMINAL_HERE) -> {ok, word, why}: whether the tool can open here, a short state for its option,
  // and why not (its option is then greyed)
  function toolState(t, here) {
    if (!here) return { ok: false, word: "terminal off here", why: "The browser terminal is off on this site (remote access: REMOTE_TERMINAL=true)." };
    if (t.installed === false) return { ok: false, word: "not in the sandbox", why: "TERMINAL_AI_TOOLS in .env leaves it out (Settings › Claude Code › More)." };
    if (t.installed === null || t.installed === undefined) return { ok: true, word: "not checked yet", why: "" };
    if (t.signed_in === "yes") return { ok: true, word: t.kind_words ? `signed in · ${t.kind_words}` : "signed in", why: "" };
    if (t.signed_in === "no") return { ok: true, word: "sign in first", why: "" };
    return { ok: true, word: t.id === "copilot" ? "/user in it says who" : "sign-in not known here", why: "" };
  }
  // terminalOptions(DATA) -> [{label, items: [{value, label, disabled, title}]}] for the Terminal tab
  function terminalOptions(d) {
    const here = Boolean(d && d.terminal && d.terminal.here);
    const basics = (d && Array.isArray(d.basics) ? d.basics : []).map((b) => ({ value: b.id, label: `${b.name} — ${b.command}`, disabled: !here, title: "" }));
    const tools = (d && Array.isArray(d.tools) ? d.tools : []).map((t) => {
      const s = toolState(t, here);
      return { value: t.id, label: `${t.name} (${t.command}) · ${s.word}`, disabled: !s.ok, title: s.why || `${t.provider}: ${t.plan}` };
    });
    return [{ label: "Claude Code on Bedrock, and a shell", items: basics },
      { label: "Your AI subscriptions — each signs in with its own flow", items: tools }].filter((g) => g.items.length);
  }
  // chatOptions(DATA) -> the Chat tab's groups: Open WebUI, Bedrock and OpenRouter models, your API keys (next), the
  // tools themselves (they open here), and the subscriptions as Chat models (greyed until the next release, each saying how)
  function chatOptions(d) {
    const here = Boolean(d && d.terminal && d.terminal.here);
    const models = d && Array.isArray(d.models) ? d.models : [];
    const tools = d && Array.isArray(d.tools) ? d.tools : [];
    const by = (p) => models.filter((m) => m.provider === p).map((m) => ({ value: `model:${m.id}`, label: m.label, disabled: false, title: m.id }));
    return [
      { label: "", items: [{ value: "owui", label: "Open WebUI — its own model menu", disabled: false, title: "" }] },
      { label: "Bedrock", items: by("Bedrock") },
      { label: "OpenRouter", items: by("OpenRouter") },
      { label: "Your API keys", items: [{ value: "keys", label: "Your own OpenAI, Anthropic, xAI, Google or Mistral key — coming next", disabled: true, title: "Billed by each provider, with budgets, through LiteLLM (as OpenRouter is)." }] },
      { label: "Your AI subscriptions — the tool itself, here", items: tools.map((t) => {
        const s = toolState(t, here);
        return { value: `tool:${t.id}`, label: `${t.name} · ${s.word}`, disabled: !s.ok, title: s.why || `${t.provider}: ${t.plan}. You type into ${t.name} itself.` };
      }) },
      { label: "Your AI subscriptions as Chat models", items: tools.filter((t) => t.chat_model !== "yes").map((t) => (
        { value: `as-model:${t.id}`, label: `${t.name} — as a Chat model: next release`, disabled: true, title: t.chat_why || "" })) },
    ].filter((g) => g.items.length);
  }
  const bare = (base) => String(base).split(/[?#]/)[0];
  // chatSrc(BASE, ID) -> Open WebUI's address for a new chat with that model preselected
  const chatSrc = (base, id) => (id ? `${bare(base)}?models=${encodeURIComponent(id)}` : bare(base));
  // parseSaved(TEXT) -> {chat, folder}: the saved choice, each field checked
  function parseSaved(text) {
    let raw = null;
    try { raw = JSON.parse(text || "null"); } catch (_) { raw = null; }
    const out = { chat: "owui", folder: "" };
    if (!raw || typeof raw !== "object") return out;
    if (typeof raw.chat === "string" && /^(owui|model:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}|tool:[a-z]{2,10})$/.test(raw.chat)) out.chat = raw.chat;
    if (typeof raw.folder === "string" && raw.folder.length <= 512 && /^\/[^\u0000-\u001f\u007f]*$/.test(raw.folder)) out.folder = raw.folder;
    return out;
  }
  root.bnAnswers = { _pure: { toolState, terminalOptions, chatOptions, chatSrc, parseSaved } };
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return;

  const PHONE = window.matchMedia("(max-width: 767.98px)");
  let data = null, loadedAt = 0, loading = null;
  let saved = parseSaved((() => { try { return localStorage.getItem(KEY); } catch (_) { return null; } })());
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (_) { /* storage blocked: this page only */ } };

  // launch(MODE, TOOL, FOLDER) -> the terminal's address with those words and a launch token the portal made now, on
  // this click (its own page's request: X-Requested-With, its Origin); throws with what to say
  async function launch(mode, tool, folder) {
    const r = await fetch("/api/terminal/launch", { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { ...API_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ mode, tool, folder: folder || "" }) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { location.assign("/login"); throw new Error("signed out"); }
    if (!r.ok || typeof d.url !== "string" || !d.url.startsWith(appUrl("terminal").split(/[?#]/)[0])) throw new Error(d.error || `HTTP ${r.status}`);
    return d.url;
  }
  const failed = (e) => { if (e.message !== "signed out") toast(`Could not open it: ${e.message}`); };
  root.bnAnswers.launch = launch;

  async function load(force) {
    if (!force && data && Date.now() - loadedAt < 30000) return data;
    if (loading) return loading;
    loading = api("/api/answers").then((d) => { data = d; loadedAt = Date.now(); return d; })
      .catch(() => data).finally(() => { loading = null; });
    return loading;
  }

  function fill(select, groups, value) {
    select.replaceChildren();
    for (const g of groups) {
      const parent = g.label ? el("optgroup", { label: g.label }) : select;
      for (const it of g.items) {
        const o = el("option", { value: it.value, text: it.label });
        if (it.disabled) o.disabled = true;
        if (it.title) o.title = it.title;
        parent.append(o);
      }
      if (parent !== select) select.append(parent);
    }
    if ([...select.options].some((o) => o.value === value && !o.disabled)) select.value = value;
  }

  // --- the bar above the frames (one at a time: the Terminal's or Chat's) ---
  const bar = el("div", { class: "answers-bar", id: "answers-bar", role: "toolbar", "aria-label": "Who answers" });
  bar.hidden = true;

  // Terminal tab: Open [tool ▾] [Open]
  const tSelect = el("select", { id: "answers-terminal", "aria-label": "What to open in the terminal" });
  const tOpen = el("button", { type: "button", class: "action", id: "answers-terminal-open", text: "Open" });
  const tNote = el("span", { class: "answers-note", text: "A window of its own; each tool signs in with its own flow there." });
  const tWrap = el("span", { class: "answers-group" }, el("label", { for: "answers-terminal", text: "Open" }), tSelect, tOpen, tNote);
  tOpen.addEventListener("click", () => {
    const f = document.querySelector('#frames iframe[data-app="terminal"]');
    if (!f || !tSelect.value || tSelect.selectedOptions[0]?.disabled) return;
    tOpen.disabled = true;
    launch("open", tSelect.value).then((url) => { f.src = url; f.focus(); }, failed).finally(() => { tOpen.disabled = false; });
  });

  // Chat tab: Who answers [▾]  in [folder ▾]
  const cSelect = el("select", { id: "answers-chat", "aria-label": "Who answers in Chat" });
  const cFolder = el("select", { id: "answers-folder", "aria-label": "Folder the tool works in" });
  const cFolderWrap = el("span", { class: "answers-group answers-folder" }, el("label", { for: "answers-folder", text: "in" }), cFolder);
  const cNote = el("span", { class: "answers-note", id: "answers-chat-note" });
  const cWrap = el("span", { class: "answers-group" }, el("label", { for: "answers-chat", text: PHONE.matches ? "" : "Who answers" }), cSelect, cFolderWrap, cNote);
  bar.append(tWrap, cWrap);

  function toolFrame() {
    let f = document.querySelector('#frames iframe[data-app="chat-tool"]');
    if (!f) {
      f = el("iframe", { "data-app": "chat-tool", title: "A tool of yours, in Chat", allow: "clipboard-read; clipboard-write" });
      f.hidden = true;
      $("#frames").append(f);
    }
    return f;
  }
  // what the Chat tab shows: Open WebUI, or the tool's own screen
  function showChat() {
    const tool = saved.chat.startsWith("tool:") && data && data.terminal && data.terminal.here;
    const owui = document.querySelector('#frames iframe[data-app="chat"]');
    const tf = document.querySelector('#frames iframe[data-app="chat-tool"]');
    if (owui) owui.hidden = Boolean(tool);
    if (tf) tf.hidden = !tool;
    cFolderWrap.hidden = !tool;
    const t = tool && data.tools.find((x) => `tool:${x.id}` === saved.chat);
    cNote.textContent = t ? `${t.name} itself, on ${t.plan}: you type into it. Its own sign-in; bedrock-now never sees it. As a Chat model: ${t.chat_model === "yes" ? "yes" : t.chat_why || "next release"}`
      : saved.chat.startsWith("model:") ? "A new chat with this model in Open WebUI." : "";
  }
  function openTool(id) {
    launch("chat", id, saved.folder || "").then((url) => { toolFrame().src = url; showChat(); }, (e) => {
      failed(e);
      saved.chat = "owui"; save(); cSelect.value = "owui"; showChat();
    });
  }
  cSelect.addEventListener("change", () => {
    const v = cSelect.value;
    if (v.startsWith("model:")) {
      saved.chat = v; save();
      const owui = document.querySelector('#frames iframe[data-app="chat"]');
      if (owui) owui.src = chatSrc(appUrl("chat"), v.slice(6));
      showChat();
    } else if (v.startsWith("tool:")) {
      saved.chat = v; save(); openTool(v.slice(5));
    } else {
      saved.chat = "owui"; save(); showChat();
    }
  });
  cFolder.addEventListener("change", () => {
    saved.folder = cFolder.value === "/workspace" ? "" : cFolder.value; save();
    if (saved.chat.startsWith("tool:")) openTool(saved.chat.slice(5));
  });

  function folders(d) {
    cFolder.replaceChildren(el("option", { value: "/workspace", text: "the workspace" }));
    for (const f of (d && Array.isArray(d.folders) ? d.folders : [])) cFolder.append(el("option", { value: f.path, text: f.name }));
    cFolder.value = [...cFolder.options].some((o) => o.value === saved.folder) ? saved.folder : "/workspace";
  }

  let current = "";
  async function onTab(tab) {
    current = tab;
    const want = tab === "terminal" || tab === "chat";
    bar.hidden = !want;
    $("#frames").classList.toggle("answers-on", want);
    tWrap.hidden = tab !== "terminal";
    cWrap.hidden = tab !== "chat";
    if (!want) return;
    if (tab === "chat" && data) showChat();   // (at once, from what this page knows: no flash of Open WebUI)
    const d = await load(false);
    if (current !== tab) return;
    if (tab === "terminal") fill(tSelect, terminalOptions(d), tSelect.value || "bedrock");
    else {
      fill(cSelect, chatOptions(d), saved.chat);
      // (a choice this page no longer offers — a model turned off, a tool left out — is Open WebUI again)
      if (d && cSelect.value !== saved.chat) { saved.chat = cSelect.value || "owui"; save(); }
      folders(d);
      // a tool chosen earlier comes back (its window is still there; a new token only selects it)
      if (saved.chat.startsWith("tool:") && !document.querySelector('#frames iframe[data-app="chat-tool"]') && cSelect.value === saved.chat) openTool(saved.chat.slice(5));
      else showChat();
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const stage = $(".stage");
    if (stage) stage.append(bar);
  });
  document.addEventListener("bn:tab", (e) => { onTab(e.detail); });
  // Settings' Check again: the next look asks again
  root.bnAnswers.refresh = () => load(true).then(() => onTab(current));
})(typeof window !== "undefined" ? window : globalThis);
