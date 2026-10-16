"""Settings: the masked snapshot, the validators (the same cases as lib/settings.sh), the front door of every change,
the request files for the helper, Reveal, Sign out other devices, the carry-over cookie of a password change and
the hash-based login."""

import base64
import json
import os
import re
import stat
import time
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from conftest import PASSWORD_HASH, SECRET
from portal import settings as st
from portal.app import create_app
from portal.config import ConfigError, from_env
from portal.security import NEXT_COOKIE, Sessions, hash_password, verify_password

ORIGIN = {"Origin": "http://bedrock-now.localhost"}
API = {"X-Requested-With": "bedrock-now"}
H = {**ORIGIN, **API, "Content-Type": "application/json"}
PROXY = "p" * 64
REMOTE = {"X-Portal-Remote": "1", "X-Portal-Proxy": PROXY}
R_ORIGIN = {"Origin": "https://bn.tail1234.ts.net"}
BASE = "b" * 64
FIX = Path(__file__).parent / "fixtures" / "settings_cases.tsv"


def offline(request):
    raise httpx.ConnectError("offline in tests")


def row(key, group="budgets", secret="-", policy="edit", validator="budget", apply="budget", value=None, **kw):
    r = {"key": key, "group": group, "secret": secret, "policy": policy, "validator": validator, "apply": apply,
         "label": key.title(), "note": "n", "cli": f"./stack config set {key}", "present": True, "set": True, **kw}
    if value is not None:
        r["value"] = value
    return r


KEYS = [
    row("BUDGET_OPENWEBUI", value="50"),
    row("BUDGET_SETUP", value="5"),
    row("PORTAL_PASSWORD", "account", "S", "edit", "portal_password", "portal-pw"),
    row("PORTAL_PASSWORD_HASH", "account", "h", "companion", "pw_hash", "-", hint="…abcd"),
    row("OPENWEBUI_ADMIN_EMAIL", "account", "s", "edit", "email", "email", value="admin@example.com"),
    row("LITELLM_UI_PASSWORD", "account", "S", "edit", "litellm_password", "litellm-pw"),
    row("AWS_ACCESS_KEY_ID", "aws", "k", "local", "aws_key_id", "aws", hint="AKIA…MNOP"),
    row("AWS_SECRET_ACCESS_KEY", "aws", "S", "local", "aws_secret", "aws"),
    row("ALERT_WEBHOOK_URL", "budgets", "u", "local", "webhook", "litellm-cfg", hint="https://hooks.example.com/…"),
    row("REMOTE_ADMIN_ACTIONS", "remote", "-", "widen-local", "bool", "portal", value="false"),
    row("UPDATE_REQUIRE_SIGNED_TAGS", "updates", "-", "on-only", "true_blank", "-", value=""),
    row("STT_PROVIDER", "voice", "-", "local", "stt_provider", "stt", value="bedrock"),
    row("STT_API_KEY", "voice", "h", "local", "stt_key", "stt", set=False),
    row("STT_MODEL", "voice", "-", "edit", "stt_model", "stt", value=""),
    row("PORTAL_SECRET", "account", "h", "ro", "-", "-", hint="…1234", cli="edit .env, then ./stack up"),
    row("SHARED_MCP_TOKEN", "files", "h", "regen", "-", "mcp", hint="…cdef"),
    row("RUSTFS_ACCESS_KEY", "files", "s", "regen", "-", "rustfs", value="bn-abc123"),
    row("CHAT_DEFAULT_MODEL", "aws", "-", "edit", "model_pin", "pins", value=""),
    row("CLAUDE_MODEL_OPUS", "aws", "-", "edit", "model_pin", "pins", value=""),
    row("BACKUP_KEEP", "updates", "-", "widen-local", "keep", "-", value="7"),
    row("MODELS_HIDDEN", "aws", "-", "edit", "models_list", "owui-models", value=""),
    row("PORTAL_SESSION_DAYS", "account", "-", "widen-local", "days", "portal", value=""),
]
CHOICES = {"stt_models": {"bedrock": ["voxtral-small", "voxtral-mini"], "openai": ["gpt-4o-mini-transcribe"], "groq": []},
           "stt_bedrock_ready": ["voxtral-small"], "restart": ["litellm", "open-webui"],
           "chat_models": [["claude-haiku-5-5", "Claude Haiku 5.5"], ["mistral-large-3", "Mistral Large 3"]]}


def write_snapshot(stdir, keys=KEYS, base=BASE, **extra):
    d = {"version": 1, "written_at": int(time.time()), "base": base, "remote_on": False, "last_change": None,
         "choices": CHOICES, "keys": keys, **extra}
    (stdir / "settings.json").write_text(json.dumps(d))


def helper_up(stdir, settings_cap=True, job=None):
    (stdir / "helper.json").write_text(json.dumps({"heartbeat": int(time.time()), "pid": 1, "version": "v0.3.0",
                                                    "rollback": {"available": False}}))
    if settings_cap:
        (stdir / "helper-settings.json").write_text(json.dumps({"settings": 1, "diagnostics": list(st.DIAG_ACTIONS),
                                                                "written_at": int(time.time())}))
    if job:
        (stdir / "helper-status.json").write_text(json.dumps(job))


@pytest.fixture
def dirs(tmp_path):
    s, r = tmp_path / "status", tmp_path / "requests"
    s.mkdir()
    r.mkdir()
    return s, r


