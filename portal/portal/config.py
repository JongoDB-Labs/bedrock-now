"""Portal settings, read once from the environment (compose passes them from .env)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Subdomains of PORTAL_HOST that the portal fronts (Caddy routes them; see caddy/Caddyfile).
APPS = {"chat": "/", "admin": "/ui/", "files": "/rustfs/console/"}

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
    claude_models: dict = field(default_factory=dict)

    def origin(self, sub: str | None = None) -> str:
        """http://[sub.]host[:port] — ':80' left out, exactly as browsers send it in Origin."""
        host = f"{sub}.{self.host}" if sub else self.host
        return f"http://{host}" if self.port == 80 else f"http://{host}:{self.port}"

    def app_origins(self) -> list[str]:
        return [self.origin(sub) for sub in APPS]


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
        claude_models={
            "opus": env.get("CLAUDE_BEDROCK_OPUS_MODEL", ""),
            "sonnet": env.get("CLAUDE_BEDROCK_SONNET_MODEL", ""),
            "haiku": env.get("CLAUDE_BEDROCK_HAIKU_MODEL", ""),
        },
    )
