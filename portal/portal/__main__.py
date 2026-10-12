"""python -m portal — serve the portal on :8000 (reached only through Caddy)."""

import logging
import sys

import uvicorn

from .app import create_app
from .config import ConfigError, from_env


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    try:
        settings = from_env()
    except ConfigError as e:
        print(f"portal: {e}", file=sys.stderr)
        sys.exit(2)
    # access_log off: Caddy is the front door; uvicorn's log would only repeat /auth/verify calls.
    uvicorn.run(create_app(settings), host="0.0.0.0", port=8000, access_log=False, proxy_headers=False)


if __name__ == "__main__":
    main()