@pytest.fixture
def make(settings, dirs):
    def make(remote=False, login=True, **over):
        sd, rq = dirs
        s = replace(settings, status_dir=sd, request_dir=rq, shared_mcp_token="mcp-token-0123456789abcdef", **over)
        if remote:
            s = replace(s, remote_mode="tailscale", remote_host="bn.tail1234.ts.net", proxy_secret=PROXY,
                        remote_app_hosts={"chat": "bn-chat.tail1234.ts.net", "admin": "bn-admin.tail1234.ts.net",
                                          "files": "bn-files.tail1234.ts.net"})
        c = TestClient(create_app(s, transport=httpx.MockTransport(offline)), follow_redirects=False,
                       base_url="https://bn.tail1234.ts.net" if remote else "http://bedrock-now.localhost")
        c.__enter__()
        if login:
            assert c.post("/login", data={"password": "correct horse"}, headers=ORIGIN).status_code == 303
        return c
    return make


def apply(c, values, password="correct horse", base=BASE, headers=H):
    return c.post("/api/settings/apply", content=json.dumps({"password": password, "base": base, "set": values}), headers=headers)


def files(rq):
    return sorted(p.name for p in rq.iterdir())


# --- the validators: the same table as lib/settings.sh ---

def _unescape(v):
    out, i = [], 0
    while i < len(v):
        if v[i] == "\\" and i + 1 < len(v):
            n = v[i + 1]
            if n in "tnr\\":
                out.append({"t": "\t", "n": "\n", "r": "\r", "\\": "\\"}[n]); i += 2; continue
            if n == "x":
                out.append(chr(int(v[i + 2:i + 4], 16))); i += 4; continue
        out.append(v[i]); i += 1
    return "".join(out)


def cases():
    for line in FIX.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        v, remote, expect, value = (line.split("\t", 3) + [""])[:4]
        yield v, remote == "1", expect, _unescape(value)


@pytest.mark.parametrize("validator,remote_on,expect,value", list(cases()))
def test_validators_agree_with_the_shared_table(validator, remote_on, expect, value):
    e = st.validate(validator, value, remote_on)
    assert (e is None) == (expect == "ok"), f"{validator} {value!r}: {e}"
    if e and len(value) >= 8:
        assert value not in e   # messages never carry the value


def test_every_snapshot_validator_has_a_python_twin():
    # the names catalog/settings.tsv uses (the shell test compares that list with this one)
    for name in ("portal_password", "litellm_password", "email", "aws_key_id", "aws_secret", "budget", "webhook", "bool",
                 "on_off", "true_blank", "hour", "stt_provider", "stt_key", "stt_model", "or_key", "or_mode",
                 "int_1_5000", "login"):
        assert name in st.VALIDATORS


# --- the snapshot ---

def test_snapshot_keeps_values_of_plain_keys_only(dirs):
    sd, _ = dirs
    keys = [row("PORTAL_PASSWORD", "account", "S", "edit", "portal_password", value="leaked!", hint="x"),
            row("AWS_ACCESS_KEY_ID", "aws", "k", "local", "aws_key_id", value="AKIAFULL", hint="AKIA…MNOP"),
            row("BUDGET_SETUP", value="5"), {"key": "bad key"}, "nonsense", row("XKEY", secret="??", value="v")]
    write_snapshot(sd, keys)
    snap = st.snapshot(sd)
    k = st.by_key(snap)
    assert "value" not in k["PORTAL_PASSWORD"] and "hint" not in k["PORTAL_PASSWORD"]
    assert "value" not in k["AWS_ACCESS_KEY_ID"] and k["AWS_ACCESS_KEY_ID"]["hint"] == "AKIA…MNOP"
    assert k["BUDGET_SETUP"]["value"] == "5"
    assert k["XKEY"]["secret"] == "S" and "value" not in k["XKEY"]   # an unknown code counts as a secret
    assert len(snap["keys"]) == 4


def test_no_snapshot_or_a_bad_one(dirs):
    sd, _ = dirs
    assert st.snapshot(sd) is None
    (sd / "settings.json").write_text("{not json")
    assert st.snapshot(sd) is None
    (sd / "settings.json").write_text(json.dumps({"version": 2, "keys": []}))
    assert st.snapshot(sd) is None


def test_get_settings_needs_a_session_and_shows_the_snapshot(make, dirs):
    sd, _ = dirs
    write_snapshot(sd)
    c = make(login=False)
    assert c.get("/api/settings", headers=API).status_code == 401
    c = make()
    assert c.get("/api/settings").status_code == 400            # no X-Requested-With
    d = c.get("/api/settings", headers=API).json()
    assert d["available"] and d["snapshot"]["base"] == BASE
    assert d["helper"] == {"running": False, "heartbeat_at": None, "settings": False, "diagnostics": [],
                           "in_progress": False, "job": None}
    assert d["here"] == {"remote": False, "allowed": True}
    assert "correct horse" not in json.dumps(d) and PASSWORD_HASH not in json.dumps(d)
    helper_up(sd)
    d = c.get("/api/settings", headers=API).json()
    assert d["helper"]["running"] and d["helper"]["settings"] and "test" in d["helper"]["diagnostics"]


# --- the front door ---

def test_apply_needs_session_header_origin_and_password(make, dirs):
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    assert apply(make(login=False), {"BUDGET_SETUP": "6"}).status_code == 401
    c = make()
    assert apply(c, {"BUDGET_SETUP": "6"}, headers={**ORIGIN, "Content-Type": "application/json"}).status_code == 400
    assert apply(c, {"BUDGET_SETUP": "6"}, headers={**API, "Origin": "http://evil.example"}).status_code == 403
    assert apply(c, {"BUDGET_SETUP": "6"}, headers={**API, "Origin": "http://chat.bedrock-now.localhost"}).status_code == 403
    r = apply(c, {"BUDGET_SETUP": "6"}, password="wrong")
    assert r.status_code == 403 and "password" in r.json()["error"]
    assert apply(c, {"BUDGET_SETUP": "6"}, password=None).status_code == 403
    assert files(rq) == []


