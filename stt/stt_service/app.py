"""HTTP side: POST /v1/audio/transcriptions (OpenAI-compatible multipart) and GET /healthz.

Nothing is stored: the upload is held in memory (Starlette spools a file part above 1 MB to /tmp, a tmpfs),
converted in a temporary directory that is removed right away, and neither audio nor transcripts are logged
(only sizes, durations and status codes).

Limits are enforced on the bytes actually received (chunked uploads have no Content-Length), every non-file
form field is capped at 64 KB, and at most max_parallel requests are read, converted and transcribed at once;
reading an upload may take read_timeout (30 s) at most, so a slow sender cannot hold a slot.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass

import httpx
from starlette.applications import Starlette
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException
from starlette.formparsers import MultiPartException
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response
from starlette.routing import Route

from . import audio, upstream

log = logging.getLogger("stt")
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
FORMATS = ("json", "text", "verbose_json")
MAX_FIELD = 64 * 1024          # language, prompt, model, response_format…
BODY_SLACK = 1024 * 1024       # multipart framing and the small fields, on top of the file itself


class ConfigError(Exception):
    pass


class BodyTooLarge(Exception):
    pass


@dataclass(frozen=True)
class Settings:
    litellm_url: str = "http://litellm:4000"
    model: str = "voxtral-small"          # the LiteLLM model name (catalog/models.tsv) Voxtral is served as
    max_bytes: int = 25 * 1024 * 1024     # OpenAI's limit; Open WebUI splits at 20 MB
    max_seconds: int = 600
    ffmpeg_timeout: float = 60.0
    upstream_timeout: float = 120.0
    read_timeout: float = 30.0            # the whole upload: a slow sender cannot hold one of the slots longer
    max_parallel: int = 3                 # compose sizes /tmp (192 MB) and memory (768 MB) for this many
    workdir: str | None = None


def valid_model(name: str) -> bool:
    return bool(MODEL_RE.match(name)) and ".." not in name


def from_env(env: dict | None = None) -> Settings:
    env = os.environ if env is None else env
    s = Settings(
        litellm_url=env.get("LITELLM_URL", "http://litellm:4000"),
        model=env.get("STT_BEDROCK_MODEL", "") or "voxtral-small",
        max_bytes=int(env.get("STT_MAX_MB", "25")) * 1024 * 1024,
        max_seconds=int(env.get("STT_MAX_SECONDS", "600")),
        workdir=env.get("STT_WORKDIR") or None,
    )
    if not valid_model(s.model):
        raise ConfigError(f"STT_BEDROCK_MODEL={s.model!r} is not a model name")
    if not s.litellm_url.startswith(("http://", "https://")):
        raise ConfigError("LITELLM_URL must be an http(s) URL")
    return s


def error(status: int, code: str, message: str) -> JSONResponse:
    kind = "invalid_request_error" if status < 500 else "server_error"
    return JSONResponse({"error": {"message": message, "type": kind, "code": code}}, status_code=status)


def counting_receive(receive, limit: int):
    """ASGI receive that raises BodyTooLarge once more than `limit` body bytes arrived (chunked or not)."""
    seen = 0

    async def wrapped():
        nonlocal seen
        message = await receive()
        if message.get("type") == "http.request":
            seen += len(message.get("body", b""))
            if seen > limit:
                raise BodyTooLarge
        return message

    return wrapped


def create_app(settings: Settings, client: httpx.AsyncClient | None = None) -> Starlette:
    gate = asyncio.Semaphore(settings.max_parallel)
    state: dict = {"client": client}
    too_large = f"the recording is larger than {settings.max_bytes // (1024 * 1024)} MB"

    @asynccontextmanager
    async def lifespan(_app):
        own = state["client"] is None
        if own:
            state["client"] = httpx.AsyncClient()
        try:
            yield
        finally:
            if own:
                await state["client"].aclose()

    async def healthz(_request: Request) -> Response:
        return JSONResponse({"ok": True, "model": settings.model})

    async def transcriptions(request: Request) -> Response:
        auth = request.headers.get("authorization", "")
        if not auth.lower().startswith("bearer ") or len(auth) < 12 or any(c in auth for c in "\r\n"):
            return error(401, "missing_api_key", "speech-to-text needs the LiteLLM key as 'Authorization: Bearer …'")
        try:
            length = int(request.headers.get("content-length", "0"))
        except ValueError:
            return error(400, "bad_request", "invalid Content-Length")
        if length > settings.max_bytes + BODY_SLACK:
            return error(413, "file_too_large", too_large)
        if not request.headers.get("content-type", "").lower().startswith("multipart/form-data"):
            return error(400, "bad_request", "send the audio as multipart/form-data with a 'file' field")
        async with gate:
            return await _transcribe(Request(request.scope, counting_receive(request.receive, settings.max_bytes + BODY_SLACK)), auth)

    async def _transcribe(request: Request, auth: str) -> Response:
        t0 = time.monotonic()

        async def read_form():
            return await request.form(max_files=1, max_fields=16, max_part_size=MAX_FIELD)

        try:
            form = await asyncio.wait_for(read_form(), settings.read_timeout)
        except asyncio.TimeoutError:
            return error(408, "upload_timeout", f"the upload took longer than {int(settings.read_timeout)} s")
        except BodyTooLarge:
            return error(413, "file_too_large", too_large)
        except (MultiPartException, HTTPException) as e:   # Starlette turns MultiPartException into a 400
            why = str(getattr(e, "detail", "") or e)
            if "maximum size" in why.lower():
                return error(413, "field_too_large", "a form field is larger than 64 KB")
            return error(400, "bad_request", f"could not read the upload: {why}")
        except OSError as e:
            return error(503, "server_busy", f"the speech-to-text service has no room for the upload right now — try again ({e.strerror or e})")
        try:
            up = form.get("file")
            if not isinstance(up, UploadFile):
                return error(400, "missing_file", "no 'file' in the upload")
            data = await up.read(settings.max_bytes + 1)
            if len(data) > settings.max_bytes:
                return error(413, "file_too_large", too_large)
            fmt_out = str(form.get("response_format") or "json")
            if fmt_out not in FORMATS:
                return error(400, "unsupported_response_format", f"response_format must be one of {', '.join(FORMATS)}")
            language = str(form.get("language") or "") or None
            prompt = str(form.get("prompt") or "") or None
        finally:
            await form.close()

        fmt = audio.sniff(data[:16])
        if fmt is None:
            return error(400, "unsupported_audio", "unsupported audio: send WebM, Ogg, MP4/M4A, WAV, MP3, AAC or FLAC")
        try:
            mp3 = await audio.to_mp3(data, fmt, settings.max_seconds, settings.ffmpeg_timeout, settings.workdir)
        except audio.AudioError as e:
            log.info("rejected %s upload (%d bytes): %s", fmt, len(data), e.code)
            return error(e.status, e.code, e.message)
        del data
        seconds = audio.mp3_seconds(mp3)
        body = upstream.converse_body(mp3, seconds, language, prompt)
        del mp3
        try:
            text = await upstream.transcribe(state["client"], settings.litellm_url, settings.model, auth, body,
                                             settings.upstream_timeout)
        except upstream.UpstreamError as e:
            log.warning("transcription failed (%.1f s of %s audio): HTTP %d %s", seconds, fmt, e.status, e.code)
            return error(e.status, e.code, e.message)
        log.info("transcribed %.1f s of %s audio in %.1f s", seconds, fmt, time.monotonic() - t0)
        if fmt_out == "text":
            return PlainTextResponse(text)
        if fmt_out == "verbose_json":
            return JSONResponse({"task": "transcribe", "language": language or "", "duration": round(seconds, 2),
                                 "text": text, "segments": []})
        return JSONResponse({"text": text})

    return Starlette(routes=[
        Route("/healthz", healthz, methods=["GET"]),
        Route("/v1/audio/transcriptions", transcriptions, methods=["POST"]),
    ], lifespan=lifespan)
