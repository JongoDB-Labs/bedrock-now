"""The web app manifest: what Chrome, Edge, Android and iOS need to install the portal as an app.

An installed web app belongs to one origin (http://PORTAL_HOST[:PORTAL_PORT]), so a second bedrock-now copy is a
second app. Its name says which: "bedrock-now" for the default address, "bedrock-now (bn-dev)" otherwise.
lib/portal.sh's portal_app_name gives the same name, so `./stack open` can find the installed app.
The remote address (./stack remote: https://<remote host>) is another origin, so another app: "bedrock-now
(remote)", or "bedrock-now (bn-dev, remote)" for a second copy (the local port plays no part there).
"""

from __future__ import annotations

import hashlib

from .appicons import ICON_DIR
from .config import Settings

DEFAULT_HOST = "bedrock-now.localhost"
BASE = "bedrock-now"


def app_name(host: str, port: int = 80, remote: bool = False) -> str:
    """bedrock-now, or bedrock-now (<project>[, port N]) for any other address; the remote site's app is
    bedrock-now ([<project>, ]remote). host and port are always the LOCAL ones (they name the copy)."""
    label = "" if host == DEFAULT_HOST else host.removesuffix(".localhost")
    if remote:
        label = f"{label}, remote" if label else "remote"
    elif port != 80:
        label = f"{label}, port {port}" if label else f"port {port}"
    return f"{BASE} ({label})" if label else BASE


def _icon(size: int, purpose: str = "any") -> dict:
    name = f"app-{'' if purpose == 'any' else purpose + '-'}{size}.png"
    # ?v=<content hash>: browsers and installed apps refetch an icon when it changes (the files are cached a day).
    v = hashlib.sha256((ICON_DIR / name).read_bytes()).hexdigest()[:10]
    return {"src": f"/icons/{name}?v={v}", "sizes": f"{size}x{size}", "type": "image/png", "purpose": purpose}


def manifest(s: Settings, remote: bool = False) -> dict:
    name = app_name(s.host, s.port, remote)
    icon = _icon
    return {
        "id": "/",
        "name": name,
        # Under the icon on a phone's home screen and in the Dock tooltip: short, but still tells copies apart.
        "short_name": name if name == BASE else name[len(BASE) + 2:-1],
        "description": "Chat with AI models on your own AWS account, and see what it costs.",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        # Clicking the Dock icon (or a link to the portal) brings the open window forward instead of a second one.
        "launch_handler": {"client_mode": "focus-existing"},
        # The title bar matches the sidebar; index.html's theme-color meta tags switch it for dark mode.
        "theme_color": "#e3e8ec",
        "background_color": "#edf0f2",
        "categories": ["productivity", "developer"],
        "icons": [icon(192), icon(512), icon(1024), icon(192, "maskable"), icon(512, "maskable"),
                  icon(512, "monochrome")],
        "shortcuts": [
            {"name": "Chat", "short_name": "Chat", "url": "/#chat", "icons": [icon(192)]},
            {"name": "Home", "short_name": "Home", "description": "Spend, services and models", "url": "/#home",
             "icons": [icon(192)]},
        ],
    }
