# shellcheck shell=bash
# Server speech-to-text, so Open WebUI's microphone and voice Call work. Three providers (STT_PROVIDER in .env):
#
#   bedrock  Mistral Voxtral on Bedrock (catalog models voxtral-small / voxtral-mini, kind stt). No extra key and
#            the audio stays in your AWS account: Open WebUI sends the recording to the small "stt" container
#            (stt/, compose profile "stt"), which converts it with ffmpeg to 16 kHz WAV and asks Voxtral for a
#            verbatim transcript through LiteLLM's Bedrock pass-through (/bedrock/model/<model>/converse) with
#            Open WebUI's own virtual key — so spend lands on the open-webui key and its budget. The default:
#            setup turns it on when the model check finds Voxtral usable and you never chose otherwise.
#   openai | groq   the documented exception to "Bedrock only": OFF unless .env holds the provider and a valid
#            STT_API_KEY. litellm/config.yaml then gets a "stt" model (mode audio_transcription) that sends audio
#            to the provider with os.environ/STT_API_KEY (compose passes that key to the litellm container only),
#            and Open WebUI transcribes through LiteLLM with its own virtual key (model "stt").
#
# Off (no provider), Open WebUI keeps the browser's Web Speech API (AUDIO_STT_ENGINE=web), and v0.12 then refuses
# Call ("Call feature is not supported when using Web STT engine"). Call reads answers aloud with the browser's
# voices (AUDIO_TTS_ENGINE=""), so no server text-to-speech is needed.
# Only .env counts: an STT_* variable in your shell is ignored (dc() strips it; setup adopts shell values only
# after asking, see setup_stt). A key goes only to its provider (curl -K -, never argv) and to LiteLLM.
# Your choice is remembered in .state/stt-choice (bedrock|openai|groq|browser); an install that answered the
# older setup question (.state/stt-asked) counts as having chosen, so an update never switches it on by itself.
#
# Hooks for other parts of ./stack:
#   setup_stt            setup step (asks once; before the config is rendered)
#   stt_after_probe      setup step after the model check: Bedrock on by default / still usable?
#   stt_yaml             LiteLLM model_list entry (render_litellm_config; openai/groq only)
#   stt_sync_owui        hides the "stt" entry in Open WebUI's model picker (needs a portal session)
#   stt_after_up         ./stack up, inside its portal session: that sync, when ./stack stt ran while stopped
#   stt_service_up / stt_service_down   the stt container (Bedrock); stt_services: the extra service names
#   stt_costs_section / stt_summary_line   ./stack costs / setup summary

# provider  model  litellm_model  usd_per_second_of_audio  billed_by (the first row per provider is its default)
# billed_by: tokens = the provider reports token usage and LiteLLM prices it (for OpenAI the per-second price is
# the provider's per-minute list price, for labels); seconds = the config carries the per-second price and asks for
# verbose_json, whose "duration" LiteLLM bills. Per-second rows need both: LiteLLM 1.105 cannot measure the
# browser's webm/mp4 recordings, and for Groq it looks the model up under "openai" and logs $0 without our price.
# Prices = LiteLLM 1.105.0's bundled map (input_cost_per_second) = the providers' price pages.
# Bedrock rows: litellm_model is the catalog model; the per-minute price is an estimate (stt_bedrock_per_minute).
STT_CATALOG='openai	gpt-4o-mini-transcribe	openai/gpt-4o-mini-transcribe	0.00005	tokens
openai	gpt-4o-transcribe	openai/gpt-4o-transcribe	0.0001	tokens
openai	whisper-1	openai/whisper-1	0.0001	seconds
groq	whisper-large-v3-turbo	groq/whisper-large-v3-turbo	0.00001111	seconds
groq	whisper-large-v3	groq/whisper-large-v3	0.00003083	seconds
bedrock	voxtral-small	voxtral-small	-	tokens
bedrock	voxtral-mini	voxtral-mini	-	tokens'

# Bedrock bills Voxtral per token (catalog/prices.tsv). Measured on Bedrock (us-east-1, 2026-10): the audio counts
# as 375 input tokens per started 30 seconds (12.5 per second; 5 s: one block, 37 s: two, 10 min: twenty) plus ~60
# for the instruction; a minute of ordinary speech is ~150-200 words (~200 output tokens). Per-minute labels are
# therefore estimates for continuous speech; a call's short utterances each pay a full block (~$0.00005 each).
STT_EST_IN_TOKENS_PER_MIN=750
STT_EST_OUT_TOKENS_PER_MIN=200

stt_catalog() { printf '%s\n' "$STT_CATALOG"; }

# Tests may point both key providers at another server; users cannot (no per-provider override).
stt_api_base() {
  if [ -n "${BEDROCK_NOW_TEST_STT_API:-}" ]; then printf '%s\n' "$BEDROCK_NOW_TEST_STT_API"; return 0; fi
  case "$1" in openai) echo https://api.openai.com/v1 ;; groq) echo https://api.groq.com/openai/v1 ;; esac
}
stt_host() { case "$1" in openai) echo api.openai.com ;; groq) echo api.groq.com ;; bedrock) echo "Bedrock in your AWS account" ;; esac; }
stt_provider_label() { case "$1" in openai) echo OpenAI ;; groq) echo Groq ;; bedrock) echo Bedrock ;; *) printf '%s\n' "$1" ;; esac; }
stt_keys_url() { case "$1" in openai) echo https://platform.openai.com/api-keys ;; groq) echo https://console.groq.com/keys ;; esac; }
stt_model_label() { case "$1" in voxtral-small) echo "Mistral Voxtral Small" ;; voxtral-mini) echo "Mistral Voxtral Mini" ;; *) printf '%s\n' "$1" ;; esac; }

valid_stt_provider() { case "$1" in openai | groq | bedrock) return 0 ;; *) return 1 ;; esac; }
stt_needs_key() { case "$1" in openai | groq) return 0 ;; *) return 1 ;; esac; }

# valid_stt_key KEY -> 0 if it looks like an API key we can store and send safely: letters, digits, - and _,
# 20-512 characters (OpenAI: sk-…, Groq: gsk_…).
valid_stt_key() {
  case "$1" in '' | *[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#1}" -ge 20 ] && [ "${#1}" -le 512 ]
}

# stt_row PROVIDER MODEL -> its STT_CATALOG line, or nothing (status 1)
stt_row() { stt_catalog | P="$1" M="$2" awk -F'\t' '$1 == ENVIRON["P"] && $2 == ENVIRON["M"] { print; f = 1 } END { exit !f }'; }
stt_default_model() { stt_catalog | P="$1" awk -F'\t' '!f && $1 == ENVIRON["P"] { print $2; f = 1 }'; }
stt_models_of() { stt_catalog | P="$1" awk -F'\t' '$1 == ENVIRON["P"] { printf "%s%s", (n++ ? ", " : ""), $2 } END { print "" }'; }

# stt_bedrock_model_arg small|mini|voxtral-small|voxtral-mini -> the catalog name (status 1 for anything else)
stt_bedrock_model_arg() { case "$1" in small | voxtral-small) echo voxtral-small ;; mini | voxtral-mini) echo voxtral-mini ;; *) return 1 ;; esac; }

stt_provider() { get_env STT_PROVIDER; }

# stt_model -> STT_MODEL from .env when it is one of the provider's models, else the provider's default
stt_model() {
  local p m; p="$(stt_provider)"; m="$(get_env STT_MODEL)"
  if [ -n "$m" ] && stt_row "$p" "$m" >/dev/null; then printf '%s\n' "$m"; else stt_default_model "$p"; fi
}

