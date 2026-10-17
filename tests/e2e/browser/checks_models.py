"""Every model of the catalog as Claude Code's model (lib/code_models.sh, litellm/code-models.tsv, catalog/code-models.tsv):
the portal's /.bn/models lists every enabled chat model (Claude first) with its provider, vendor, how it works with
Claude Code and whether Settings › Claude Code › Models lists it; LiteLLM's /model/info carries the same as bn_* keys
(the browser terminal's claude-bedrock reads them) and its hook lowers a request's max_tokens to a model's limit. Live:
a Code page session on another provider's model (the cheapest that "works") round-trips a Bash tool call and its spend
lands under that model; a Haiku session switches to it mid-session (no "Couldn't confirm model"); Llama 3.3 70B (chat
only) answers at all — Bedrock refuses Claude Code's 32,000 max_tokens without the hook. The page: the status bar's quick
actions (28 px+, styled tips with shortcuts) and the model picker in groups with badges; the terminal: claude-bedrock
--models and Claude Code's /model menu listing the catalog's models; Settings (with the update helper): Anthropic only,
then every model again."""

from __future__ import annotations

import json
import re
import time

from playwright.sync_api import expect as see

from common import ENV, Skip, check, expect
from checks_api import lite
from checks_browser import _confirm, _need_helper, _wait_job, goto_setting, login, open_settings, shot
from checks_code import HAIKU, LOCKED_OK, Code, csp_clean, need_haiku, need_on, saved, ui_page
from checks_terminal import new_shell_window, term_text, terminal_frame, type_line, unlock_in, wait_text, wait_xterm


def _models(c) -> dict:
    r = c.api("GET", "/.bn/models")
    expect(r["status"] == 200, f"/.bn/models {r['status']} {r['text'][:200]}")
    return r["json"]


def _other(bn: dict) -> dict | None:
    """The cheapest listed model of another provider on Bedrock that works with Claude Code's tools."""
    ms = [m for m in bn["models"] if m["provider"] == "Bedrock" and m["vendor"] != "Anthropic" and m["compat"] == "works"
          and m["listed"] and m["input_per_mtok"] is not None]
    return min(ms, key=lambda m: (m["input_per_mtok"], m["id"])) if ms else None


def _tool_result(evs, tid):
    return next((e for e in evs if e["type"] == "tool_result" and e.get("id") == tid), None)


@check("browser", "code-models-catalog")
def catalog(ctx):
    """/.bn/models and LiteLLM's /model/info: every enabled chat model, Claude first, with compatibility and listing."""
    need_on()
    c = Code(ctx, "code-models-catalog")
    bn = _models(c)
    ms = bn["models"]
    ids = [m["id"] for m in ms]
    expect(ms and ms[0]["id"].startswith("claude-"), f"Claude first: {ids[:4]}")
    claude_end = max(i for i, m in enumerate(ms) if m["vendor"] == "Anthropic" and m["provider"] == "Bedrock")
    expect(all(m["vendor"] == "Anthropic" for m in ms[:claude_end + 1]), f"Claude models together first: {ids}")
    for m in ms:
        expect(m["provider"] in ("Bedrock", "OpenRouter") and m["compat"] in ("works", "chat-only", "fails", "untested"), f"model {m}")
        expect(isinstance(m["listed"], bool) and isinstance(m["free"], bool), f"model {m}")
        if m["free"]:
            expect(m["input_per_mtok"] == 0 and m["output_per_mtok"] == 0, f"a free model is $0: {m}")
    expect(bn["default"] in ids and bn["scope"]["mode"] in ("all", "anthropic", "list"), f"default {bn['default']}, scope {bn['scope']}")
    # the same through LiteLLM (what the browser terminal's claude-bedrock reads)
    r = lite("GET", "/model/info", key=ENV["LITELLM_MASTER_KEY"])
    expect(r.status == 200, f"/model/info {r.status}")
    info = {d["model_name"]: d["model_info"] for d in r.json()["data"]}
    for m in ms:
        i = info.get(m["id"]) or {}
        expect(i.get("bn_name") == m["name"] and i.get("bn_compat") == m["compat"] and i.get("bn_code") is m["listed"],
               f"{m['id']}: /model/info says {({k: v for k, v in i.items() if k.startswith('bn_')})}")
    expect(info.get(bn["default"], {}).get("bn_default") is True, f"bn_default not on {bn['default']}")
    other = [m["id"] for m in ms if m["vendor"] != "Anthropic"]
    c.rec.save()
    return (f"{len(ms)} models ({sum(m['listed'] for m in ms)} listed, scope {bn['scope']['mode']}), default {bn['default']}; "
            f"other providers: {', '.join(f'{m}' for m in other) or 'none enabled for this key'}; "
            f"compat {dict((s, sum(m['compat'] == s for m in ms)) for s in ('works', 'chat-only', 'fails', 'untested'))}; /model/info agrees")


