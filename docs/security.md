# Security model

Back to the [README](../README.md#security-model).

## What stays local

- Every host port binds to `127.0.0.1`. All containers share one private Docker network.
- AWS credentials reach only the `litellm` container (and throwaway `aws-cli` containers during setup). They
  are never passed on a command line. Every secret lives in `.env` (mode 600, never committed).
- Open WebUI's only model connection is LiteLLM. Ollama, web search and community sharing are off.
  `OFFLINE_MODE` is on (no Hugging Face downloads, no update check) and telemetry is off.
- LiteLLM uses its **bundled** price map (no runtime fetch from GitHub); our prices override it. LiteLLM's
  breached-password check (a haveibeenpwned.com lookup) is off.
- LiteLLM does **not** store prompt or response text, only metadata and spend. To store it, set
  `LITELLM_STORE_PROMPTS=true` in `.env` and run `./stack setup`. Spend logs are kept for 90 days (LiteLLM's
  built-in cleanup job, `maximum_spend_logs_retention_period`).
- `claude-bedrock` sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so Bedrock sessions send no telemetry,
  error reports or update checks. Plain `claude` is not affected and follows Claude Code's own settings.

## How the single login works

Caddy is the only thing that publishes a browser UI, on `127.0.0.1` only. Before every request to any of the
four host names it asks the portal whether the `bn_session` cookie is valid (Caddy `forward_auth`). Without a
session you get the login page.

- The cookie is signed with `PORTAL_SECRET`, `HttpOnly`, `SameSite=Strict`, scoped to the portal host name and
  its subdomains, and valid for 30 days; it is never passed on to the apps.
- Open WebUI signs you in from an `X-Portal-User` header that only Caddy sets, after the portal confirmed the
  session; any `X-Portal-User` a client sends is deleted first, and Open WebUI publishes no port, so the header
  can't be forged.
- The login form only accepts a POST from the portal itself, sends you back only to a portal address (no open
  redirect), compares the password in constant time and slows down after five wrong attempts; a login body
  over 8 KB is refused (Caddy caps it at 16 KB before it reaches the portal).
- **Sign out** on Home ends every session, and that survives a restart of the portal: the time of the last
  sign-out is kept in the small `portal-state` volume (the portal's only writable storage besides `/tmp` and
  the price files in `litellm/prices/`).
- Chat, Admin and Files may be framed only by the portal (`Content-Security-Policy: frame-ancestors
  <portal>`); the portal can't be framed at all. Host names other than the four answer 404.
- The LiteLLM and RustFS sign-ins shown on Home come from the portal's API with copy buttons; the values never
  appear in the page source.

## Supply chain

Every image version is pinned in `compose.yaml` (Caddy also by digest); the portal and shared-mcp Python
dependencies are hash-locked. LiteLLM is pinned to **1.105.0**. Never use LiteLLM **1.82.7 or 1.82.8**: those
releases were compromised. Update only with `./stack update`.