# stt_model_ready MODEL -> 0 when the last model check found that Bedrock model usable (before the first check:
# assumed usable) and Bedrock takes audio for it (stt_model_refused). stt_model_reason MODEL -> the check's reason when
# it is not.
stt_model_ready() { is_enabled "$1" "$(_enabled_or_all)" && ! stt_model_refused "$1"; }
# stt_model_ok MODEL -> 0 only when the model check's real request succeeded (reason "ok"); "kept" verdicts
# (throttled, timeout, budget…) do not turn Bedrock speech-to-text on by default.
stt_model_ok() { stt_model_ready "$1" && [ "$(stt_model_reason "$1")" = ok ]; }
stt_model_reason() {
  local f="$STACK_DIR/litellm/probe-results.tsv" r=''
  [ ! -r "$f" ] || r="$(M="$1" awk -F'\t' '$1 == ENVIRON["M"] { print $4; exit }' "$f")"
  printf '%s\n' "${r:-not enabled by the last model check}"
}

# --- Bedrock refusing audio (since October 2026) ---
# Bedrock now answers every audio request to both Voxtral models with HTTP 400 "The model returned the following
# errors: Model does not support audio modality" (Converse and Invoke, in every region tried); text still works, so
# the model check's 1-token text request alone says ok. AWS lists both as Legacy (end of life 2027-03-30), without
# audio. That answer is a state of its own: Bedrock speech-to-text goes off once, said plainly (the notice: Home,
# ./stack status, ./stack stt status), and is refused while a check gets that answer. Its code stays: when a check
# gets audio through again (AWS re-enabling it, or another Bedrock model), it works again. Other failures (network,
# permissions, throttling) keep their own handling — they never switch anything off here.
#   checks: the model check (stt_probe_audio), ./stack up (stt_up_check), ./stack test (stt_test_checks), ./stack stt
#   set bedrock and Settings › Voice (stt_audio_check); the stt container says it to Chat in its own words.
STT_AUDIO_GONE="AWS no longer accepts audio for the Voxtral models (since October 2026)"
STT_REFUSED_NOTICE="Bedrock speech-to-text was turned off: $STT_AUDIO_GONE. Voice uses your browser's speech recognition; or use your own OpenAI/Groq key: ./stack stt set openai|groq."
STT_REFUSED_ERR="Bedrock speech-to-text is unavailable: $STT_AUDIO_GONE. Use browser speech, or your own OpenAI/Groq key: ./stack stt set openai|groq."
# the model check's reason for such a model (litellm/probe-results.tsv; the table's WHY: "no audio (AWS)")
STT_REFUSED_REASON="no audio: Bedrock no longer accepts audio for this model (AWS: Model does not support audio modality)"

# stt_refusal_in TEXT -> 0 when TEXT is that answer: AWS's words (through LiteLLM, or passed on by an stt container
# from before this release) or the stt container's own (code audio_not_supported, "no longer accepts audio")
stt_refusal_in() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    *"does not support audio modality"* | *audio_not_supported* | *"no longer accepts audio"*) return 0 ;;
  esac
  return 1
}

# stt_model_refused MODEL -> 0 when the last check got that answer for this Bedrock model (its recorded reason)
stt_model_refused() { case "$(stt_model_reason "$1")" in "no audio:"*) return 0 ;; esac; return 1; }
# stt_bedrock_refused -> 0 when every Bedrock speech-to-text model got that answer
stt_bedrock_refused() {
  local m
  for m in $(stt_catalog | awk -F'\t' '$1 == "bedrock" { print $2 }'); do stt_model_refused "$m" || return 1; done
}

# stt_audio_check MODEL -> STT_AUDIO: ok (Bedrock took the audio), refused (that answer) or other (anything else:
# not this state), STT_AUDIO_CODE: the HTTP status. Half a second of a tone (stt/check-tone.mp3: 16 kHz MP3, as the stt
# container sends) through LiteLLM's Bedrock pass-through with the setup key, at most 8 output tokens: well under
# $0.0001 when it works, nothing when refused.
stt_audio_check() {
  local tmp body code tone="$STACK_DIR/stt/check-tone.mp3"
  STT_AUDIO=other
  # shellcheck disable=SC2034  # for the caller (and the tests)
  STT_AUDIO_CODE=''
  case "$1" in '' | *[!a-z0-9.-]*) return 0 ;; esac
  [ -r "$tone" ] || return 0
  body="$(printf '{"messages":[{"role":"user","content":[{"text":"Transcribe the recording."},{"audio":{"format":"mp3","source":{"bytes":"%s"}}}]}],"inferenceConfig":{"temperature":0,"maxTokens":8}}' \
    "$(base64 < "$tone" | tr -d '\n')")"
  tmp="$(mktemp)"
  code="$(litellm_call "$(setup_key)" POST "/bedrock/model/$1/converse" "$body" "$tmp")"
  # shellcheck disable=SC2034
  STT_AUDIO_CODE="$code"
  if [ "$code" = 200 ]; then STT_AUDIO=ok
  elif stt_refusal_in "$(head -c 4000 "$tmp" 2>/dev/null)"; then STT_AUDIO=refused; fi
  rm -f "$tmp"
}

# stt_probe_audio NAME REASON -> the reason the model check records for a Bedrock speech-to-text model whose 1-token
# text request said REASON: the refusal when Bedrock refuses its audio, else REASON (any other audio answer changes
# nothing). For ok only: a model the text request already found unusable is not asked again.
stt_probe_audio() {
  [ "$2" = ok ] || { printf '%s\n' "$2"; return 0; }
  stt_audio_check "$1"
  if [ "$STT_AUDIO" = refused ]; then printf '%s\n' "$STT_REFUSED_REASON"; else printf '%s\n' "$2"; fi
}

# _stt_mark_audio MODEL refused|ok — the model check's record (litellm/probe-results.tsv) follows what a check found
# later: refused = the model's reason becomes the refusal; ok = a refusal recorded before goes back to ok. Its verdict
# stays: LiteLLM keeps serving the model, so a later check still reaches it.
_stt_mark_audio() {
  local f="$STACK_DIR/litellm/probe-results.tsv" tmp
  [ -f "$f" ] || return 0
  tmp="$(mktemp "$f.XXXXXX")" || return 0
  if M="$1" W="$2" R="$STT_REFUSED_REASON" awk -F'\t' -v OFS='\t' '
      $1 == ENVIRON["M"] && $3 == "ENABLED" {
        if (ENVIRON["W"] == "refused") $4 = ENVIRON["R"]
        else if (index($4, "no audio:") == 1) $4 = "ok"
      } { print }' "$f" > "$tmp"; then
    chmod 644 "$tmp" && mv "$tmp" "$f" || rm -f "$tmp"
  else rm -f "$tmp"; fi
}

# The notice: .state/status/stt-notice.json for the portal (Home: its voice line and one notification) and the
# ./stack status lines. Recorded once (the first time; its "at" names the event), when Bedrock speech-to-text was on
# or would have been turned on by default; cleared by a voice choice (./stack stt set / remove, Settings) or when
# Bedrock speech-to-text is on again.
stt_notice_file() { printf '%s/stt-notice.json\n' "$(status_dir)"; }
stt_notice_record() {
  local d f tmp
  d="$(status_dir)"; f="$(stt_notice_file)"
  [ ! -e "$f" ] || return 0
  mkdir -p "$d" 2>/dev/null || return 0
  tmp="$(mktemp "$d/.stt-notice.XXXXXX")" 2>/dev/null || return 0
  printf '{"at": %s, "reason": "audio-refused"}\n' "$(date +%s)" > "$tmp" && chmod 644 "$tmp" && mv "$tmp" "$f" || rm -f "$tmp"
}
stt_notice_clear() { rm -f "$(stt_notice_file)" 2>/dev/null || true; }
stt_notice_on() { [ -e "$(stt_notice_file)" ] && ! stt_enabled; }

