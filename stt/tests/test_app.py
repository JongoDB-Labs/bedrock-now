import asyncio
import json

import httpx
import pytest
import respx
from starlette.testclient import TestClient

from conftest import make_wav, needs_ffmpeg
from stt_service import app as stt_app
from stt_service import audio

URL = "http://litellm:4000/bedrock/model/voxtral-small/converse"
AUTH = {"Authorization": "Bearer sk-openwebui-key"}
OK = {"output": {"message": {"role": "assistant", "content": [{"text": '{"transcript": "Hello world."}'}]}},
      "usage": {"inputTokens": 400, "outputTokens": 4}}


@pytest.fixture
def fake_ffmpeg(monkeypatch):
    """Skips ffmpeg: returns 1 s of 32 kbit/s "MP3" for any input (the real conversion is tested in test_audio)."""
    seen = []

    async def to_mp3(data, fmt, max_seconds, timeout, workdir=None):
        seen.append(fmt)
        return b"\xff\xf3" + b"\x00" * 3998

    monkeypatch.setattr(audio, "to_mp3", to_mp3)
    return seen


def client(**kw):
    return TestClient(stt_app.create_app(stt_app.Settings(**kw)))


def post(c, data=b"RIFF\x00\x00\x00\x00WAVEfmt ", headers=AUTH, **fields):
    return c.post("/v1/audio/transcriptions", headers=headers,
                  files={"file": ("rec.webm", data, "audio/webm")}, data={"model": "stt", **fields})


def test_healthz():
    with client() as c:
        r = c.get("/healthz")
    assert r.status_code == 200 and r.json()["ok"] is True


@respx.mock
def test_transcribes_with_the_callers_key(fake_ffmpeg):
    route = respx.post(URL).mock(return_value=httpx.Response(200, json=OK))
    with client() as c:
        r = post(c, language="en")
    assert r.status_code == 200 and r.json() == {"text": "Hello world."}
    req = route.calls.last.request
    assert req.headers["authorization"] == "Bearer sk-openwebui-key"   # forwarded as-is: spend lands on that key
    body = json.loads(req.content)
    assert body["messages"][0]["content"][1]["audio"]["format"] == "mp3"
    assert "'en'" in body["messages"][0]["content"][0]["text"]
    assert fake_ffmpeg == ["wav"]


@respx.mock
def test_model_from_settings_not_from_the_request(fake_ffmpeg):
    route = respx.post("http://litellm:4000/bedrock/model/voxtral-mini/converse").mock(return_value=httpx.Response(200, json=OK))
    with client(model="voxtral-mini") as c:
        r = post(c, model="whatever")
    assert r.status_code == 200 and route.called


@respx.mock
def test_response_formats(fake_ffmpeg):
    respx.post(URL).mock(return_value=httpx.Response(200, json=OK))
    with client() as c:
        assert post(c, response_format="text").text == "Hello world."
        v = post(c, response_format="verbose_json").json()
        assert v["text"] == "Hello world." and v["duration"] == pytest.approx(1.0)
        r = post(c, response_format="srt")
    assert r.status_code == 400 and r.json()["error"]["code"] == "unsupported_response_format"


def test_needs_a_bearer_key(fake_ffmpeg):
    with client() as c:
        r = post(c, headers={})
        r2 = post(c, headers={"Authorization": "Basic abc"})
    assert r.status_code == 401 and r2.status_code == 401
    assert "Bearer" in r.json()["error"]["message"]
    assert fake_ffmpeg == []


def test_unknown_format_is_rejected_before_ffmpeg(fake_ffmpeg):
    with client() as c:
        r = post(c, data=b"#EXTM3U\nfile:///etc/passwd\n")
    assert r.status_code == 400 and r.json()["error"]["code"] == "unsupported_audio"
    assert fake_ffmpeg == []


def test_size_limit(fake_ffmpeg):
    with client(max_bytes=1024) as c:
        r = post(c, data=b"RIFF" + b"\x00" * 4000)
    assert r.status_code == 413 and r.json()["error"]["code"] == "file_too_large"
    assert fake_ffmpeg == []


