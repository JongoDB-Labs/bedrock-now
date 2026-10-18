"""LiteLLM API (127.0.0.1:LITELLM_PORT) and shared-mcp (127.0.0.1:SHARED_MCP_PORT/mcp) as the stack uses them."""

from __future__ import annotations

import json
import time

from common import ENV, LITELLM_PORT, MCP_PORT, Skip, check, expect, http

E2E_MARK = f"e2e-{int(time.time())}"


def lite(method, path, key=None, body=None, timeout=60):
    h = {"Content-Type": "application/json"}
    if key:
        h["Authorization"] = f"Bearer {key}"
    return http(method, None, path, h, json.dumps(body) if body is not None else None, port=LITELLM_PORT,
                host_header=f"127.0.0.1:{LITELLM_PORT}", timeout=timeout)


def chat_model() -> str:
    m = ENV.get("CLAUDE_BEDROCK_HAIKU_MODEL") or ENV.get("OWUI_TASK_MODEL")
    if not m:
        raise Skip("no Haiku/task model enabled for this AWS key")
    return m


@check("litellm", "health-and-auth")
def health(ctx):
    expect(lite("GET", "/health/liveliness").status == 200, "liveliness")
    r = lite("GET", "/health/readiness")
    expect(r.status == 200 and r.json().get("db") == "connected", f"readiness {r.status} {r.text[:100]}")
    expect(lite("GET", "/v1/models").status in (401, 403), "/v1/models without a key is open")
    expect(lite("GET", "/v1/models", key="sk-wrong").status in (401, 403), "/v1/models with a wrong key is open")
    return "liveliness, readiness (db connected); no/wrong key refused"


@check("litellm", "models-per-key")
def models(ctx):
    enabled = [l.strip() for l in ctx.enabled_models()]
    out = []
    for k in ("LITELLM_KEY_CLAUDE_CODE", "LITELLM_KEY_OPENWEBUI", "LITELLM_KEY_SETUP"):
        r = lite("GET", "/v1/models", key=ENV[k])
        expect(r.status == 200, f"{k}: {r.status}")
        ids = {m["id"] for m in r.json()["data"]}
        missing = [m for m in enabled if m not in ids]
        expect(not missing, f"{k} lacks {missing}")
        out.append(len(ids))
    return f"each virtual key sees the {len(enabled)} enabled models ({out})"


@check("litellm", "key-info-budgets")
def key_info(ctx):
    rows = []
    for k, alias, budget in (("LITELLM_KEY_CLAUDE_CODE", "claude-code", "BUDGET_CLAUDE_CODE"),
                             ("LITELLM_KEY_OPENWEBUI", "open-webui", "BUDGET_OPENWEBUI"), ("LITELLM_KEY_SETUP", "setup", "BUDGET_SETUP")):
        r = lite("GET", "/key/info", key=ENV[k])
        expect(r.status == 200, f"{alias}: /key/info {r.status}")
        info = r.json()["info"]
        expect(info.get("key_alias") == alias, f"alias {info.get('key_alias')}")
        expect(float(info.get("max_budget") or 0) == float(ENV[budget]), f"{alias} max_budget {info.get('max_budget')} != {ENV[budget]}")
        soft = info.get("soft_budget") or (info.get("litellm_budget_table") or {}).get("soft_budget") or 0
        expect(abs(float(soft) - 0.8 * float(ENV[budget])) < 0.01, f"{alias} soft_budget {soft}")
        expect(info.get("budget_duration") == "30d" and info.get("budget_reset_at"), f"{alias} duration {info.get('budget_duration')}")
        rows.append(f"{alias} ${info.get('max_budget')}")
    r = lite("GET", "/global/spend", key=ENV["LITELLM_MASTER_KEY"])
    expect(r.status == 200 and "spend" in r.json(), f"/global/spend {r.status}")
    r = lite("GET", "/global/spend", key=ENV["LITELLM_KEY_OPENWEBUI"])
    expect(r.status in (401, 403), f"/global/spend with a user key: {r.status}")
    return "budgets " + ", ".join(rows) + " (80% soft, 30d); /global/spend master-only"


