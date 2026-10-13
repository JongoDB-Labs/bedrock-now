"""Shared plumbing for the e2e browser suite: the throwaway's settings, secret redaction, raw HTTP through Caddy,
check registration and results. Runs inside the Playwright container (tests/e2e/browser.sh)."""

from __future__ import annotations

import http.client as httpclient
import json
import os
import re
import socket
import time
import traceback
from pathlib import Path
from urllib.parse import urlsplit

OUT = Path("/out")
SHOTS = OUT / "shots"
NET = OUT / "net"
for d in (SHOTS, NET):
    d.mkdir(parents=True, exist_ok=True)


def read_env(path: str = "/run/e2e/env") -> dict:
    env = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k] = v  # last one wins, like docker compose
    return env


ENV = read_env()
HOST = os.environ["E2E_HOST"]
PORT = int(os.environ["E2E_PORT"])
LITELLM_PORT = int(os.environ["E2E_LITELLM_PORT"])
MCP_PORT = int(os.environ["E2E_MCP_PORT"])
FILTER = os.environ.get("E2E_FILTER", "")
# The app versions the app-specific selectors were written against (compose.yaml pins them; browser.sh passes the
# pinned tags). Checks that drive these UIs skip, saying why, on any other version instead of failing obscurely.
TESTED_WITH = {"open-webui": "v0.12.0-slim", "litellm": "1.105.0", "rustfs": "1.0.1"}
PINNED = {"open-webui": os.environ.get("E2E_OWUI_TAG", ""), "litellm": os.environ.get("E2E_LITELLM_TAG", ""),
          "rustfs": os.environ.get("E2E_RUSTFS_TAG", "")}
# Where the *.HOST names and 127.0.0.1-published ports are reachable from this container.
TARGET_IP = socket.gethostbyname(HOST)
# Published-only-on-127.0.0.1 ports (LiteLLM API, shared-mcp): same address as the portal from here.
API_IP = TARGET_IP

SECRET_KEYS = re.compile(r"(PASSWORD|SECRET|KEY|TOKEN|SALT)")
SECRETS = sorted({v for k, v in ENV.items() if SECRET_KEYS.search(k) and len(v) >= 8}, key=len, reverse=True)
# S3 presigned URLs carry the access key and a signature in the query string; hand-off links and some APIs a token
# or key (t=, token=, key=, …): their values never reach a log.
_AMZ = re.compile(r"(X-Amz-(?:Credential|Signature|Security-Token)=)[^&\s\"']+", re.I)
_QS = re.compile(r"([?&](?:t|token|access_token|id_token|key|api_key|apikey|secret|password|code|sig|signature)=)[^&#\s\"']+", re.I)


def redact(text) -> str:
    s = str(text)
    for v in SECRETS:
        if v in s:
            s = s.replace(v, "***")
    return _QS.sub(r"\1***", _AMZ.sub(r"\1***", s))


def origin(sub: str | None = None) -> str:
    return f"http://{(sub + '.') if sub else ''}{HOST}:{PORT}"


def host_of(sub: str | None) -> str:
    return f"{(sub + '.') if sub else ''}{HOST}"


class Resp:
    def __init__(self, status: int, headers: list[tuple[str, str]], body: bytes):
        self.status, self.headers_list, self.body = status, headers, body

    def header(self, name: str) -> str | None:
        for k, v in self.headers_list:
            if k.lower() == name.lower():
                return v
        return None

    def headers_all(self, name: str) -> list[str]:
        return [v for k, v in self.headers_list if k.lower() == name.lower()]

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")

    def json(self):
        return json.loads(self.body)


def _connect(ip: str, port: int, timeout: float) -> httpclient.HTTPConnection:
    """A connected HTTPConnection. Only the TCP connect is retried, 3 × 10 s (Docker Desktop's host-gateway
    forwarding once left a connect hanging for 30 s in a full run): nothing has been sent yet, so a retry never
    repeats a request."""
    last = None
    for attempt in range(3):
        conn = httpclient.HTTPConnection(ip, port, timeout=min(timeout, 10))
        try:
            conn.connect()
            conn.sock.settimeout(timeout)
            return conn
        except (TimeoutError, ConnectionRefusedError, ConnectionResetError, OSError) as e:
            last = e
            conn.close()
            time.sleep(1 + attempt)
    raise last