def test_wrong_passwords_share_the_login_throttle(make, dirs):
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    c = make()
    for _ in range(5):
        apply(c, {"BUDGET_SETUP": "6"}, password="wrong")
    r = apply(c, {"BUDGET_SETUP": "6"})
    assert r.status_code == 429 and r.headers["Retry-After"]
    assert c.post("/login", data={"password": "correct horse"}, headers=ORIGIN).status_code == 429   # the same lock
    assert files(rq) == []


def test_size_limits(make, dirs):
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    c = make()
    big = {"BUDGET_SETUP": "6", "pad": "x" * 13000}
    assert c.post("/api/settings/apply", content=json.dumps(big), headers=H).status_code == 413
    r = c.post("/api/settings/apply", content=b"{}", headers={**H, "Content-Length": "99999"})
    assert r.status_code == 413
    assert files(rq) == []


def test_a_valid_change_writes_one_request_the_helper_reads(make, dirs):
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    c = make()
    r = apply(c, {"BUDGET_SETUP": "6.5", "BUDGET_OPENWEBUI": "75"})
    assert r.status_code == 202, r.text
    nonce = r.json()["id"]
    assert files(rq) == [f"cfg-{nonce}.req"]
    f = rq / f"cfg-{nonce}.req"
    assert oct(f.stat().st_mode & 0o777) == "0o640"
    body = f.read_text()
    lines = body.split("\n")
    assert lines[0] == "bedrock-now-settings 1" and lines[1] == f"nonce {nonce}"
    assert re.fullmatch(r"requested_at [0-9]{1,12}", lines[2]) and lines[3] == f"base {BASE}" and lines[4] == "origin local"
    assert base64.b64decode(lines[5].split(" ", 1)[1]).decode() == "correct horse"
    # the line format lib/settings_helper.sh accepts
    sets = [l for l in lines if l.startswith("set ")]
    assert all(re.fullmatch(r"set [A-Z][A-Z0-9_]{1,40} [A-Za-z0-9+/]{0,2732}={0,2}", l) for l in sets)
    assert {l.split()[1]: base64.b64decode(l.split()[2]).decode() for l in sets} == {"BUDGET_SETUP": "6.5", "BUDGET_OPENWEBUI": "75"}
    assert lines[-2:] == ["end", ""] and len(body) <= st.MAX_REQUEST
    assert "75" not in r.text or r.json()["keys"] == ["BUDGET_SETUP", "BUDGET_OPENWEBUI"]


def test_invalid_values_come_back_per_field_without_the_value(make, dirs):
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    c = make()
    r = apply(c, {"BUDGET_SETUP": "-5", "PORTAL_PASSWORD": "short$", "PORTAL_SECRET": "x" * 40, "NOPE": "1"})
    assert r.status_code == 400
    f = r.json()["fields"]
    assert set(f) == {"BUDGET_SETUP", "PORTAL_PASSWORD", "PORTAL_SECRET", "NOPE"}
    assert "read-only" in f["PORTAL_SECRET"] and "./stack up" in f["PORTAL_SECRET"]
    assert "short$" not in r.text and "x" * 40 not in r.text
    assert apply(c, {"PORTAL_PASSWORD_HASH": PASSWORD_HASH}).status_code == 400   # only ever added by the portal
    assert files(rq) == []


def test_keys_that_go_together_and_values_that_did_not_change(make, dirs):
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    c = make()
    assert "AWS_SECRET_ACCESS_KEY" in apply(c, {"AWS_ACCESS_KEY_ID": "AKIAABCDEFGHIJKLMNOP"}).json()["fields"]
    assert "PORTAL_PASSWORD" in apply(c, {"PORTAL_PASSWORD": "correct horse"}).json()["fields"]   # 13 chars, the current one
    assert "OPENWEBUI_ADMIN_EMAIL" in apply(c, {"OPENWEBUI_ADMIN_EMAIL": "admin@example.com"}).json()["fields"]
    assert "LITELLM_UI_PASSWORD" in apply(c, {"LITELLM_UI_PASSWORD": "ui-pass"}).json()["fields"]
    assert "STT_API_KEY" in apply(c, {"STT_PROVIDER": "openai"}).json()["fields"]               # openai needs a key
    assert "STT_MODEL" in apply(c, {"STT_MODEL": "whisper-1"}).json()["fields"]                 # not a Bedrock model
    assert "STT_PROVIDER" in apply(c, {"STT_MODEL": "voxtral-mini"}).json()["fields"]           # not ready with this key
    assert apply(c, {"STT_PROVIDER": "openai", "STT_API_KEY": "sk-proj-abcdefghijklmnop1234"}).status_code == 202


def test_stale_base_is_refused(make, dirs):
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    r = apply(make(), {"BUDGET_SETUP": "6"}, base="c" * 64)
    assert r.status_code == 409 and "reload" in r.json()["error"]
    assert files(rq) == []