@check("litellm", "chat-completions-and-messages")
def completions(ctx):
    """OpenAI-style /v1/chat/completions (Open WebUI's path) and Anthropic-style /v1/messages (claude-bedrock's)."""
    m = chat_model()
    r = lite("POST", "/v1/chat/completions", key=ENV["LITELLM_KEY_SETUP"], timeout=120,
             body={"model": m, "max_tokens": 5, "messages": [{"role": "user", "content": "Say: ok"}]})
    expect(r.status == 200, f"chat/completions {r.status} {r.text[:200]}")
    d = r.json()
    expect(d["choices"][0]["message"]["content"], "empty answer")
    expect(d.get("usage", {}).get("total_tokens"), "no usage")
    r = lite("POST", "/v1/chat/completions", key=ENV["LITELLM_KEY_SETUP"], timeout=120,
             body={"model": m, "max_tokens": 5, "stream": True, "messages": [{"role": "user", "content": "Say: ok"}]})
    expect(r.status == 200 and r.text.count("data: ") >= 2 and "[DONE]" in r.text, f"streaming {r.status}")
    h = {"Content-Type": "application/json", "Authorization": f"Bearer {ENV['LITELLM_KEY_SETUP']}", "anthropic-version": "2023-06-01"}
    r = http("POST", None, "/v1/messages", h, json.dumps({"model": m, "max_tokens": 5, "messages": [{"role": "user", "content": "Say: ok"}]}),
             port=LITELLM_PORT, host_header=f"127.0.0.1:{LITELLM_PORT}", timeout=120)
    expect(r.status == 200 and r.json().get("type") == "message" and r.json().get("content"), f"/v1/messages {r.status} {r.text[:200]}")
    r = http("POST", None, "/v1/messages", h, json.dumps({"model": m, "max_tokens": 5, "stream": True,
                                                          "messages": [{"role": "user", "content": "Say: ok"}]}),
             port=LITELLM_PORT, host_header=f"127.0.0.1:{LITELLM_PORT}", timeout=120)
    expect(r.status == 200 and "event: message_stop" in r.text, f"/v1/messages streaming {r.status} {r.text[:200]}")
    return f"{m}: chat/completions (+ SSE stream) and Anthropic /v1/messages (+ stream)"


@check("litellm", "virtual-key-for-a-tool")
def tool_key(ctx):
    """What the walkthrough's API step and README's "The models from your own code" say: a key of its own for a tool
    (as Admin › Virtual Keys makes one), with its own budget and models, works with the OpenAI-style path (Bearer) and
    the Anthropic-style one (x-api-key, as the anthropic SDK sends it); another model is refused; deleting it revokes it."""
    m = chat_model()
    master = ENV["LITELLM_MASTER_KEY"]
    r = lite("POST", "/key/generate", key=master, body={"key_alias": f"{E2E_MARK}-tool", "models": [m], "max_budget": 0.02, "budget_duration": "30d"})
    expect(r.status == 200 and r.json().get("key"), f"/key/generate {r.status} {r.text[:200]}")
    key = r.json()["key"]
    try:
        r = lite("GET", "/v1/models", key=key)
        ids = sorted(x["id"] for x in r.json().get("data", []))
        expect(r.status == 200 and ids == [m], f"/v1/models {r.status} {ids}")
        r = lite("POST", "/v1/chat/completions", key=key, timeout=120,
                 body={"model": m, "max_tokens": 5, "messages": [{"role": "user", "content": "Say: ok"}]})
        expect(r.status == 200 and r.json()["choices"][0]["message"]["content"], f"chat/completions {r.status} {r.text[:200]}")
        h = {"Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"}
        r = http("POST", None, "/v1/messages", h, json.dumps({"model": m, "max_tokens": 5, "messages": [{"role": "user", "content": "Say: ok"}]}),
                 port=LITELLM_PORT, host_header=f"127.0.0.1:{LITELLM_PORT}", timeout=120)
        expect(r.status == 200 and r.json().get("type") == "message", f"/v1/messages with x-api-key {r.status} {r.text[:200]}")
        other = next((x for x in ctx.enabled_models() if x != m and x.startswith("claude-")), None)
        if other:   # (refused before any model call: free)
            r = lite("POST", "/v1/chat/completions", key=key, body={"model": other, "max_tokens": 5, "messages": [{"role": "user", "content": "x"}]})
            expect(r.status in (400, 401, 403), f"{other} with a key for {m} only: {r.status}")
        info = lite("GET", "/key/info", key=key).json().get("info", {})
        expect(float(info.get("max_budget") or 0) == 0.02 and info.get("models") == [m], f"key/info {info.get('max_budget')} {info.get('models')}")
    finally:
        r = lite("POST", "/key/delete", key=master, body={"keys": [key]})
    expect(r.status == 200, f"/key/delete {r.status}")
    r = lite("GET", "/v1/models", key=key)
    expect(r.status in (400, 401, 403), f"a deleted key still works: {r.status}")
    return f"a key for {m} with a $0.02 budget: /v1/models lists it alone, chat/completions (Bearer) and /v1/messages (x-api-key) answer{f', {other} refused' if other else ''}; deleted → refused"


