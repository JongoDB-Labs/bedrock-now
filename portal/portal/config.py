"""Portal settings, read once from the environment (compose passes them from .env)."""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

# Same rule as valid_or_key in lib/openrouter.sh: a key with anything else is treated as "no key" and never sent.
_OPENROUTER_KEY = re.compile(r"[A-Za-z0-9_-]+")


def valid_openrouter_key(key: str) -> bool:
    return bool(key) and _OPENROUTER_KEY.fullmatch(key) is not None


def openrouter_key(key: str) -> str:
    return key if valid_openrouter_key(key) else ""


def site_of(host: str) -> str:
    """A host's site as browsers see it for a name under .localhost (not on the public suffix list: its last label
    counts as the registry): the last two labels."""
    return ".".join(host.split(".")[-2:])


PREVIEW_SITE_SUFFIX = "-preview.localhost"
_PREVIEW_DOMAIN = re.compile(r"[a-z0-9]([a-z0-9-]{0,52}[a-z0-9])?-preview\.localhost")
_HOSTNAME = re.compile(r"(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")

# The apps the portal fronts and their start paths (Caddy routes them; see caddy/Caddyfile). Each has its own host
# name: CHAT_HOST / ADMIN_HOST / FILES_HOST, by default chat./admin./files. under PORTAL_HOST.
APPS = {"chat": "/", "admin": "/ui/", "files": "/rustfs/console/"}
APP_HOST_ENV = {"chat": "CHAT_HOST", "admin": "ADMIN_HOST", "files": "FILES_HOST"}
REMOTE_APP_HOST_ENV = {"chat": "REMOTE_CHAT_HOST", "admin": "REMOTE_ADMIN_HOST", "files": "REMOTE_FILES_HOST"}
REMOTE_MODES = ("tailscale", "domain")
# The optional browser terminal (./stack terminal; compose.terminal.yaml passes TERMINAL_ENABLED=true): its own host,
# TERMINAL_HOST (default terminal.PORTAL_HOST), behind the session AND a fresh password unlock; on the remote site
# only with REMOTE_TERMINAL=true (REMOTE_TERMINAL_HOST, written by lib/terminal.sh).
TERMINAL = "terminal"
# The optional Code page (./stack code; compose.code.yaml passes CODE_ENABLED=true): Claude Code with a chat, in the
# terminal's sandbox — so only while the terminal is on. Its own host, CODE_HOST (default code.PORTAL_HOST), behind the
# session AND a fresh password unlock of its own; remote with the terminal's switch (REMOTE_CODE_HOST, lib/code.sh).
CODE = "code"

