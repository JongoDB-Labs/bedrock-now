// The Code page's plain version (served while the image has no code/web build): chat with Claude Code in the
// sandbox over the backend's WebSocket, permission prompts, model/mode/effort, stop, sessions (resume), the
// workspace's files (list, read, edit and save, upload) and the session's cost from LiteLLM. Everything the sandbox
// says is shown with textContent — never parsed as HTML (the CSP and Trusted Types back that up).
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const meta = (n) => (document.querySelector(`meta[name="${n}"]`) || {}).content || "";
  const PORTAL = meta("bn-portal-origin");
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const usd = (v) => (v == null ? "…" : v < 0.0001 && v > 0 ? "<$0.0001" : `$${v.toFixed(4)}`);

  let ws = null, current = null, lastSeq = {}, streaming = null, perms = new Map(), models = [], reqN = 0;
  const waiting = new Map();

  // --- REST ---
  async function api(path, opts = {}) {
    const r = await fetch(path, { credentials: "same-origin", ...opts,
      headers: { ...(opts.body && typeof opts.body === "string" ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) } });
    let body = null;
    try { body = await r.json(); } catch (_) { /* not JSON */ }
    if (!r.ok) throw new Error((body && body.error) || `HTTP ${r.status}`);
    return body;
  }
  const note = (t) => { $("note").textContent = t || ""; };

  // --- the conversation ---
  const log = $("log");
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  function line(cls, text) {
    const stick = atBottom();
    const d = el("div", `msg ${cls}`, text);
    log.append(d);
    if (stick) log.scrollTop = log.scrollHeight;
    return d;
  }
  function render(ev) {
    switch (ev.type) {
      case "init": line("muted", `${ev.model} · ${ev.permissionMode} · Claude Code ${ev.cliVersion} · ${ev.tools.length} tools · MCP ${ev.mcp.map((s) => `${s.name}: ${s.status}`).join(", ") || "none"}`); break;
      case "user": streaming = null; line("user", `› ${ev.text}${ev.images ? ` [${ev.images} image(s)]` : ""}`); break;
      case "delta": if (!streaming) streaming = line("assistant", ""); streaming.textContent += ev.text; if (atBottom()) log.scrollTop = log.scrollHeight; break;
      case "thinking_delta": break;
      case "text": if (streaming) { streaming.textContent = ev.text; streaming = null; } else line("assistant", ev.text); break;
      case "thinking": line("thinking", `(thinking) ${ev.text}`); break;
      case "tool_use": streaming = null; line("tool", `▶ ${ev.name} ${JSON.stringify(ev.input)}`); break;
      case "tool_result": {
        let t = `◀ ${ev.text}`;
        if (ev.edit) t += `\n${ev.edit.path}\n${ev.edit.hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`).join("\n")}`;
        line(`tool${ev.is_error ? " err" : ""}`, t); break;
      }
      case "task": line("muted", `task ${ev.id}: ${ev.status}${ev.description ? ` — ${ev.description}` : ""}${ev.summary ? ` — ${ev.summary}` : ""}`); break;
      case "local": streaming = null; line("tool", ev.text); break;
      case "status": if (ev.status) line("muted", `… ${ev.status}`); break;
      case "notice": line("muted", ev.text); break;
      case "result": streaming = null; line("muted", `— ${ev.subtype}, ${ev.turns ?? "?"} turn(s), ${ev.duration ?? "?"} ms, tokens in ${ev.usage?.input_tokens ?? "?"} / out ${ev.usage?.output_tokens ?? "?"} / cache read ${ev.usage?.cache_read_input_tokens ?? 0} / cache write ${ev.usage?.cache_creation_input_tokens ?? 0}`); costSoon(); break;
      case "error": line("err", `error: ${ev.message}`); break;
      default: break;
    }
  }

  // --- permission prompts ---
  function sentence(p) {
    const i = p.input || {};
    if (p.tool === "Bash") return `Claude wants to run: ${i.command || ""}`;
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(p.tool)) return `Claude wants to change ${i.file_path || i.notebook_path || "a file"}`;
    if (p.tool === "WebFetch") return `Claude wants to fetch ${i.url || ""}`;
    return `Claude wants to use ${p.tool}`;
  }
  function showPerms() {
    const box = $("perms");
    box.textContent = "";
    for (const p of perms.values()) {
      if (p.session !== current) continue;
      const card = el("div", "perm");
      card.append(el("p", "perm-title", sentence(p)));
      if (p.reason) card.append(el("p", "muted", p.reason));
      card.append(el("pre", "", JSON.stringify(p.input, null, 2)));
      if (p.rules.length) card.append(el("p", "muted", `"Always" adds: ${p.rules.join("; ")}`));
      const row = el("p", "perm-buttons");
      const b = (label, decision, answers) => { const x = el("button", "", label); x.type = "button"; x.dataset.decision = decision;
        x.addEventListener("click", () => request({ type: "permission", id: p.id, session: p.session, decision, answers }).catch((e) => note(e.message))); return x; };
      // AskUserQuestion: Claude's question with its options; a click answers it (the tool gets {answers})
      if (p.tool === "AskUserQuestion" && Array.isArray(p.input.questions)) {
        for (const q of p.input.questions.slice(0, 4)) {
          const qr = el("p", "perm-buttons");
          qr.append(el("span", "", `${q.question} `));
          for (const o of (Array.isArray(q.options) ? q.options : []).slice(0, 8)) qr.append(b(String(o.label), "answer", { [q.question]: String(o.label) }));
          card.append(qr);
        }
      }
      row.append(b("Allow once", "once"));
      if (p.suggestions.length) row.append(b("Always allow", "always"));
      row.append(b("Deny", "deny"));
      card.append(row);
      box.append(card);
    }
  }
  function badge(n) { if (PORTAL && window.parent !== window) window.parent.postMessage({ type: "bn-code-status", pending: n }, PORTAL); }

  // --- WebSocket ---
  function request(m) {
    const req = `r${++reqN}`;
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) return reject(new Error("not connected"));
      waiting.set(req, { resolve, reject });
      ws.send(JSON.stringify({ ...m, req }));
    });
  }
  function connect() {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => { $("status").textContent = "connected"; if (current) attach(current, lastSeq[current] || 0); };
    ws.onclose = () => { $("status").textContent = "disconnected — reconnecting"; setTimeout(connect, 2000); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      switch (m.type) {
        case "reply": { const w = waiting.get(m.req); if (w) { waiting.delete(m.req); if (m.ok) w.resolve(m.data); else w.reject(new Error(m.error)); } break; }
        case "event": if (m.session === current) { lastSeq[m.session] = m.seq; render(m.ev); } break;
        case "attached": if (m.gap) line("muted", "(earlier events are no longer kept here — reopen the session from the list for its history)"); break;
        case "permission": perms.set(m.id, m); showPerms(); break;
        case "permission_done": perms.delete(m.id); showPerms(); break;
        case "pending": case "hello": badge(m.pending ?? m.count); break;
        case "session_state":
          if (m.session === current) { $("status").textContent = `${m.state}${m.error ? `: ${m.error}` : ""}`; if (m.mode) $("mode").value = m.mode; }
          break;
        case "error": note(m.message); break;
        default: break;
      }
    };
  }
  function attach(id, since) { return request({ type: "attach", session: id, since }).catch((e) => note(e.message)); }

  async function select(id, { history = false } = {}) {
    current = id; lastSeq[id] = 0; streaming = null; log.textContent = ""; perms.clear(); showPerms();
    $("session").value = id;
    $("cost").textContent = "";
    if (history) {
      try {
        const h = await api(`/api/sessions/${id}/messages?limit=2000`);
        if (h.truncated) line("muted", "(only the end of a long transcript)");
        for (const ev of h.events) render(ev);
        line("muted", "— resumed —");
      } catch (e) { note(`history: ${e.message}`); }
    }
    await attach(id, 0);
    cost();
  }

  async function open(body) {
    try {
      const r = await api("/api/sessions", { method: "POST", body: JSON.stringify(body) });
      await loadSessions();
      await select(r.id, { history: Boolean(body.resume) && !r.existing });
    } catch (e) { note(e.message); }
  }

  // --- sessions ---
  async function loadSessions() {
    try {
      const [{ sessions }, state] = await Promise.all([api(`/api/sessions?q=${encodeURIComponent($("find").value)}`), api("/api/state")]);
      const sel = $("session"), list = $("sessions");
      sel.textContent = ""; list.textContent = "";
      sel.append(new Option("—", ""));
      const known = new Set();
      for (const s of state.sessions) { known.add(s.id); sel.append(new Option(`${s.id.slice(0, 8)} (${s.state})`, s.id)); }
      for (const s of sessions) {
        const li = el("li");
        const b = el("button", "linkish", `${new Date(s.modified).toLocaleString()} · ${s.title || "(untitled)"}`);
        b.type = "button"; b.dataset.session = s.id;
        b.addEventListener("click", () => open({ resume: s.id, model: $("model").value || undefined, mode: $("mode").value }));
        li.append(b, el("span", "muted", s.state ? ` ${s.state}` : ""));
        list.append(li);
        if (!known.has(s.id)) sel.append(new Option(`${s.id.slice(0, 8)} · ${s.title.slice(0, 40)}`, s.id));
      }
      if (current) sel.value = current;
    } catch (e) { note(`sessions: ${e.message}`); }
  }

  // --- cost (LiteLLM's spend logs, through the portal) ---
  let costTimer = null;
  async function cost() {
    if (!current) return;
    try {
      const r = await api(`/.bn/spend?session=${current}`);
      $("cost").textContent = `session ${usd(r.total)} (${r.rows.length} request${r.rows.length === 1 ? "" : "s"})`;
    } catch (e) { $("cost").textContent = ""; }
  }
  // LiteLLM writes its spend logs in batches: asked again a few times after each turn
  function costSoon() {
    clearTimeout(costTimer);
    let i = 0;
    const next = () => { cost(); if (++i < 4) costTimer = setTimeout(next, [4000, 8000, 15000, 30000][i]); };
    costTimer = setTimeout(next, 4000);
  }

  // --- models (bedrock-now's, with its prices) ---
  async function loadModels() {
    try {
      const r = await api("/.bn/models");
      models = r.models;
      const sel = $("model");
      sel.textContent = "";
      for (const m of models) {
        sel.append(new Option(`${m.name}${m.input_per_mtok != null ? ` ($${m.input_per_mtok}/$${m.output_per_mtok} per Mtok)` : ""}`, m.alias || m.id));
      }
      const def = models.find((m) => m.alias === "sonnet") || models[0];
      if (def) sel.value = def.alias || def.id;
      note(r.note || "");
    } catch (e) { note(`models: ${e.message}`); }
  }

  // --- files ---
  let cwd = "", editing = null;
  async function files(dir) {
    try {
      const r = await api(`/api/fs?path=${encodeURIComponent(dir)}`);
      cwd = r.path === "." ? "" : r.path;
      $("cwd").textContent = `/workspace${cwd ? `/${cwd}` : ""}`;
      const ul = $("files"); ul.textContent = "";
      for (const f of r.entries) {
        const li = el("li");
        const b = el("button", "linkish", `${f.type === "dir" ? "▸ " : ""}${f.name}`);
        b.type = "button"; b.dataset.name = f.name;
        const p = cwd ? `${cwd}/${f.name}` : f.name;
        b.addEventListener("click", () => (f.type === "dir" ? files(p) : openFile(p)));
        li.append(b, el("span", "muted", f.type === "file" ? ` ${f.size} B` : ""));
        ul.append(li);
      }
    } catch (e) { note(`files: ${e.message}`); }
  }
  async function openFile(p) {
    try {
      const r = await api(`/api/fs/file?path=${encodeURIComponent(p)}`);
      editing = { path: p, mtimeMs: r.mtimeMs };
      $("editor").hidden = false; $("editing").textContent = p;
      $("text").value = r.binary ? "" : r.text; $("text").disabled = r.binary || r.truncated;
      $("file-note").textContent = r.binary ? `binary, ${r.size} bytes` : r.truncated ? "only the first 2 MiB (read-only here)" : "";
    } catch (e) { note(`open: ${e.message}`); }
  }
  async function save() {
    if (!editing) return;
    try {
      const r = await api(`/api/fs/file?path=${encodeURIComponent(editing.path)}`, { method: "PUT", body: JSON.stringify({ text: $("text").value, ifMtimeMs: editing.mtimeMs }) });
      editing.mtimeMs = r.mtimeMs; $("file-note").textContent = "saved";
    } catch (e) { $("file-note").textContent = e.message; }
  }
  async function upload(list) {
    for (const f of list) {
      try {
        const r = await api(`/api/fs/upload?dir=${encodeURIComponent(cwd)}`, { method: "POST", body: f, headers: { "X-Filename": encodeURIComponent(f.name) } });
        note(`uploaded ${r.path} — mention it as @${r.path}`);
      } catch (e) { note(`upload ${f.name}: ${e.message}`); }
    }
    files(cwd);
  }

  // --- wiring ---
  $("ask").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("prompt").value;
    if (!text.trim()) return;
    if (!current) await open({ model: $("model").value || undefined, mode: $("mode").value, effort: $("effort").value || undefined });
    if (!current) return;
    try { await request({ type: "prompt", session: current, text }); $("prompt").value = ""; } catch (err) { note(err.message); }
  });
  $("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("ask").requestSubmit(); });
  $("new").addEventListener("click", () => open({ model: $("model").value || undefined, mode: $("mode").value, effort: $("effort").value || undefined }));
  $("stop").addEventListener("click", () => current && request({ type: "interrupt", session: current }).catch((e) => note(e.message)));
  $("model").addEventListener("change", () => { if (current) request({ type: "set_model", session: current, model: $("model").value }).then(() => line("muted", `model → ${$("model").value} (the next turn writes this model's prompt cache again)`)).catch((e) => note(e.message)); });
  $("mode").addEventListener("change", () => { if (current) request({ type: "set_mode", session: current, mode: $("mode").value }).catch((e) => note(e.message)); });
  $("effort").addEventListener("change", () => { if (current && $("effort").value) request({ type: "set_effort", session: current, effort: $("effort").value }).catch((e) => note(e.message)); });
  $("session").addEventListener("change", () => { const id = $("session").value; if (id) open({ resume: id, model: $("model").value || undefined, mode: $("mode").value }); });
  $("find").addEventListener("input", () => { clearTimeout(loadSessions.t); loadSessions.t = setTimeout(loadSessions, 300); });
  for (const b of document.querySelectorAll("[data-side]")) {
    b.addEventListener("click", () => {
      for (const x of document.querySelectorAll("[data-side]")) x.setAttribute("aria-pressed", String(x === b));
      for (const n of ["sessions", "files", "info"]) $(`side-${n}`).hidden = n !== b.dataset.side;
      if (b.dataset.side === "files") files(cwd);
      if (b.dataset.side === "sessions") loadSessions();
    });
  }
  $("up").addEventListener("click", () => files(cwd.split("/").slice(0, -1).join("/")));
  $("refresh").addEventListener("click", () => files(cwd));
  $("save").addEventListener("click", save);
  $("close-file").addEventListener("click", () => { editing = null; $("editor").hidden = true; });
  $("upload").addEventListener("change", (e) => { upload([...e.target.files]); e.target.value = ""; });
  const show = (title, data) => { $("info").textContent = `${title}\n\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`; };
  $("cmds").addEventListener("click", () => current && request({ type: "commands", session: current }).then((d) => show("Slash commands", d.map((c) => `/${c.name} ${c.argumentHint} — ${c.description}`).join("\n"))).catch((e) => show("Commands", e.message)));
  $("mcp").addEventListener("click", () => current && request({ type: "mcp", session: current }).then((d) => show("MCP servers", d)).catch((e) => show("MCP", e.message)));
  $("context").addEventListener("click", () => current && request({ type: "context", session: current }).then((d) => show("Context", d)).catch((e) => show("Context", e.message)));

  connect();
  loadModels();
  loadSessions();
})();
