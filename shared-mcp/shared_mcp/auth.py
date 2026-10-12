"""Pure-ASGI bearer-token gate (doesn't buffer streaming responses the way BaseHTTPMiddleware can)."""

import hmac

from starlette.responses import JSONResponse

OPEN_PATHS = {"/healthz"}


class BearerAuth:
    def __init__(self, app, token: str):
        if not token:
            raise ValueError("SHARED_MCP_TOKEN must be set")
        self.app = app
        self.expected = f"Bearer {token}".encode()

    async def __call__(self, scope, receive, send):
        kind = scope["type"]
        if kind == "lifespan":
            await self.app(scope, receive, send)
            return
        if kind == "websocket":  # not used by MCP streamable HTTP; refuse outright
            await send({"type": "websocket.close", "code": 1008})
            return
        if kind != "http":
            return
        if scope["path"] not in OPEN_PATHS:
            supplied = dict(scope.get("headers") or []).get(b"authorization", b"")
            if not hmac.compare_digest(supplied, self.expected):
                await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
                return
        await self.app(scope, receive, send)
