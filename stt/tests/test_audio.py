import asyncio
import errno
import os
import subprocess

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
    argv = audio.ffmpeg_argv("/tmp/x/in.bin", "/tmp/x/out.mp3", "webm", 600)
    assert argv[0] == "ffmpeg"
    # forced demuxer, local files only and only the audio decoders recordings need: all before -i
    i = argv.index("-i")
    assert argv[argv.index("-f"):argv.index("-f") + 2] == ["-f", "matroska"] and argv.index("-f") < i
    assert argv[argv.index("-protocol_whitelist") + 1] == "file" and argv.index("-protocol_whitelist") < i
    cw = argv.index("-codec_whitelist")
    assert cw < i and argv[cw + 1] == "opus,vorbis,aac,mp3float,mp3,flac,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_u8"
    assert argv[i + 1] == "/tmp/x/in.bin" and argv[-1] == "/tmp/x/out.mp3"
    assert argv[argv.index("-t") + 1] == "601"
    assert ["-ac", "1"] == argv[argv.index("-ac"):argv.index("-ac") + 2]
    assert ["-ar", "16000"] == argv[argv.index("-ar"):argv.index("-ar") + 2]
    # constant-bitrate MP3: 10 minutes stay under Bedrock's ~4 MB request limit
    assert ["-c:a", "libmp3lame", "-b:a", "32000"] == argv[argv.index("-c:a"):argv.index("-c:a") + 4]
    assert "-nostdin" in argv
    assert all(isinstance(a, str) for a in argv)


class SlowProc:
    """A fake ffmpeg that never finishes; records kill()."""
    returncode = None

    def __init__(self, killed):
        self.killed = killed

    async def communicate(self):
        await asyncio.sleep(10)

    def kill(self):
        self.killed.append(True)

    async def wait(self):
        self.returncode = -9
        return -9


def test_ffmpeg_runs_without_a_shell(monkeypatch, tmp_path):
    calls = []

    async def fake_exec(*argv, **kw):
        calls.append((argv, kw))
        raise FileNotFoundError

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    with pytest.raises(audio.AudioError) as e:
        asyncio.run(audio.to_mp3(b"x" * 100, "wav", 600, 5, str(tmp_path)))
    assert e.value.code == "ffmpeg_missing"
    argv, kw = calls[0]
    assert argv[0] == "ffmpeg" and "shell" not in kw
    assert kw["stdin"] == asyncio.subprocess.DEVNULL
    assert list(tmp_path.iterdir()) == []  # the temporary directory is gone


def test_ffmpeg_timeout_kills_and_is_a_504(monkeypatch, tmp_path):
    killed = []

    async def fake_exec(*argv, **kw):
        return SlowProc(killed)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    with pytest.raises(audio.AudioError) as e:
        asyncio.run(audio.to_mp3(b"x" * 100, "wav", 600, 0.05, str(tmp_path)))
    assert e.value.status == 504 and e.value.code == "conversion_timeout" and killed == [True]
    assert list(tmp_path.iterdir()) == []


def test_cancelled_request_kills_ffmpeg(monkeypatch, tmp_path):
    killed = []

    async def fake_exec(*argv, **kw):
        return SlowProc(killed)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    async def run():
        task = asyncio.create_task(audio.to_mp3(b"x" * 100, "wav", 600, 30, str(tmp_path)))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert killed == [True]
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("err,code", [(errno.ENOSPC, "server_busy"), (errno.EAGAIN, "server_busy"), (errno.EACCES, "server_error")])
def test_no_room_for_the_recording_is_a_503(monkeypatch, tmp_path, err, code):
    def full(*a, **k):
        raise OSError(err, os.strerror(err))

    monkeypatch.setattr(audio, "open", full, raising=False)
    with pytest.raises(audio.AudioError) as e:
        asyncio.run(audio.to_mp3(b"x" * 100, "wav", 600, 5, str(tmp_path)))
    assert e.value.status == 503 and e.value.code == code
    assert list(tmp_path.iterdir()) == []


def test_mp3_seconds_from_the_constant_bitrate():
    assert audio.mp3_seconds(b"x" * 4000 * 90) == pytest.approx(90.0)


def _mp3_header(mp3: bytes) -> tuple:
    b1, b2, b3 = mp3[1], mp3[2], mp3[3]
    return mp3[0], b1, b2 >> 4, (b2 >> 2) & 3, b3 >> 6


@needs_ffmpeg
@pytest.mark.parametrize("args", [
    ["-c:a", "libopus", "webm"],
    ["-c:a", "aac", "-f", "mp4", "m4a"],
    ["-c:a", "libvorbis", "ogg"],
    ["-c:a", "flac", "flac"],
    ["wav"],
])
def test_real_conversion_to_16k_mono_mp3(args, tmp_path):
    src = encode(make_wav(1.5, rate=48000), args, tmp_path)
    fmt = audio.sniff(src[:16])
    assert fmt is not None
    out = asyncio.run(audio.to_mp3(src, fmt, 600, 30, str(tmp_path)))
    # first frame: sync, MPEG-2 layer III without CRC (0xF3), 32 kbit/s (index 4), 16 kHz (index 2), mono (3)
    assert _mp3_header(out) == (0xFF, 0xF3, 4, 2, 3)
    assert audio.mp3_seconds(out) == pytest.approx(1.5, abs=0.2)
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(["src.wav", f"out.{args[-1]}"])  # nothing left behind


@needs_ffmpeg
def test_ten_minutes_fit_in_one_bedrock_request(tmp_path):
    out = asyncio.run(audio.to_mp3(make_wav(600, tone=False), "wav", 600, 60, str(tmp_path)))
    assert len(out) * 4 / 3 < 3_500_000   # base64 in the Converse body; Bedrock refused 4.1 MB, took 3.6 MB


@needs_ffmpeg
def test_too_long_is_rejected(tmp_path):
    with pytest.raises(audio.AudioError) as e:
        asyncio.run(audio.to_mp3(make_wav(3.0), "wav", 2, 30, str(tmp_path)))
    assert e.value.status == 413 and "minutes" in e.value.message


@needs_ffmpeg
def test_garbage_with_a_valid_magic_is_a_clear_400(tmp_path):
    with pytest.raises(audio.AudioError) as e:
        asyncio.run(audio.to_mp3(b"\x1a\x45\xdf\xa3" + b"\x00" * 200, "webm", 600, 30, str(tmp_path)))
    assert e.value.status == 400 and e.value.code == "invalid_audio"


@needs_ffmpeg
def test_a_video_codec_is_not_decoded(tmp_path):
    # an MP4 with only a video stream: no audio decoder applies, nothing else is allowed
    src = tmp_path / "v.mp4"
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=5",
                    "-t", "1", "-c:v", "mpeg4", str(src)], check=True)
    with pytest.raises(audio.AudioError) as e:
        asyncio.run(audio.to_mp3(src.read_bytes(), "mp4", 600, 30, str(tmp_path)))
    assert e.value.code == "invalid_audio"
