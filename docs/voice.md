# Voice: speech-to-text for the microphone and voice calls

Back to the [README](../README.md#voice-speech-to-text).

Open WebUI's **Call** button (the sound-wave button next to the microphone) needs a server speech-to-text
service; with only the browser's speech recognition (the Web Speech API), Open WebUI v0.12 refuses Call with
*"Call feature is not supported when using Web STT engine"*. bedrock-now offers these choices:

| Choice | Key | Where your speech goes | Price per minute of audio |
|---|---|---|---|
| **Bedrock** — Mistral Voxtral Small (default) | none | **your AWS account** (Bedrock) | ~$0.00014, estimated |
| Bedrock — Mistral Voxtral Mini | none | your AWS account (Bedrock) | ~$0.00004, estimated |
| OpenAI `gpt-4o-mini-transcribe` | OpenAI | api.openai.com | $0.003 |
| Groq `whisper-large-v3-turbo` | Groq | api.groq.com | $0.0007 |
| Browser only | — | your browser's speech service | — (no Call) |

**Bedrock is the default.** When setup's model check finds that your AWS key can use Mistral Voxtral, it turns
Bedrock speech-to-text on and says so in one line:

```
==> Voice: Bedrock speech-to-text on (Mistral Voxtral Small, ~$0.00014 per minute of audio, estimated) — ./stack stt remove to use browser speech
```

It never overrides a choice you made: an interactive setup asks once (*1) Bedrock, 2) OpenAI, 3) Groq,
4) Browser only*; Enter = Bedrock), and `./stack stt set …` / `./stack stt remove` are remembered
(`.state/stt-choice`). An install that answered the older setup question (OpenAI/Groq/none) keeps its answer
after an update; `./stack stt set bedrock` switches it.

## Commands

```bash
./stack stt status                  # what is on, where audio goes, the price
./stack stt set bedrock             # Mistral Voxtral Small (no key)
./stack stt set bedrock mini        # Mistral Voxtral Mini: cheaper, less reliable (see below)
./stack stt set openai              # or groq; asks for the key (checked first; stored in .env)
./stack stt set openai gpt-4o-transcribe
./stack stt remove                  # browser speech only (no Call); setup will not turn Bedrock back on
```

`./stack stt set bedrock` refuses (and changes nothing) when the last model check found Voxtral unusable, with
the reason (for example *not subscribed in this AWS account (AWS Marketplace)*). After your AWS admin enables
it: `./stack models --recheck`, then `./stack stt set bedrock` (or just `./stack setup`).

## How Bedrock speech-to-text works

```
browser ──(webm/opus or mp4/aac)──▶ Open WebUI ──▶ stt container ──(16 kHz WAV)──▶ LiteLLM ──▶ Bedrock (Voxtral)
                         Open WebUI's own LiteLLM key, forwarded ──────────────────▲ spend + budget
```

- Open WebUI's speech-to-text engine becomes `openai` (its OpenAI-compatible engine), pointed at the small
  **`stt` container** (`AUDIO_STT_OPENAI_API_BASE_URL=http://stt:8000/v1`, model `stt`) with Open WebUI's own
  LiteLLM key.
- The stt container checks the recording's format from its first bytes (WebM, Ogg, MP4/M4A, WAV, MP3, AAC or
  FLAC; anything else is refused), converts it with **ffmpeg** to 16 kHz mono WAV, and sends it to
  **Mistral Voxtral** through **LiteLLM's Bedrock pass-through** (`/bedrock/model/voxtral-small/converse`),
  forwarding the caller's key. Voxtral is a chat model, so the request is the audio plus the instruction
  *"Transcribe this audio verbatim … Output only the words spoken"*, temperature 0, with the language hint
  Open WebUI sends.
- LiteLLM checks the key, signs the request with the stack's AWS credentials and books the spend on the
  **open-webui key**: its monthly budget applies, and the spend shows on Home, in `./stack costs` and in the
  LiteLLM UI. The per-answer cost line in Chat does not include it (it prices chat tokens only).
- Voxtral Small and Mini are ordinary catalog models (`catalog/models.tsv`, kind `stt`): setup checks them with
  a real 1-token request (well under $0.0001), they are hidden from Open WebUI's model picker, and
  `./stack models` and Home list them.
