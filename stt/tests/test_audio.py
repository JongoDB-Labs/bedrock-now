import asyncio

import pytest

from conftest import encode, make_wav, needs_ffmpeg
from stt_service import audio


@pytest.mark.parametrize("head,fmt", [
    (b"\x1a\x45\xdf\xa3\x01\x00\x00\x00", "webm"),
    (b"OggS\x00\x02\x00\x00", "ogg"),
    (b"\x00\x00\x00\x20ftypM4A \x00\x00", "mp4"),
    (b"\x00\x00\x00\x1cftypiso5\x00\x00", "mp4"),
    (b"RIFF\x24\x00\x00\x00WAVEfmt ", "wav"),
    (b"ID3\x04\x00\x00\x00\x00", "mp3"),
    (b"\xff\xfb\x90\x64\x00", "mp3"),
    (b"\xff\xf1\x50\x80\x00", "aac"),
    (b"fLaC\x00\x00\x00\x22", "flac"),
])
def test_sniff_allowed_formats(head, fmt):
    assert audio.sniff(head) == fmt


@pytest.mark.parametrize("head", [
    b"", b"#EXTM3U\nhttp://x", b"<?xml version", b"\x89PNG\r\n\x1a\n", b"%PDF-1.7", b"PK\x03\x04",
    b"RIFF\x24\x00\x00\x00AVI LIST", b"ffconcat version 1.0", b"\xff\xd8\xff\xe0",  # JPEG: not MPEG audio
])
def test_sniff_rejects_everything_else(head):
    assert audio.sniff(head) is None


def test_ffmpeg_argv_is_locked_down():
    argv = audio.ffmpeg_argv("/tmp/x/in.bin", "/tmp/x/out.wav", "webm", 600)
    assert argv[0] == "ffmpeg"
    # forced demuxer and local files only, both before -i
    i = argv.index("-i")
    assert argv[argv.index("-f"):argv.index("-f") + 2] == ["-f", "matroska"] and argv.index("-f") < i
    assert argv[argv.index("-protocol_whitelist") + 1] == "file" and argv.index("-protocol_whitelist") < i
    assert argv[i + 1] == "/tmp/x/in.bin" and argv[-1] == "/tmp/x/out.wav"
    assert argv[argv.index("-t") + 1] == "601"
    assert ["-ac", "1"] == argv[argv.index("-ac"):argv.index("-ac") + 2]
    assert ["-ar", "16000"] == argv[argv.index("-ar"):argv.index("-ar") + 2]
    assert "-nostdin" in argv
    assert all(isinstance(a, str) for a in argv)


def test_ffmpeg_runs_without_a_shell(monkeypatch, tmp_path):
    calls = []

    async def fake_exec(*argv, **kw):
        calls.append((argv, kw))
        raise FileNotFoundError

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    with pytest.raises(audio.AudioError) as e:
        asyncio.run(audio.to_wav(b"x" * 100, "wav", 600, 5, str(tmp_path)))
    assert e.value.code == "ffmpeg_missing"
    argv, kw = calls[0]
    assert argv[0] == "ffmpeg" and "shell" not in kw
    assert kw["stdin"] == asyncio.subprocess.DEVNULL
    assert list(tmp_path.iterdir()) == []  # the temporary directory is gone


def test_ffmpeg_timeout_kills_and_cleans_up(monkeypatch, tmp_path):
    killed = []

    class Proc:
        returncode = None

        async def communicate(self):
            await asyncio.sleep(10)

        def kill(self):
            killed.append(True)

        async def wait(self):
            return -9

    async def fake_exec(*argv, **kw):
        return Proc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    with pytest.raises(audio.AudioError) as e:
        asyncio.run(audio.to_wav(b"x" * 100, "wav", 600, 0.05, str(tmp_path)))
    assert e.value.status == 413 and killed == [True]
    assert list(tmp_path.iterdir()) == []


def test_wav_seconds():
    assert audio.wav_seconds(make_wav(2.0)) == pytest.approx(2.0)
    assert audio.wav_seconds(make_wav(0.5, tone=False)) == pytest.approx(0.5)


@needs_ffmpeg
@pytest.mark.parametrize("args", [
    ["-c:a", "libopus", "webm"],
    ["-c:a", "aac", "-f", "mp4", "m4a"],
    ["-c:a", "libvorbis", "ogg"],
    ["wav"],
])
def test_real_conversion_to_16k_mono_wav(args, tmp_path):
    src = encode(make_wav(1.5, rate=48000), args, tmp_path)
    fmt = audio.sniff(src[:16])
    assert fmt is not None
    out = asyncio.run(audio.to_wav(src, fmt, 600, 30, str(tmp_path)))
    assert out[:4] == b"RIFF" and out[8:12] == b"WAVE"
    assert audio.wav_seconds(out) == pytest.approx(1.5, abs=0.15)
    assert int.from_bytes(out[22:24], "little") == 1          # mono
    assert int.from_bytes(out[24:28], "little") == 16000      # 16 kHz
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(["src.wav", f"out.{args[-1]}"])  # nothing left behind


@needs_ffmpeg
def test_too_long_is_rejected(tmp_path):
    with pytest.raises(audio.AudioError) as e:
        asyncio.run(audio.to_wav(make_wav(3.0), "wav", 2, 30, str(tmp_path)))
    assert e.value.status == 413 and "minutes" in e.value.message


@needs_ffmpeg
def test_garbage_with_a_valid_magic_is_a_clear_400(tmp_path):
    with pytest.raises(audio.AudioError) as e:
        asyncio.run(audio.to_wav(b"\x1a\x45\xdf\xa3" + b"\x00" * 200, "webm", 600, 30, str(tmp_path)))
    assert e.value.status == 400 and e.value.code == "invalid_audio"