def http(method: str, sub: str | None, path: str, headers: dict | None = None, body: bytes | str | None = None,
         cookie: str | None = None, port: int | None = None, host_header: str | None = None, ip: str | None = None,
         timeout: float = 30) -> Resp:
    """One raw HTTP request to Caddy (or another published port) with exactly the headers given (no redirects,
    no cookie jar): Host is <sub>.HOST:PORT unless host_header says otherwise."""
    p = port or PORT
    conn = _connect(ip or TARGET_IP, p, timeout)
    h = {"Host": host_header or f"{host_of(sub)}:{p}", "Connection": "close"}
    if cookie:
        h["Cookie"] = cookie
    h.update(headers or {})
    if isinstance(body, str):
        body = body.encode()
    conn.request(method, path, body=body, headers=h)
    r = conn.getresponse()
    data = r.read()
    out = Resp(r.status, r.getheaders(), data)
    conn.close()
    return out


def portal_login() -> str:
    """Logs in through Caddy like the login form; returns the "bn_session=…" cookie pair."""
    from urllib.parse import urlencode
    body = urlencode({"password": ENV["PORTAL_PASSWORD"], "next": "/"})
    r = http("POST", None, "/login", {"Origin": origin(), "Content-Type": "application/x-www-form-urlencoded"}, body)
    if r.status != 303:
        raise AssertionError(f"portal login: HTTP {r.status}")
    for c in r.headers_all("set-cookie"):
        if c.startswith("bn_session="):
            return c.split(";", 1)[0]
    raise AssertionError("portal login: no bn_session cookie")


# --- checks and results ---

class Skip(Exception):
    pass


def need(app: str) -> None:
    """Skip the calling check when compose.yaml pins another version of APP than the selectors were written for."""
    if PINNED.get(app) != TESTED_WITH[app]:
        raise Skip(f"{app} is pinned at {PINNED.get(app) or '?'}; this check's selectors were written for "
                   f"{TESTED_WITH[app]} — update tests/e2e/browser for it")


CHECKS: list[tuple[str, str, object]] = []
RESULTS = OUT / "results.tsv"


def check(suite: str, cid: str):
    def deco(fn):
        CHECKS.append((suite, cid, fn))
        return fn
    return deco


def _record(suite: str, cid: str, status: str, secs: float, msg: str) -> None:
    msg = redact(msg).replace("\t", " ").replace("\n", " ")[:400]
    with RESULTS.open("a", encoding="utf-8") as f:
        f.write(f"{suite}\t{cid}\t{status}\t{int(secs)}\t{msg}\n")
    print(f"  {status:<5} {suite}/{cid}: {msg}", flush=True)


def run_all(ctx) -> int:
    fails = 0
    selected = [c for c in CHECKS if not FILTER or re.search(FILTER, f"{c[0]}/{c[1]}")]
    (OUT / "expected.txt").write_text(f"{len(selected)}\n", encoding="ascii")   # run.sh: every check must report
    for suite, cid, fn in selected:
        t0 = time.time()
        try:
            msg = fn(ctx) or "ok"
            _record(suite, cid, "PASS", time.time() - t0, msg)
        except Skip as e:
            _record(suite, cid, "SKIP", time.time() - t0, str(e))
        except Exception as e:  # noqa: BLE001 — every failure becomes a FAIL line
            fails += 1
            tb = traceback.format_exc()
            (OUT / "tracebacks").mkdir(exist_ok=True)
            (OUT / "tracebacks" / f"{suite}-{cid}.txt").write_text(redact(tb), encoding="utf-8")
            _record(suite, cid, "FAIL", time.time() - t0, f"{type(e).__name__}: {e}")
    return fails


def expect(cond, msg: str):
    if not cond:
        raise AssertionError(msg)


def url_path(url: str) -> str:
    u = urlsplit(url)
    return u.path + (f"?{u.query}" if u.query else "")
