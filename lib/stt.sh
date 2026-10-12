# shellcheck shell=bash
# Optional server speech-to-text, so Open WebUI's voice Call works. Bedrock has no speech-to-text model, so this
# is the one documented exception to "Bedrock only": OFF unless .env holds STT_PROVIDER (openai|groq) and a
# valid STT_API_KEY. Off, Open WebUI keeps the browser's Web Speech API (AUDIO_STT_ENGINE=web), and v0.12 then
# refuses Call ("Call feature is not supported when using Web STT engine").
#
# On: litellm/config.yaml gets a "stt" model (mode audio_transcription) that sends audio to the provider with
# os.environ/STT_API_KEY (compose passes that key to the litellm container only), and Open WebUI transcribes
# through LiteLLM with its own virtual key (AUDIO_STT_ENGINE=openai from OWUI_STT_ENGINE in .env, model "stt"),
# so the spend lands on the open-webui key and its budget. Prices: STT_CATALOG below (LiteLLM's own price map
# for these models; a test checks that they still match the pinned image's map).
# Call reads answers aloud with the browser's voices (AUDIO_TTS_ENGINE=""), so no server text-to-speech is needed.
# Only .env counts: an STT_* variable in your shell is ignored (dc() strips it; setup adopts shell values only
# after asking, see setup_stt). The key goes only to the provider (curl -K -, never argv) and to LiteLLM.
#
# Hooks for other parts of ./stack:
#   setup_stt            setup step (asks once; before the config is rendered)
#   stt_yaml             LiteLLM model_list entry (render_litellm_config)
#   stt_sync_owui        hides the "stt" entry in Open WebUI's model picker (needs a portal session)
#   stt_after_up         ./stack up, inside its portal session: that sync, when ./stack stt ran while stopped
#   stt_costs_section / stt_summary_line   ./stack costs / setup summary

# provider  model  litellm_model  usd_per_second_of_audio  billed_by (the first row per provider is its default)
# billed_by: tokens = OpenAI reports token usage and LiteLLM's map prices it (the per-second price is the
# provider's per-minute list price, for labels); seconds = the config carries the per-second price and asks for
# verbose_json, whose "duration" LiteLLM bills. Per-second rows need both: LiteLLM 1.105 cannot measure the
# browser's webm/mp4 recordings, and for Groq it looks the model up under "openai" and logs $0 without our price.
# Prices = LiteLLM 1.105.0's bundled map (input_cost_per_second) = the providers' price pages.
STT_CATALOG='openai	gpt-4o-mini-transcribe	openai/gpt-4o-mini-transcribe	0.00005	tokens
openai	gpt-4o-transcribe	openai/gpt-4o-transcribe	0.0001	tokens
openai	whisper-1	openai/whisper-1	0.0001	seconds
groq	whisper-large-v3-turbo	groq/whisper-large-v3-turbo	0.00001111	seconds
groq	whisper-large-v3	groq/whisper-large-v3	0.00003083	seconds'

stt_catalog() { printf '%s\n' "$STT_CATALOG"; }

# Tests may point both providers at another server; users cannot (no per-provider override).
stt_api_base() {
  if [ -n "${BEDROCK_NOW_TEST_STT_API:-}" ]; then printf '%s\n' "$BEDROCK_NOW_TEST_STT_API"; return 0; fi
  case "$1" in openai) echo https://api.openai.com/v1 ;; groq) echo https://api.groq.com/openai/v1 ;; esac
}
stt_host() { case "$1" in openai) echo api.openai.com ;; groq) echo api.groq.com ;; esac; }
stt_provider_label() { case "$1" in openai) echo OpenAI ;; groq) echo Groq ;; *) printf '%s\n' "$1" ;; esac; }
stt_keys_url() { case "$1" in openai) echo https://platform.openai.com/api-keys ;; groq) echo https://console.groq.com/keys ;; esac; }

valid_stt_provider() { case "$1" in openai | groq) return 0 ;; *) return 1 ;; esac; }

