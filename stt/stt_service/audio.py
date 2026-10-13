"""Audio intake: sniff the container format from its first bytes, convert with ffmpeg to 16 kHz mono MP3.

Why MP3: Bedrock refuses a Converse request body above ~4 MB ("Failed to buffer the request body: length limit
exceeded"; measured 2026-10: 3.6 MB passed, 4.1 MB failed). 16 kHz 16-bit WAV reaches that after ~85 s of audio,
so a longer dictation would fail. Constant-bitrate MP3 at 32 kbit/s (4000 bytes per second) carries 10 minutes
in 2.4 MB (3.2 MB as base64), and Voxtral transcribed a 10-minute MP3 completely.

ffmpeg runs without a shell (argv list), reads only local files (-protocol_whitelist file) with the demuxer
forced to the sniffed format (no playlists or other formats that could reference something else) and only
the audio decoders browsers' recordings need (-codec_whitelist), and is killed after a timeout or when the
request is cancelled. Inputs and outputs live in a per-request temporary directory that is always removed.
"""

from __future__ import annotations

import asyncio
import errno
import os
import tempfile

SAMPLE_RATE = 16000
MP3_BITRATE = 32000
MP3_BYTES_PER_SECOND = MP3_BITRATE // 8  # CBR, MPEG-2 layer III at 16 kHz: 144-byte frames of 36 ms, no padding

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
# The decoders those containers need, nothing else (video, subtitle and exotic audio decoders stay unreachable).
DECODERS = "opus,vorbis,aac,mp3float,mp3,flac,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_u8"


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
    """The exact ffmpeg command: forced demuxer and decoders, local files only, at most max_seconds + 1 of output."""
    return [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-protocol_whitelist", "file", "-codec_whitelist", DECODERS,
        "-f", DEMUXERS[fmt], "-i", src,
        "-t", str(max_seconds + 1),
        "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
        "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-c:a", "libmp3lame", "-b:a", str(MP3_BITRATE), "-write_xing", "0", "-id3v2_version", "0",
        "-threads", "1", "-f", "mp3", "-y", dst,
    ]


def mp3_seconds(mp3: bytes) -> float:
    """Duration of the constant-bitrate MP3 ffmpeg_argv writes (no ID3 tag, no Xing header)."""
    return len(mp3) / MP3_BYTES_PER_SECOND


async def _run(argv: list[str], timeout: float) -> tuple[int, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    try:
        _, err = await asyncio.wait_for(proc.communicate(), timeout)
    except BaseException:  # timeout, or the request was cancelled (client gone): never leave ffmpeg running
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        raise
    return proc.returncode or 0, err or b""


def _no_room(e: OSError) -> AudioError:
    if e.errno in (errno.ENOSPC, errno.EAGAIN, errno.ENOMEM, errno.EDQUOT):
        return AudioError(503, "server_busy", "the speech-to-text service has no room for the recording right now — try again in a moment")
    return AudioError(503, "server_error", f"the speech-to-text service could not store the recording ({e.strerror or e})")


async def to_mp3(data: bytes, fmt: str, max_seconds: int, timeout: float, workdir: str | None = None) -> bytes:
    """data (sniffed as fmt) -> 16 kHz mono 32 kbit/s MP3 bytes. Raises AudioError."""
    try:
        with tempfile.TemporaryDirectory(prefix="stt-", dir=workdir) as d:
            src, dst = os.path.join(d, "in.bin"), os.path.join(d, "out.mp3")
            with open(src, "wb") as f:
                f.write(data)
            try:
                rc, _err = await _run(ffmpeg_argv(src, dst, fmt, max_seconds), timeout)
            except asyncio.TimeoutError:
                raise AudioError(504, "conversion_timeout",
                                 f"converting the audio took longer than {int(timeout)} s — try a shorter recording")
            except FileNotFoundError:
                raise AudioError(500, "ffmpeg_missing", "ffmpeg is not installed in the stt container")
            if rc != 0 or not os.path.exists(dst):
                raise AudioError(400, "invalid_audio", f"could not read the {fmt} audio (the recording may be empty or damaged)")
            with open(dst, "rb") as f:
                mp3 = f.read()
    except OSError as e:
        raise _no_room(e)
    seconds = mp3_seconds(mp3)
    if seconds > max_seconds + 0.5:   # ffmpeg stops at max + 1 s; the encoder adds a few ms to any recording
        raise AudioError(413, "audio_too_long", f"the recording is longer than {max_seconds // 60} minutes — send a shorter one")
    if seconds < 0.1:
        raise AudioError(400, "audio_too_short", "the recording contains no audio")
    return mp3
