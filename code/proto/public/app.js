// PROTOTYPE (code-page spike): a bare page over code's WebSocket. Everything from the sandbox is rendered with
// textContent (never innerHTML).
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const log = $("log"), side = $("side");
  let ws = null, current = null, perms = [];
  const line = (cls, text) => { const d = document.createElement("div"); d.className = "msg " + cls; d.textContent = text; log.append(d); log.scrollTop = log.scrollHeight; return d; };
  const show = (title, obj) => { side.textContent = title + "\n\n" + (typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)); };
  const send = (m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));
  const getJSON = async (u) => { const r = await fetch(u, { credentials: "same-origin" }); return r.json(); };

  function connect() {
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
    ws.onopen = () => { $("status").textContent = "connected"; };
    ws.onclose = () => { $("status").textContent = "disconnected"; setTimeout(connect, 2000); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      switch (m.t) {
        case "started": line("muted", "session " + m.session_id); $("status").textContent = "session " + m.session_id.slice(0, 8); break;
        case "init": line("muted", `init: ${m.model} · ${m.permissionMode} · Claude Code ${m.claude_code_version} · ${m.tools.length} tools · ${m.slash_commands.length} commands · plugins ${m.plugins.map((p) => p.name).join(", ") || "none"} · MCP ${m.mcp_servers.map((s) => s.name + ":" + s.status).join(", ")}`); break;
        case "delta": if (!current) current = line("assistant", ""); current.textContent += m.text; break;
        case "text": if (!current) line("assistant", m.text); current = null; break;
        case "tool_use": current = null; line("tool", `▶ ${m.name} ${JSON.stringify(m.input)}`); break;
        case "tool_result": line("tool" + (m.is_error ? " err" : ""), `◀ ${m.text}`); break;
        case "result": current = null; line("muted", `— ${m.subtype}, ${m.num_turns} turn(s), ${m.duration_ms} ms, in ${m.usage?.input_tokens ?? "?"} / out ${m.usage?.output_tokens ?? "?"} tokens (cache read ${m.usage?.cache_read_input_tokens ?? 0}); CLI's own estimate $${m.cli_cost_usd}`); break;
        case "permission": perms.push(m); showPerm(); break;
        case "permission_done": perms = perms.filter((p) => p.id !== m.id); showPerm(); break;
        case "local": current = null; line("tool", m.text); break;
        case "commands": show("Slash commands", m.commands.map((c) => `/${c.name} ${c.argumentHint || ""} — ${c.description}`).join("\n")); break;
        case "models": show("Models", m.models); break;
        case "mcp": show("MCP servers", m.servers); break;
        case "model_set": line("muted", "model → " + m.model); break;
        case "mode_set": line("muted", "permission mode → " + m.mode); break;
        case "error": line("err", "error: " + m.message); break;
        case "ended": line("muted", "session ended"); break;
        default: if (m.t !== "other") line("muted", JSON.stringify(m));
      }
    };
  }
  function showPerm() {
    const p = perms[0];
    $("perm").hidden = !p;
    if (!p) return;
    $("perm-title").textContent = (p.title || `Claude wants to use ${p.tool}`) + (p.reason ? ` (${p.reason})` : "");
    $("perm-input").textContent = JSON.stringify(p.input, null, 2);
    $("perm-always").hidden = !p.canAlways;
  }
  for (const [btn, decision] of [["perm-allow", "allow"], ["perm-always", "always"], ["perm-deny", "deny"]]) {
    $(btn).addEventListener("click", () => { const p = perms[0]; if (p) send({ t: "permission", id: p.id, decision }); });
  }
  $("start").addEventListener("click", () => { log.textContent = ""; current = null; send({ t: "start", model: $("model").value, mode: $("mode").value }); });
  $("stop").addEventListener("click", () => send({ t: "interrupt" }));
  $("model").addEventListener("change", () => send({ t: "set_model", model: $("model").value }));
  $("mode").addEventListener("change", () => send({ t: "set_mode", mode: $("mode").value }));
  $("cmds").addEventListener("click", () => send({ t: "commands" }));
  $("models").addEventListener("click", () => send({ t: "models" }));
  $("mcp").addEventListener("click", () => send({ t: "mcp" }));
  $("plugins").addEventListener("click", async () => show("Plugins (claude plugin list --json, in the sandbox)", await getJSON("/api/plugins")));
  $("files").addEventListener("click", async () => show("/workspace", await getJSON("/api/fs?path=/")));
  $("sessions").addEventListener("click", async () => {
    const r = await getJSON("/api/sessions");
    side.textContent = "Sessions (click to resume)\n\n";
    for (const s of r.sessions || []) {
      const b = document.createElement("button"); b.type = "button";
      b.textContent = `${new Date(s.mtimeMs).toLocaleString()} · ${s.title || "(untitled)"} · ${s.id.slice(0, 8)}`;
      b.addEventListener("click", () => { line("muted", "resuming " + s.id); current = null; send({ t: "start", resume: s.id, model: $("model").value, mode: $("mode").value }); });
      side.append(b, document.createElement("br"));
    }
  });
  $("ask").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("prompt").value.trim();
    if (!text) return;
    line("user", "› " + text); current = null; send({ t: "prompt", text }); $("prompt").value = "";
  });
  connect();
})();
