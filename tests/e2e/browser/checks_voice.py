"""Voice: Bedrock speech-to-text (the stt container, Mistral Voxtral through LiteLLM) as Open WebUI and Home use it.
Each check follows the throwaway's current setting (.env), so run.sh runs them again after ./stack stt remove and
./stack stt set bedrock (results id@stt-off / id@stt-on-again)."""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path

from checks_browser import chat_frame, login, shot
from common import ENV, Skip, check, expect, need, origin

FIXTURE = Path(__file__).parent / "fixtures" / "speech.webm"   # espeak-ng: fixtures/make-speech.sh
WEB_STT = "Call feature is not supported when using Web STT engine"


def stt_mode() -> str:
    """bedrock | openai | groq while server speech-to-text is on, else browser."""
    if ENV.get("OWUI_STT_ENGINE") == "openai" and ENV.get("STT_PROVIDER") in ("bedrock", "openai", "groq"):
        return ENV["STT_PROVIDER"]
    return "browser"


@check("browser", "home-voice-line")
def home_voice(ctx):
    page, rec = ctx.page("home-voice")
    login(page)
    note = page.locator("#voice-note")
    note.wait_for(timeout=30000)
    page.locator("#voice-note", has_text="Voice:").wait_for(timeout=30000)
    text = note.inner_text()
    if stt_mode() == "bedrock":
        expect(text.startswith("Voice: Bedrock Mistral Voxtral"), f"voice line {text!r}")
        expect("estimated" in text and "per minute of audio" in text and "your AWS account" in text, f"voice line {text!r}")
    elif stt_mode() == "browser":
        expect(text.startswith("Voice: browser speech recognition (Call is unavailable)"), f"voice line {text!r}")
    rec.save()
    return f"{stt_mode()}: {text[:110]!r}"


@check("browser", "chat-voice-call")
def chat_call(ctx):
    """Call with server speech-to-text: the call opens ("Listening…", End call), no Web-STT error; without it: the
    Web-STT message (README troubleshooting row)."""
    need("open-webui")
    page, rec = ctx.page("chat-call")
    page.context.grant_permissions(["microphone"], origin=origin("chat"))
    login(page)
    fl, f = chat_frame(page)
    fl.locator("button[aria-label='Voice mode']").click()
    if stt_mode() == "browser":
        fl.locator(f"text={WEB_STT}").first.wait_for(timeout=10000)
        shot(page, "10-chat-call-web-stt")
        rec.save()
        return f"browser speech: Call → '{WEB_STT}'"
    fl.locator("button[aria-label='End call']").wait_for(timeout=15000)
    fl.locator("text=Listening").first.wait_for(timeout=15000)
    expect(not fl.locator(f"text={WEB_STT}").count(), "the Web-STT error was shown although speech-to-text is on")
    shot(page, "10-chat-call-open")
    fl.locator("button[aria-label='End call']").click()
    # A blocked screen wake lock is reported by chat-voice-call-wake-lock alone; anything else counts here.
    probs = rec.problems(allow=[r"No token found in localStorage", r"Permissions policy violation: screen-wake-lock"])
    rec.save()
    expect(not probs, f"errors: {probs}")
    return f"{stt_mode()} speech-to-text: Call opens (Listening…, End call), no Web-STT error"


@check("browser", "chat-voice-call-wake-lock")
def chat_call_wake_lock(ctx):
    """In the Chat tab (the portal's frame) a Call may keep the screen awake: Open WebUI asks for a wake lock."""
    need("open-webui")
    if stt_mode() == "browser":
        raise Skip("no server speech-to-text: Call does not start")
    page, rec = ctx.page("chat-call-wake-lock")
    page.context.grant_permissions(["microphone"], origin=origin("chat"))
    login(page)
    fl, f = chat_frame(page)
    fl.locator("button[aria-label='Voice mode']").click()
    fl.locator("button[aria-label='End call']").wait_for(timeout=15000)
    fl.locator("text=Listening").first.wait_for(timeout=15000)
    fl.locator("button[aria-label='End call']").click()
    blocked = [e["text"] for e in rec.events if e["t"] == "console" and "screen-wake-lock" in e["text"]]
    rec.save()
    expect(not blocked, f"{blocked[:1]} — the portal's iframe allow list lacks screen-wake-lock")
    return "Call in the portal frame may hold a screen wake lock"


@check("browser", "stt-transcription")
def stt_transcription(ctx):
    """A spoken WebM clip (as a browser records it) through Open WebUI's /api/v1/audio/transcriptions → Caddy :8090 →
    the stt container → LiteLLM → Bedrock Voxtral."""
    need("open-webui")
    if stt_mode() == "browser":
        raise Skip("speech-to-text is off (browser speech): nothing to transcribe on the server")
    page, rec = ctx.page("stt-transcription")
    login(page)
    fl, f = chat_frame(page)
    r = f.evaluate("""async (b64) => { const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const fd = new FormData(); fd.append('file', new Blob([bin], {type: 'audio/webm'}), 'speech.webm');
        const r = await fetch('/api/v1/audio/transcriptions', {method: 'POST',
            headers: {Authorization: 'Bearer ' + localStorage.token}, body: fd});
        return {status: r.status, body: await r.text()}; }""", base64.b64encode(FIXTURE.read_bytes()).decode())
    expect(r["status"] == 200, f"/api/v1/audio/transcriptions {r['status']}: {r['body'][:200]}")
    text = (json.loads(r["body"]).get("text") or "").lower()
    said = (Path(__file__).parent / "fixtures" / "speech.txt").read_text(encoding="utf-8").lower()
    words = [w for w in ("hello", "world", "voice", "test") if w in said]
    heard = [w for w in words if re.search(rf"\b{w}\b", text)]
    rec.save()
    expect(len(heard) >= 3, f"transcript {text!r} lacks most of {words}")
    return f"{stt_mode()}: {FIXTURE.stat().st_size // 1024} KB WebM → {text!r}"
