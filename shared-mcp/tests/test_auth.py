import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from shared_mcp.auth import BearerAuth

inner = Starlette(routes=[
    Route("/mcp", lambda r: PlainTextResponse("ok"), methods=["GET", "POST"]),
    Route("/healthz", lambda r: PlainTextResponse("ok")),
])
client = TestClient(BearerAuth(inner, "s3cret"))


def test_rejects_missing_token():
    assert client.get("/mcp").status_code == 401


def test_rejects_wrong_token():
    assert client.get("/mcp", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_accepts_right_token():
    assert client.get("/mcp", headers={"Authorization": "Bearer s3cret"}).text == "ok"


def test_healthz_is_open():
    assert client.get("/healthz").status_code == 200


def test_websocket_is_refused_even_with_token():
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/mcp", headers={"Authorization": "Bearer s3cret"}):
            pass
    assert exc.value.code == 1008


def test_empty_token_is_rejected_at_startup():
    with pytest.raises(ValueError):
        BearerAuth(inner, "")
