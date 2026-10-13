"""Audio intake: sniff the container format from its first bytes, convert with ffmpeg to 16 kHz mono WAV.

ffmpeg runs without a shell (argv list), reads only local files (-protocol_whitelist file) with the demuxer
forced to the sniffed format (no playlists or other formats that could reference something else), and is
killed after a timeout. Inputs and outputs live in a per-request temporary directory that is always removed.
"""

from __future__ import annotations

import asyncio
import os
import struct
import tempfile

SAMPLE_RATE = 16000
BYTES_PER_SECOND = SAMPLE_RATE * 2  # mono, 16-bit

# sniffed name -> ffmpeg demuxer
DEMUXERS = {
    "webm": "matroska",  # Chrome, Edge, Firefox (MediaRecorder: WebM/Opus)
    "ogg": "ogg",
    "mp4": "mov",        # Safari (MP4/AAC), .m4a
    "wav": "wav",
    "mp3": "mp3",        # audio/mpeg
    "aac": "aac",        # raw ADTS AAC
    "flac": "flac",
}


class AudioError(Exception):
    """A problem with the uploaded audio; status/code/message become the OpenAI-style error response."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def sniff(head: bytes) -> str | None:
    """The container format from the file's first bytes (never the name or the declared content type)."""
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "webm"
    if head.startswith(b"OggS"):
        return "ogg"
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return "mp4"
    if len(head) >= 12 and head.startswith(b"RIFF") and head[8:12] == b"WAVE":
        return "wav"
    if head.startswith(b"fLaC"):
        return "flac"
    if head.startswith(b"ID3"):
        return "mp3"
    if len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0:
        layer = (head[1] >> 1) & 0x03
        if layer == 0:
            return "aac" if (head[1] & 0xF6) == 0xF0 else None  # ADTS: 1111 1111 1111 x00x
        return "mp3"  # MPEG audio frame sync (layer I/II/III)
    return None


def ffmpeg_argv(src: str, dst: str, fmt: str, max_seconds: int) -> list[str]:
    """The exact ffmpeg command: forced demuxer, local files only, at most max_seconds + 1 of output."""
    return [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-protocol_whitelist", "file",
        "-f", DEMUXERS[fmt], "-i", src,
        "-t", str(max_seconds + 1),
        "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
        "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le",
        "-threads", "1", "-f", "wav", "-y", dst,
    ]


def wav_seconds(wav: bytes) -> float:
    """Duration of a PCM WAV from its data chunk size (falls back to the whole file)."""
    pos, size = 12, len(wav)
    while pos + 8 <= size:
        cid, clen = wav[pos:pos + 4], struct.unpack("<I", wav[pos + 4:pos + 8])[0]
        if cid == b"data":
            return min(clen, size - pos - 8) / BYTES_PER_SECOND
        pos += 8 + clen + (clen & 1)
    return max(size - 44, 0) / BYTES_PER_SECOND


async def _run(argv: list[str], timeout: float) -> tuple[int, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    try:
        _, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise
    return proc.returncode or 0, err or b""


async def to_wav(data: bytes, fmt: str, max_seconds: int, timeout: float, workdir: str | None = None) -> bytes:
    """data (sniffed as fmt) -> 16 kHz mono 16-bit WAV bytes. Raises AudioError."""
    with tempfile.TemporaryDirectory(prefix="stt-", dir=workdir) as d:
        src, dst = os.path.join(d, "in.bin"), os.path.join(d, "out.wav")
        with open(src, "wb") as f:
            f.write(data)
        try:
            rc, err = await _run(ffmpeg_argv(src, dst, fmt, max_seconds), timeout)
        except asyncio.TimeoutError:
            raise AudioError(413, "audio_too_long", f"converting the audio took longer than {int(timeout)} s — send a shorter recording")
        except FileNotFoundError:
            raise AudioError(500, "ffmpeg_missing", "ffmpeg is not installed in the stt container")
        if rc != 0 or not os.path.exists(dst):
            raise AudioError(400, "invalid_audio", f"could not read the {fmt} audio (the recording may be empty or damaged)")
        with open(dst, "rb") as f:
            wav = f.read()
    seconds = wav_seconds(wav)
    if seconds > max_seconds:
        raise AudioError(413, "audio_too_long", f"the recording is longer than {max_seconds // 60} minutes — send a shorter one")
    if seconds < 0.1:
        raise AudioError(400, "audio_too_short", "the recording contains no audio")
    return wav