- With server speech-to-text on, the **microphone button uses it too**, not the browser. That also makes
  dictation work where the browser has no speech recognition: Firefox, and installed web apps / iOS
  home-screen apps.
- **Answers in a call are read aloud by your browser's voices** (Open WebUI's text-to-speech stays "browser"),
  so no server text-to-speech is needed.

### Privacy

With Bedrock speech-to-text, your recordings go only to **your own AWS account**: the stt container (on the
stack's internal Docker network, no published port) converts them in a temporary directory in memory that is
deleted right after the request, and LiteLLM sends them to Bedrock in your region. The container holds no AWS
credentials and no key of its own, keeps nothing, and logs only sizes, durations and status codes — never audio
or transcripts. LiteLLM does not store the audio either (prompt logging stays off unless you turned on
`LITELLM_STORE_PROMPTS`).

### Limits

- At most **25 MB** and **10 minutes** per recording (Open WebUI itself splits uploads above 20 MB into
  chunks); longer or larger ones get a clear error. ffmpeg is stopped after 60 s.
- The container runs as an unprivileged user with a read-only file system, no Linux capabilities, a 160 MB
  `/tmp` in memory, 768 MB RAM and 64 processes at most, and converts four recordings at a time.

### Prices (estimated)

Bedrock bills Voxtral **per token**, like a chat model: Voxtral Small $0.10 per 1M input / $0.30 per 1M output
tokens, Voxtral Mini $0.04 / $0.04 (us-east-1; the AWS Price List agrees). The audio counts as input tokens —
in our measurements about **12.5 tokens per second of speech** (a 5 s clip: 392 input tokens including the
instruction; a 37 s clip: 767) — and a minute of speech is about 200 output tokens. So:

- Voxtral Small: ~750 × $0.10/1M + ~200 × $0.30/1M ≈ **$0.00014 per minute** (~$0.008 per hour), plus about
  $0.00003 per request for the instruction;
- Voxtral Mini: ≈ **$0.00004 per minute**.

These are **estimates**, and `./stack stt status`, `./stack costs` and Home say so. What LiteLLM records on the
open-webui key is computed from the tokens Bedrock actually reports for each request.

### Voxtral Small or Mini?

Voxtral Small follows the transcription instruction reliably in our tests (short and 10–40 s clips, verbatim).
Voxtral Mini is about 3× cheaper but sometimes **answers** the question it hears instead of transcribing it.
Small is the default; setup falls back to Mini only when Small is not usable with your AWS key.

## OpenAI or Groq (outside Bedrock)

These are the opt-in **exception to "Bedrock only"**: your recorded speech goes to that provider. Chat answers
still come from Bedrock (or OpenRouter, if you use it).

- **At setup:** choose 2 or 3, then paste the API key (hidden input; Enter skips = browser speech).
- **Later:** `./stack stt set openai` or `./stack stt set groq` (asks for the key, or reads `STT_API_KEY`
  from the environment). The key is checked with the provider first (`GET /v1/models`, free); a rejected key
  is not stored.
- **Restricted OpenAI keys** (project keys with limited permissions) need write access to the **audio**
  endpoints (`/v1/audio/transcriptions`); *Models: Read* is optional. Without it the check answers HTTP 403
  "missing scopes": bedrock-now then accepts the key with a note, and transcription is tested on first use.
- **Without a terminal:** `STT_PROVIDER=openai STT_API_KEY=… ./stack stt set`, or at setup
  `BEDROCK_NOW_STT_FROM_ENV=1 STT_PROVIDER=… STT_API_KEY=… ./stack setup --yes`. (`STT_PROVIDER=bedrock` needs
  no key and no opt-in.)
- **Only `.env` counts.** `STT_*` variables that happen to be in your shell never turn a key provider on:
  `./stack` strips them from what Docker Compose sees, an interactive setup asks before it uses them,
  `setup --yes` uses them only with `BEDROCK_NOW_STT_FROM_ENV=1`, and `./stack update` ignores them.
- The key is stored in `.env` (mode 600) as `STT_API_KEY`; Compose passes it to the LiteLLM container only. It
  is sent with `curl -K -` (never on a command line) and must be letters, digits, `-` and `_`.
  Create keys at https://platform.openai.com/api-keys or https://console.groq.com/keys; a spend limit there
  caps what a lost key can cost.
- LiteLLM gets one more model, `stt` (`mode: audio_transcription`), hidden from the model picker, and Open
  WebUI transcribes through LiteLLM (`http://litellm:4000/v1`, model `stt`) with its own key — spend counts on
  the open-webui key, as with Bedrock.

| Provider | Model | Price per minute of audio |
|---|---|---|
| openai | `gpt-4o-mini-transcribe` (default) | $0.003 |
| openai | `gpt-4o-transcribe` | $0.006 |
| openai | `whisper-1` | $0.006 |
| groq | `whisper-large-v3-turbo` (default) | $0.0007 ($0.04 per hour) |
| groq | `whisper-large-v3` | $0.0018 ($0.11 per hour) |

These are LiteLLM's prices for these models (the price map in the pinned LiteLLM image, which matches the
providers' price pages). Models billed per second (`whisper-1` and Groq) ask the provider for `verbose_json`,
whose duration is what LiteLLM bills, and carry their per-second price in the config: LiteLLM 1.105 cannot
measure the browser's webm/mp4 recordings itself and would log Groq calls as $0 otherwise.

**Groq bills at least 10 seconds per request.** A call sends each utterance separately (typically 2–4 seconds),
so Groq's bill can be 2–5× what LiteLLM records (about $0.0001 per utterance instead of $0.00003). For Groq the
spend in `./stack costs` and the `open-webui` budget are therefore approximate; the totals are still tiny
(an hour of talking stays well under $0.25). OpenAI bills the actual length.

With OpenAI or Groq on, the audio you record goes to `api.openai.com` or `api.groq.com`, under that provider's
API data policy. `./stack stt set bedrock` or `./stack stt remove` stops that.

## Why a separate container?

As of LiteLLM 1.105 and Open WebUI v0.12 slim, Voxtral (`mistral.voxtral-small-24b-2507`,
`mistral.voxtral-mini-3b-2507`) cannot be reached directly:

- LiteLLM's Bedrock transcription route fails for Voxtral (it adds a system message, which Voxtral rejects:
  *"Found system messages at indexes [0] and audio chunks…"*), and its chat route drops audio for Bedrock.