def test_needs_a_helper_that_takes_settings_and_no_job_running(make, dirs):
    sd, rq = dirs
    write_snapshot(sd)
    c = make()
    r = apply(c, {"BUDGET_SETUP": "6"})
    assert r.status_code == 503 and "./stack config set" in r.json()["error"]
    helper_up(sd, settings_cap=False)
    assert "predates" in apply(c, {"BUDGET_SETUP": "6"}).json()["error"]
    now = int(time.time())
    helper_up(sd, job={"id": "a" * 32, "action": "update", "phase": "restarting", "message": "m", "started_at": now,
                       "updated_at": now})
    assert apply(c, {"BUDGET_SETUP": "6"}).status_code == 409
    assert files(rq) == []


def test_rate_limited(make, dirs):
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    c = make()
    assert apply(c, {"BUDGET_SETUP": "6"}).status_code == 202
    r = apply(c, {"BUDGET_SETUP": "7"})
    assert r.status_code == 429 and r.headers["Retry-After"]
    assert len(files(rq)) == 1


def test_no_snapshot_no_change(make, dirs):
    sd, rq = dirs
    helper_up(sd)
    r = apply(make(), {"BUDGET_SETUP": "6"})
    assert r.status_code == 409 and "./stack up" in r.json()["error"]


# --- remote sessions ---

def remote_client(make, admin_actions):
    c = make(remote=True, login=False, remote_admin_actions=admin_actions)
    r = c.post("/login", data={"password": "correct horse"}, headers={**R_ORIGIN, **REMOTE})
    assert r.status_code == 303
    return c


RH = {**R_ORIGIN, **API, **REMOTE, "Content-Type": "application/json"}


def test_remote_sessions_need_remote_admin_actions(make, dirs):
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    c = remote_client(make, False)
    r = apply(c, {"BUDGET_SETUP": "6"}, headers=RH)
    assert r.status_code == 403 and "REMOTE_ADMIN_ACTIONS" in r.json()["error"]
    assert c.get("/api/settings", headers={**API, **REMOTE}).json()["here"] == {"remote": True, "allowed": False}
    assert files(rq) == []


def test_remote_sessions_never_change_exfiltration_keys(make, dirs):
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    c = remote_client(make, True)
    for values in ({"AWS_ACCESS_KEY_ID": "AKIAABCDEFGHIJKLMNOP", "AWS_SECRET_ACCESS_KEY": "a" * 40},
                   {"ALERT_WEBHOOK_URL": "https://attacker.example/x"}, {"STT_PROVIDER": "openai", "STT_API_KEY": "k" * 30},
                   {"REMOTE_ADMIN_ACTIONS": "true"}):
        r = apply(c, values, headers=RH)
        assert r.status_code == 400, values
        assert any("computer running bedrock-now" in m for m in r.json()["fields"].values())
    assert apply(c, {"REMOTE_ADMIN_ACTIONS": "false"}, headers=RH).status_code == 202   # narrowing is fine anywhere
    req = next(rq.iterdir()).read_text()
    assert "\norigin remote\n" in req


def test_a_bare_remote_header_counts_as_remote(make, dirs):
    # without Caddy's proxy secret the portal's remote site is not recognized — Settings still treats it as remote
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    c = make(remote_admin_actions=True)
    r = apply(c, {"ALERT_WEBHOOK_URL": "https://attacker.example/x"}, headers={**H, "X-Portal-Remote": "1"})
    assert r.status_code == 400
    assert files(rq) == []


def test_signed_tags_only_on(make, dirs):
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    c = make()
    assert "turned on" in apply(c, {"UPDATE_REQUIRE_SIGNED_TAGS": ""}).json()["fields"]["UPDATE_REQUIRE_SIGNED_TAGS"]
    assert apply(c, {"UPDATE_REQUIRE_SIGNED_TAGS": "true"}).status_code == 202


# --- the portal password: hash login, the hash in the request, the carry-over cookie ---

def test_login_checks_the_hash():
    # the same keys ./stack computes with openssl (lib/settings.sh _pbkdf2), UTF-8 included
    h = hash_password("pässwörd-ü12", rounds=1000, salt=bytes.fromhex("0011223344556677"))
    assert h.endswith(":fe4bdd45b01e4732567dd6880db806c24b446df017c533c6a5de845ccf5bdd5c")
    assert hash_password("correct horse", rounds=1000, salt=bytes.fromhex("0011223344556677")) == \
        "pbkdf2-sha256:1000:0011223344556677:c18ad9343a0073f2bf7cb960890cc7f2d9cff2da1261a3df2288e8f48920caa8"
    assert verify_password("correct horse", PASSWORD_HASH)
    assert not verify_password("correct horsE", PASSWORD_HASH)
    assert not verify_password("correct horse", "plain")
    assert not verify_password(None, PASSWORD_HASH)


def test_from_env_takes_the_hash_and_never_needs_the_password():
    s = from_env({"PORTAL_PASSWORD_HASH": PASSWORD_HASH, "PORTAL_SECRET": "z" * 40})
    assert s.password_hash == PASSWORD_HASH
    assert "correct" not in repr(s) and PASSWORD_HASH not in repr(s)
    with pytest.raises(ConfigError):
        from_env({"PORTAL_PASSWORD_HASH": "md5:abc", "PORTAL_SECRET": "z" * 40})
    with pytest.raises(ConfigError):
        from_env({"PORTAL_SECRET": "z" * 40})
    dev = from_env({"PORTAL_PASSWORD": "pw", "PORTAL_SECRET": "z" * 40})   # development: hashed at start, stable
    assert verify_password("pw", dev.password_hash) and dev.password_hash == from_env({"PORTAL_PASSWORD": "pw", "PORTAL_SECRET": "z" * 40}).password_hash