@check("browser", "code-session-other-provider")
def other_provider(ctx):
    """A session on another provider's model (the cheapest that works): a Bash tool call round-trips through LiteLLM's
    translation, the spend lands under that model; a Haiku session switches to it and back."""
    need_haiku()
    c = Code(ctx, "code-other-provider")
    bn = _models(c)
    m = _other(bn)
    if not m:
        raise Skip("no model of another provider that works is enabled for this key")
    sid = c.new_session(m["id"], "default")
    n = len(c.msgs())
    c.request({"type": "prompt", "session": sid, "text": "Use the Bash tool to run exactly this command: echo bn-e2e-$((6*7)) — then reply with its output only."})
    p = c.wait(lambda x: x.get("type") == "permission" or (x.get("type") == "event" and x.get("session") == sid and x["ev"]["type"] == "result"),
               "a permission prompt or the result", 150, since=n)
    expect(p.get("type") == "permission" and p["tool"] == "Bash", f"{m['id']} asked for no Bash: {json.dumps(p)[:300]}")
    c.request({"type": "permission", "id": p["id"], "session": sid, "decision": "once"})
    c.wait(lambda x: x.get("type") == "event" and x["session"] == sid and x["ev"]["type"] == "result", "result", 150, since=n)
    evs = c.events(sid, n)
    use = [e for e in evs if e["type"] == "tool_use" and e["name"] == "Bash"]
    res = _tool_result(evs, use[0]["id"]) if use else None
    text = "".join(e["text"] for e in evs if e["type"] == "text")
    expect(res and "bn-e2e-42" in res["text"] and not res["is_error"], f"tool result {res}")
    expect("bn-e2e-42" in text, f"answer {text[:200]!r}")
    init = next((e for e in evs if e["type"] == "init"), None)
    expect(init is None or init["model"] == m["id"], f"init model {init and init['model']}")
    # its spend, from LiteLLM's logs, under that model
    t0, rows = time.time(), []
    while time.time() - t0 < 60:
        rows = (c.api("GET", f"/.bn/spend?session={sid}")["json"] or {}).get("rows") or []
        if any(r["model"] == m["id"] for r in rows):
            break
        c.page.wait_for_timeout(2000)
    spent = sum(r["spend"] for r in rows if r["model"] == m["id"])
    expect(rows and spent > 0, f"no spend under {m['id']}: {rows[:3]}")
    # a Haiku session switches to it (by its full id; the picker's flag settings spare Claude Code its 5 s check) and back
    sid2 = getattr(ctx, "code_session", None) or c.new_session(HAIKU, "default")
    c.request({"type": "attach", "session": sid2, "since": 10 ** 9})
    c.request({"type": "set_model", "session": sid2, "model": m["id"]}, timeout=90)
    evs2 = c.turn(sid2, "Reply with exactly the word: ok")
    models = sorted({e.get("model") for e in evs2 if e["type"] == "text"})
    expect(models == [m["id"]], f"after set_model {m['id']}: text from {models}")
    c.request({"type": "set_model", "session": sid2, "model": HAIKU}, timeout=90)
    c.rec.save()
    return (f"{m['name']} ({m['id']}, {m['vendor']}): Bash tool call round-tripped → {res['text'].strip()[:40]!r}, answer {text.strip()[:40]!r}; "
            f"spend ${spent:.5f} under it; a Haiku session switched to it (text from {models}) and back")