# stt_turn_off_refused — Bedrock speech-to-text off because Bedrock refused its audio: .env back to browser speech
# (STT_PROVIDER blank, as setup's fallback), the stt container removed, the notice recorded and said. The recorded
# choice stays, so a later check that gets audio through turns it on again. The caller restarts Chat and the portal.
stt_turn_off_refused() {
  unset_env STT_PROVIDER; unset_env STT_MODEL
  stt_sync_env
  rm -f "$STATE_DIR/stt-start-failed"
  stt_notice_record
  stt_service_down
  warn "Voice: $STT_REFUSED_NOTICE"
}

# stt_up_check — ./stack up, once the services run, while Bedrock speech-to-text is on: half a second of audio
# (stt_audio_check). Refused: the other Voxtral model if Bedrock takes its audio, else browser speech
# (stt_turn_off_refused) with Chat and the portal restarted. Any other answer changes nothing.
stt_up_check() {
  local m alt
  [ "$(stt_provider)" = bedrock ] || return 0
  m="$(stt_model 2>/dev/null)"
  stt_audio_check "$m"
  case "$STT_AUDIO" in
    ok) _stt_mark_audio "$m" ok; stt_notice_clear; return 0 ;;
    refused) _stt_mark_audio "$m" refused ;;
    *) return 0 ;;
  esac
  alt=voxtral-small; [ "$m" != voxtral-small ] || alt=voxtral-mini
  if is_enabled "$alt" "$(_enabled_or_all)"; then
    stt_audio_check "$alt"
    if [ "$STT_AUDIO" = ok ]; then
      _stt_mark_audio "$alt" ok
      _stt_store_bedrock "$alt" 2>/dev/null
      log "Voice: Bedrock no longer accepts audio for $(stt_model_label "$m") — using $(stt_model_label "$alt")"
      dc up -d --no-deps --wait stt >/dev/null 2>&1 || warn "could not restart the stt container — ./stack up retries"
      _stt_refresh_portal
      return 0
    fi
    [ "$STT_AUDIO" != refused ] || _stt_mark_audio "$alt" refused
  fi
  stt_turn_off_refused
  dc up -d --no-deps --wait open-webui >/dev/null 2>&1 || warn "could not restart Open WebUI — ./stack up applies browser speech"
  _stt_refresh_portal
}

# stt_choice -> what the user chose: bedrock|openai|groq|browser, "legacy" for an install that answered the
# older setup question, or nothing (never chose: Bedrock may be turned on by default).
stt_choice() {
  local c=''
  [ ! -r "$STATE_DIR/stt-choice" ] || c="$(head -n 1 "$STATE_DIR/stt-choice" 2>/dev/null | tr -cd 'a-z')"
  case "$c" in bedrock | openai | groq | browser) printf '%s\n' "$c"; return 0 ;; esac
  [ ! -e "$STATE_DIR/stt-asked" ] || echo legacy
}
stt_set_choice() { mkdir -p "$STATE_DIR"; printf '%s\n' "$1" > "$STATE_DIR/stt-choice"; stt_notice_clear; }   # (a choice: no notice)

# stt_enabled -> 0 when .env holds a usable choice: openai/groq with a valid key, or bedrock with a Voxtral model
# the model check enabled. Anything malformed counts as off (stt_key_problem says why) and is never sent anywhere.
stt_enabled() {
  local p; p="$(stt_provider)"
  case "$p" in
    openai | groq) valid_stt_key "$(get_env STT_API_KEY)" ;;
    bedrock) stt_model_ready "$(stt_model 2>/dev/null)" ;;
    *) return 1 ;;
  esac
}

stt_key_problem() { # warns about STT_* settings in .env that keep speech-to-text off (or fall back)
  local p k m; p="$(stt_provider)"; k="$(get_env STT_API_KEY)"; m="$(get_env STT_MODEL)"
  [ -n "$p$k" ] || return 0
  if ! valid_stt_provider "$p"; then warn "STT_PROVIDER in .env must be bedrock, openai or groq — speech-to-text stays off; fix it with ./stack stt set"; return 0; fi
  if [ "$p" = bedrock ]; then
    [ -z "$m" ] || stt_row bedrock "$m" >/dev/null || warn "STT_MODEL=$m in .env is not a Bedrock speech-to-text model ($(stt_models_of bedrock)) — using voxtral-small"
    if stt_model_refused "$(stt_model)"; then warn "STT_PROVIDER=bedrock in .env: $STT_AUDIO_GONE — speech-to-text stays off (./stack stt status)"; return 0; fi
    stt_model_ready "$(stt_model)" ||
      warn "$(stt_model) (Mistral Voxtral) is not usable with your AWS key ($(stt_model_reason "$(stt_model)")) — speech-to-text stays off; ./stack models --recheck after your AWS admin enables it"
    return 0
  fi
  if ! valid_stt_key "$k"; then warn "STT_API_KEY in .env is not a valid key (20+ letters, digits, - and _) — speech-to-text stays off; fix it with ./stack stt set"; return 0; fi
  [ -z "$m" ] || stt_row "$p" "$m" >/dev/null ||
    warn "STT_MODEL=$m in .env is not a $(stt_provider_label "$p") model ($(stt_models_of "$p")) — using $(stt_default_model "$p")"
}

_stt_cut() { awk -v v="$1" -v d="$2" 'BEGIN { s = sprintf("%." d "f", v); sub(/0+$/, "", s); sub(/\.$/, "", s); print s }'; }

# stt_bedrock_per_minute MODEL -> estimated USD per minute of speech, from the prices in use (catalog/daily update)
stt_bedrock_per_minute() {
  local in out; in="$(price_field "$1" in)"; out="$(price_field "$1" out)"
  # an automatic price file from before Voxtral joined the catalog: the catalog's price until the next update
  [ -n "$in" ] || { in="$(PRICES="$(prices_catalog)" price_field "$1" in)"; out="$(PRICES="$(prices_catalog)" price_field "$1" out)"; }
  awk -v i="${in:-0}" -v o="${out:-0}" -v ti="$STT_EST_IN_TOKENS_PER_MIN" -v to="$STT_EST_OUT_TOKENS_PER_MIN" \
    'BEGIN { printf "%.8f\n", (ti * i + to * o) / 1000000 }'
}

# stt_bedrock_per_utterance MODEL -> estimated USD for one short request: one 30-second block (375 tokens) plus
# the instruction (~60), and a short answer (~15 tokens)
stt_bedrock_per_utterance() {
  local in out; in="$(price_field "$1" in)"; out="$(price_field "$1" out)"
  [ -n "$in" ] || { in="$(PRICES="$(prices_catalog)" price_field "$1" in)"; out="$(PRICES="$(prices_catalog)" price_field "$1" out)"; }
  _stt_cut "$(awk -v i="${in:-0}" -v o="${out:-0}" 'BEGIN { printf "%.8f", (435 * i + 15 * o) / 1000000 }')" 5
}

# stt_price_label PROVIDER MODEL -> "$0.003 per minute of audio ($0.18 per hour)";
# Bedrock: "~$0.00014 per minute of audio, estimated (~$0.0081 per hour)"
stt_price_label() {
  local m
  if [ "$1" = bedrock ]; then
    m="$(stt_bedrock_per_minute "$2")"
    printf '~$%s per minute of audio, estimated (~$%s per hour)\n' "$(_stt_cut "$m" 5)" "$(_stt_cut "$(awk -v m="$m" 'BEGIN { print m * 60 }')" 4)"
    return 0
  fi
  stt_row "$1" "$2" | awk -F'\t' '
    function cut(v, d,  s) { s = sprintf("%." d "f", v); sub(/0+$/, "", s); sub(/\.$/, "", s); return s }
    { m = $4 * 60; printf "$%s per minute of audio ($%.2f per hour)\n", cut(m, 4), m * 60 }'
}