@check("litellm", "embeddings-and-rerank")
def embeddings(ctx):
    em = ENV.get("OWUI_EMBED_MODEL")
    if not em:
        raise Skip("no embedding model enabled")
    r = lite("POST", "/v1/embeddings", key=ENV["LITELLM_KEY_OPENWEBUI"], body={"model": em, "input": ["bedrock-now e2e"]})
    expect(r.status == 200, f"embeddings {r.status} {r.text[:200]}")
    dim = len(r.json()["data"][0]["embedding"])
    msg = f"{em}: {dim}-dim embedding"
    rr = ENV.get("OWUI_RERANK_MODEL")
    if rr:
        r = lite("POST", "/v1/rerank", key=ENV["LITELLM_KEY_OPENWEBUI"],
                 body={"model": rr, "query": "cat", "documents": ["a dog", "a cat"], "top_n": 1})
        expect(r.status == 200 and r.json()["results"][0]["index"] == 1, f"rerank {r.status} {r.text[:200]}")
        msg += f"; {rr} rerank ok"
    else:
        msg += "; rerank not enabled for this key"
    return msg


# --- shared-mcp: FastMCP streamable HTTP, stateless + JSON responses; DNS-rebinding protection wants Host 127.0.0.1:* ---

def mcp(method, params=None, token=None, rid=1):
    h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if token is not False:
        h["Authorization"] = f"Bearer {token or ENV['SHARED_MCP_TOKEN']}"
    return http("POST", None, "/mcp", h, json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}),
                port=MCP_PORT, host_header=f"127.0.0.1:{MCP_PORT}", timeout=180)


def tool(name, **args):
    r = mcp("tools/call", {"name": name, "arguments": args})
    expect(r.status == 200, f"{name}: HTTP {r.status} {r.text[:200]}")
    res = r.json().get("result") or {}
    expect(not res.get("isError"), f"{name} error: {json.dumps(res)[:300]}")
    if "structuredContent" in res:
        sc = res["structuredContent"]
        return sc.get("result", sc) if isinstance(sc, dict) else sc
    return "".join(c.get("text", "") for c in res.get("content", []))


@check("mcp", "auth-and-health")
def mcp_auth(ctx):
    r = http("GET", None, "/healthz", port=MCP_PORT, host_header=f"127.0.0.1:{MCP_PORT}")
    expect(r.status == 200, f"/healthz {r.status}")
    expect(mcp("tools/list", token=False).status == 401, "no token accepted")
    expect(mcp("tools/list", token="wrong-token-" + "x" * 20).status == 401, "wrong token accepted")
    r = http("POST", None, "/mcp", {"Authorization": f"Bearer {ENV['SHARED_MCP_TOKEN']}", "Content-Type": "application/json",
                                    "Accept": "application/json, text/event-stream"}, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
             port=MCP_PORT, host_header=f"evil.example:{MCP_PORT}")
    expect(r.status in (421, 400, 403), f"foreign Host header (DNS rebinding): {r.status}")
    return "healthz 200; no/wrong token 401; foreign Host refused"


@check("mcp", "tools-list")
def mcp_tools(ctx):
    r = mcp("tools/list")
    names = {t["name"] for t in r.json()["result"]["tools"]}
    want = {"list_files", "read_file", "write_file", "list_knowledge_bases", "search_knowledge"}
    expect(want <= names, f"tools {names}")
    return ", ".join(sorted(names))


@check("mcp", "files-roundtrip")
def mcp_files(ctx):
    path = f"e2e/{E2E_MARK}.txt"
    tool("write_file", path=path, content="hello from the bedrock-now e2e suite")
    listed = json.dumps(tool("list_files", prefix="e2e/"))
    expect(path in listed, f"list_files lacks {path}")
    text = tool("read_file", path=path)
    expect("hello from the bedrock-now e2e suite" in json.dumps(text), f"read_file: {str(text)[:100]}")
    r = mcp("tools/call", {"name": "read_file", "arguments": {"path": "../../etc/passwd"}})
    res = r.json().get("result") or {}
    expect(res.get("isError") or "error" in r.json(), "path traversal not refused")
    return f"write_file/list_files/read_file on s3://shared/{path}; ../ refused"


@check("mcp", "knowledge-ingest-and-search")
def mcp_knowledge(ctx):
    if not ENV.get("OWUI_EMBED_MODEL"):
        raise Skip("no embedding model: knowledge bases cannot index")
    kb = "e2e-knowledge"
    tool("write_file", path=f"e2e/{E2E_MARK}-kb.md", ingest_to=kb,
         content="# Codeword\nThe bedrock-now e2e codeword for the knowledge base is TEAL-HERON-7.\n")
    kbs = json.dumps(tool("list_knowledge_bases"))
    expect(kb in kbs, f"list_knowledge_bases lacks {kb}")
    hits = json.dumps(tool("search_knowledge", query="What is the e2e codeword?", knowledge_base=kb, k=3))
    expect("TEAL-HERON-7" in hits, f"search_knowledge: {hits[:200]}")
    return f"write_file(ingest_to={kb}) → knowledge base → search_knowledge finds the codeword"