@check("browser", "code-session-llama-capped")
def llama_capped(ctx):
    """Llama 3.3 70B (chat only): Bedrock refuses more than 8,192 output tokens and Claude Code asks for 32,000 — LiteLLM's
    hook (litellm/bn_hooks.py) lowers it, so the session answers."""
    need_haiku()
    c = Code(ctx, "code-llama")
    bn = _models(c)
    m = next((x for x in bn["models"] if x["id"] == "llama-3-3-70b"), None)
    if not m:
        raise Skip("Llama 3.3 70B is not enabled for this key")
    expect(m["compat"] == "chat-only" and m["max_output_tokens"] == 8192, f"llama: {m}")
    sid = c.new_session(m["id"], "default")
    evs = c.turn(sid, "Reply with exactly the word: pong")
    res = [e for e in evs if e["type"] == "result"][-1]
    text = "".join(e["text"] for e in evs if e["type"] == "text")
    expect(res["subtype"] == "success" and not res.get("is_error") and "maximum tokens" not in text, f"llama: {res} {text[:200]!r}")
    c.rec.save()
    return f"Llama 3.3 70B answered {text.strip()[:40]!r} ({res['subtype']}): max_tokens capped at 8,192 by LiteLLM's hook"


@check("browser", "code-ui-models-and-status-bar")
@saved
def ui_models(ctx):
    """The page: the status bar's quick actions (28 px+, a styled tip with the shortcut), the model picker in groups
    with compatibility badges, its search; no Bedrock call."""
    need_on()
    page, rec = ui_page(ctx, "code-ui-models")
    for t in ("sb-terminal", "run-status", "ports-status", "sb-model"):
        el = page.get_by_test_id(t)
        see(el).to_be_visible(timeout=20000)
        box = el.bounding_box()
        expect(box["height"] >= 28 and el.get_attribute("aria-label"), f"{t}: {box}, aria-label {el.get_attribute('aria-label')!r}")
    page.get_by_test_id("run-status").hover()
    see(page.get_by_test_id("tip-run")).to_contain_text("Alt+R", timeout=5000)
    shot(page, "70-code-status-bar-tip")
    page.mouse.move(10, 200)
    page.get_by_test_id("model-picker").click()
    panel = page.locator(".model-panel")
    see(panel).to_be_visible()
    see(page.get_by_test_id("model-group-anthropic")).to_be_visible()
    groups = page.locator(".model-panel .mp-group").evaluate_all("els => els.map((e) => e.dataset.testid)")
    llama = page.get_by_test_id("model-llama-3-3-70b")
    if llama.count():
        see(llama.get_by_test_id("compat-chat-only")).to_have_text("chat only")
    shot(page, "71-code-model-picker")
    page.get_by_test_id("model-search").fill("haiku")
    see(page.locator(".model-panel .mp-row")).to_have_count(1)
    page.keyboard.press("Escape")
    csp_clean(page, rec)
    return f"status bar actions 28 px+ with tips (Run: Alt+R); picker groups {groups}"


