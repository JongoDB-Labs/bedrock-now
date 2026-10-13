"""python -m stt_service — serve on :8000 (reached only from Open WebUI on the stack's network; no published port)."""

import logging
import shutil
import sys

import uvicorn

from .app import ConfigError, create_app, from_env


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    try:
        settings = from_env()
    except (ConfigError, ValueError) as e:
        print(f"stt: {e}", file=sys.stderr)
        sys.exit(2)
    if not shutil.which("ffmpeg"):
        print("stt: ffmpeg not found", file=sys.stderr)
        sys.exit(2)
    uvicorn.run(create_app(settings), host="0.0.0.0", port=8000, access_log=False, proxy_headers=False)


if __name__ == "__main__":
    main()