def test_password_change_adds_the_hash_and_a_carry_over_cookie(make, dirs, settings):
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    c = make()
    r = apply(c, {"PORTAL_PASSWORD": "a brand new password"})
    assert r.status_code == 202, r.text
    assert r.json()["keys"] == ["PORTAL_PASSWORD"]
    lines = next(rq.iterdir()).read_text().split("\n")
    sets = {l.split()[1]: base64.b64decode(l.split()[2]).decode() for l in lines if l.startswith("set ")}
    assert sets["PORTAL_PASSWORD"] == "a brand new password"
    new_hash = sets["PORTAL_PASSWORD_HASH"]
    assert verify_password("a brand new password", new_hash) and new_hash.startswith("pbkdf2-sha256:600000:")
    carry = c.cookies.get(NEXT_COOKIE)
    assert carry
    # the running portal (old hash) refuses the carry-over cookie on its own
    old = TestClient(create_app(replace(settings, status_dir=sd, request_dir=rq), transport=httpx.MockTransport(offline)),
                     base_url="http://bedrock-now.localhost")
    assert old.get("/auth/verify", headers={"Cookie": f"{NEXT_COOKIE}={carry}"}).status_code == 401
    # the portal restarted with the new hash: the old session is gone, the carry-over cookie works and is swapped
    new = TestClient(create_app(replace(settings, password_hash=new_hash, status_dir=sd, request_dir=rq),
                                transport=httpx.MockTransport(offline)), base_url="http://bedrock-now.localhost",
                     follow_redirects=False)
    old_cookie = c.cookies.get("bn_session")
    assert new.get("/auth/verify", headers={"Cookie": f"bn_session={old_cookie}"}).status_code == 401
    r = new.get("/api/settings", headers={**API, "Cookie": f"{NEXT_COOKIE}={carry}"})
    assert r.status_code == 200
    set_cookies = r.headers.get_list("set-cookie")
    assert any(sc.startswith("bn_session=") and "Domain=bedrock-now.localhost" in sc and "HttpOnly" in sc for sc in set_cookies)
    assert any(sc.startswith(f"{NEXT_COOKIE}=") and "Max-Age=0" in sc for sc in set_cookies)
    fresh = next(sc.split(";", 1)[0].split("=", 1)[1] for sc in set_cookies if sc.startswith("bn_session="))
    assert new.get("/auth/verify", headers={"Cookie": f"bn_session={fresh}"}).status_code == 200
    # a normal session is not touched
    r = new.get("/api/settings", headers={**API, "Cookie": f"bn_session={fresh}"})
    assert r.headers.get_list("set-cookie") == []


def test_logout_clears_the_carry_over_cookie_too(make, dirs):
    c = make()
    r = c.post("/logout", headers=ORIGIN)
    assert any(sc.startswith(f"{NEXT_COOKIE}=") for sc in r.headers.get_list("set-cookie"))


# --- Reveal, diagnostics, Sign out other devices, the report ---

def reveal(c, key, password="correct horse", headers=H):
    return c.post("/api/settings/reveal", content=json.dumps({"key": key, "password": password}), headers=headers)


def test_reveal_only_what_the_portal_holds(make, dirs):
    c = make()
    assert reveal(c, "LITELLM_UI_PASSWORD").json() == {"key": "LITELLM_UI_PASSWORD", "value": "ui-pass"}
    assert reveal(c, "RUSTFS_SECRET_KEY").json()["value"] == "rustfs-secret"
    assert reveal(c, "LITELLM_KEY_CLAUDE_CODE").json()["value"] == "sk-cc"
    assert reveal(c, "LITELLM_KEY_OPENWEBUI").json()["value"] == "sk-ow"
    assert reveal(c, "SHARED_MCP_TOKEN").json()["value"] == "mcp-token-0123456789abcdef"
    assert reveal(c, "LITELLM_KEY_SETUP").status_code == 404                 # not set in this fixture
    for k in ("AWS_SECRET_ACCESS_KEY", "PORTAL_PASSWORD", "LITELLM_MASTER_KEY", "PORTAL_SECRET", "OPENROUTER_API_KEY"):
        r = reveal(c, k)
        assert r.status_code == 403 and "never shown" in r.json()["error"]
    assert reveal(c, "LITELLM_UI_PASSWORD", password="wrong").status_code == 403
    assert reveal(c, "LITELLM_UI_PASSWORD", headers={**API, "Origin": "http://evil.example"}).status_code == 403
    assert reveal(make(login=False), "LITELLM_UI_PASSWORD").status_code == 401
    assert reveal(c, "LITELLM_UI_PASSWORD").headers["Cache-Control"] == "no-store"


def test_reveal_from_remote_needs_remote_admin_actions(make, dirs):
    assert reveal(remote_client(make, False), "RUSTFS_SECRET_KEY", headers=RH).status_code == 403
    assert reveal(remote_client(make, True), "RUSTFS_SECRET_KEY", headers=RH).json()["value"] == "rustfs-secret"


def action(c, act, password="correct horse", headers=H):
    return c.post("/api/settings/action", content=json.dumps({"action": act, "password": password}), headers=headers)


def test_diagnostics_write_one_strict_request(make, dirs):
    sd, rq = dirs
    c = make()
    assert action(c, "test").status_code == 503       # no helper
    helper_up(sd)
    r = action(c, "restart-litellm")
    assert r.status_code == 202
    nonce = r.json()["id"]
    body = (rq / f"act-{nonce}.json").read_text()
    m = re.fullmatch(r'\{"action":"restart-litellm","requested_at":[0-9]{1,12},"nonce":"' + nonce + r'","auth":"([A-Za-z0-9+/=]+)"\}', body)
    assert m and base64.b64decode(m.group(1)) == b"correct horse"   # the helper checks the password again
    assert action(c, "restart-portal").status_code == 400
    assert action(c, "restore").status_code == 400
    assert action(c, "test", password="nope").status_code == 403
    assert action(c, "test").status_code == 429       # rate limit
    assert len(files(rq)) == 1