@check("browser", "terminal-claude-bedrock-models")
def terminal_models(ctx):
    """The browser terminal: claude-bedrock --models from LiteLLM's /model/info, and Claude Code's /model menu listing the
    catalog's models by name, price and how they work (no model call)."""
    need_on()
    page, rec = ctx.page("terminal-models")
    login(page)
    page.click(".tab[data-tab=terminal]")
    f = terminal_frame(page)
    unlock_in(f, ENV["PORTAL_PASSWORD"])
    f = terminal_frame(page)
    wait_xterm(f)
    new_shell_window(page, f)
    type_line(page, f, "clear; claude-bedrock --models")
    out = wait_text(f, r"WITH CLAUDE CODE", 30)
    out = wait_text(f, r"claude-bedrock --model <id or name>", 10)
    expect(re.search(r"^\* claude-", out, re.M) or re.search(r"^\* \S+", out, re.M), f"no default marked: {out[-600:]!r}")
    shot(page, "72-terminal-claude-bedrock-models")
    listed = [ln.split()[0] for ln in out.splitlines() if re.match(r"^[ *] [a-z]", ln)]
    # Claude Code's /model menu: our rows (replaceBuiltInOptions), no aliases
    type_line(page, f, "clear; claude-bedrock")
    t0, steps = time.time(), []
    while time.time() - t0 < 90:
        s = term_text(f)
        if "Choose the text style" in s or "Press Enter to continue" in s:
            page.keyboard.press("Enter"); steps.append("onboarding")
        elif "Yes, I trust this folder" in s:
            page.keyboard.press("ArrowDown"); page.keyboard.press("Enter"); steps.append("trust")
        elif re.search(r"^\s*❯\s*$", s, re.M) or "for shortcuts" in s:
            break
        page.wait_for_timeout(700)
    page.keyboard.type("/model", delay=30)
    page.wait_for_timeout(400)
    page.keyboard.press("Enter")
    menu = wait_text(f, r"Select model", 20)
    expect("Default" in menu, f"no Default row: {menu[-800:]!r}")
    expect(not re.search(r"^\s*\d+\.\s+(Opus|Sonnet|Haiku)\s", menu, re.M), f"Claude Code's own alias rows are shown: {menu[-800:]!r}")
    expect(re.search(r"Claude \w+ \d", menu) and "per 1M" in menu, f"no catalog rows with prices: {menu[-800:]!r}")
    shot(page, "73-terminal-model-menu")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    page.keyboard.type("/exit", delay=30)
    page.keyboard.press("Enter")
    rec.save()
    rows = [ln.strip() for ln in menu.splitlines() if re.match(r"^\s*❯?\s*\d+\.", ln)]
    return f"--models listed {len(listed)} ({', '.join(listed[:5])}…); /model menu rows: {rows[:6]}; first start: {steps or 'no questions'}"


@check("settings", "settings-code-models")
def settings_code_models(ctx):
    """Settings › Claude Code › Models: Anthropic only through the update helper — /.bn/models and LiteLLM's bn_code
    follow — then every model again."""
    need_on()
    _need_helper(ctx)
    page, rec = ctx.page("settings-code-models")
    login(page)
    open_settings(page)
    notes = []
    for val, label in (("anthropic", "Anthropic only"), ("", "All enabled")):
        row = goto_setting(page, "CODE_MODELS")
        btn = row.locator(".set-seg button", has_text=label)
        if btn.get_attribute("aria-pressed") == "true":
            notes.append(f"{label}: already")
            continue
        t0 = time.time()
        btn.click()
        _confirm(page)
        ok, msg = _wait_job(page, 300)
        expect(ok, f"CODE_MODELS={val or 'all'}: {msg}")
        if val == "anthropic":
            row = goto_setting(page, "CODE_MODELS")
            row.scroll_into_view_if_needed()
            shot(page, "74-settings-code-models-anthropic", mask=[".set-value", ".set-adv-value"])
        info = {}
        t1 = time.time()
        while time.time() - t1 < 90:
            r = lite("GET", "/model/info", key=ENV["LITELLM_MASTER_KEY"], timeout=10)
            if r.status == 200:
                info = {d["model_name"]: d["model_info"] for d in r.json()["data"]}
                others = [k for k, v in info.items() if v.get("bn_vendor") and v.get("bn_vendor") != "Anthropic"]
                if not others or all(info[k].get("bn_code") is (val != "anthropic") for k in others):
                    break
            page.wait_for_timeout(2000)
        others = [k for k, v in info.items() if v.get("bn_vendor") and v.get("bn_vendor") != "Anthropic"]
        expect(all(info[k].get("bn_code") is (val != "anthropic") for k in others), f"bn_code after {val or 'all'}: {[(k, info[k].get('bn_code')) for k in others]}")
        notes.append(f"{label} in {time.time() - t0:.0f} s ({len(others)} other models now {'hidden' if val else 'listed'})")
    rec.save()
    return "; ".join(notes)