def test_missing_file_and_wrong_content_type():
    with client() as c:
        r = c.post("/v1/audio/transcriptions", headers=AUTH, data={"model": "stt"})
        r2 = c.post("/v1/audio/transcriptions", headers={**AUTH, "Content-Type": "application/json"}, content=b"{}")
    assert r.status_code == 400 and r2.status_code == 400


@respx.mock
def test_upstream_errors_become_openai_style_errors(fake_ffmpeg):
    respx.post(URL).mock(return_value=httpx.Response(
        400, json={"error": {"message": "Budget has been exceeded! Key=sk-...wxyz Current cost: 5.2, Max budget: 5.0", "type": "budget_exceeded"}}))
    with client() as c:
        r = post(c)
    assert r.status_code == 429
    err = r.json()["error"]
    assert err["code"] == "budget_exceeded" and "BUDGET_OPENWEBUI" in err["message"]   # Open WebUI shows error.message


@respx.mock
def test_unreachable_litellm(fake_ffmpeg):
    respx.post(URL).mock(side_effect=httpx.ConnectError("refused"))
    with client() as c:
        r = post(c)
    assert r.status_code == 502 and "./stack status" in r.json()["error"]["message"]


def test_settings_from_env():
    s = stt_app.from_env({"STT_BEDROCK_MODEL": "voxtral-mini", "STT_MAX_MB": "10"})
    assert s.model == "voxtral-mini" and s.max_bytes == 10 * 1024 * 1024
    assert stt_app.from_env({}).model == "voxtral-small"
    with pytest.raises(stt_app.ConfigError):
        stt_app.from_env({"STT_BEDROCK_MODEL": "../../admin"})
    with pytest.raises(stt_app.ConfigError):
        stt_app.from_env({"LITELLM_URL": "file:///etc"})
    for bad in ("..", "a..b", ".hidden", "-x", "x/y", "x" * 200, "voxtral small"):
        with pytest.raises(stt_app.ConfigError):
            stt_app.from_env({"STT_BEDROCK_MODEL": bad})
    assert stt_app.from_env({"STT_BEDROCK_MODEL": "us.mistral.voxtral-small-24b-2507:0"}).model.startswith("us.")


@needs_ffmpeg
@respx.mock
def test_end_to_end_with_real_ffmpeg(tmp_path):
    route = respx.post(URL).mock(return_value=httpx.Response(200, json=OK))
    with client(workdir=str(tmp_path)) as c:
        r = post(c, data=make_wav(1.0, rate=44100))
    assert r.status_code == 200
    sent = json.loads(route.calls.last.request.content)["messages"][0]["content"][1]["audio"]["source"]["bytes"]
    import base64
    mp3 = base64.b64decode(sent)
    assert mp3[:2] == b"\xff\xf3"   # MPEG-2 layer III: 16 kHz
    assert list(tmp_path.iterdir()) == []   # temp files are gone


# --- upload limits: enforced on the bytes received ---

def _multipart(file_bytes: bytes, extra: dict | None = None, boundary: str = "BNSTT") -> bytes:
    parts = []
    for k, v in (extra or {}).items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.webm"\r\n'
                 'Content-Type: audio/webm\r\n\r\n'.encode() + file_bytes + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts)


def test_chunked_upload_past_the_limit_is_a_413(fake_ffmpeg):
    body = _multipart(b"\x1a\x45\xdf\xa3" + b"\x00" * (3 * 1024 * 1024))

    def chunks():   # a generator: httpx sends Transfer-Encoding: chunked, no Content-Length
        for i in range(0, len(body), 64 * 1024):
            yield body[i:i + 64 * 1024]

    with client(max_bytes=1024 * 1024) as c:
        r = c.post("/v1/audio/transcriptions", headers={**AUTH, "Content-Type": "multipart/form-data; boundary=BNSTT"},
                   content=chunks())
    assert r.status_code == 413 and r.json()["error"]["code"] == "file_too_large"
    assert fake_ffmpeg == []


def test_content_length_over_the_limit_is_refused_before_reading(fake_ffmpeg):
    body = _multipart(b"\x1a\x45\xdf\xa3" + b"\x00" * (2 * 1024 * 1024 + 10))
    with client(max_bytes=1024 * 1024) as c:
        r = c.post("/v1/audio/transcriptions", headers={**AUTH, "Content-Type": "multipart/form-data; boundary=BNSTT"},
                   content=body)
    assert r.status_code == 413 and fake_ffmpeg == []