- Voxtral on Bedrock takes WAV or MP3 (Ogg/Opus is refused), while browsers record WebM (Chrome, Edge, Firefox)
  or MP4/AAC (Safari), and the slim Open WebUI image does not convert them.

LiteLLM's Bedrock **pass-through** works and records spend on the calling key, so the stt container converts
the audio and uses that.

## Troubleshooting

- **"Error transcribing chunk: External: …"** in Chat carries the stt container's message, for example:
  - *the Open WebUI key is over its monthly budget* — raise `BUDGET_OPENWEBUI` in `.env`, then `./stack setup`;
  - *Bedrock refused voxtral-small … for this AWS account* — model access was revoked: ask your AWS admin, then
    `./stack models --recheck`; or `./stack stt set openai|groq`;
  - *Bedrock is throttling speech-to-text right now* — try again in a few seconds;
  - *the recording is longer than 10 minutes* / *larger than 25 MB*.
- **Setup says Voxtral is not usable:** `./stack models` shows the reason. Your AWS account (and any
  organization SCPs or IAM policies) must allow invoking `mistral.voxtral-small-24b-2507` in your region;
  Bedrock offers Voxtral in us-east-1, us-east-2, us-west-2 and several EU and Asia Pacific regions.
- **The microphone still uses the browser** after turning it on: a user who saved their own audio settings
  keeps them. Settings → Audio → Speech-to-Text Engine → *Default*.
- **Call starts but nothing is transcribed:** `./stack stt status`, then `./stack logs stt` (Bedrock) or
  `./stack logs litellm` (OpenAI/Groq: a rejected or out-of-credit key shows there).
- **A failed transcription shows up twice** in the logs and the LiteLLM UI: Open WebUI retries a failed
  transcription once (without a language hint). Only successful transcriptions are billed.
- **Edited `STT_*` in `.env` by hand:** `./stack up` (or `./stack setup`) applies it.
- **Call asks for the microphone and fails:** browsers allow the microphone only on `https://` or
  `localhost` origins; `http://*.localhost` (the default portal) works.
