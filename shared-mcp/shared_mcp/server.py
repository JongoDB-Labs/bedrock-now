"""bedrock-shared MCP server: the `shared` bucket + Open WebUI knowledge search, over streamable HTTP."""

import os
import posixpath
from functools import lru_cache, partial

import anyio.to_thread
import boto3
import uvicorn
from botocore.config import Config
from mcp.server.fastmcp import FastMCP
from starlette.responses import PlainTextResponse

from .auth import BearerAuth
from .openwebui import OpenWebUI
from .storage import SharedStore

# FastMCP's default host (127.0.0.1) turns on DNS-rebinding protection: requests to /mcp must carry a
# Host header of 127.0.0.1:*, localhost:* or [::1]:*. Claude Code on the host uses the published
# 127.0.0.1 port, so that works; a client inside the compose network calling http://shared-mcp:8000
# gets "421 Invalid Host header". Pass transport_security=TransportSecuritySettings(allowed_hosts=[...])
# here if in-network clients are ever needed. (/healthz is a custom route and is not affected.)
mcp = FastMCP("bedrock-shared", stateless_http=True, json_response=True)


def _env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} is not set; re-run ./stack setup")
    return value


@lru_cache(maxsize=1)
def store() -> SharedStore:
    s3 = boto3.client(
        "s3",
        endpoint_url=_env("S3_ENDPOINT_URL"),
        aws_access_key_id=_env("S3_ACCESS_KEY_ID"),
        aws_secret_access_key=_env("S3_SECRET_ACCESS_KEY"),
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}, connect_timeout=3, read_timeout=30,
                      retries={"max_attempts": 2, "mode": "standard"}),
    )
    return SharedStore(s3=s3, bucket=os.environ.get("SHARED_BUCKET", "shared"))


@lru_cache(maxsize=1)
def owui() -> OpenWebUI:
    return OpenWebUI(_env("OPENWEBUI_URL"), _env("OPENWEBUI_API_KEY"))


async def _blocking(fn, *args, **kwargs):
    """Run boto3/httpx calls in a worker thread so a slow backend never stalls the event loop (or /healthz)."""
    return await anyio.to_thread.run_sync(partial(fn, *args, **kwargs))


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(_request):
    return PlainTextResponse("ok")


@mcp.tool()
async def list_files(prefix: str = "") -> dict:
    """List files in the shared bucket (also browsable in the RustFS console). Optional path prefix
    like 'reports/'. Returns {"files": [{path, size, modified}], "truncated": bool}; at most 500 files are
    returned, and "truncated" is true when there are more (narrow the prefix)."""
    return await _blocking(lambda: store().list(prefix))


@mcp.tool()
async def read_file(path: str) -> str:
    """Read a UTF-8 text file (max 2 MB) from the shared bucket."""
    return await _blocking(lambda: store().read_text(path))


def _write(path: str, content: str, ingest_to: str | None) -> dict:
    key = store().write_text(path, content)
    result: dict = {"path": key}
    if ingest_to:
        try:
            result["ingested"] = owui().ingest(posixpath.basename(key), content.encode("utf-8"), ingest_to)
        except Exception as e:  # the file is already written; report the ingest problem, don't hide the write
            result["ingest_error"] = f"{type(e).__name__}: {e}"
    return result


@mcp.tool()
async def write_file(path: str, content: str, ingest_to: str | None = None) -> dict:
    """Write a UTF-8 text file to the shared bucket. If `ingest_to` names an Open WebUI knowledge base
    (created if missing), the file is also indexed there so it can be used in Open WebUI chats.
    If indexing fails the file is still written and the result carries "ingest_error"."""
    return await _blocking(_write, path, content, ingest_to)


@mcp.tool()
async def list_knowledge_bases() -> list[dict]:
    """List Open WebUI knowledge bases (the RAG collections used in Open WebUI chats)."""
    return await _blocking(lambda: owui().list_knowledge_bases())


def _search(query: str, knowledge_base: str | None, k: int) -> list[dict]:
    client = owui()
    ids = ([client.resolve_kb(knowledge_base)] if knowledge_base
           else [kb["id"] for kb in client.list_knowledge_bases()])
    return client.search(query, ids, k) if ids else []


@mcp.tool()
async def search_knowledge(query: str, knowledge_base: str | None = None, k: int = 5) -> list[dict]:
    """Semantic search over Open WebUI knowledge bases — the same index Open WebUI chats use.
    Searches every knowledge base unless `knowledge_base` (name or id) is given."""
    return await _blocking(_search, query, knowledge_base, k)


def main() -> None:
    app = BearerAuth(mcp.streamable_http_app(), os.environ.get("SHARED_MCP_TOKEN", ""))
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")


if __name__ == "__main__":
    main()