# stt_describe -> "OpenAI gpt-4o-mini-transcribe · $0.003 per minute of audio ($0.18 per hour)" for .env's choice,
# "Bedrock Mistral Voxtral Small · ~$0.00014 per minute of audio, estimated (…)" for Bedrock
stt_describe() {
  local p m; p="$(stt_provider)"; m="$(stt_model 2>/dev/null)"
  if [ "$p" = bedrock ]; then printf 'Bedrock %s · %s\n' "$(stt_model_label "$m")" "$(stt_price_label bedrock "$m")"
  else printf '%s %s · %s\n' "$(stt_provider_label "$p")" "$m" "$(stt_price_label "$p" "$m")"; fi
}

# stt_yaml -> the LiteLLM model_list entry for openai/groq; nothing while speech-to-text is off or on Bedrock
# (Voxtral is an ordinary catalog model). Called by render_litellm_config. Models billed by the second carry
# their price and ask for verbose_json (see STT_CATALOG).
stt_yaml() {
  local p row
  stt_enabled || return 0
  p="$(stt_provider)"; stt_needs_key "$p" || return 0
  row="$(stt_row "$p" "$(stt_model 2>/dev/null)")" || return 0
  printf '%s\n' "$row" | awk -F'\t' '{
    printf "  - model_name: \"stt\"\n    litellm_params:\n      model: \"%s\"\n      api_key: os.environ/STT_API_KEY\n", $3
    if ($5 == "seconds") printf "      response_format: \"verbose_json\"\n"
    printf "    model_info:\n      mode: \"audio_transcription\"\n"
    if ($5 == "seconds") printf "      input_cost_per_second: %s\n", $4
  }'
}

_stt_env_follow() { # _stt_env_follow NAME VALUE -> .env holds NAME=VALUE, or no NAME line when VALUE is empty
  if [ -n "$2" ]; then [ "$(get_env "$1")" = "$2" ] || set_env "$1" "$2"
  elif grep -q "^$1=" "$ENV_FILE" 2>/dev/null; then unset_env "$1"; fi
}

# stt_sync_env — the derived settings compose reads follow stt_enabled: OWUI_STT_ENGINE "openai" (Open WebUI's
# OpenAI-compatible engine) when on, removed when off (compose falls back to "web"). Bedrock adds where Open WebUI
# sends audio (OWUI_STT_BASE_URL, the stt container; else compose's default, LiteLLM) and STT_BEDROCK_MODEL.
stt_sync_env() {
  local engine='' base='' model=''
  stt_key_problem
  if stt_enabled; then
    engine=openai
    if [ "$(stt_provider)" = bedrock ]; then base=http://caddy:8090/v1; model="$(stt_model)"; fi
  fi
  _stt_env_follow OWUI_STT_ENGINE "$engine"
  _stt_env_follow OWUI_STT_BASE_URL "$base"
  _stt_env_follow STT_BEDROCK_MODEL "$model"
}

# stt_validate_key PROVIDER KEY -> 0 if the provider accepts KEY (GET /models: free); otherwise STT_ERR says why.
# A 403 that is about permissions/scopes (an OpenAI restricted key without "Models: Read") is accepted: the key
# authenticated, it just may not list models. STT_NOTE then says so; transcription is tested on first use.
stt_validate_key() {
  local tmp code host body
  STT_ERR=''; STT_NOTE=''; host="$(stt_host "$1")"
  valid_stt_key "$2" || { STT_ERR="that does not look like a $(stt_provider_label "$1") API key (letters, digits, - and _ only)"; return 1; }
  tmp="$(mktemp)"
  code="$(curl_auth "$2" --proto '=https' -sS --connect-timeout 10 -m 20 -o "$tmp" -w '%{http_code}' "$(stt_api_base "$1")/models" 2>/dev/null || true)"
  body="$(head -c 2000 "$tmp" 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)"
  rm -f "$tmp"
  case "$code" in
    200) return 0 ;;
    403)
      case "$body" in
        *"missing scope"* | *"insufficient permission"* | *"restricted api key"* | *permission*scope* | *scope*permission*)
          STT_NOTE="this $(stt_provider_label "$1") key cannot list models (a restricted key) — accepted; it needs access to audio transcription, which is tested on first use"
          return 0 ;;
      esac
      STT_ERR="$(stt_provider_label "$1") rejected the key (HTTP $code) — create one at $(stt_keys_url "$1")" ;;
    401) STT_ERR="$(stt_provider_label "$1") rejected the key (HTTP $code) — create one at $(stt_keys_url "$1")" ;;
    000 | '') STT_ERR="could not reach $host to check the key (network?)" ;;
    *) STT_ERR="$host answered HTTP $code while checking the key" ;;
  esac
  return 1
}

# _stt_store PROVIDER KEY [MODEL] -> 0 when the key was accepted and saved (STT_ERR otherwise)
_stt_store() {
  stt_validate_key "$1" "$2" || return 1
  [ -z "$STT_NOTE" ] || warn "$STT_NOTE"
  set_env STT_PROVIDER "$1"; set_env STT_API_KEY "$2"
  if [ -n "${3:-}" ]; then set_env STT_MODEL "$3"; else unset_env STT_MODEL; fi
  stt_set_choice "$1"
  stt_sync_env
}

# _stt_store_bedrock MODEL — Bedrock needs no key; a key left from openai/groq is removed from .env. (On again: no notice.)
_stt_store_bedrock() {
  set_env STT_PROVIDER bedrock; unset_env STT_API_KEY
  if [ "$1" = voxtral-small ]; then unset_env STT_MODEL; else set_env STT_MODEL "$1"; fi
  stt_sync_env
  stt_notice_clear
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
  log "STT_PROVIDER/STT_API_KEY in your environment are ignored (speech-to-text keys are opt-in: ./stack stt set uses them, or BEDROCK_NOW_STT_FROM_ENV=1)"
  return 1
}

_stt_short_price() { stt_price_label "$@" | sed 's/ (.*//'; }

_stt_ask_choice() { # -> bedrock|openai|groq|browser|unknown
  log "Voice: the microphone and the Call button in Chat need speech-to-text. Choose one:"
  log "  1) Bedrock — Mistral Voxtral in your AWS account (recommended: no extra key, audio stays in AWS; $(_stt_short_price bedrock voxtral-small))"
  log "  2) OpenAI  — needs an OpenAI API key; your speech goes to api.openai.com ($(_stt_short_price openai gpt-4o-mini-transcribe))"
  log "  3) Groq    — needs a Groq API key; your speech goes to api.groq.com ($(_stt_short_price groq whisper-large-v3-turbo))"
  log "  4) Browser only — the browser's own speech recognition; Call stays unavailable"
  case "$(ask "Speech-to-text (1-4)" "1")" in
    1 | bedrock | Bedrock) echo bedrock ;; 2 | openai | OpenAI) echo openai ;; 3 | groq | Groq) echo groq ;;
    4 | browser | none) echo browser ;; *) echo unknown ;;
  esac
}