# valid_stt_key KEY -> 0 if it looks like an API key we can store and send safely: letters, digits, - and _,
# 20-512 characters (OpenAI: sk-…, Groq: gsk_…).
valid_stt_key() {
  case "$1" in '' | *[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#1}" -ge 20 ] && [ "${#1}" -le 512 ]
}

# stt_row PROVIDER MODEL -> its STT_CATALOG line, or nothing (status 1)
stt_row() { stt_catalog | P="$1" M="$2" awk -F'\t' '$1 == ENVIRON["P"] && $2 == ENVIRON["M"] { print; f = 1 } END { exit !f }'; }
stt_default_model() { stt_catalog | P="$1" awk -F'\t' '$1 == ENVIRON["P"] { print $2; exit }'; }
stt_models_of() { stt_catalog | P="$1" awk -F'\t' '$1 == ENVIRON["P"] { printf "%s%s", (n++ ? ", " : ""), $2 } END { print "" }'; }

stt_provider() { get_env STT_PROVIDER; }

# stt_model -> STT_MODEL from .env when it is one of the provider's models, else the provider's default
stt_model() {
  local p m; p="$(stt_provider)"; m="$(get_env STT_MODEL)"
  if [ -n "$m" ] && stt_row "$p" "$m" >/dev/null; then printf '%s\n' "$m"; else stt_default_model "$p"; fi
}

# stt_enabled -> 0 when .env holds a known provider and a usable key. Anything malformed counts as off
# (stt_key_problem says why) and is never sent anywhere.
stt_enabled() { valid_stt_provider "$(stt_provider)" && valid_stt_key "$(get_env STT_API_KEY)"; }

stt_key_problem() { # warns about STT_* settings in .env that keep speech-to-text off (or fall back)
  local p k m; p="$(stt_provider)"; k="$(get_env STT_API_KEY)"; m="$(get_env STT_MODEL)"
  [ -n "$p$k" ] || return 0
  if ! valid_stt_provider "$p"; then warn "STT_PROVIDER in .env must be openai or groq — speech-to-text stays off; fix it with ./stack stt set"; return 0; fi
  if ! valid_stt_key "$k"; then warn "STT_API_KEY in .env is not a valid key (20+ letters, digits, - and _) — speech-to-text stays off; fix it with ./stack stt set"; return 0; fi
  [ -z "$m" ] || stt_row "$p" "$m" >/dev/null ||
    warn "STT_MODEL=$m in .env is not a $(stt_provider_label "$p") model ($(stt_models_of "$p")) — using $(stt_default_model "$p")"
}

# stt_price_label PROVIDER MODEL -> "$0.003 per minute of audio ($0.18 per hour)"
stt_price_label() {
  stt_row "$1" "$2" | awk -F'\t' '
    function cut(v, d,  s) { s = sprintf("%." d "f", v); sub(/0+$/, "", s); sub(/\.$/, "", s); return s }
    { m = $4 * 60; printf "$%s per minute of audio ($%.2f per hour)\n", cut(m, 4), m * 60 }'
}

# stt_describe -> "OpenAI gpt-4o-mini-transcribe · $0.003 per minute of audio ($0.18 per hour)" for .env's choice
stt_describe() { local p m; p="$(stt_provider)"; m="$(stt_model 2>/dev/null)"; printf '%s %s · %s\n' "$(stt_provider_label "$p")" "$m" "$(stt_price_label "$p" "$m")"; }

# stt_yaml -> the LiteLLM model_list entry; nothing while speech-to-text is off. Called by render_litellm_config.
# Models billed by the second carry their price and ask for verbose_json (see STT_CATALOG).
stt_yaml() {
  local p row
  stt_enabled || return 0
  p="$(stt_provider)"; row="$(stt_row "$p" "$(stt_model 2>/dev/null)")" || return 0
  printf '%s\n' "$row" | awk -F'\t' '{
    printf "  - model_name: \"stt\"\n    litellm_params:\n      model: \"%s\"\n      api_key: os.environ/STT_API_KEY\n", $3
    if ($5 == "seconds") printf "      response_format: \"verbose_json\"\n"
    printf "    model_info:\n      mode: \"audio_transcription\"\n"
    if ($5 == "seconds") printf "      input_cost_per_second: %s\n", $4
  }'
}

