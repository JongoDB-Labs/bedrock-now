"""bedrock-now speech-to-text: an OpenAI-compatible /v1/audio/transcriptions in front of Mistral Voxtral on Bedrock.

Open WebUI posts the browser's recording here (webm/ogg/mp4/wav/mp3); ffmpeg turns it into 16 kHz mono WAV and
the service asks Voxtral for a verbatim transcript through LiteLLM's Bedrock pass-through, with the caller's own
LiteLLM key — so the spend lands on that key and its budget applies. This container holds no AWS credentials and
no LiteLLM key of its own.
"""