# LiteLLM virtual keys shown on Home: (env var, key alias, label)
KEYS = (
    ("LITELLM_KEY_CLAUDE_CODE", "claude-code", "Claude Code"),
    ("LITELLM_KEY_OPENWEBUI", "open-webui", "Chat (Open WebUI)"),
    ("LITELLM_KEY_SETUP", "setup", "Setup and tests"),
    ("LITELLM_KEY_TERMINAL", "claude-code-terminal", "Terminal (browser)"),   # only once ./stack terminal made it
)
OPTIONAL_KEYS = ("LITELLM_KEY_TERMINAL",)


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    password_hash: str = field(repr=False)  # PBKDF2 hash of PORTAL_PASSWORD (security.hash_password); never the password
    secret: str = field(repr=False)
    host: str = "bedrock-now.localhost"
    port: int = 80
    user_email: str = "admin@bedrock-now.local"
    litellm_url: str = "http://litellm:4000"
    litellm_master_key: str = ""
    keys: tuple = ()  # ((alias, label, key), ...)
    litellm_ui_user: str = "admin"
    litellm_ui_password: str = ""
    rustfs_access_key: str = ""
    rustfs_secret_key: str = ""
    shared_mcp_token: str = field(default="", repr=False)  # Settings → Files shows it behind the password
    session_days: int = 30   # PORTAL_SESSION_DAYS (1-90): how long a sign-in lasts
    alert_pct: int = 80      # BUDGET_ALERT_PCT (50-99): where Home's budget meters turn amber
    openwebui_url: str = "http://open-webui:8080"
    rustfs_url: str = "http://rustfs:9000"
    shared_mcp_url: str = "http://shared-mcp:8000"
    litellm_dir: Path = Path("/data/litellm")
    catalog_dir: Path = Path("/data/catalog")
    prices_dir: Path = Path("/data/prices")  # writable mount for the daily price update (its two files only)
    aws_region: str = "us-east-1"
    price_updates: bool = False  # from_env turns it on unless PRICE_UPDATES=false; off in tests (no network)
    claude_models: dict = field(default_factory=dict)
    state_dir: Path | None = None  # logout time survives restarts here (compose: the portal-state volume)
    openrouter_api_key: str = field(default="", repr=False)  # optional; only sent to openrouter.ai (portal/openrouter.py)
    # Daily release check (portal/updates.py): writes only update_dir; reads status_dir (written by ./stack).
    update_check: bool = False  # from_env turns it on unless UPDATE_CHECK=false; off in tests (no network)
    update_dir: Path = Path("/data/update-check")
    status_dir: Path = Path("/data/status")
    # One-click actions through the host helper (portal/admin.py): the only folder they write is request_dir.
    request_dir: Path = Path("/data/requests")
    remote_admin_actions: bool = False  # REMOTE_ADMIN_ACTIONS=true allows them from remote (non-localhost) access
    app_hosts: dict = field(default_factory=dict)  # local overrides {"chat": host, ...}; missing = <app>.<host>
    # Remote access (./stack remote, docs/remote.md): a second site, https on 443, that Caddy marks with
    # X-Portal-Remote: 1. Off unless remote_mode is tailscale/domain and remote_host is set.
    remote_mode: str = ""
    remote_host: str = ""
    remote_app_hosts: dict = field(default_factory=dict)  # {"chat": host, "admin": host, "files": host}
    tailscale_allowed_login: str = ""  # tailscale mode: every remote request must carry this Tailscale-User-Login
    # Caddy adds X-Portal-Proxy: <this> to everything it forwards; without it X-Portal-Remote and
    # Tailscale-User-Login are ignored (they could only come from another container calling portal:8000 directly).
    proxy_secret: str = field(default="", repr=False)
    # Where PORTAL_PASSWORD lives (./stack passes the .env path, ~ for $HOME, and the Compose project), so the
    # login page of a second copy names its own .env. Blank: the generic wording.
    env_file: str = ""
    project: str = ""
    # Voice on Home (lib/stt.sh): Open WebUI's engine ("web" = browser speech), the provider and its model.
    stt_engine: str = "web"
    stt_provider: str = ""
    stt_model: str = ""
    stt_url: str = "http://caddy:8090"   # Caddy's internal speech-to-text site (no network is shared with stt)
    terminal: bool = False         # TERMINAL_ENABLED=true: the Terminal tab and terminal host (./stack terminal)
    remote_terminal: bool = False  # REMOTE_TERMINAL=true: also on the remote site (remote_app_hosts["terminal"])
    code: bool = False             # CODE_ENABLED=true (with the terminal): the Code tab and code host (./stack code)
    # The Code page's previews of dev servers in the sandbox (caddy/preview-on.caddy): their own site,
    # p<port>-<capability>.PREVIEW_DOMAIN (compose.code.yaml; lib/code.sh derives it from PORTAL_HOST).
    preview_domain: str = ""
    # ... and over remote access (caddy/remote-*.caddy, remote_preview): one host, REMOTE_PREVIEW_HOST (written by
    # lib/code.sh: <base>-preview.<tailnet>.ts.net, preview.<REMOTE_HOST> or REMOTE_PREVIEW_DOMAIN), routed by the
    # __Host-bn_preview cookie a hand-off from the code host sets. Blank: off (REMOTE_PREVIEW not true — the default — or
    # no remote Code page); remote_preview (REMOTE_PREVIEW=true) says which, for the Code page's message.
    remote_preview_host: str = ""
    remote_preview: bool = False

    def password_where(self) -> str:
        """"~/bn/.env (project bn-dev)", or "" when ./stack did not say."""
        if not self.env_file:
            return ""
        return f"{self.env_file} (project {self.project})" if self.project else self.env_file

    def remote_on(self) -> bool:
        return self.remote_mode in REMOTE_MODES and bool(self.remote_host)

    def app_host(self, sub: str | None = None, remote: bool = False) -> str:
        if remote:
            return self.remote_app_hosts.get(sub, "") if sub else self.remote_host
        return (self.app_hosts.get(sub) or f"{sub}.{self.host}") if sub else self.host

    def origin(self, sub: str | None = None, remote: bool = False) -> str:
        """http://<host>[:port] (':80' left out, exactly as browsers send it in Origin); remote: https://<host>."""
        host = self.app_host(sub, remote)
        if remote:
            return f"https://{host}"
        return f"http://{host}" if self.port == 80 else f"http://{host}:{self.port}"

    def portal_origins(self) -> list[str]:
        """The portal's own origins: the local one, plus the remote one while remote access is on."""
        return [self.origin()] + ([self.origin(remote=True)] if self.remote_on() else [])

    def app_origins(self) -> list[str]:
        local = [self.origin(sub) for sub in APPS]
        return (local + ([self.origin(sub, remote=True) for sub in APPS] if self.remote_on() else []) + self.terminal_origins()
                + self.code_origins())

    def app_urls(self, remote: bool = False) -> dict:
        """{"chat": "https://…/", …}: where Home opens each app on this site (the terminal only where it is on)."""
        urls = {sub: self.origin(sub, remote) + path for sub, path in APPS.items()}
        if self.terminal_on(remote):
            urls[TERMINAL] = self.origin(TERMINAL, remote) + "/"
        if self.code_on(remote):
            urls[CODE] = self.origin(CODE, remote) + "/"
        return urls

    def terminal_on(self, remote: bool = False) -> bool:
        """The terminal is enabled — and, on the remote site, allowed there (REMOTE_TERMINAL) with a name of its own."""
        if not self.terminal:
            return False
        return not remote or (self.remote_terminal and self.remote_on() and bool(self.remote_app_hosts.get(TERMINAL)))

    def terminal_origins(self) -> list[str]:
        return [self.origin(TERMINAL, remote=rem) for rem in (False, True) if self.terminal_on(rem)]

    def code_on(self, remote: bool = False) -> bool:
        """The Code page is enabled and so is the terminal (its sandbox) on this site; remotely also its own name."""
        return self.code and self.terminal_on(remote) and (not remote or bool(self.remote_app_hosts.get(CODE)))

    def code_origins(self) -> list[str]:
        return [self.origin(CODE, remote=rem) for rem in (False, True) if self.code_on(rem)]

    def preview_on(self, remote: bool = False) -> bool:
        """Previews: with the Code page on this site — locally on PREVIEW_DOMAIN, remotely on REMOTE_PREVIEW_HOST."""
        if remote:
            return self.code_on(True) and bool(self.remote_preview_host)
        return self.code_on(False) and bool(self.preview_domain)

    def remote_preview_same_site(self) -> bool:
        """The remote preview host is on the remote portal's site (<base>-preview.<tailnet>.ts.net beside <base>.<tailnet>.
        ts.net — ts.net is a public suffix, so every Service of a tailnet is one site — or preview.<REMOTE_HOST>): its
        cookie can be SameSite=Strict, and the Code page frames it as a first-party frame. A REMOTE_PREVIEW_DOMAIN on a
        registrable domain of its own is another site: the frame is a third-party one there."""
        h, r = self.remote_preview_host, self.remote_host
        if not h or not r:
            return False
        return h.endswith("." + r) or (r.endswith(".ts.net") and h.split(".", 1)[-1] == r.split(".", 1)[-1])

    def locked_on(self, app: str, remote: bool = False) -> bool:
        """The terminal / the Code page: on, and usable on this site."""
        return self.terminal_on(remote) if app == TERMINAL else self.code_on(remote) if app == CODE else False


