"""/api/settings/*: the Settings page (portal/portal/settings.py has the data and the request files).

Every change goes through the same front door as Update/Rollback/Clean: a session, X-Requested-With, the portal's
own Origin, the portal password typed again (counted by the login throttle), and REMOTE_ADMIN_ACTIONS for remote
sessions. Keys that could send data elsewhere (the AWS key, OpenRouter, speech-to-text, the alert webhook) are taken
only from local sessions. The helper checks all of it again (lib/settings_helper.sh)."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from . import admin
from . import settings as st
from .security import NEXT_MAX_AGE, Sessions, cookie_params, hash_password, same_origin, verify_password

log = logging.getLogger("portal.settings")


class RateLimit:
    def __init__(self, min_interval: float, per_hour: int, clock=time.monotonic):
        self.min_interval, self.per_hour, self._clock, self._times = min_interval, per_hour, clock, deque()

    def retry_after(self) -> int:
        now = self._clock()
        while self._times and now - self._times[0] > 3600:
            self._times.popleft()
        if self._times and now - self._times[-1] < self.min_interval:
            return int(self.min_interval - (now - self._times[-1])) + 1
        if len(self._times) >= self.per_hour:
            return int(3600 - (now - self._times[0])) + 1
        return 0

    def hit(self) -> None:
        self._times.append(self._clock())


@dataclass
class Ctx:
    """What the routes need from app.py's create_app."""
    settings: object
    sessions: Sessions
    throttle: object
    remote: Callable[[Request], bool]           # the remote site (Caddy's marker, with the proxy secret)
    api_guard: Callable[[Request], Response | None]
    session_login: Callable[[Request], str | None]
    set_session: Callable                     # set_session(resp, remote, login, iat)
    on_signout: Callable[[], None] = lambda: None   # after revoke_all: end the Admin sessions too (appsso.Sweeper)


def _no_store(r: Response) -> Response:
    r.headers["Cache-Control"] = "no-store"
    return r


def err(status: int, msg: str, retry: int = 0, **extra) -> Response:
    r = JSONResponse({"error": msg, **extra}, status_code=status)
    if retry:
        r.headers["Retry-After"] = str(retry)
    return _no_store(r)