# stt_sync_env — OWUI_STT_ENGINE in .env follows stt_enabled: "openai" (Open WebUI's OpenAI-compatible engine,
# pointed at LiteLLM in compose.yaml) when on; removed when off, so compose falls back to "web".
stt_sync_env() {
  stt_key_problem
  if stt_enabled; then [ "$(get_env OWUI_STT_ENGINE)" = openai ] || set_env OWUI_STT_ENGINE openai
  elif [ -n "$(get_env OWUI_STT_ENGINE)" ] || grep -q '^OWUI_STT_ENGINE=' "$ENV_FILE" 2>/dev/null; then unset_env OWUI_STT_ENGINE; fi
}

# stt_validate_key PROVIDER KEY -> 0 if the provider accepts KEY (GET /models: free); otherwise STT_ERR says why
stt_validate_key() {
  local tmp code host
  STT_ERR=''; host="$(stt_host "$1")"
  valid_stt_key "$2" || { STT_ERR="that does not look like a $(stt_provider_label "$1") API key (letters, digits, - and _ only)"; return 1; }
  tmp="$(mktemp)"
  code="$(curl_auth "$2" --proto '=https' -sS --connect-timeout 10 -m 20 -o "$tmp" -w '%{http_code}' "$(stt_api_base "$1")/models" 2>/dev/null || true)"
  rm -f "$tmp"
  case "$code" in
    200) return 0 ;;
    401 | 403) STT_ERR="$(stt_provider_label "$1") rejected the key (HTTP $code) — create one at $(stt_keys_url "$1")" ;;
    000 | '') STT_ERR="could not reach $host to check the key (network?)" ;;
    *) STT_ERR="$host answered HTTP $code while checking the key" ;;
  esac
  return 1
}

# _stt_store PROVIDER KEY [MODEL] -> 0 when the key was accepted and saved (STT_ERR otherwise)
_stt_store() {
  stt_validate_key "$1" "$2" || return 1
  set_env STT_PROVIDER "$1"; set_env STT_API_KEY "$2"
  if [ -n "${3:-}" ]; then set_env STT_MODEL "$3"; else unset_env STT_MODEL; fi
  stt_sync_env
}

# _stt_env_wanted -> 0 if setup may adopt STT_PROVIDER/STT_API_KEY from the shell: interactively only after a "y";
# non-interactively (--yes) only with BEDROCK_NOW_STT_FROM_ENV=1. Asked once (.state/stt-asked).
_stt_env_wanted() {
  if [ "${ASSUME_YES:-0}" != 1 ] && _have_tty && [ ! -e "$STATE_DIR/stt-asked" ]; then
    case "$(ask "found STT_PROVIDER=$1 and STT_API_KEY in your environment — use them for voice calls (your speech goes to $(stt_host "$1"))? [y/N]" "n")" in
      [Yy]*) return 0 ;; *) return 1 ;;
    esac
  fi
  [ "${BEDROCK_NOW_STT_FROM_ENV:-0}" = 1 ] && return 0
  log "STT_PROVIDER/STT_API_KEY in your environment are ignored (speech-to-text is opt-in: ./stack stt set uses them, or BEDROCK_NOW_STT_FROM_ENV=1)"
  return 1
}