def test_body_longer_than_its_content_length_is_still_counted(fake_ffmpeg):
    """A client that claims a small Content-Length but keeps sending: the receive wrapper counts real bytes."""
    app = stt_app.create_app(stt_app.Settings(max_bytes=1024 * 1024))
    body = _multipart(b"\x1a\x45\xdf\xa3" + b"\x00" * (3 * 1024 * 1024))
    pieces = [body[i:i + 65536] for i in range(0, len(body), 65536)]
    sent = []

    async def receive():
        if pieces:
            return {"type": "http.request", "body": pieces.pop(0), "more_body": bool(pieces)}
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": "/v1/audio/transcriptions", "raw_path": b"/v1/audio/transcriptions",
             "query_string": b"", "root_path": "", "scheme": "http", "server": ("stt", 8000), "client": ("x", 1),
             "http_version": "1.1", "headers": [(b"authorization", b"Bearer sk-openwebui-key"), (b"content-length", b"1000"),
                                                (b"content-type", b"multipart/form-data; boundary=BNSTT")]}
    asyncio.run(app(scope, receive, send))
    assert sent[0]["status"] == 413
    assert len(pieces) > 0   # stopped reading early
    assert fake_ffmpeg == []


def test_a_huge_text_field_is_refused(fake_ffmpeg):
    with client() as c:
        r = post(c, prompt="word " * 40000)   # 200 KB
    assert r.status_code == 413 and r.json()["error"]["code"] == "field_too_large"
    assert fake_ffmpeg == []


def test_requests_are_processed_at_most_max_parallel_at_a_time(monkeypatch):
    active, peak = 0, 0

    async def to_mp3(data, fmt, max_seconds, timeout, workdir=None):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.05)
        active -= 1
        return b"\xff\xf3" + b"\x00" * 3998

    async def transcribe(*a, **k):
        nonlocal active, peak
        active += 1   # the upstream call counts too: one gate covers conversion and Bedrock
        peak = max(peak, active)
        await asyncio.sleep(0.05)
        active -= 1
        return "ok"

    monkeypatch.setattr(audio, "to_mp3", to_mp3)
    monkeypatch.setattr(stt_app.upstream, "transcribe", transcribe)
    app = stt_app.create_app(stt_app.Settings(max_parallel=2), client=httpx.AsyncClient())

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://stt") as c:
            rs = await asyncio.gather(*(c.post("/v1/audio/transcriptions", headers=AUTH,
                                               files={"file": ("a.wav", b"RIFF\x00\x00\x00\x00WAVEfmt ", "audio/wav")})
                                        for _ in range(6)))
        return [r.status_code for r in rs]

    assert asyncio.run(run()) == [200] * 6
    assert peak <= 2


@respx.mock
def test_answer_cut_at_max_tokens_keeps_the_words(fake_ffmpeg):
    cut = {"output": {"message": {"content": [{"text": '{"transcript": "one two three four'}]}}, "stopReason": "max_tokens"}
    respx.post(URL).mock(return_value=httpx.Response(200, json=cut))
    with client() as c:
        r = post(c)
    assert r.json() == {"text": "one two three four"}


def test_a_slow_upload_times_out_and_frees_its_slot(fake_ffmpeg):
    app = stt_app.create_app(stt_app.Settings(read_timeout=0.2, max_parallel=1))
    sent = []

    async def receive():
        await asyncio.sleep(5)   # a sender that never finishes
        return {"type": "http.request", "body": b"", "more_body": True}

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": "/v1/audio/transcriptions", "raw_path": b"/v1/audio/transcriptions",
             "query_string": b"", "root_path": "", "scheme": "http", "server": ("stt", 8000), "client": ("x", 1),
             "http_version": "1.1", "headers": [(b"authorization", b"Bearer sk-openwebui-key"),
                                                (b"content-type", b"multipart/form-data; boundary=BNSTT")]}

    async def run():
        await asyncio.wait_for(app(scope, receive, send), 3)

    asyncio.run(run())
    assert sent[0]["status"] == 408
    assert b"upload_timeout" in b"".join(m.get("body", b"") for m in sent)
    assert fake_ffmpeg == []