def routes(ctx: Ctx) -> list[Route]:
    s = ctx.settings
    apply_rate = RateLimit(5, 30)
    action_rate = RateLimit(5, 30)

    def is_remote(request: Request) -> bool:
        # remote if either says so: Caddy's verified marker, or the bare header (admin.is_remote) — the safe side
        return ctx.remote(request) or admin.is_remote(request)

    def allowed(request: Request) -> bool:
        return not is_remote(request) or admin.remote_allowed(s)

    async def front_door(request: Request) -> tuple[dict, str] | Response:
        """Session, X-Requested-With, same Origin, remote rule, a bounded JSON body and the password again."""
        if (deny := ctx.api_guard(request)) is not None:
            return deny
        if not same_origin(request.headers, s):
            return err(403, "cross-site request refused")
        if not allowed(request):
            return err(403, "Settings changes are off for remote access (REMOTE_ADMIN_ACTIONS in .env).")
        length = request.headers.get("content-length", "")
        if not length.isdigit() or not length.isascii():
            return err(411, "Content-Length required")
        if int(length) > st.MAX_BODY:
            return err(413, "request too large")
        body = await request.body()
        if len(body) > st.MAX_BODY:
            return err(413, "request too large")
        try:
            data = json.loads(body)
        except ValueError:
            return err(400, "not JSON")
        if not isinstance(data, dict):
            return err(400, "not a JSON object")
        password = data.get("password")
        if wait := ctx.throttle.retry_after():
            return err(429, f"Too many wrong passwords. Try again in {wait} s.", wait)
        if not isinstance(password, str) or not await asyncio.to_thread(verify_password, password, s.password_hash):
            ctx.throttle.failure()
            log.warning("settings: wrong password (%d in a row)", ctx.throttle.failures)
            return err(403, "That password is not right (PORTAL_PASSWORD in .env).")
        ctx.throttle.success()
        if len(password.encode("utf-8", "surrogatepass")) > st.MAX_AUTH:
            return err(413, f"The portal password is longer than {st.MAX_AUTH} bytes, more than a request to the update helper "
                            "can carry: set a shorter one with ./stack config set PORTAL_PASSWORD.")
        return data, password

    def helper_ready() -> Response | None:
        state = admin.helper_state(s.status_dir)
        if not state["running"]:
            return err(503, f"{admin.not_running(state)}. Nothing can be applied from here until it runs: ./stack helper "
                            "install starts it, or use ./stack config set KEY in a terminal.")
        if not st.capability(s.status_dir)["settings"]:
            return err(503, "This update helper predates Settings: ./stack helper install refreshes it.")
        if admin.job_in_progress(state):
            return err(409, "Another action is still running.")
        return None

    async def get_settings(request: Request) -> Response:
        if (deny := ctx.api_guard(request)) is not None:
            return deny
        rem = is_remote(request)
        st.sweep_requests(s.request_dir)
        state = admin.helper_state(s.status_dir)
        cap = st.capability(s.status_dir)
        snap = st.snapshot(s.status_dir)
        return _no_store(JSONResponse({
            "available": snap is not None, "snapshot": snap, "layout": st.layout(s.catalog_dir),
            "helper": {"running": state["running"], "heartbeat_at": state["heartbeat_at"], "settings": cap["settings"],
                       "diagnostics": cap["diagnostics"], "projects": cap["projects"], "sessions": cap["sessions"], "screen": cap["screen"],
                       "in_progress": admin.job_in_progress(state), "job": state["job"]},
            # the folders of this computer the Code page's sandbox sees (./stack project; lib/projects.sh)
            "projects": st.project_folders(s.status_dir),
            # what bedrock-now may read of your Claude Code and claude-bedrock sessions here (lib/sessions.sh)
            "sessions": st.sessions_consent(s.status_dir),
            "here": {"remote": rem, "allowed": allowed(request)},
            "apps": s.app_urls(ctx.remote(request)), "user": s.user_email, "backups": st.backups(s.status_dir),
            "remote": {"on": s.remote_on(), "mode": s.remote_mode if s.remote_on() else "off",
                       "url": s.origin(remote=True) if s.remote_on() else ""},
        }))

    def check_values(values: dict, snap: dict, local: bool, same_password: bool = False) -> dict:
        """{KEY: what is wrong} (no value in any message); the same rules as lib/settings.sh settings_check_batch."""
        rows, fields = st.by_key(snap), {}
        ctx = {k: r.get("value") or "" for k, r in rows.items()}   # (the other settings, for REMOTE_PREVIEW's rule)
        for k, v in values.items():
            row = rows.get(k)
            if row is None or row["policy"] not in st.EDITABLE:
                fields[k] = st.policy_error(row, v, local, ctx) if row else "is not a bedrock-now setting"
                continue
            e = st.policy_error(row, v, local, ctx) or st.validate(row["validator"], v, snap["remote_on"])
            if e:
                fields[k] = e
        if fields:
            return fields
        eff = lambda k: values[k] if k in values else (rows.get(k) or {}).get("value", "")  # noqa: E731
        if ("AWS_ACCESS_KEY_ID" in values) != ("AWS_SECRET_ACCESS_KEY" in values):
            fields["AWS_SECRET_ACCESS_KEY"] = "goes together with the access key ID: replace both"
        if same_password:   # (verified off the event loop by the caller: 600,000 rounds)
            fields["PORTAL_PASSWORD"] = "is the password you have now"
        if "LITELLM_UI_PASSWORD" in values and values["LITELLM_UI_PASSWORD"] == s.litellm_ui_password:
            fields["LITELLM_UI_PASSWORD"] = "is the password you have now"
        if "OPENWEBUI_ADMIN_EMAIL" in values and \
                values["OPENWEBUI_ADMIN_EMAIL"].lower() == ((rows.get("OPENWEBUI_ADMIN_EMAIL") or {}).get("value") or "").lower():
            fields["OPENWEBUI_ADMIN_EMAIL"] = "is the owner email you have now"
        # (the Code page with the terminal off turns the terminal on too: ./stack checks its folder, settings_check_batch)
        if "TAILSCALE_ALLOWED_LOGIN" in values and values["TAILSCALE_ALLOWED_LOGIN"] == "":
            fields["TAILSCALE_ALLOWED_LOGIN"] = "cannot be made blank here"
        chat = {m[0] for m in snap["choices"]["chat_models"]}
        for k in ("CHAT_DEFAULT_MODEL", "CHAT_TASK_MODEL", "CLAUDE_MODEL_OPUS", "CLAUDE_MODEL_SONNET", "CLAUDE_MODEL_HAIKU"):
            if values.get(k) and values[k] not in chat:
                fields[k] = "is not a chat model your AWS key can use"
            elif k.startswith("CLAUDE_MODEL_") and values.get(k) and not values[k].startswith("claude-"):
                fields[k] = "must be a Claude model (Claude Code speaks Anthropic's API)"
        if values.get("MODELS_HIDDEN") and not set(values["MODELS_HIDDEN"].split(",")) <= chat:
            fields["MODELS_HIDDEN"] = "lists a model your AWS key cannot use"
        # Settings › Claude Code › Models: models the stack serves (litellm/code-models.tsv; not checked before it exists)
        code = {m[0] for m in snap["choices"].get("code_models") or []}
        if code and values.get("CODE_DEFAULT_MODEL") and values["CODE_DEFAULT_MODEL"] not in code:
            fields["CODE_DEFAULT_MODEL"] = "is not a chat model this stack serves"
        if code and values.get("CODE_MODELS") not in (None, "", "all", "anthropic") and not set(values["CODE_MODELS"].split(",")) <= code:
            fields["CODE_MODELS"] = "lists a model this stack does not serve"
        if {"STT_PROVIDER", "STT_API_KEY", "STT_MODEL"} & set(values):
            p, model = eff("STT_PROVIDER"), eff("STT_MODEL")
            models = snap["choices"]["stt_models"].get(p, [])
            if p in ("openai", "groq"):
                key_set = values.get("STT_API_KEY", "") != "" or ("STT_API_KEY" not in values and (rows.get("STT_API_KEY") or {}).get("set"))
                if not key_set:
                    fields["STT_API_KEY"] = f"{p} needs an API key"
            if p and model and model not in models:
                fields["STT_MODEL"] = f"is not a {p} speech-to-text model ({', '.join(models)})"
            if p == "bedrock" and (model or "voxtral-small") in snap["choices"].get("stt_bedrock_refused", []):
                fields["STT_PROVIDER"] = st.STT_REFUSED
            elif p == "bedrock" and (model or "voxtral-small") not in snap["choices"]["stt_bedrock_ready"]:
                fields["STT_PROVIDER"] = "Voxtral is not usable with your AWS key (the last model check)"
        return fields

    async def apply(request: Request) -> Response:
        st.sweep_requests(s.request_dir)
        got = await front_door(request)
        if isinstance(got, Response):
            return got
        data, password = got
        snap = st.snapshot(s.status_dir)
        if snap is None:
            return err(409, "Settings are not available yet: run ./stack up once.")
        if data.get("base") != snap["base"]:
            return err(409, "Settings changed on disk since you opened the page — reload it.")
        values = data.get("set") if data.get("set") is not None else {}
        regen = data.get("regen") or []
        if not isinstance(regen, list) or any(k not in st.REGEN for k in regen) or len(set(regen)) != len(regen):
            return err(400, "only RUSTFS_ACCESS_KEY and SHARED_MCP_TOKEN can be regenerated")
        if not isinstance(values, dict) or not (values or regen) or len(values) + len(regen) > st.MAX_KEYS - 1:
            return err(400, f"between 1 and {st.MAX_KEYS - 1} settings at a time")
        if any(not isinstance(k, str) or not st.NAME.fullmatch(k) or not isinstance(v, str) for k, v in values.items()):
            return err(400, "settings are names and text values")
        local = not is_remote(request)
        confirm = data.get("confirm") or []
        if not isinstance(confirm, list) or any(c not in st.CONFIRMS for c in confirm):
            return err(400, "unknown confirmation")
        same = "PORTAL_PASSWORD" in values and await asyncio.to_thread(verify_password, values["PORTAL_PASSWORD"], s.password_hash)
        fields = check_values(values, snap, local, same)
        if fields:
            return err(400, "Some settings need another value.", fields=fields)
        if (busy := helper_ready()) is not None:
            return busy
        if wait := apply_rate.retry_after():
            return err(429, f"Please wait {wait} s before the next change.", wait)
        values = dict(values)
        new_hash = None
        if "PORTAL_PASSWORD" in values:
            new_hash = await asyncio.to_thread(hash_password, values["PORTAL_PASSWORD"])
            values["PORTAL_PASSWORD_HASH"] = new_hash
        try:
            nonce = st.write_request(s.request_dir, snap["base"], local, password, values, regen=tuple(regen),
                                     confirm=tuple(confirm))
        except ValueError:
            return err(413, "These settings do not fit in one change: save them in smaller groups.")
        except OSError as e:
            log.warning("cannot write a settings request to %s (%s)", s.request_dir, e)
            return err(500, "Could not hand the change to the helper (see ./stack logs portal).")
        apply_rate.hit()
        keys = [k for k in values if k != "PORTAL_PASSWORD_HASH"] + list(regen)
        log.warning("settings change requested: %s%s", ", ".join(keys), "" if local else " (remote)")
        resp = _no_store(JSONResponse({"id": nonce, "keys": keys}, status_code=202))
        if new_hash:
            # Carry-over: this browser stays signed in after the portal restarts with the new password; the
            # running portal (old hash) refuses this cookie, every other session ends with the restart.
            rem = ctx.remote(request)
            c = cookie_params(s, rem, carry=True)
            token = Sessions(s.secret, new_hash).issue(login=ctx.session_login(request))
            resp.set_cookie(c["key"], token, max_age=NEXT_MAX_AGE, path="/", domain=c["domain"], httponly=True,
                            samesite="strict", secure=c["secure"])
        return resp

    def reveal_value(key: str) -> str:
        env = {"claude-code": "LITELLM_KEY_CLAUDE_CODE", "open-webui": "LITELLM_KEY_OPENWEBUI", "setup": "LITELLM_KEY_SETUP"}
        keys = {env[a]: v for a, _, v in s.keys if a in env}
        return {"LITELLM_UI_PASSWORD": s.litellm_ui_password, "RUSTFS_ACCESS_KEY": s.rustfs_access_key,
                "RUSTFS_SECRET_KEY": s.rustfs_secret_key, "SHARED_MCP_TOKEN": s.shared_mcp_token, **keys}.get(key, "")

    async def reveal(request: Request) -> Response:
        """One of the values the portal holds anyway (st.REVEAL), after the password again."""
        got = await front_door(request)
        if isinstance(got, Response):
            return got
        key = got[0].get("key")
        if key not in st.REVEAL:
            return err(403, "That setting is never shown here.")
        value = reveal_value(key)
        if not value:
            return err(404, "Not set.")
        log.warning("settings: %s revealed%s", key, " (remote)" if is_remote(request) else "")
        return _no_store(JSONResponse({"key": key, "value": value}))

    async def action(request: Request) -> Response:
        st.sweep_requests(s.request_dir)
        got = await front_door(request)
        if isinstance(got, Response):
            return got
        data, password = got
        act = data.get("action")
        if act not in st.DIAG_ACTIONS:
            return err(400, "unknown action")
        if (busy := helper_ready()) is not None:
            return busy
        if act not in st.capability(s.status_dir)["diagnostics"]:
            return err(409, "This update helper does not offer that yet: ./stack helper install refreshes it.")
        if wait := action_rate.retry_after():
            return err(429, f"Please wait {wait} s before the next action.", wait)
        try:
            nonce = st.write_action(s.request_dir, act, password)
        except ValueError:
            return err(413, f"The portal password is longer than {st.MAX_AUTH} bytes: set a shorter one with ./stack config set PORTAL_PASSWORD.")
        except OSError as e:
            log.warning("cannot write the %s request to %s (%s)", act, s.request_dir, e)
            return err(500, "Could not hand the request to the helper (see ./stack logs portal).")
        action_rate.hit()
        log.warning("diagnostic requested: %s%s", act, " (remote)" if is_remote(request) else "")
        return _no_store(JSONResponse({"id": nonce, "action": act}, status_code=202))

    async def project_action(request: Request) -> Response:
        """A project folder action for the helper: the folder chooser on this computer's screen (local sessions only:
        a request never names a path), or a folder removed / made read-only by its id (narrowing: from anywhere)."""
        st.sweep_requests(s.request_dir)
        got = await front_door(request)
        if isinstance(got, Response):
            return got
        data, password = got
        act, when = data.get("action"), data.get("when", "now")
        if act not in st.PROJECT_ACTIONS or when not in ("now", "idle"):
            return err(400, "unknown action")
        if act == "project-pick" and is_remote(request):
            return err(403, "A folder is added only from the computer running bedrock-now: its folder chooser opens on that screen.")
        project = data.get("project")
        if act != "project-pick":
            if not isinstance(project, str) or not st.PROJECT_ID.fullmatch(project):
                return err(400, "bad project id")
            if not any(f["id"] == project for f in st.project_folders(s.status_dir)["folders"]):
                return err(404, "No such project folder (removed already?).")
        mode, hide = data.get("mode", "rw"), data.get("hide", False)
        if act == "project-pick" and (mode not in ("rw", "ro") or not isinstance(hide, bool)):
            return err(400, "bad request")
        if (busy := helper_ready()) is not None:
            return busy
        cap = st.capability(s.status_dir)
        if act not in cap["projects"]:
            return err(409, "This update helper does not offer project folders yet: ./stack helper install refreshes it.")
        if act == "project-pick" and not cap["screen"]:
            return err(409, "The update helper cannot show a dialog on this computer's screen: in a terminal there, ./stack project add DIR.")
        if wait := action_rate.retry_after():
            return err(429, f"Please wait {wait} s before the next action.", wait)
        try:
            nonce = st.write_project_action(s.request_dir, act, password, when, project=project if act != "project-pick" else None,
                                            mode=mode, hide=hide)
        except ValueError:
            return err(413, f"The portal password is longer than {st.MAX_AUTH} bytes: set a shorter one with ./stack config set PORTAL_PASSWORD.")
        except OSError as e:
            log.warning("cannot write the %s request to %s (%s)", act, s.request_dir, e)
            return err(500, "Could not hand the request to the helper (see ./stack logs portal).")
        action_rate.hit()
        log.warning("project folder action requested: %s%s", act, " (remote)" if is_remote(request) else "")
        return _no_store(JSONResponse({"id": nonce, "action": act}, status_code=202))

    async def sessions_action(request: Request) -> Response:
        """What bedrock-now may read of your sessions on this computer, taken back (narrowing: from anywhere; given only
        on the computer itself): by a project's id, or all, and a tool — never a path."""
        st.sweep_requests(s.request_dir)
        got = await front_door(request)
        if isinstance(got, Response):
            return got
        data, password = got
        act, project, tool = data.get("action"), data.get("project"), data.get("tool")
        if act not in st.SESSIONS_ACTIONS:
            return err(400, "unknown action")
        if not (project == "all" or (isinstance(project, str) and st.PROJECT_ID.fullmatch(project))) or tool not in ("claude", "claude-bedrock", "both", "suggest"):
            return err(400, "bad request")
        if (busy := helper_ready()) is not None:
            return busy
        if act not in st.capability(s.status_dir)["sessions"]:
            return err(409, "This update helper does not take that back yet: ./stack helper install refreshes it, or ./stack sessions consent --revoke in a terminal.")
        if wait := action_rate.retry_after():
            return err(429, f"Please wait {wait} s before the next action.", wait)
        try:
            nonce = st.write_sessions_action(s.request_dir, password, project, tool)
        except ValueError:
            return err(413, f"The portal password is longer than {st.MAX_AUTH} bytes: set a shorter one with ./stack config set PORTAL_PASSWORD.")
        except OSError as e:
            log.warning("cannot write the %s request to %s (%s)", act, s.request_dir, e)
            return err(500, "Could not hand the request to the helper (see ./stack logs portal).")
        action_rate.hit()
        log.warning("sessions consent taken back: %s %s%s", project, tool, " (remote)" if is_remote(request) else "")
        return _no_store(JSONResponse({"id": nonce, "action": act}, status_code=202))

    async def signout_others(request: Request) -> Response:
        """Every other browser and device signs in again; this one stays (its new session starts just after)."""
        got = await front_door(request)
        if isinstance(got, Response):
            return got
        ctx.sessions.revoke_all()
        ctx.on_signout()
        resp = _no_store(JSONResponse({"ok": True}))
        rem = ctx.remote(request)
        ctx.set_session(resp, rem, ctx.session_login(request), ctx.sessions.not_before + 0.001)
        c = cookie_params(s, rem, carry=True)
        resp.delete_cookie(c["key"], path="/", domain=c["domain"], httponly=True, samesite="strict", secure=c["secure"])
        log.warning("settings: signed out every other device%s", " (remote)" if is_remote(request) else "")
        return resp

    async def get_report(request: Request) -> Response:
        if (deny := ctx.api_guard(request)) is not None:
            return deny
        if not allowed(request):
            return err(403, "Diagnostics are off for remote access (REMOTE_ADMIN_ACTIONS in .env).")
        return _no_store(JSONResponse(st.report(s.status_dir)))

    return [
        Route("/api/settings", get_settings, methods=["GET"]),
        Route("/api/settings/apply", apply, methods=["POST"]),
        Route("/api/settings/reveal", reveal, methods=["POST"]),
        Route("/api/settings/action", action, methods=["POST"]),
        Route("/api/settings/project", project_action, methods=["POST"]),
        Route("/api/settings/sessions", sessions_action, methods=["POST"]),
        Route("/api/settings/signout-others", signout_others, methods=["POST"]),
        Route("/api/settings/report", get_report, methods=["GET"]),
    ]