def test_sign_out_other_devices_keeps_this_one(settings, dirs):
    sd, rq = dirs
    app = create_app(replace(settings, status_dir=sd, request_dir=rq), transport=httpx.MockTransport(offline))
    other, c = (TestClient(app, base_url="http://bedrock-now.localhost", follow_redirects=False) for _ in range(2))
    for x in (other, c):
        assert x.post("/login", data={"password": "correct horse"}, headers=ORIGIN).status_code == 303
    assert other.get("/api/settings", headers=API).status_code == 200
    r = c.post("/api/settings/signout-others", content=json.dumps({"password": "correct horse"}), headers=H)
    assert r.status_code == 200
    assert other.get("/api/settings", headers=API).status_code == 401
    assert c.get("/api/settings", headers=API).status_code == 200
    assert c.post("/api/settings/signout-others", content=json.dumps({"password": "x"}), headers=H).status_code == 403


def test_report_is_read_from_the_status_folder(make, dirs):
    sd, _ = dirs
    c = make()
    assert c.get("/api/settings/report", headers=API).json() == {"text": "", "written_at": None}
    (sd / "report.txt").write_text("bedrock-now status report\n")
    assert c.get("/api/settings/report", headers=API).json()["text"].startswith("bedrock-now status report")
    assert remote_client(make, False).get("/api/settings/report", headers={**API, **REMOTE}).status_code == 403


def test_request_file_is_bounded():
    with pytest.raises(ValueError):
        st.build_request("a" * 32, BASE, True, "pw", {f"K{i:02d}": "x" * 400 for i in range(19)})


def test_capability_file_must_be_recent(dirs):
    sd, _ = dirs
    (sd / "helper-settings.json").write_text(json.dumps({"settings": 1, "diagnostics": ["test", "rm -rf"], "written_at": 1}))
    assert st.capability(sd) == {"settings": False, "diagnostics": []}
    (sd / "helper-settings.json").write_text(json.dumps({"settings": 1, "diagnostics": ["test", "rm -rf"], "written_at": int(time.time())}))
    assert st.capability(sd) == {"settings": True, "diagnostics": ["test"]}


# --- Part 2: regenerate, pins, the backup list, the session length, the alert threshold ---

def test_regenerate_writes_regen_lines_and_never_a_value(make, dirs):
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    c = make()
    r = c.post("/api/settings/apply", content=json.dumps({"password": "correct horse", "base": BASE, "set": {},
                                                           "regen": ["RUSTFS_ACCESS_KEY"]}), headers=H)
    assert r.status_code == 202, r.text
    body = next(rq.iterdir()).read_text()
    assert "\nregen RUSTFS_ACCESS_KEY\nend\n" in body and "\nset " not in body
    assert r.json()["keys"] == ["RUSTFS_ACCESS_KEY"]
    for bad in (["PORTAL_SECRET"], ["RUSTFS_ACCESS_KEY", "RUSTFS_ACCESS_KEY"], "SHARED_MCP_TOKEN"):
        assert c.post("/api/settings/apply", content=json.dumps({"password": "correct horse", "base": BASE, "set": {}, "regen": bad}),
                      headers=H).status_code == 400
    # a regen key never takes a value of the browser's choosing
    r = apply(c, {"RUSTFS_ACCESS_KEY": "bn-mine"})
    assert r.status_code == 400 and "regenerated" in r.json()["fields"]["RUSTFS_ACCESS_KEY"]


def test_pins_and_hidden_models_must_be_enabled_chat_models(make, dirs):
    sd, rq = dirs
    write_snapshot(sd); helper_up(sd)
    c = make()
    assert "CHAT_DEFAULT_MODEL" in apply(c, {"CHAT_DEFAULT_MODEL": "titan-embed-v2"}).json()["fields"]
    assert "MODELS_HIDDEN" in apply(c, {"MODELS_HIDDEN": "claude-haiku-5-5,nope"}).json()["fields"]
    assert apply(c, {"CHAT_DEFAULT_MODEL": "mistral-large-3"}).status_code == 202


def test_backup_list_is_sanitized(make, dirs):
    sd, _ = dirs
    (sd / "backups.json").write_text(json.dumps({"written_at": 1, "nightly": {"on": True, "hour": 4, "keep": 3}, "backups": [
        {"name": "20261001-120000", "kind": "manual", "bytes": 1024, "at": 1790000000, "rollback": False},
        {"name": "../../etc", "kind": "manual"}, {"name": "x", "kind": "weird", "bytes": "big", "rollback": "yes"},
        {"name": "20261002-120000-portal", "kind": "portal"}]}))
    b = st.backups(sd)
    assert [x["name"] for x in b["backups"]] == ["20261001-120000", "x", "20261002-120000-portal"]
    assert b["backups"][2]["kind"] == "portal"   # Back up now in Settings
    assert b["backups"][1] == {"name": "x", "kind": "manual", "bytes": None, "at": None, "rollback": False}
    assert b["nightly"] == {"on": True, "hour": 4, "keep": 3}
    write_snapshot(sd)
    assert make().get("/api/settings", headers=API).json()["backups"]["backups"][0]["name"] == "20261001-120000"