def _on(value: str | None) -> bool:
    """true / 1 / yes / on (any case) — anything else, or nothing, is off."""
    return (value or "false").strip().lower() in ("true", "1", "yes", "on")


def _int_in(raw, lo: int, hi: int, default: int) -> int:
    """A whole number within [lo, hi] from the environment; anything else is the default (as ./stack reads it)."""
    raw = (raw or "").strip()
    return int(raw) if raw.isdigit() and lo <= int(raw) <= hi else default


def from_env(env: dict | None = None) -> Settings:
    from .security import PW_HASH, hash_password  # (security imports this module)

    env = os.environ if env is None else env
    secret = env.get("PORTAL_SECRET", "")
    if len(secret) < 32:
        raise ConfigError("PORTAL_SECRET is missing or shorter than 32 characters — run ./stack setup")
    password_hash = (env.get("PORTAL_PASSWORD_HASH") or "").strip()
    if password_hash and not PW_HASH.fullmatch(password_hash):
        raise ConfigError("PORTAL_PASSWORD_HASH is not a hash this portal reads — run ./stack up")
    if not password_hash and env.get("PORTAL_PASSWORD"):
        # Development only (compose passes the hash): a salt derived from the secret keeps sessions across restarts.
        password_hash = hash_password(env["PORTAL_PASSWORD"], salt=hashlib.sha256(secret.encode()).digest()[:8])
    if not password_hash:
        raise ConfigError("PORTAL_PASSWORD_HASH is not set — run ./stack setup")
    try:
        port = int(env.get("PORTAL_PORT") or 80)
    except ValueError as e:
        raise ConfigError(f"PORTAL_PORT is not a number: {env.get('PORTAL_PORT')!r}") from e
    keys = tuple((alias, label, env.get(var, "")) for var, alias, label in KEYS if var not in OPTIONAL_KEYS or env.get(var))
    terminal = _on(env.get("TERMINAL_ENABLED"))
    remote_terminal = terminal and _on(env.get("REMOTE_TERMINAL"))
    code = terminal and _on(env.get("CODE_ENABLED"))
    app_hosts = {sub: env.get(var, "").strip().lower() for sub, var in APP_HOST_ENV.items() if env.get(var, "").strip()}
    if (env.get("TERMINAL_HOST") or "").strip():
        app_hosts[TERMINAL] = env["TERMINAL_HOST"].strip().lower()
    if (env.get("CODE_HOST") or "").strip():
        app_hosts[CODE] = env["CODE_HOST"].strip().lower()
    remote_app_hosts = {sub: (env.get(var) or "").strip().lower() for sub, var in REMOTE_APP_HOST_ENV.items()}
    if remote_terminal and (env.get("REMOTE_TERMINAL_HOST") or "").strip():
        remote_app_hosts[TERMINAL] = env["REMOTE_TERMINAL_HOST"].strip().lower()
    if code and remote_terminal and (env.get("REMOTE_CODE_HOST") or "").strip():
        remote_app_hosts[CODE] = env["REMOTE_CODE_HOST"].strip().lower()
    # a preview domain is a site of its own, <name>-preview.localhost, and no portal's site is ever one (lib/portal.sh
    # refuses such a PORTAL_HOST): browsers count x.bedrock-now.localhost and bedrock-now.localhost as one site, so a
    # portal there — this one, or another install's — would get the previews' requests with its cookies
    preview = (env.get("PREVIEW_DOMAIN") or "").strip().lower() if code else ""
    host = (env.get("PORTAL_HOST") or "bedrock-now.localhost").lower()
    if preview and (not _PREVIEW_DOMAIN.fullmatch(preview) or site_of(preview) == site_of(host)
                    or any(site_of(h).endswith(PREVIEW_SITE_SUFFIX) for h in [host, *app_hosts.values()])):
        preview = ""
    # the remote preview host: only with the Code page remote, a plain host name, and never one of the remote site's own
    # (the portal's or an app's: its cookie would be theirs)
    r_preview = (env.get("REMOTE_PREVIEW_HOST") or "").strip().lower() if remote_app_hosts.get(CODE) else ""
    if r_preview and (not _HOSTNAME.fullmatch(r_preview) or r_preview in (
            (env.get("REMOTE_HOST") or "").strip().lower(), *remote_app_hosts.values())):
        r_preview = ""
    return Settings(
        password_hash=password_hash,
        secret=secret,
        host=(env.get("PORTAL_HOST") or "bedrock-now.localhost").lower(),
        port=port,
        # Open WebUI matches trusted-header users by lower-cased email.
        user_email=(env.get("PORTAL_USER_EMAIL") or "admin@bedrock-now.local").strip().lower(),
        litellm_url=env.get("LITELLM_URL", "http://litellm:4000"),
        litellm_master_key=env.get("LITELLM_MASTER_KEY", ""),
        keys=keys,
        # setup switches LiteLLM to a database admin (login = the admin email) once it has created one
        litellm_ui_user=env.get("LITELLM_UI_USER") or "admin",
        litellm_ui_password=env.get("LITELLM_UI_PASSWORD", ""),
        rustfs_access_key=env.get("RUSTFS_ACCESS_KEY", ""),
        rustfs_secret_key=env.get("RUSTFS_SECRET_KEY", ""),
        shared_mcp_token=env.get("SHARED_MCP_TOKEN", ""),
        session_days=_int_in(env.get("PORTAL_SESSION_DAYS"), 1, 90, 30),
        alert_pct=_int_in(env.get("BUDGET_ALERT_PCT"), 50, 99, 80),
        openwebui_url=env.get("OPENWEBUI_URL", "http://open-webui:8080"),
        rustfs_url=env.get("RUSTFS_URL", "http://rustfs:9000"),
        shared_mcp_url=env.get("SHARED_MCP_URL", "http://shared-mcp:8000"),
        litellm_dir=Path(env.get("PORTAL_LITELLM_DIR", "/data/litellm")),
        catalog_dir=Path(env.get("PORTAL_CATALOG_DIR", "/data/catalog")),
        state_dir=Path(env.get("PORTAL_STATE_DIR") or "/state"),
        openrouter_api_key=openrouter_key(env.get("OPENROUTER_API_KEY", "")),
        prices_dir=Path(env.get("PORTAL_PRICES_DIR", "/data/prices")),
        aws_region=env.get("AWS_REGION_NAME") or "us-east-1",
        price_updates=(env.get("PRICE_UPDATES") or "true").strip().lower() not in ("false", "0", "no", "off"),
        update_check=(env.get("UPDATE_CHECK") or "true").strip().lower() not in ("false", "0", "no", "off"),
        update_dir=Path(env.get("PORTAL_UPDATE_DIR", "/data/update-check")),
        status_dir=Path(env.get("PORTAL_STATUS_DIR", "/data/status")),
        request_dir=Path(env.get("PORTAL_REQUEST_DIR", "/data/requests")),
        remote_admin_actions=_on(env.get("REMOTE_ADMIN_ACTIONS")),
        app_hosts=app_hosts,
        remote_mode=(env.get("REMOTE_MODE") or "").strip().lower(),
        remote_host=(env.get("REMOTE_HOST") or "").strip().lower(),
        remote_app_hosts=remote_app_hosts,
        terminal=terminal,
        remote_terminal=remote_terminal,
        code=code,
        preview_domain=preview,
        remote_preview_host=r_preview,
        remote_preview=_on(env.get("REMOTE_PREVIEW")),
        tailscale_allowed_login=(env.get("TAILSCALE_ALLOWED_LOGIN") or "").strip().lower(),
        proxy_secret=env.get("PORTAL_PROXY_SECRET", ""),
        env_file=(env.get("PORTAL_ENV_FILE") or "").strip(),
        project=(env.get("PORTAL_PROJECT") or "").strip(),
        stt_engine=(env.get("STT_ENGINE") or "web").strip().lower(),
        stt_provider=(env.get("STT_PROVIDER") or "").strip().lower(),
        stt_model=((env.get("STT_BEDROCK_MODEL") if (env.get("STT_PROVIDER") or "").strip().lower() == "bedrock"
                    else env.get("STT_MODEL")) or "").strip(),
        claude_models={
            "opus": env.get("CLAUDE_BEDROCK_OPUS_MODEL", ""),
            "sonnet": env.get("CLAUDE_BEDROCK_SONNET_MODEL", ""),
            "haiku": env.get("CLAUDE_BEDROCK_HAIKU_MODEL", ""),
        },
    )