# setup_stt — setup step, before the model check. Settings already in .env are kept. Otherwise: STT_PROVIDER=bedrock
# from the shell is taken as the choice when none is recorded (no key, nothing leaves AWS); an install that answered
# the older question is offered Bedrock once (interactive only); STT_PROVIDER + STT_API_KEY for openai/groq
# are adopted only after asking (or with BEDROCK_NOW_STT_FROM_ENV=1 when non-interactive); and an interactive setup
# asks once: Bedrock (default), OpenAI, Groq (key, hidden) or browser only. Bedrock itself is switched on after the
# model check (stt_after_probe). Never fatal: a rejected key means browser speech, with a warning.
setup_stt() {
  local p='' key='' model='' marker="$STATE_DIR/stt-asked" choice=''
  if [ -z "$(stt_provider)$(get_env STT_API_KEY)" ]; then
    choice="$(stt_choice)"
    if [ "${STT_PROVIDER:-}" = bedrock ] && [ -z "$choice" ]; then   # a recorded choice wins over the shell
      stt_set_choice bedrock
      if [ -n "${STT_MODEL:-}" ] && model="$(stt_bedrock_model_arg "$STT_MODEL")"; then set_env STT_MODEL "$model"; fi
      model=''
      log "STT_PROVIDER=bedrock in your environment: Bedrock speech-to-text is turned on after the model check"
    elif [ -n "${STT_PROVIDER:-}" ] && [ -n "${STT_API_KEY:-}" ]; then
      if valid_stt_provider "$STT_PROVIDER"; then
        if _stt_env_wanted "$STT_PROVIDER"; then p="$STT_PROVIDER"; key="$STT_API_KEY"; model="${STT_MODEL:-}"; fi
      else warn "STT_PROVIDER=$STT_PROVIDER in your environment is not bedrock, openai or groq — ignored"; fi
    elif [ "$choice" = legacy ] && [ "${ASSUME_YES:-0}" != 1 ] && _have_tty; then
      # Answered the older question (OpenAI/Groq/none, before Bedrock speech-to-text existed): offered once.
      log "Voice: speech-to-text can now run on Bedrock (Mistral Voxtral): no extra key, your audio stays in your AWS account ($(_stt_short_price bedrock voxtral-small))."
      if confirm "Turn on Bedrock speech-to-text for the microphone and voice calls?"; then
        stt_set_choice bedrock; log "Bedrock speech-to-text: turned on after the model check, if your AWS key can use Mistral Voxtral"
      else
        stt_set_choice browser; log "kept browser speech (./stack stt set bedrock turns it on later)"
      fi
    elif [ -z "$choice" ] && [ "${ASSUME_YES:-0}" != 1 ] && _have_tty; then
      choice="$(_stt_ask_choice)"
      case "$choice" in
        bedrock) stt_set_choice bedrock; log "Bedrock speech-to-text: turned on after the model check, if your AWS key can use Mistral Voxtral" ;;
        openai | groq) p="$choice"; key="$(ask_secret "$(stt_provider_label "$p") API key (hidden; Enter to skip)")"
          [ -n "$key" ] || { p=''; stt_set_choice browser; log "no key — the microphone uses your browser (./stack stt set bedrock|openai|groq later)"; } ;;
        browser) stt_set_choice browser; log "browser speech only — Call stays unavailable (./stack stt set bedrock turns voice on later)" ;;
        *) stt_set_choice browser; warn "unknown answer — browser speech for now (./stack stt set bedrock|openai|groq later)" ;;
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

_stt_unusable_warning() {
  warn "Voice: Bedrock speech-to-text is off — Mistral Voxtral is not usable with your AWS key ($(stt_model_reason "$1")); the microphone uses your browser. ./stack models --recheck after your AWS admin enables it, or ./stack stt set openai|groq"
}

# stt_after_probe — setup step after the model check (it knows which Voxtral models your AWS key can use):
#  - Bedrock chosen but its model is not usable: the other Voxtral model if it is, else off with one warning
#    (the choice is kept, so a later setup turns it on once your AWS admin enables the model);
#  - nothing configured and no choice ever made: on, with one line, if the check's real request succeeded
#    (reason "ok"); Bedrock chosen (setup question, STT_PROVIDER=bedrock): on if the model is enabled.
stt_after_probe() {
  local p m alt choice
  p="$(stt_provider)"; choice="$(stt_choice)"
  if [ "$p" = bedrock ]; then
    m="$(stt_model 2>/dev/null)"
    if ! stt_model_ready "$m"; then
      alt=voxtral-small; [ "$m" != voxtral-small ] || alt=voxtral-mini
      if stt_model_ready "$alt"; then
        _stt_store_bedrock "$alt" 2>/dev/null
        if stt_model_refused "$m"; then log "Voice: Bedrock no longer accepts audio for $(stt_model_label "$m") — using $(stt_model_label "$alt")"
        else log "speech-to-text: $(stt_model_label "$m") is not usable with your AWS key — using $(stt_model_label "$alt")"; fi
      elif stt_model_refused "$m"; then
        stt_turn_off_refused   # (once: the notice; the choice stays, so audio taken again turns it back on)
      else
        unset_env STT_PROVIDER; unset_env STT_MODEL
        _stt_unusable_warning "$m"
      fi
    fi
  elif [ -z "$p$(get_env STT_API_KEY)" ]; then
    case "$choice" in
      '' | bedrock)
        if [ -e "$STATE_DIR/stt-start-failed" ]; then
          log "Voice: trying Bedrock speech-to-text again (its container did not start last time)"; rm -f "$STATE_DIR/stt-start-failed"
        fi
        for m in voxtral-small voxtral-mini; do
          if [ "$choice" = bedrock ]; then stt_model_ready "$m" || continue; else stt_model_ok "$m" || continue; fi
          _stt_store_bedrock "$m"
          log "Voice: Bedrock speech-to-text on ($(stt_model_label "$m"), $(_stt_short_price bedrock "$m")) — ./stack stt remove to use browser speech"
          break
        done
        if [ "$(stt_provider)" != bedrock ]; then
          if stt_model_refused voxtral-small || stt_model_refused voxtral-mini; then
            # chosen, or the default it would have been: said once on Home and in ./stack status too
            stt_notice_record
            warn "Voice: Bedrock speech-to-text is unavailable: $STT_AUDIO_GONE. Voice uses your browser's speech recognition; or use your own OpenAI/Groq key: ./stack stt set openai|groq."
          elif [ "$choice" = bedrock ]; then _stt_unusable_warning voxtral-small
          else log "Voice: Mistral Voxtral is not usable with your AWS key, so the microphone uses your browser (./stack stt status)"; fi
        fi ;;
    esac
  fi
  stt_sync_env
}

# stt_services -> the compose services speech-to-text adds to the stack's own ("stt" while Bedrock is chosen)
stt_services() { [ "$(stt_provider)" != bedrock ] || echo stt; }

# The stt image installs ffmpeg from its Alpine release's repository. Docker's build cache would keep that layer
# forever, so the build passes the ISO week as APK_REFRESH (stt/Dockerfile): the ffmpeg layer is reinstalled once
# a week at most (setup, ./stack update), with Alpine's latest ffmpeg security fixes. The week of the last good
# build is kept in .state/stt-apk-week: when a new week's build fails (offline, repository down), the previous
# week's value is used again — Docker's cached layer, no network — and a warning says so.
stt_apk_week() { date -u +%G-%V; }

_stt_build() {
  local week prev; week="$(stt_apk_week)"; prev="$(cat "$STATE_DIR/stt-apk-week" 2>/dev/null || true)"
  case "$prev" in *[!0-9-]* | '') prev='' ;; esac
  if building "the speech-to-text image" dc build -q --build-arg "APK_REFRESH=$week" stt; then
    mkdir -p "$STATE_DIR"; printf '%s\n' "$week" > "$STATE_DIR/stt-apk-week"; return 0
  fi
  [ -n "$prev" ] && [ "$prev" != "$week" ] || return 1
  warn "could not refresh ffmpeg in the stt image (offline?) — building it with last refresh's packages ($prev)"
  building "the speech-to-text image" dc build -q --build-arg "APK_REFRESH=$prev" stt
}

_stt_build_profiled() { _STT_PROFILE=1 _stt_build; }   # before .env says bedrock (./stack stt set bedrock)

# .state/stt-service: a stt container may exist (written before it is started), so turning Bedrock off removes it.
_stt_build_and_up() { mkdir -p "$STATE_DIR"; : > "$STATE_DIR/stt-service"; _stt_build && dc up -d --no-deps --wait stt; }

# stt_service_up — Bedrock on: build (new code after an update) and start the stt container. Off: stt_service_down.
# For ./stack stt set (an explicit command): a failure stops it.
stt_service_up() {
  if [ "$(stt_provider)" = bedrock ]; then run_phase "Speech-to-text (Bedrock Voxtral)" stt _stt_build_and_up
  else stt_service_down; fi
}