def test_session_length_follows_portal_session_days(settings, dirs):
    assert from_env({"PORTAL_PASSWORD_HASH": PASSWORD_HASH, "PORTAL_SECRET": "z" * 40, "PORTAL_SESSION_DAYS": "7"}).session_days == 7
    for bad in ("0", "91", "x", ""):
        assert from_env({"PORTAL_PASSWORD_HASH": PASSWORD_HASH, "PORTAL_SECRET": "z" * 40, "PORTAL_SESSION_DAYS": bad}).session_days == 30
    now = [1_000_000.0]
    long = Sessions(SECRET, PASSWORD_HASH, clock=lambda: now[0])
    tok = long.issue()
    now[0] += 3 * 86400
    assert long.valid(tok)
    assert not Sessions(SECRET, PASSWORD_HASH, clock=lambda: now[0], max_age=2 * 86400).valid(tok)   # shorter: ends at once
    sd, rq = dirs
    c = TestClient(create_app(replace(settings, status_dir=sd, request_dir=rq, session_days=7), transport=httpx.MockTransport(offline)),
                   base_url="http://bedrock-now.localhost", follow_redirects=False)
    assert "signed in for 7 days" in c.get("/login").text
    r = c.post("/login", data={"password": "correct horse"}, headers=ORIGIN)
    assert f"Max-Age={7 * 86400}" in r.headers["set-cookie"]


def test_alert_threshold_reaches_home(settings, dirs):
    sd, rq = dirs
    assert from_env({"PORTAL_PASSWORD_HASH": PASSWORD_HASH, "PORTAL_SECRET": "z" * 40, "BUDGET_ALERT_PCT": "90"}).alert_pct == 90
    assert from_env({"PORTAL_PASSWORD_HASH": PASSWORD_HASH, "PORTAL_SECRET": "z" * 40, "BUDGET_ALERT_PCT": "40"}).alert_pct == 80
    with TestClient(create_app(replace(settings, status_dir=sd, request_dir=rq, alert_pct=90), transport=httpx.MockTransport(offline)),
                    base_url="http://bedrock-now.localhost", follow_redirects=False) as c:
        c.post("/login", data={"password": "correct horse"}, headers=ORIGIN)
        assert c.get("/api/summary", headers=API).json()["spend"]["alert_pct"] == 90
    js = (Path(__file__).parent.parent / "portal" / "static" / "app.js").read_text()
    assert js.count("pct >= alert") == 2   # the budget meters' colour and footer
    # the only fixed 80%: OpenRouter's daily free-request meter (a rate limit, not a budget)
    assert all("m.classList" in line for line in js.splitlines() if "pct >= 80" in line)


# --- review round 2 ---

def test_less_protection_only_from_this_computer():
    keep = row("BACKUP_KEEP", policy="widen-local", validator="keep", value="7")
    assert st.policy_error(keep, "10", local=False) is None
    assert "can only be lowered" in st.policy_error(keep, "3", local=False)
    assert st.policy_error(keep, "3", local=True) is None
    days = row("PORTAL_SESSION_DAYS", policy="widen-local", validator="days", value="")
    assert st.policy_error(days, "7", local=False) is None and "made longer" in st.policy_error(days, "60", local=False)
    nightly = row("BACKUP_NIGHTLY", policy="widen-local", validator="on_off", value="on")
    assert "turned off" in st.policy_error(nightly, "off", local=False)
    prompts = row("LITELLM_STORE_PROMPTS", policy="widen-local", validator="bool", value="false")
    assert "turned on" in st.policy_error(prompts, "true", local=False) and st.policy_error(prompts, "false", local=False) is None
    budget = row("BUDGET_OPENWEBUI", policy="widen-local", value="50")
    assert st.policy_error(budget, "20", local=False) is None and "raised" in st.policy_error(budget, "60", local=False)
    pct = row("BUDGET_ALERT_PCT", policy="widen-local", validator="pct", value="")
    assert st.policy_error(pct, "70", local=False) is None and "raised" in st.policy_error(pct, "90", local=False)
    auto = row("AUTO_UPDATE", policy="widen-local", validator="on_off", value="on")
    assert "turned off" in st.policy_error(auto, "off", local=False)
    check = row("UPDATE_CHECK", policy="widen-local", validator="bool", value="")
    assert "turned off" in st.policy_error(check, "false", local=False) and st.policy_error(check, "true", local=False) is None
    # old values as they take effect (lib/settings.sh _eff_int / _eff_budget agree)
    assert st.weakens("BACKUP_KEEP", "5", "abc") and not st.weakens("BACKUP_KEEP", "10", "abc")
    assert st.weakens("PORTAL_SESSION_DAYS", "40", "999") and not st.weakens("PORTAL_SESSION_DAYS", "20", "999")
    assert st.weakens("BUDGET_SETUP", "6", "x") and not st.weakens("BUDGET_SETUP", "4", "x")


def test_stale_requests_are_deleted_by_the_portal(tmp_path):
    old, new = tmp_path / ("cfg-" + "a" * 32 + ".req"), tmp_path / ("act-" + "b" * 32 + ".json")
    other = tmp_path / ("req-" + "c" * 32 + ".json")   # Home's update requests: not the portal's settings files
    for p in (old, new, other):
        p.write_text("x")
    os.utime(old, (time.time() - 200, time.time() - 200))
    os.utime(other, (time.time() - 200, time.time() - 200))
    assert st.sweep_requests(tmp_path) == 1
    assert not old.exists() and new.exists() and other.exists()