# setup_stt — setup step. Settings already in .env are kept. Otherwise: STT_PROVIDER + STT_API_KEY from the shell
# are adopted only after asking (or with BEDROCK_NOW_STT_FROM_ENV=1 when non-interactive), and an interactive setup
# asks once for a provider and key (hidden). Never fatal: a rejected key means browser speech, with a warning.
setup_stt() {
  local p='' key='' model='' marker="$STATE_DIR/stt-asked"
  if [ -z "$(stt_provider)$(get_env STT_API_KEY)" ]; then
    if [ -n "${STT_PROVIDER:-}" ] && [ -n "${STT_API_KEY:-}" ]; then
      if valid_stt_provider "$STT_PROVIDER"; then
        if _stt_env_wanted "$STT_PROVIDER"; then p="$STT_PROVIDER"; key="$STT_API_KEY"; model="${STT_MODEL:-}"; fi
      else warn "STT_PROVIDER=$STT_PROVIDER in your environment is not openai or groq — ignored"; fi
    elif [ ! -e "$marker" ] && [ "${ASSUME_YES:-0}" != 1 ] && _have_tty; then
      log "Optional: voice calls (the Call button in Chat) need a speech-to-text service outside Bedrock — Bedrock has none."
      log "  Your speech then goes to that provider: openai ($(stt_price_label openai gpt-4o-mini-transcribe)) or groq ($(stt_price_label groq whisper-large-v3-turbo))."
      log "  Without one, the microphone keeps using your browser's speech recognition and Call stays unavailable."
      p="$(ask "Speech-to-text provider for voice calls (openai/groq/none)" "none")"
      case "$p" in
        openai | groq) key="$(ask_secret "$(stt_provider_label "$p") API key (hidden; Enter to skip)")"
          [ -n "$key" ] || { p=''; log "no key — voice calls stay off (./stack stt set adds one later)"; } ;;
        none | '') p=''; log "no speech-to-text service — voice calls stay off (./stack stt set adds one later)" ;;
        *) warn "unknown provider '$p' — skipped (./stack stt set openai|groq adds one later)"; p='' ;;
      esac
    fi
    if [ "${ASSUME_YES:-0}" != 1 ] && _have_tty; then mkdir -p "$STATE_DIR"; : > "$marker"; fi
  fi
  if [ -n "$p" ]; then
    if [ -n "$model" ] && ! stt_row "$p" "$model" >/dev/null; then
      warn "STT_MODEL=$model is not a $(stt_provider_label "$p") model ($(stt_models_of "$p")) — using $(stt_default_model "$p")"; model=''
    fi
    if _stt_store "$p" "$key" "$model"; then log "speech-to-text on: $(stt_describe) — voice calls work; your speech goes to $(stt_host "$p")"
    else warn "speech-to-text: $STT_ERR — not stored; voice calls stay off"; fi
  fi
  stt_sync_env
}

# stt_sync_owui — the "stt" model must not show up as a chat model: a hidden Open WebUI entry (like the
# embedding models), with the provider and price as its description. Needs a portal session. Never fatal.
stt_sync_owui() {
  local OWUI_ERR=''
  stt_enabled || return 0
  [ -n "$(get_env OPENWEBUI_API_KEY)" ] || return 0
  if owui_upsert_model stt "Speech to text" "Speech to text" "$(stt_describe) · voice input and calls" '[{"name":"Speech to text"}]' true
  then rm -f "$STATE_DIR/stt-owui-pending"
  else warn "Open WebUI: could not hide the speech-to-text model ($OWUI_ERR) — it may show in the model picker; ./stack stt set retries"; fi
}

# stt_after_up — ./stack up, inside its portal session: the sync ./stack stt could not do while the stack was stopped
stt_after_up() { [ ! -e "$STATE_DIR/stt-owui-pending" ] || stt_sync_owui || true; }

# _stt_apply — after set/remove: re-render, recreate LiteLLM (new model, new STT_API_KEY) and Open WebUI (new
# engine), hide the model and restore the budget banner (Open WebUI keeps it in memory only).
_stt_apply() {
  if [ -z "$(get_env LITELLM_MASTER_KEY)" ] || [ ! -f "$STACK_DIR/litellm/config.yaml" ]; then
    log "saved — ./stack setup applies it"; return 0
  fi
  render_config "$(_enabled_or_all)"
  if [ -z "$(dc ps -q litellm 2>/dev/null)" ]; then
    ! stt_enabled || { mkdir -p "$STATE_DIR"; : > "$STATE_DIR/stt-owui-pending"; }
    log "saved — the stack is stopped; ./stack up applies it"; return 0
  fi
  run_phase "LiteLLM" litellm dc up -d --no-deps --force-recreate --wait litellm
  run_phase "Open WebUI" open-webui dc up -d --no-deps --wait open-webui
  portal_session_or_die
  stt_sync_owui
  sync_budget_banner
  portal_session_end
}