# stt_setup_service — setup / ./stack models --recheck: like stt_service_up, but a stt container that does not
# build or start never stops setup or keeps Open WebUI down: speech-to-text falls back to the browser (Open WebUI
# is started after this with the engine back on "web"), with one warning; the next setup tries again.
stt_setup_service() {
  local out start
  if [ "$(stt_provider)" != bedrock ]; then stt_service_down; return 0; fi
  out="$(mktemp)"; start="$(_now)"
  if _stt_build_and_up > "$out" 2>&1; then
    rm -f "$out" "$STATE_DIR/stt-start-failed"
    log "$(phase_line "Speech-to-text (Bedrock Voxtral)" $(($(_now) - start)))"
    return 0
  fi
  warn "Voice: the speech-to-text container did not start. Its last messages:"
  { tail -n 15 "$out"; dc logs --no-color --tail 15 stt 2>&1 || true; } | sed 's/^/    /' >&2
  rm -f "$out"
  _stt_fall_back_to_browser
  warn "Voice: the microphone uses your browser for now — setup goes on; the next ./stack setup tries Bedrock speech-to-text again (or ./stack stt set bedrock)"
}

# _stt_fall_back_to_browser — Bedrock speech-to-text off after a failure (container, ./stack test): .env back to
# browser speech, the container removed, and a mark so that the next setup says it tries again.
_stt_fall_back_to_browser() {
  unset_env STT_PROVIDER; unset_env STT_MODEL
  stt_sync_env
  mkdir -p "$STATE_DIR"; : > "$STATE_DIR/stt-start-failed"
  stt_service_down
}

# stt_service_down — removes the stt container left from Bedrock speech-to-text (its profile is off by then, so
# it is named with the profile on). Only when one was started (.state/stt-service); never fatal.
stt_service_down() {
  [ -e "$STATE_DIR/stt-service" ] || return 0
  if [ -z "$(_STT_PROFILE=1 dc ps -aq stt 2>/dev/null)" ] || _STT_PROFILE=1 dc rm -sf stt >/dev/null 2>&1; then
    rm -f "$STATE_DIR/stt-service"
  else
    warn "could not remove the stt container — ./stack down removes it"
  fi
}

# stt_before_up — ./stack up, before compose starts the services (stt included while Bedrock is chosen)
stt_before_up() {
  if [ "$(stt_provider)" = bedrock ]; then mkdir -p "$STATE_DIR"; : > "$STATE_DIR/stt-service"; else stt_service_down; fi
}

# stt_rollback_cleanup — ./stack rollback, right after it checked out a version from before Bedrock speech-to-text
# (no stt/ in it): that version's compose file has no stt service, so the container is removed by its Compose
# labels, and the settings only this version understands leave .env (Open WebUI is recreated by the rollback's
# restore with the browser engine). The recorded choice stays: ./stack update turns it back on.
stt_rollback_cleanup() {
  local p ids
  p="$(project_name)"
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$p" --filter "label=com.docker.compose.service=stt" 2>/dev/null || true)"
  # shellcheck disable=SC2086  # one id per word
  [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || warn "could not remove the stt container — remove it with: docker rm -f $p-stt-1"
  rm -f "$STATE_DIR/stt-service" "$STATE_DIR/stt-start-failed"
  if [ "$(stt_provider)" = bedrock ]; then
    unset_env STT_PROVIDER; unset_env STT_MODEL; unset_env OWUI_STT_ENGINE
    log "speech-to-text: the version you rolled back to has no Bedrock speech-to-text — the microphone uses your browser (./stack update brings it back)"
  fi
  unset_env OWUI_STT_BASE_URL; unset_env STT_BEDROCK_MODEL
}

# stt_rollback_network_cleanup — after that rollback's ./stack up (its containers left the network): the stt
# network this version created. Never fatal.
stt_rollback_network_cleanup() { docker network rm "$(project_name)_stt" >/dev/null 2>&1 || true; }

# stt_sync_owui — the "stt" model (openai/groq) must not show up as a chat model: a hidden Open WebUI entry (like
# the embedding models), with the provider and price as its description. Otherwise (off, or Bedrock, whose Voxtral
# entries the catalog sync already hides) the entry we created (.state/stt-owui-entry) is deleted. Needs a portal
# session. Never fatal.
stt_sync_owui() {
  local OWUI_ERR='' tmp code entry="$STATE_DIR/stt-owui-entry"
  [ -n "$(get_env OPENWEBUI_API_KEY)" ] || return 0
  if ! stt_enabled || ! stt_needs_key "$(stt_provider)"; then
    [ -e "$entry" ] || { rm -f "$STATE_DIR/stt-owui-pending"; return 0; }
    tmp="$(mktemp)"; code="$(_owui_post /api/v1/models/model/delete '{"id":"stt"}' "$tmp")"; rm -f "$tmp"
    case "$code" in
      200 | 404) rm -f "$entry" "$STATE_DIR/stt-owui-pending" ;;
      *) warn "Open WebUI: could not remove the speech-to-text model entry (HTTP $code) — ./stack up retries"
         mkdir -p "$STATE_DIR"; : > "$STATE_DIR/stt-owui-pending" ;;
    esac
    return 0
  fi
  if owui_upsert_model stt "Speech to text" "Speech to text" "$(stt_describe) · voice input and calls" '[{"name":"Speech to text"}]' true
  then mkdir -p "$STATE_DIR"; : > "$entry"; rm -f "$STATE_DIR/stt-owui-pending"
  else warn "Open WebUI: could not hide the speech-to-text model ($OWUI_ERR) — it may show in the model picker; ./stack stt set retries"; fi
}

# stt_after_up — ./stack up, inside its portal session: the sync ./stack stt could not do while the stack was stopped
stt_after_up() { [ ! -e "$STATE_DIR/stt-owui-pending" ] || stt_sync_owui || true; }

# stt_up_hook — ./stack up, before compose: STT_* edited by hand in .env take effect. Keeps the derived settings in
# step and, when the rendered LiteLLM config does not match (stt entry missing, stale or left over), re-renders
# it and returns 0 (the caller then recreates a running LiteLLM); 1 = nothing changed.
stt_up_hook() {
  local cfg="$STACK_DIR/litellm/config.yaml" cur want
  [ -f "$cfg" ] || return 1
  stt_sync_env
  cur="$(cat "$cfg")"
  want="$(stt_yaml)"
  if [ -n "$want" ]; then
    case "$cur" in *"$want"*) return 1 ;; esac
  else
    case "$cur" in *'model_name: "stt"'*) ;; *) return 1 ;; esac
  fi
  render_config "$(_enabled_or_all)"
  mkdir -p "$STATE_DIR"; : > "$STATE_DIR/stt-owui-pending"
  log "speech-to-text settings in .env changed — LiteLLM config updated"
  return 0
}