def test_a_confirmation_travels_with_the_change():
    body = st.build_request("a" * 32, "0" * 64, True, "pw", {"AWS_ACCESS_KEY_ID": "AKIA"}, now=1, confirm=("other-aws-account", "x"))
    assert b"\nconfirm other-aws-account\n" in body and b"confirm x" not in body


def test_claude_code_slots_take_claude_models_only(make, dirs):
    sd, _ = dirs
    c = make()
    write_snapshot(sd); helper_up(sd)
    r = apply(c, {"CLAUDE_MODEL_OPUS": "mistral-large-3"})
    assert r.status_code == 400 and "Claude model" in r.json()["fields"]["CLAUDE_MODEL_OPUS"]


def test_the_owner_email_compares_without_case(make, dirs):
    sd, _ = dirs
    c = make()
    write_snapshot(sd); helper_up(sd)
    r = apply(c, {"OPENWEBUI_ADMIN_EMAIL": "admin@example.com"})
    assert r.status_code == 400 and "you have now" in r.json()["fields"]["OPENWEBUI_ADMIN_EMAIL"]


def test_unknown_confirmations_are_refused(make, dirs):
    sd, _ = dirs
    c = make()
    write_snapshot(sd); helper_up(sd)
    r = c.post("/api/settings/apply", content=json.dumps({"password": "correct horse", "base": BASE, "set": {"BUDGET_SETUP": "6"},
                                                          "confirm": ["anything"]}), headers=H)
    assert r.status_code == 400


def test_a_password_too_long_for_a_request_is_a_clear_413(settings, dirs):
    from portal.security import hash_password
    sd, rq = dirs
    long_pw = "x" * 301
    app = create_app(replace(settings, status_dir=sd, request_dir=rq, password_hash=hash_password(long_pw)),
                     transport=httpx.MockTransport(offline))
    c = TestClient(app, base_url="http://bedrock-now.localhost", follow_redirects=False)
    assert c.post("/login", data={"password": long_pw}, headers=ORIGIN).status_code == 303
    write_snapshot(sd); helper_up(sd)
    r = action(c, "test", password=long_pw)
    assert r.status_code == 413 and "300 bytes" in r.json()["error"]
    assert apply(c, {"BUDGET_SETUP": "6"}, password=long_pw).status_code == 413
    assert files(rq) == []


# --- the Code page: on only from this computer and only with the terminal on; off from anywhere ---

def code_rows(code="false", terminal="true"):
    return KEYS + [row("CODE_ENABLED", "advanced", "-", "widen-local", "bool", "code", value=code),
                   row("TERMINAL_ENABLED", "advanced", "-", "ro", "-", "-", value=terminal),
                   row("TERMINAL_WORKSPACE", "advanced", "s", "ro", "-", "-", value="/home/u/bedrock-workspace")]


def test_code_page_turns_on_here_with_the_terminal_and_off_from_anywhere(make, dirs):
    sd, rq = dirs
    write_snapshot(sd, keys=code_rows(code="false", terminal="false")); helper_up(sd)
    c = make()
    r = apply(c, {"CODE_ENABLED": "true"})
    assert r.status_code == 400 and "needs the browser terminal" in r.json()["fields"]["CODE_ENABLED"]
    assert "./stack code enable" in r.json()["fields"]["CODE_ENABLED"] and files(rq) == []
    write_snapshot(sd, keys=code_rows(code="false", terminal="true"))
    r = apply(c, {"CODE_ENABLED": "true"})
    assert r.status_code == 202, r.text
    req = (rq / f"cfg-{r.json()['id']}.req").read_text()
    assert f"set CODE_ENABLED {base64.b64encode(b'true').decode()}\n" in req and "\norigin local\n" in req
    # the policy, as lib/settings.sh setting_allowed: turning it on weakens (this computer only), off never does
    code = row("CODE_ENABLED", policy="widen-local", validator="bool", value="false")
    assert "can only be turned on from the computer running bedrock-now" in st.policy_error(code, "true", local=False)
    assert st.policy_error(code, "true", local=True) is None
    assert st.policy_error(row("CODE_ENABLED", policy="widen-local", validator="bool", value="true"), "false", local=False) is None


def test_code_page_from_remote_access_only_off(make, dirs):
    sd, rq = dirs
    write_snapshot(sd, keys=code_rows(code="false", terminal="true")); helper_up(sd)
    c = remote_client(make, True)
    r = apply(c, {"CODE_ENABLED": "true"}, headers=RH)
    assert r.status_code == 400 and "computer running bedrock-now" in r.json()["fields"]["CODE_ENABLED"]
    write_snapshot(sd, keys=code_rows(code="true", terminal="true"))
    r = apply(c, {"CODE_ENABLED": "false"}, headers=RH)
    assert r.status_code == 202, r.text
    assert "\norigin remote\n" in (rq / f"cfg-{r.json()['id']}.req").read_text()


def test_settings_page_has_the_code_page_row_and_its_read_only_workspace():
    from portal.app import STATIC
    js = (STATIC / "settings.js").read_text(encoding="utf-8")
    assert '["code", "Code page", ' in js and 'code: ["CODE_ENABLED"]' in js
    assert 'if (g === "code") { codeRow(body); return c; }' in js
    # the workspace shown, never changed here: the command that changes it, with Copy
    assert "Workspace (read-only here): " in js and '"./stack terminal enable --workspace DIR"' in js
    # On stays off while the terminal is off (the helper and the portal refuse it too) and remotely (widen-local)
    assert "needsTerminal(k, val)" in js and "localOnlyHere(k, val)" in js
    assert "./stack code enable" in js and "./stack code disable" in js
