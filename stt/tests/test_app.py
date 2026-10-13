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
    """Skips ffmpeg: returns a 1 s 16 kHz WAV for any input (the real conversion is tested in test_audio)."""
    seen = []

    async def to_wav(data, fmt, max_seconds, timeout, workdir=None):
        seen.append(fmt)
        return make_wav(1.0)

    monkeypatch.setattr(audio, "to_wav", to_wav)
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
    assert body["messages"][0]["content"][1]["audio"]["format"] == "wav"
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
        400, json={"error": {"message": "Budget has been exceeded! Current cost: 5.2, Max budget: 5.0", "type": "budget_exceeded"}}))
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


@needs_ffmpeg
@respx.mock
def test_end_to_end_with_real_ffmpeg(tmp_path):
    route = respx.post(URL).mock(return_value=httpx.Response(200, json=OK))
    with client(workdir=str(tmp_path)) as c:
        r = post(c, data=make_wav(1.0, rate=44100))
    assert r.status_code == 200
    sent = json.loads(route.calls.last.request.content)["messages"][0]["content"][1]["audio"]["source"]["bytes"]
    import base64
    wav = base64.b64decode(sent)
    assert int.from_bytes(wav[24:28], "little") == 16000
    assert list(tmp_path.iterdir()) == []   # temp files are gone