# _stt_apply — after set/remove: re-render, recreate LiteLLM (new model, new STT_API_KEY), start or remove the stt
# container, recreate Open WebUI (new engine), hide the model and restore the budget banner (Open WebUI keeps it in
# memory only).
_stt_apply() {
  if [ -z "$(get_env LITELLM_MASTER_KEY)" ] || [ ! -f "$STACK_DIR/litellm/config.yaml" ]; then
    log "saved — ./stack setup applies it"; return 0
  fi
  local cfg="$STACK_DIR/litellm/config.yaml" before
  before="$(cat "$cfg")"
  render_config "$(_enabled_or_all)"
  if [ -z "$(dc ps -q litellm 2>/dev/null)" ]; then
    mkdir -p "$STATE_DIR"; : > "$STATE_DIR/stt-owui-pending"   # hide (or remove) the Open WebUI entry at ./stack up
    [ "$(stt_provider)" = bedrock ] || stt_service_down
    log "saved — the stack is stopped; ./stack up applies it"; return 0
  fi
  # A changed config needs a new container (compose does not see a mounted file change); otherwise compose recreates
  # it only if its environment changed (a new STT_API_KEY). Bedrock Small <-> Mini changes neither.
  if [ "$(cat "$cfg")" != "$before" ]; then run_phase "LiteLLM" litellm dc up -d --no-deps --force-recreate --wait litellm
  else run_phase "LiteLLM" litellm dc up -d --no-deps --wait litellm; fi
  if ! (stt_service_up); then
    [ -n "${STT_PREVIOUS:-}" ] || die "the stt container did not start — see above"
    _stt_restore_previous
    die "the stt container did not start (see above) — your previous speech-to-text setting is back: $(if stt_enabled; then stt_describe; else echo 'browser speech'; fi)"
  fi
  run_phase "Open WebUI" open-webui dc up -d --no-deps --wait open-webui
  _stt_refresh_portal
  portal_session_or_die
  stt_sync_owui
  sync_budget_banner
  portal_session_end
}

# _stt_restore_previous — ./stack stt set bedrock whose container did not start: .env and the recorded choice as
# they were before (STT_PREVIOUS = provider|key|model|choice), applied again; the stt container removed.
_stt_restore_previous() {
  local p k m c cfg="$STACK_DIR/litellm/config.yaml" before
  IFS='|' read -r p k m c <<< "$STT_PREVIOUS"
  if [ -n "$p" ]; then set_env STT_PROVIDER "$p"; else unset_env STT_PROVIDER; fi
  if [ -n "$k" ]; then set_env STT_API_KEY "$k"; else unset_env STT_API_KEY; fi
  if [ -n "$m" ]; then set_env STT_MODEL "$m"; else unset_env STT_MODEL; fi
  case "$c" in bedrock | openai | groq | browser) stt_set_choice "$c" ;; *) rm -f "$STATE_DIR/stt-choice" ;; esac
  stt_sync_env
  _STT_PROFILE=1 dc rm -sf stt >/dev/null 2>&1 || true
  rm -f "$STATE_DIR/stt-service"
  before="$(cat "$cfg")"; render_config "$(_enabled_or_all)"
  if [ "$(cat "$cfg")" != "$before" ]; then dc up -d --no-deps --force-recreate --wait litellm >/dev/null 2>&1 || true
  else dc up -d --no-deps --wait litellm >/dev/null 2>&1 || true; fi
  dc up -d --no-deps --wait open-webui >/dev/null 2>&1 || warn "could not restart Open WebUI — ./stack up applies the previous setting"
  _stt_refresh_portal
}

# _stt_refresh_portal — Home reads which speech-to-text is on from its environment (STT_ENGINE, STT_PROVIDER,
# STT_MODEL, STT_BEDROCK_MODEL) at start: compose recreates the portal only when those changed. Never fatal.
_stt_refresh_portal() { ensure_portal_password_hash; dc up -d --no-deps --wait portal >/dev/null 2>&1 || warn "could not restart the portal — Home shows the new voice setting after ./stack up"; }

_stt_on_message() {
  local p; p="$(stt_provider)"
  log "speech-to-text on: $(stt_describe)"
  if [ "$p" = bedrock ]; then
    log "your speech (microphone and Call) stays in your AWS account: the stt container sends it to Bedrock through LiteLLM; spend counts on the open-webui key"
  else
    log "your speech (microphone and Call) now goes to $(stt_host "$p"); spend counts on the open-webui key"
  fi
}

cmd_stt() {
  local p m key url running STT_PREVIOUS=''   # STT_PREVIOUS: what _stt_apply restores if set bedrock's container fails
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  case "${1:-status}" in
    set)
      # An explicit command: here STT_PROVIDER / STT_API_KEY / STT_MODEL from the environment are the documented
      # non-interactive input.
      stack_lock stt   # lib/lock.sh: not while an update/setup/restore changes the stack
      p="${2:-${STT_PROVIDER:-}}"; m="${3:-${STT_MODEL:-}}"
      [ -n "$p" ] || { _have_tty && [ "${ASSUME_YES:-0}" != 1 ] && p="$(ask "Speech-to-text provider (bedrock/openai/groq)" "bedrock")"; } || true
      valid_stt_provider "$p" || die "usage: ./stack stt set bedrock [small|mini] | openai|groq [model] — the provider must be bedrock, openai or groq"
      if [ "$p" = bedrock ]; then
        if [ -z "$m" ]; then m=voxtral-small
        else m="$(stt_bedrock_model_arg "$m")" || die "'${3:-${STT_MODEL:-}}' is not a Bedrock speech-to-text model: small (voxtral-small) or mini (voxtral-mini)"; fi
        running=''; [ -z "$(get_env LITELLM_MASTER_KEY)" ] || [ -z "$(dc ps -q litellm 2>/dev/null)" ] || running=1
        # Bedrock refusing audio: the check decides (half a second of audio, while LiteLLM runs; else what the last
        # check found) — refused, nothing changes; audio taken again clears what an earlier check recorded.
        if [ -n "$running" ] && { stt_model_ready "$m" || stt_model_refused "$m"; }; then
          stt_audio_check "$m"
          case "$STT_AUDIO" in
            refused) _stt_mark_audio "$m" refused ;;
            ok) _stt_mark_audio "$m" ok ;;
          esac
        fi
        ! stt_model_refused "$m" || die "$STT_REFUSED_ERR Nothing changed."
        stt_model_ready "$m" ||
          die "$(stt_model_label "$m") is not usable with your AWS key ($(stt_model_reason "$m")) — nothing changed; ./stack models --recheck after your AWS admin enables it"
        # Build first, while nothing has changed: a failed build leaves the current speech-to-text as it is.
        if [ -n "$running" ]; then
          (run_phase "Speech-to-text image" stt _stt_build_profiled) || die "could not build the stt container — nothing changed (./stack stt status)"
        fi
        STT_PREVIOUS="$(get_env STT_PROVIDER)|$(get_env STT_API_KEY)|$(get_env STT_MODEL)|$(stt_choice)"
        _stt_store_bedrock "$m"
        stt_set_choice bedrock
        _stt_on_message
        _stt_apply
        return 0
      fi
      [ -z "$m" ] || stt_row "$p" "$m" >/dev/null || die "'$m' is not a $(stt_provider_label "$p") speech-to-text model: $(stt_models_of "$p")"
      key="${STT_API_KEY:-}"
      [ -z "$key" ] || log "using STT_API_KEY from your environment"
      [ -n "$key" ] || { _have_tty && [ "${ASSUME_YES:-0}" != 1 ] && key="$(ask_secret "$(stt_provider_label "$p") API key (hidden)")"; } ||
        die "no key: export STT_API_KEY or run this in a terminal"
      [ -n "$key" ] || die "no key entered — nothing changed"
      _stt_store "$p" "$key" "$m" || die "$STT_ERR — nothing changed"
      _stt_on_message
      _stt_apply ;;
    remove)
      stack_lock stt
      stt_set_choice browser   # an explicit choice: setup never turns Bedrock speech-to-text back on by itself
      [ -n "$(stt_provider)$(get_env STT_API_KEY)$(get_env STT_MODEL)" ] || { log "speech-to-text is not set — the microphone keeps using your browser (remembered for later setups)"; return 0; }
      p="$(stt_provider)"; url="$(stt_keys_url "$p")"
      unset_env STT_PROVIDER; unset_env STT_API_KEY; unset_env STT_MODEL
      stt_sync_env
      log "speech-to-text removed — the microphone uses your browser again and Call is unavailable${url:+ (revoke the key at $url if you no longer need it)}"
      _stt_apply ;;
    status)
      stt_key_problem
      if ! stt_enabled; then
        if stt_notice_on; then
          printf 'Speech-to-text: browser (Web Speech) — voice calls are unavailable.\n  %s\n' "$STT_REFUSED_NOTICE"
        elif stt_bedrock_refused; then
          printf 'Speech-to-text: browser (Web Speech) — voice calls are unavailable. ./stack stt set openai|groq turns them on with your own key (Bedrock: %s; docs/voice.md).\n' "$STT_AUDIO_GONE"
        else
          printf 'Speech-to-text: browser (Web Speech) — voice calls are unavailable. ./stack stt set bedrock turns them on (no key; or openai|groq; see docs/voice.md).\n'
        fi
        return 0
      fi
      printf 'Speech-to-text: on — %s\n' "$(stt_describe)"
      if [ "$(stt_provider)" = bedrock ]; then
        printf '  your speech (microphone and Call) stays in your AWS account (Bedrock%s); spend counts on the open-webui key (./stack costs)\n' \
          "$(r="$(get_env AWS_REGION_NAME)"; [ -z "$r" ] || printf ', %s' "$r")"
        printf '  the price is an estimate for continuous speech: Bedrock bills Voxtral per token (~%s audio tokens per minute);\n' "$STT_EST_IN_TOKENS_PER_MIN"
        printf '  each short utterance in a call pays a 30-second block: ~$%s each (docs/voice.md › Prices)\n' "$(stt_bedrock_per_utterance "$(stt_model)")"
      else
        printf '  your speech (microphone and Call) goes to %s; spend counts on the open-webui key (./stack costs)\n' "$(stt_host "$(stt_provider)")"
      fi
      printf '  answers in Call are read aloud by your browser'"'"'s voices (no server text-to-speech)\n' ;;
    *) die "usage: ./stack stt [status|set bedrock [small|mini]|set openai|groq [model]|remove]" ;;
  esac
}