cmd_stt() {
  local p m key
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  case "${1:-status}" in
    set)
      # An explicit command: here STT_PROVIDER / STT_API_KEY / STT_MODEL from the environment are the documented
      # non-interactive input.
      p="${2:-${STT_PROVIDER:-}}"; m="${3:-${STT_MODEL:-}}"
      [ -n "$p" ] || { _have_tty && [ "${ASSUME_YES:-0}" != 1 ] && p="$(ask "Speech-to-text provider (openai/groq)" "openai")"; } || true
      valid_stt_provider "$p" || die "usage: ./stack stt set openai|groq [model] — the provider must be openai or groq"
      [ -z "$m" ] || stt_row "$p" "$m" >/dev/null || die "'$m' is not a $(stt_provider_label "$p") speech-to-text model: $(stt_models_of "$p")"
      key="${STT_API_KEY:-}"
      [ -n "$key" ] || { _have_tty && [ "${ASSUME_YES:-0}" != 1 ] && key="$(ask_secret "$(stt_provider_label "$p") API key (hidden)")"; } ||
        die "no key: export STT_API_KEY or run this in a terminal"
      [ -n "$key" ] || die "no key entered — nothing changed"
      _stt_store "$p" "$key" "$m" || die "$STT_ERR — nothing changed"
      log "speech-to-text on: $(stt_describe)"
      log "your speech (microphone and Call) now goes to $(stt_host "$p"); spend counts on the open-webui key"
      _stt_apply ;;
    remove)
      [ -n "$(stt_provider)$(get_env STT_API_KEY)$(get_env STT_MODEL)" ] || { log "speech-to-text is not set — nothing to remove"; return 0; }
      p="$(stt_provider)"
      unset_env STT_PROVIDER; unset_env STT_API_KEY; unset_env STT_MODEL
      stt_sync_env
      log "speech-to-text removed — the microphone uses your browser again and Call is unavailable${p:+ (revoke the key at $(stt_keys_url "$p") if you no longer need it)}"
      _stt_apply ;;
    status)
      stt_key_problem
      if ! stt_enabled; then
        printf 'Speech-to-text: browser (Web Speech) — voice calls are unavailable. ./stack stt set openai|groq turns them on (see README › Optional: voice calls).\n'
        return 0
      fi
      printf 'Speech-to-text: on — %s\n' "$(stt_describe)"
      printf '  your speech (microphone and Call) goes to %s; spend counts on the open-webui key (./stack costs)\n' "$(stt_host "$(stt_provider)")"
      printf '  answers in Call are read aloud by your browser'"'"'s voices (no server text-to-speech)\n' ;;
    *) die "usage: ./stack stt [status|set openai|groq [model]|remove]" ;;
  esac
}

# stt_costs_section — ./stack costs: one line either way
stt_costs_section() {
  stt_key_problem
  if ! stt_enabled; then printf '\nSpeech-to-text: browser (Web Speech), no cost — ./stack stt set enables voice calls\n'; return 0; fi
  printf '\nSpeech-to-text: %s\n' "$(stt_describe)"
  printf '  audio goes to %s; its spend is in the open-webui key above (LiteLLM prices it per request)\n' "$(stt_host "$(stt_provider)")"
}

# stt_summary_line — print_summary: one line when speech-to-text is on
stt_summary_line() {
  stt_enabled || return 0
  printf '  Voice calls     %s   (./stack stt status)\n' "$(stt_describe)"
}
