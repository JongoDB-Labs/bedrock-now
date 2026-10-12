# Voice calls: speech-to-text (optional)

Back to the [README](../README.md#optional-voice-calls-speech-to-text).

Open WebUI's **Call** button (the sound-wave button next to the microphone) needs a server speech-to-text
service. Bedrock has none, so by default bedrock-now uses your browser's speech recognition (the Web Speech
API) for the microphone, and Open WebUI v0.12 then refuses Call with *"Call feature is not supported when using
Web STT engine"*.

Speech-to-text is the one **opt-in exception to "Bedrock only"**: you can give bedrock-now an OpenAI or Groq
key, and your recorded speech then goes to that provider. Chat answers still come from Bedrock (or OpenRouter,
if you use it).

## Turning it on and off

- **At setup:** an interactive setup asks once: *Speech-to-text provider for voice calls (openai/groq/none)*,
  then the API key (hidden input; Enter skips). It shows the price first. `none` or Enter keeps the browser
  default and is not asked again.
- **Later:** `./stack stt set openai` or `./stack stt set groq` (asks for the key, or reads `STT_API_KEY`
  from the environment). Pick another model with `./stack stt set openai gpt-4o-transcribe`. The key is
  checked with the provider first (`GET /v1/models`, free); a rejected key is not stored. `./stack stt status`
  shows what is on; `./stack stt remove` goes back to browser speech.
- **Without a terminal:** `STT_PROVIDER=openai STT_API_KEY=… ./stack stt set`, or at setup
  `BEDROCK_NOW_STT_FROM_ENV=1 STT_PROVIDER=… STT_API_KEY=… ./stack setup --yes`.
- **Only `.env` counts.** `STT_*` variables that happen to be in your shell never turn it on: `./stack`
  strips them from what Docker Compose sees, an interactive setup asks before it uses them, `setup --yes` uses
  them only with `BEDROCK_NOW_STT_FROM_ENV=1`, and `./stack update` ignores them.
- The key is stored in `.env` (mode 600) as `STT_API_KEY`; Compose passes it to the LiteLLM container only. It
  is sent with `curl -K -` (never on a command line) and must be letters, digits, `-` and `_`.
  Create keys at https://platform.openai.com/api-keys or https://console.groq.com/keys; a spend limit there
  caps what a lost key can cost.

## Prices

| Provider | Model | Price per minute of audio |
|---|---|---|
| openai | `gpt-4o-mini-transcribe` (default) | $0.003 |
| openai | `gpt-4o-transcribe` | $0.006 |
| openai | `whisper-1` | $0.006 |
| groq | `whisper-large-v3-turbo` (default) | $0.0007 ($0.04 per hour) |
| groq | `whisper-large-v3` | $0.0018 ($0.11 per hour) |

These are LiteLLM's prices for these models (the price map in the pinned LiteLLM image, which matches the
providers' price pages). Groq bills at least 10 seconds per request, so many very short utterances cost a
little more than LiteLLM records.

## How it works

- LiteLLM gets one more model, `stt` (`mode: audio_transcription`), that calls the provider with
  `os.environ/STT_API_KEY`.
- Open WebUI's speech-to-text engine becomes `openai` (its OpenAI-compatible engine), pointed at LiteLLM
  (`AUDIO_STT_OPENAI_API_BASE_URL=http://litellm:4000/v1`, model `stt`) with Open WebUI's own LiteLLM key. So
  every transcription counts on the **open-webui key**: its monthly budget, the spend on Home and in
  `./stack costs`, and the LiteLLM UI's usage pages. The per-answer cost line in Chat does not include it (it
  prices chat tokens only).
- The `stt` entry is hidden from Open WebUI's model picker (like the embedding models).
- With server speech-to-text on, the **microphone button uses it too**, not the browser. That also makes
  dictation work where the browser has no speech recognition: Firefox, and installed web apps / iOS home-screen
  apps, where Web Speech is unavailable.
- **Answers in a call are read aloud by your browser's voices** (Open WebUI's text-to-speech stays "browser"),
  so no server text-to-speech is needed and nothing else is sent anywhere.
- Models billed per second (`whisper-1` and Groq) ask the provider for `verbose_json`, whose duration is what
  LiteLLM bills, and carry their per-second price in the config: LiteLLM 1.105 cannot measure the browser's
  webm/mp4 recordings itself and would log Groq calls as $0 otherwise. OpenAI's `gpt-4o-*-transcribe` report
  token usage, which LiteLLM prices.

## Privacy

With speech-to-text on, the audio you record with the microphone or during a call goes to OpenAI
(`api.openai.com`) or Groq (`api.groq.com`), under that provider's API data policy. Nothing else changes: the
transcript is then sent to the chat model as usual. Turn it off with `./stack stt remove`.

## Troubleshooting

- **The microphone still uses the browser** after turning it on: a user who saved their own audio settings
  keeps them. Settings → Audio → Speech-to-Text Engine → *Default*.
- **Call starts but nothing is transcribed:** check `./stack stt status` and `./stack logs litellm` (a
  rejected or out-of-credit key shows there). `./stack stt set …` replaces the key.
- **Call asks for the microphone and fails:** browsers allow the microphone only on `https://` or
  `localhost` origins; `http://*.localhost` (the default portal) works.
