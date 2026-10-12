"""Portal settings, read once from the environment (compose passes them from .env)."""

from __future__ import annotations

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

# The apps the portal fronts and their start paths (Caddy routes them; see caddy/Caddyfile). Each has its own host
# name: CHAT_HOST / ADMIN_HOST / FILES_HOST, by default chat./admin./files. under PORTAL_HOST.
APPS = {"chat": "/", "admin": "/ui/", "files": "/rustfs/console/"}
APP_HOST_ENV = {"chat": "CHAT_HOST", "admin": "ADMIN_HOST", "files": "FILES_HOST"}
REMOTE_APP_HOST_ENV = {"chat": "REMOTE_CHAT_HOST", "admin": "REMOTE_ADMIN_HOST", "files": "REMOTE_FILES_HOST"}
REMOTE_MODES = ("tailscale", "domain")

# LiteLLM virtual keys shown on Home: (env var, key alias, label)
KEYS = (
    ("LITELLM_KEY_CLAUDE_CODE", "claude-code", "Claude Code"),
    ("LITELLM_KEY_OPENWEBUI", "open-webui", "Chat (Open WebUI)"),
    ("LITELLM_KEY_SETUP", "setup", "Setup and tests"),
)


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    password: str
    secret: str
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
    tailscale_allowed_login: str = ""  # tailscale mode: Tailscale-User-Login, when present, must be this login

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
        return local + ([self.origin(sub, remote=True) for sub in APPS] if self.remote_on() else [])

    def app_urls(self, remote: bool = False) -> dict:
        """{"chat": "https://…/", …}: where Home opens each app on this site."""
        return {sub: self.origin(sub, remote) + path for sub, path in APPS.items()}


def from_env(env: dict | None = None) -> Settings:
    env = os.environ if env is None else env
    password = env.get("PORTAL_PASSWORD", "")
    secret = env.get("PORTAL_SECRET", "")
    if not password:
        raise ConfigError("PORTAL_PASSWORD is not set — run ./stack setup")
    if len(secret) < 32:
        raise ConfigError("PORTAL_SECRET is missing or shorter than 32 characters — run ./stack setup")
    try:
        port = int(env.get("PORTAL_PORT") or 80)
    except ValueError as e:
        raise ConfigError(f"PORTAL_PORT is not a number: {env.get('PORTAL_PORT')!r}") from e
    keys = tuple((alias, label, env.get(var, "")) for var, alias, label in KEYS)
    return Settings(
        password=password,
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
        remote_admin_actions=(env.get("REMOTE_ADMIN_ACTIONS") or "false").strip().lower() in ("true", "1", "yes", "on"),
        app_hosts={sub: env.get(var, "").strip().lower() for sub, var in APP_HOST_ENV.items() if env.get(var, "").strip()},
        remote_mode=(env.get("REMOTE_MODE") or "").strip().lower(),
        remote_host=(env.get("REMOTE_HOST") or "").strip().lower(),
        remote_app_hosts={sub: (env.get(var) or "").strip().lower() for sub, var in REMOTE_APP_HOST_ENV.items()},
        tailscale_allowed_login=(env.get("TAILSCALE_ALLOWED_LOGIN") or "").strip().lower(),
        claude_models={
            "opus": env.get("CLAUDE_BEDROCK_OPUS_MODEL", ""),
            "sonnet": env.get("CLAUDE_BEDROCK_SONNET_MODEL", ""),
            "haiku": env.get("CLAUDE_BEDROCK_HAIKU_MODEL", ""),
        },
    )
