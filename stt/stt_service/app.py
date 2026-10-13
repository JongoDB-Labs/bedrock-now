"""HTTP side: POST /v1/audio/transcriptions (OpenAI-compatible multipart) and GET /healthz.

Nothing is stored: the upload is held in memory, converted in a temporary directory that is removed right away,
and neither audio nor transcripts are logged (only sizes, durations and status codes).
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
from starlette.formparsers import MultiPartException
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response
from starlette.routing import Route

from . import audio, upstream

log = logging.getLogger("stt")
MODEL_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
FORMATS = ("json", "text", "verbose_json")


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Settings:
    litellm_url: str = "http://litellm:4000"
    model: str = "voxtral-small"          # the LiteLLM model name (catalog/models.tsv) Voxtral is served as
    max_bytes: int = 25 * 1024 * 1024     # OpenAI's limit; Open WebUI splits at 20 MB
    max_seconds: int = 600
    ffmpeg_timeout: float = 60.0
    upstream_timeout: float = 120.0
    max_parallel: int = 4
    workdir: str | None = None


def from_env(env: dict | None = None) -> Settings:
    env = os.environ if env is None else env
    s = Settings(
        litellm_url=env.get("LITELLM_URL", "http://litellm:4000"),
        model=env.get("STT_BEDROCK_MODEL", "") or "voxtral-small",
        max_bytes=int(env.get("STT_MAX_MB", "25")) * 1024 * 1024,
        max_seconds=int(env.get("STT_MAX_SECONDS", "600")),
        workdir=env.get("STT_WORKDIR") or None,
    )
    if not MODEL_RE.match(s.model):
        raise ConfigError(f"STT_BEDROCK_MODEL={s.model!r} is not a model name")
    if not s.litellm_url.startswith(("http://", "https://")):
        raise ConfigError("LITELLM_URL must be an http(s) URL")
    return s


def error(status: int, code: str, message: str) -> JSONResponse:
    kind = "invalid_request_error" if status < 500 else "server_error"
    return JSONResponse({"error": {"message": message, "type": kind, "code": code}}, status_code=status)


def create_app(settings: Settings, client: httpx.AsyncClient | None = None) -> Starlette:
    gate = asyncio.Semaphore(settings.max_parallel)
    state: dict = {"client": client}

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
        t0 = time.monotonic()
        auth = request.headers.get("authorization", "")
        if not auth.lower().startswith("bearer ") or len(auth) < 12 or any(c in auth for c in "\r\n"):
            return error(401, "missing_api_key", "speech-to-text needs the LiteLLM key as 'Authorization: Bearer …'")
        try:
            length = int(request.headers.get("content-length", "0"))
        except ValueError:
            return error(400, "bad_request", "invalid Content-Length")
        if length > settings.max_bytes + 1024 * 1024:
            return error(413, "file_too_large", f"the recording is larger than {settings.max_bytes // (1024 * 1024)} MB")
        if not request.headers.get("content-type", "").lower().startswith("multipart/form-data"):
            return error(400, "bad_request", "send the audio as multipart/form-data with a 'file' field")
        try:
            form = await request.form(max_files=1, max_fields=16, max_part_size=settings.max_bytes)
        except MultiPartException as e:
            if "size" in str(e).lower():
                return error(413, "file_too_large", f"the recording is larger than {settings.max_bytes // (1024 * 1024)} MB")
            return error(400, "bad_request", f"could not read the upload: {e}")
        try:
            up = form.get("file")
            if not isinstance(up, UploadFile):
                return error(400, "missing_file", "no 'file' in the upload")
            data = await up.read(settings.max_bytes + 1)
            if len(data) > settings.max_bytes:
                return error(413, "file_too_large", f"the recording is larger than {settings.max_bytes // (1024 * 1024)} MB")
            fmt_out = str(form.get("response_format") or "json")
            if fmt_out not in FORMATS:
                return error(400, "unsupported_response_format", f"response_format must be one of {', '.join(FORMATS)}")
            language = str(form.get("language") or "") or None
            prompt = str(form.get("prompt") or "") or None
        finally:
            await form.close()

        fmt = audio.sniff(data[:16])
        if fmt is None:
            return error(400, "unsupported_audio",
                         "unsupported audio: send WebM, Ogg, MP4/M4A, WAV, MP3, AAC or FLAC")
        try:
            async with gate:
                wav = await audio.to_wav(data, fmt, settings.max_seconds, settings.ffmpeg_timeout, settings.workdir)
        except audio.AudioError as e:
            log.info("rejected %s upload (%d bytes): %s", fmt, len(data), e.code)
            return error(e.status, e.code, e.message)
        del data
        seconds = audio.wav_seconds(wav)
        body = upstream.converse_body(wav, seconds, language, prompt)
        del wav
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