# The 1-second-tone check, run inside the open-webui container (it has Python) against the very URL Open WebUI
# uses: Caddy's internal site -> stt -> LiteLLM -> Bedrock. The key arrives on stdin, never on a command line.
# Prints the HTTP status (and the error message when it is not 200).
STT_TEST_PY='import io, json, math, struct, sys, urllib.error, urllib.request, wave
key = sys.stdin.readline().strip()
buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b"".join(struct.pack("<h", int(6000 * math.sin(i * 0.12))) for i in range(16000)))
b = "stacktest"
body = (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"t.wav\"\r\nContent-Type: audio/wav\r\n\r\n").encode() + buf.getvalue() + f"\r\n--{b}--\r\n".encode()
req = urllib.request.Request("http://caddy:8090/v1/audio/transcriptions", data=body,
                             headers={"Authorization": "Bearer " + key, "Content-Type": "multipart/form-data; boundary=" + b})
try:
    print(urllib.request.urlopen(req, timeout=120).status)
except urllib.error.HTTPError as e:
    print(e.code, (json.load(e).get("error") or {}).get("message", "")[:160])
except Exception as e:
    print("000", type(e).__name__)'

# stt_test_checks — ./stack test while Bedrock speech-to-text is on: the container answers /healthz, and a 1-second
# tone goes the way Open WebUI's recordings go (open-webui -> Caddy :8090 -> stt -> LiteLLM -> Bedrock Voxtral)
# with the setup key (~$0.00005). Uses the caller's _check/_skip and its fails counter.
stt_test_checks() {
  local health hop tone='' sk label choice ok=1
  [ "$(stt_provider)" = bedrock ] && stt_enabled || return 0
  label="speech-to-text, 1 s tone through Caddy (Bedrock $(stt_model_label "$(stt_model)"))"
  health="$(dc exec -T stt python -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8000/healthz", timeout=10).status)' 2>/dev/null || true)"
  # Open WebUI's own way in (Caddy's internal :8090 site), free
  hop="$(dc exec -T open-webui python3 -c 'import urllib.request; print(urllib.request.urlopen("http://caddy:8090/healthz", timeout=10).status)' 2>/dev/null || true)"
  sk="$(get_env LITELLM_KEY_SETUP)"
  if [ "$health" = 200 ] && [ "$hop" = 200 ] && [ -n "$sk" ]; then
    tone="$(printf '%s\n' "$sk" | dc exec -T open-webui python3 -c "$STT_TEST_PY" 2>/dev/null || true)"
  fi
  if [ -n "$tone" ] && [ "$tone" != 200 ] && stt_refusal_in "$tone"; then
    # Bedrock refusing audio: off, said once (whatever was chosen: nothing else would work), not a failure
    _check "speech-to-text health (stt container)" 200 200; _check "speech-to-text reachable from Open WebUI (Caddy :8090)" 200 200
    _stt_mark_audio "$(stt_model)" refused
    stt_turn_off_refused
    dc up -d --no-deps --wait open-webui >/dev/null 2>&1 || warn "could not restart Open WebUI — ./stack up applies browser speech"
    _stt_refresh_portal
    _skip "$label" "$STT_AUDIO_GONE — turned off, see above"
    return 0
  fi
  case "$health:$hop:$tone" in 200:200:429*)
    _check "speech-to-text health (stt container)" 200 200; _check "speech-to-text reachable from Open WebUI (Caddy :8090)" 200 200
    _skip "$label" "Bedrock is throttling right now — not checked"; return 0 ;; esac
  [ "$health" = 200 ] && [ "$hop" = 200 ] || ok=0
  [ -z "$sk" ] || [ "$tone" = 200 ] || ok=0
  choice="$(stt_choice)"
  if [ "$ok" = 0 ] && { [ -z "$choice" ] || [ "$choice" = legacy ]; }; then
    # On by default, not chosen: a broken voice path must not fail setup or an update. Back to browser speech.
    warn "Voice: the speech-to-text check failed (${tone:-health: ${health:-no answer}, through Caddy: ${hop:-no answer}}) — it was on by default, so the microphone goes back to browser speech; the next ./stack setup tries again (./stack stt set bedrock turns it on now)"
    _stt_fall_back_to_browser
    dc up -d --no-deps --wait open-webui >/dev/null 2>&1 || warn "could not restart Open WebUI — ./stack up applies browser speech"
    _stt_refresh_portal
    _skip "speech-to-text (Bedrock Voxtral)" "turned off, see the warning above"
    return 0
  fi
  _check "speech-to-text health (stt container)" "$health" 200
  _check "speech-to-text reachable from Open WebUI (Caddy :8090)" "$hop" 200
  if [ -z "$sk" ]; then _skip "speech-to-text (Bedrock Voxtral)" "no setup key — run ./stack setup"; return 0; fi
  [ "$health" = 200 ] && [ "$hop" = 200 ] || return 0
  _check "$label" "$tone" 200
}

# stt_costs_section — ./stack costs: one line either way
stt_costs_section() {
  stt_key_problem
  if ! stt_enabled; then
    if stt_bedrock_refused; then printf '\nSpeech-to-text: browser (Web Speech), no cost — ./stack stt set openai|groq enables voice calls (Bedrock: %s)\n' "$STT_AUDIO_GONE"
    else printf '\nSpeech-to-text: browser (Web Speech), no cost — ./stack stt set bedrock enables voice calls\n'; fi
    return 0
  fi
  printf '\nSpeech-to-text: %s\n' "$(stt_describe)"
  if [ "$(stt_provider)" = bedrock ]; then
    printf '  audio stays in your AWS account; its spend is in the open-webui key above (LiteLLM prices each request by its tokens)\n'
  else
    printf '  audio goes to %s; its spend is in the open-webui key above (LiteLLM prices it per request)\n' "$(stt_host "$(stt_provider)")"
  fi
}

# stt_summary_line — print_summary: one line when speech-to-text is on
stt_summary_line() {
  stt_enabled || return 0
  printf '  Voice calls     %s   (./stack stt status)\n' "$(stt_describe)"
}
