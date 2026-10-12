# shellcheck shell=bash
# shellcheck disable=SC2016  # expected output holds literal $ prices
# Optional server speech-to-text (lib/stt.sh): Open WebUI's voice Call needs it. Off by default; on, a "stt"
# model in LiteLLM sends audio to OpenAI or Groq with the key from .env, and Open WebUI uses LiteLLM for STT.
. "$STACK_DIR/lib/commands.sh"   # also sources lib/stt.sh
. "$STACK_DIR/lib/owui.sh"

OKEY='sk-proj-abcdefghijklmnopqrstuvwxyz0123'
GKEY='gsk_abcdefghijklmnopqrstuvwxyz0123'

# curl_auth stub: logs "TOKEN URL ARGS"; answers $CODE (default 200), writes $BODY to -o.
_stub_curl_auth() {
  curl_auth() {
    local tok="$1" a prev='' out='' url=''; shift
    for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; case "$a" in http*) url="$a" ;; esac; done
    echo "$tok $url $*" >> "$TMP/calls"
    [ -z "$out" ] || [ "$out" = /dev/null ] || printf '%s' "${BODY:-}" > "$out"
    printf '%s' "${CODE:-200}"
  }
  curl() { echo "PLAIN curl $*" >> "$TMP/calls"; return 22; }
}

_cat() { printf 'big\tchat\tbedrock/x.big\t-\t-\n' > "$TMP/cat.tsv"; }
_render() { CATALOG="$TMP/cat.tsv" PRICES="$STACK_DIR/none.tsv" render_litellm_config "" us-east-1 false; }

# --- what is on and what it renders ---

test_off_by_default_renders_nothing() {
  _cat; : > "$ENV_FILE"
  if stt_enabled; then return 1; fi
  out="$(_render)"
  assert_not_contains "$out" "stt"
  assert_not_contains "$out" "STT_API_KEY"
}

test_render_openai_default_model() {
  _cat; printf 'STT_PROVIDER=openai\nSTT_API_KEY=%s\n' "$OKEY" > "$ENV_FILE"
  stt_enabled
  out="$(_render)"
  assert_contains "$out" '  - model_name: "stt"
    litellm_params:
      model: "openai/gpt-4o-mini-transcribe"
      api_key: os.environ/STT_API_KEY
    model_info:
      mode: "audio_transcription"'
  # gpt-4o-*-transcribe is billed by tokens (OpenAI reports them): no verbose_json needed
  assert_not_contains "$out" "verbose_json"
  assert_not_contains "$out" "cost_per_second"
  # inside model_list, before router_settings
  assert_eq "$(printf '%s\n' "$out" | awk '/^router_settings:/ { r = NR } /model_name: "stt"/ { s = NR } END { print (s > 0 && s < r) }')" 1
  if command -v python3 >/dev/null && python3 -c 'import yaml' 2>/dev/null; then
    assert_eq "$(printf '%s\n' "$out" | python3 -c 'import sys, yaml; d = yaml.safe_load(sys.stdin); m = {e["model_name"]: e for e in d["model_list"]}; print(m["stt"]["litellm_params"]["model"], m["stt"]["model_info"]["mode"])')" \
      "openai/gpt-4o-mini-transcribe audio_transcription"
  fi
}

test_render_groq_and_per_second_models_ask_for_duration() {
  _cat; printf 'STT_PROVIDER=groq\nSTT_API_KEY=%s\n' "$GKEY" > "$ENV_FILE"
  out="$(_render)"
  assert_contains "$out" 'model: "groq/whisper-large-v3-turbo"'
  # billed per second: verbose_json makes the provider report the duration LiteLLM prices
  assert_contains "$out" '      response_format: "verbose_json"'
  # ...and carries its per-second price (LiteLLM 1.105 logs Groq transcriptions as $0 without it)
  assert_contains "$out" '    model_info:
      mode: "audio_transcription"
      input_cost_per_second: 0.00001111'
  printf 'STT_PROVIDER=openai\nSTT_API_KEY=%s\nSTT_MODEL=whisper-1\n' "$OKEY" > "$ENV_FILE"
  out="$(_render)"
  assert_contains "$out" 'model: "openai/whisper-1"'
  assert_contains "$out" 'response_format: "verbose_json"'
}

test_model_choice_and_fallback() {
  printf 'STT_PROVIDER=openai\nSTT_API_KEY=%s\nSTT_MODEL=gpt-4o-transcribe\n' "$OKEY" > "$ENV_FILE"
  assert_eq "$(stt_model)" gpt-4o-transcribe
  # a model of the other provider (or junk) falls back to the provider default, with a warning
  printf 'STT_PROVIDER=openai\nSTT_API_KEY=%s\nSTT_MODEL=whisper-large-v3-turbo\n' "$OKEY" > "$ENV_FILE"
  assert_eq "$(stt_model 2>/dev/null)" gpt-4o-mini-transcribe
  assert_contains "$(stt_key_problem 2>&1)" "STT_MODEL"
  printf 'STT_PROVIDER=groq\nSTT_API_KEY=%s\n' "$GKEY" > "$ENV_FILE"
  assert_eq "$(stt_model)" whisper-large-v3-turbo
}

test_invalid_settings_are_off_and_warned() {
  _cat
  for bad in 'STT_PROVIDER=azure\nSTT_API_KEY=%s\n' 'STT_PROVIDER=openai\nSTT_API_KEY=sk-short\n%s' \
             'STT_PROVIDER=openai\nSTT_API_KEY=sk-bad.key.with.dots.0123456789\n%s' 'STT_PROVIDER=\nSTT_API_KEY=%s\n'; do
    # shellcheck disable=SC2059  # the cases above are formats
    printf "$bad" "$OKEY" > "$ENV_FILE"
    if stt_enabled; then echo "enabled with: $bad" >&2; return 1; fi
    assert_not_contains "$(_render)" 'model_name: "stt"'
  done
  printf 'STT_PROVIDER=openai\nSTT_API_KEY=sk-bad.key.with.dots.0123456789\n' > "$ENV_FILE"
  assert_contains "$(stt_key_problem 2>&1)" "not a valid key"
  printf 'STT_PROVIDER=azure\nSTT_API_KEY=%s\n' "$OKEY" > "$ENV_FILE"
  assert_contains "$(stt_key_problem 2>&1)" "openai or groq"
}

test_shell_vars_alone_do_not_enable() {
  _cat; printf 'X=1\n' > "$ENV_FILE"
  out="$(STT_PROVIDER=openai STT_API_KEY="$OKEY" _render)"
  assert_not_contains "$out" 'model_name: "stt"'
  if STT_PROVIDER=openai STT_API_KEY="$OKEY" stt_enabled; then return 1; fi
}

test_valid_key_charset() {
  valid_stt_key "$OKEY"; valid_stt_key "$GKEY"
  for k in '' sk-short 'sk-has space 0123456789abcdef' 'sk-"quoted"-0123456789abcdef' 'sk-$dollar-0123456789abcdef' \
           "sk-$(printf 'x%.0s' $(seq 1 600))"; do
    if valid_stt_key "$k"; then echo "accepted: $k" >&2; return 1; fi
  done
}

# --- Open WebUI engine selection (compose reads OWUI_STT_ENGINE from .env) ---

test_sync_env_sets_engine_only_when_on() {
  printf 'STT_PROVIDER=openai\nSTT_API_KEY=%s\n' "$OKEY" > "$ENV_FILE"
  stt_sync_env
  assert_eq "$(get_env OWUI_STT_ENGINE)" openai
  printf 'STT_PROVIDER=openai\nSTT_API_KEY=bad\nOWUI_STT_ENGINE=openai\n' > "$ENV_FILE"
  stt_sync_env 2>/dev/null
  assert_eq "$(get_env OWUI_STT_ENGINE)" ""
  assert_not_contains "$(cat "$ENV_FILE")" "OWUI_STT_ENGINE"
  assert_eq "$(stat -f %Lp "$ENV_FILE" 2>/dev/null || stat -c %a "$ENV_FILE")" 600
}

test_compose_selects_engine_and_keeps_key_in_litellm() {
  c="$(cat "$STACK_DIR/compose.yaml")"
  owui="$(sed -n '/^  open-webui:/,/^  shared-mcp:/p' "$STACK_DIR/compose.yaml")"
  litellm="$(sed -n '/^  litellm:/,/^  open-webui:/p' "$STACK_DIR/compose.yaml")"
  assert_contains "$owui" 'AUDIO_STT_ENGINE: ${OWUI_STT_ENGINE:-web}'
  assert_contains "$owui" 'AUDIO_STT_OPENAI_API_BASE_URL: http://litellm:4000/v1'
  assert_contains "$owui" 'AUDIO_STT_OPENAI_API_KEY: ${LITELLM_KEY_OPENWEBUI:-}'
  assert_contains "$owui" 'AUDIO_STT_MODEL: stt'
  assert_contains "$owui" 'AUDIO_TTS_ENGINE: ""'   # Call reads answers aloud with browser voices
  # the per-user default no longer pins "web": the server engine decides (the mic follows it)
  assert_not_contains "$owui" '"stt":{"engine":"web"}'
  assert_contains "$litellm" 'STT_API_KEY: ${STT_API_KEY:-}'
  # the provider key reaches LiteLLM only
  assert_eq "$(printf '%s\n' "$c" | grep -c 'STT_API_KEY')" 1
}

test_compose_engine_interpolation() {
  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then echo "no docker compose" >&2; return 77; fi
  # every :? variable, so compose can render the file
  printf 'POSTGRES_PASSWORD=p\nRUSTFS_ACCESS_KEY=a\nRUSTFS_SECRET_KEY=s\nLITELLM_MASTER_KEY=m\nLITELLM_SALT_KEY=s\nLITELLM_UI_PASSWORD=u\nAWS_ACCESS_KEY_ID=a\nAWS_SECRET_ACCESS_KEY=s\nWEBUI_SECRET_KEY=w\nOPENWEBUI_ADMIN_EMAIL=a@b.c\nOPENWEBUI_ADMIN_PASSWORD=p\nSHARED_MCP_TOKEN=t\nLITELLM_KEY_OPENWEBUI=sk-ow\n' > "$ENV_FILE"
  _env() { STT_API_KEY=sk-shell-should-not-win OWUI_STT_ENGINE=openai dc config --format json 2>/dev/null; }
  off="$(_env)"
  assert_contains "$off" '"AUDIO_STT_ENGINE": "web"'
  assert_contains "$off" '"STT_API_KEY": ""'
  printf 'OWUI_STT_ENGINE=openai\nSTT_API_KEY=%s\n' "$OKEY" >> "$ENV_FILE"
  on="$(_env)"
  assert_contains "$on" '"AUDIO_STT_ENGINE": "openai"'
  assert_contains "$on" '"AUDIO_STT_OPENAI_API_KEY": "sk-ow"'
  assert_contains "$on" "\"STT_API_KEY\": \"$OKEY\""
  assert_not_contains "$on" "sk-shell-should-not-win"
}

test_dc_strips_stt_shell_vars() {
  mkdir -p "$TMP/bin"
  printf '#!/bin/sh\nenv | grep -E "^(STT_|OWUI_STT_)" || true\n' > "$TMP/bin/docker"; chmod +x "$TMP/bin/docker"
  : > "$ENV_FILE"
  out="$(PATH="$TMP/bin:$PATH" STT_PROVIDER=openai STT_API_KEY="$OKEY" STT_MODEL=whisper-1 OWUI_STT_ENGINE=openai dc ps)"
  assert_eq "$out" ""
}

test_update_setup_ignores_shell_stt_vars() {
  body="$(sed -n '/^cmd_update() {/,/^}/p' "$STACK_DIR/lib/commands.sh")"
  assert_contains "$body" "-u STT_PROVIDER -u STT_API_KEY -u STT_MODEL -u BEDROCK_NOW_STT_FROM_ENV"
}

# --- key checks ---

test_validate_key_per_provider() {
  _stub_curl_auth
  stt_validate_key openai "$OKEY"
  assert_eq "$(cut -d' ' -f1-2 "$TMP/calls")" "$OKEY https://api.openai.com/v1/models"
  assert_contains "$(cat "$TMP/calls")" "--proto =https"
  : > "$TMP/calls"
  stt_validate_key groq "$GKEY"
  assert_eq "$(cut -d' ' -f1-2 "$TMP/calls")" "$GKEY https://api.groq.com/openai/v1/models"
  if CODE=401 stt_validate_key openai "$OKEY"; then return 1; fi
  assert_contains "$STT_ERR" "rejected the key (HTTP 401)"
  if CODE=000 stt_validate_key groq "$GKEY"; then return 1; fi
  assert_contains "$STT_ERR" "could not reach api.groq.com"
  : > "$TMP/calls"
  if stt_validate_key openai 'sk-"x" 0123456789abcdefghij'; then return 1; fi
  assert_contains "$STT_ERR" "does not look like"
  assert_eq "$(cat "$TMP/calls")" ""   # never sent
}

test_api_base_only_from_test_variable() {
  assert_eq "$(STT_API_OPENAI=http://evil.example "$BASH" -c '. lib/common.sh; . lib/stt.sh; stt_api_base openai')" "https://api.openai.com/v1"
  assert_eq "$(BEDROCK_NOW_TEST_STT_API=https://t.example "$BASH" -c '. lib/common.sh; . lib/stt.sh; stt_api_base groq')" "https://t.example"
}

test_key_never_on_argv() {
  # Every request that carries the key goes through curl_auth (curl -K -), https only.
  assert_eq "$(grep -nE '(^|[^_])curl ' "$STACK_DIR/lib/stt.sh" | grep -vc '^[0-9]*:[[:space:]]*#' || true)" 0
  assert_eq "$(grep -n 'curl_auth ' "$STACK_DIR/lib/stt.sh" | grep -v '^[0-9]*:[[:space:]]*#' | grep -vc -- "--proto '=https'" || true)" 0
}

# --- setup step ---

test_setup_asks_once_and_stores() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_curl_auth
  _have_tty() { return 0; }
  ask() { echo "ASK $1" >> "$TMP/asked"; echo openai; }
  ask_secret() { echo "SECRET $1" >> "$TMP/asked"; echo "$OKEY"; }
  out="$(setup_stt 2>&1)"
  assert_contains "$out" "outside Bedrock"
  assert_contains "$out" '$0.003 per minute'
  assert_contains "$(cat "$TMP/asked")" "openai/groq/none"
  assert_eq "$(get_env STT_PROVIDER)" openai
  assert_eq "$(get_env STT_API_KEY)" "$OKEY"
  assert_eq "$(get_env OWUI_STT_ENGINE)" openai
  [ -e "$STATE_DIR/stt-asked" ]
  # the key never reaches the terminal output
  assert_not_contains "$out" "$OKEY"
  # asked once: a second setup keeps it without asking
  : > "$TMP/asked"; : > "$TMP/calls"
  setup_stt 2>/dev/null
  assert_eq "$(cat "$TMP/asked")" ""
  assert_eq "$(get_env STT_PROVIDER)" openai
}

test_setup_none_is_remembered() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_curl_auth
  _have_tty() { return 0; }
  ask() { echo ASKED >> "$TMP/asked"; echo none; }
  ask_secret() { echo SECRET >> "$TMP/asked"; echo x; }
  setup_stt 2>/dev/null
  assert_eq "$(cat "$TMP/asked")" ASKED
  assert_eq "$(get_env STT_PROVIDER)" ""
  setup_stt 2>/dev/null
  assert_eq "$(cat "$TMP/asked")" ASKED   # not asked again
  [ ! -e "$TMP/calls" ]
}

test_setup_skipped_key_stays_off() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_curl_auth
  _have_tty() { return 0; }
  ask() { echo groq; }; ask_secret() { echo ''; }
  out="$(setup_stt 2>&1)"
  assert_contains "$out" "./stack stt set"
  assert_eq "$(get_env STT_PROVIDER)" ""
  [ ! -e "$TMP/calls" ]
}

test_setup_non_interactive_ignores_env_without_opt_in() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_curl_auth
  out="$(ASSUME_YES=1 STT_PROVIDER=openai STT_API_KEY="$OKEY" setup_stt 2>&1)"
  assert_contains "$out" "in your environment are ignored"
  assert_eq "$(get_env STT_PROVIDER)" ""
  [ ! -e "$TMP/calls" ]
  # without them in the environment: silent and offline
  out="$(ASSUME_YES=1 setup_stt 2>&1)"
  assert_eq "$out" ""
  [ ! -e "$STATE_DIR/stt-asked" ]
}

test_setup_non_interactive_with_opt_in() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_curl_auth
  ASSUME_YES=1 BEDROCK_NOW_STT_FROM_ENV=1 STT_PROVIDER=groq STT_API_KEY="$GKEY" STT_MODEL=whisper-large-v3 setup_stt 2>/dev/null
  assert_eq "$(get_env STT_PROVIDER)" groq
  assert_eq "$(get_env STT_API_KEY)" "$GKEY"
  assert_eq "$(get_env STT_MODEL)" whisper-large-v3
  assert_eq "$(get_env OWUI_STT_ENGINE)" openai
}

test_setup_interactive_env_needs_a_yes() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_curl_auth
  _have_tty() { return 0; }
  ask() { echo "ASK $1" >> "$TMP/asked"; echo n; }
  ask_secret() { echo SECRET >> "$TMP/asked"; echo x; }
  STT_PROVIDER=openai STT_API_KEY="$OKEY" setup_stt 2>/dev/null
  assert_contains "$(cat "$TMP/asked")" "api.openai.com"
  assert_eq "$(get_env STT_PROVIDER)" ""
  assert_not_contains "$(cat "$TMP/asked")" SECRET
}

test_setup_rejected_key_is_not_stored() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"; _stub_curl_auth
  err="$(CODE=401 ASSUME_YES=1 BEDROCK_NOW_STT_FROM_ENV=1 STT_PROVIDER=openai STT_API_KEY="$OKEY" setup_stt 2>&1)"
  assert_contains "$err" "not stored"
  assert_eq "$(get_env STT_API_KEY)" ""
  assert_eq "$(get_env OWUI_STT_ENGINE)" ""
}

test_setup_keeps_env_file_settings_over_shell() {
  STACK_DIR="$TMP"; printf 'STT_PROVIDER=openai\nSTT_API_KEY=%s\n' "$OKEY" > "$ENV_FILE"; _stub_curl_auth
  ASSUME_YES=1 BEDROCK_NOW_STT_FROM_ENV=1 STT_PROVIDER=groq STT_API_KEY="$GKEY" setup_stt 2>/dev/null
  assert_eq "$(get_env STT_PROVIDER)" openai
  assert_eq "$(get_env OWUI_STT_ENGINE)" openai
  [ ! -e "$TMP/calls" ]   # a stored key is not re-checked at every setup
}

# --- ./stack stt ---

test_cmd_set_validates_before_changing_anything() {
  STACK_DIR="$TMP"; printf 'X=1\n' > "$ENV_FILE"; _stub_curl_auth
  _stt_apply() { echo APPLY >> "$TMP/calls"; }
  if out="$( (CODE=401 STT_API_KEY="$OKEY" cmd_stt set openai) 2>&1)"; then return 1; fi
  assert_contains "$out" "nothing changed"
  if out="$( (STT_API_KEY="$OKEY" cmd_stt set azure) 2>&1)"; then return 1; fi
  assert_contains "$out" "openai or groq"
  if out="$( (STT_API_KEY="$OKEY" cmd_stt set openai whisper-large-v3) 2>&1)"; then return 1; fi
  assert_contains "$out" "gpt-4o-mini-transcribe"
  if out="$( (STT_API_KEY='bad key' cmd_stt set openai) 2>&1)"; then return 1; fi
  assert_eq "$(cat "$ENV_FILE")" "X=1"
  assert_not_contains "$(cat "$TMP/calls")" APPLY
}

test_cmd_set_status_remove() {
  STACK_DIR="$TMP"; printf 'X=1\n' > "$ENV_FILE"; _stub_curl_auth
  _stt_apply() { echo APPLY >> "$TMP/seq"; }
  out="$(STT_API_KEY="$OKEY" cmd_stt set openai gpt-4o-transcribe 2>&1)"
  assert_contains "$out" '$0.006 per minute'
  assert_contains "$out" "api.openai.com"
  assert_eq "$(get_env STT_PROVIDER)" openai
  assert_eq "$(get_env STT_MODEL)" gpt-4o-transcribe
  assert_eq "$(get_env OWUI_STT_ENGINE)" openai
  assert_eq "$(cat "$TMP/seq")" APPLY
  st="$(cmd_stt status)"
  assert_contains "$st" "on"
  assert_contains "$st" "OpenAI gpt-4o-transcribe"
  assert_not_contains "$st" "$OKEY"
  # switching provider drops a model that belongs to the old one
  STT_API_KEY="$GKEY" cmd_stt set groq 2>/dev/null
  assert_eq "$(get_env STT_MODEL)" ""
  assert_eq "$(stt_model)" whisper-large-v3-turbo
  cmd_stt remove 2>/dev/null
  assert_eq "$(get_env STT_PROVIDER)$(get_env STT_API_KEY)$(get_env STT_MODEL)$(get_env OWUI_STT_ENGINE)" ""
  assert_contains "$(cmd_stt status)" "browser (Web Speech)"
  assert_eq "$(stat -f %Lp "$ENV_FILE" 2>/dev/null || stat -c %a "$ENV_FILE")" 600
  assert_eq "$(tr '\n' ';' < "$TMP/seq")" "APPLY;APPLY;APPLY;"
}

test_cmd_set_asks_for_key_hidden() {
  STACK_DIR="$TMP"; printf 'X=1\n' > "$ENV_FILE"; _stub_curl_auth
  _stt_apply() { :; }
  _have_tty() { return 0; }
  ask_secret() { echo "SECRET $1" >> "$TMP/asked"; echo "$GKEY"; }
  cmd_stt set groq 2>/dev/null
  assert_contains "$(cat "$TMP/asked")" "SECRET Groq API key"
  assert_eq "$(get_env STT_API_KEY)" "$GKEY"
}

test_apply_rerenders_recreates_and_hides_the_model() {
  STACK_DIR="$TMP"; mkdir -p "$TMP/litellm"; : > "$TMP/litellm/config.yaml"
  printf 'LITELLM_MASTER_KEY=sk-m\nSTT_PROVIDER=openai\nSTT_API_KEY=%s\n' "$OKEY" > "$ENV_FILE"
  render_config() { echo RENDER >> "$TMP/seq"; }
  dc() { case "$1" in ps) echo abc ;; esac; }
  run_phase() { echo "PHASE $1 ${*:3}" >> "$TMP/seq"; }
  portal_session_or_die() { :; }; portal_session_end() { :; }
  stt_sync_owui() { echo HIDE >> "$TMP/seq"; }; sync_budget_banner() { echo BANNER >> "$TMP/seq"; }
  _stt_apply 2>/dev/null
  assert_eq "$(tr '\n' ';' < "$TMP/seq")" "RENDER;PHASE LiteLLM dc up -d --no-deps --force-recreate --wait litellm;PHASE Open WebUI dc up -d --no-deps --wait open-webui;HIDE;BANNER;"
}

test_apply_before_setup_or_when_stopped() {
  STACK_DIR="$TMP"; : > "$ENV_FILE"
  render_config() { echo RENDER >> "$TMP/seq"; }
  assert_contains "$(_stt_apply 2>&1)" "./stack setup applies it"
  mkdir -p "$TMP/litellm"; : > "$TMP/litellm/config.yaml"; printf 'LITELLM_MASTER_KEY=sk-m\nSTT_PROVIDER=openai\nSTT_API_KEY=%s\n' "$OKEY" > "$ENV_FILE"
  dc() { :; }
  assert_contains "$(_stt_apply 2>&1)" "./stack up applies it"
  assert_eq "$(cat "$TMP/seq")" RENDER
  [ -e "$STATE_DIR/stt-owui-pending" ]
  # ./stack up then hides the model once
  stt_sync_owui() { echo HIDE >> "$TMP/seq"; rm -f "$STATE_DIR/stt-owui-pending"; }
  stt_after_up; stt_after_up
  assert_eq "$(tr '\n' ';' < "$TMP/seq")" "RENDER;HIDE;"
}

test_owui_entry_is_hidden_with_price() {
  printf 'STT_PROVIDER=groq\nSTT_API_KEY=%s\nOPENWEBUI_API_KEY=sk-o\n' "$GKEY" > "$ENV_FILE"
  owui_upsert_model() { printf '%s|' "$@" >> "$TMP/up"; }
  stt_sync_owui 2>/dev/null
  out="$(cat "$TMP/up")"
  assert_contains "$out" "stt|Speech to text|Speech to text|"
  assert_contains "$out" 'Groq whisper-large-v3-turbo · $0.0007 per minute of audio'
  assert_contains "$out" '|true|'
  # off: nothing to do
  : > "$TMP/up"; printf 'OPENWEBUI_API_KEY=sk-o\n' > "$ENV_FILE"
  stt_sync_owui
  assert_eq "$(cat "$TMP/up")" ""
}

# --- prices, costs, summary ---

test_price_labels() {
  assert_eq "$(stt_price_label openai gpt-4o-mini-transcribe)" '$0.003 per minute of audio ($0.18 per hour)'
  assert_eq "$(stt_price_label openai gpt-4o-transcribe)" '$0.006 per minute of audio ($0.36 per hour)'
  assert_eq "$(stt_price_label openai whisper-1)" '$0.006 per minute of audio ($0.36 per hour)'
  assert_eq "$(stt_price_label groq whisper-large-v3-turbo)" '$0.0007 per minute of audio ($0.04 per hour)'
  assert_eq "$(stt_price_label groq whisper-large-v3)" '$0.0018 per minute of audio ($0.11 per hour)'
}

test_prices_match_litellms_bundled_map() {
  # LiteLLM bills from its own price map (bundled in the pinned image); our labels must say the same.
  f="${LITELLM_COST_MAP:-}"
  [ -n "$f" ] && [ -r "$f" ] || { echo "set LITELLM_COST_MAP to LiteLLM's model_prices_and_context_window_backup.json" >&2; return 77; }
  command -v python3 >/dev/null || return 77
  stt_catalog | while IFS=$'\t' read -r p m lm per_s _; do
    got="$(python3 -c 'import json, sys; d = json.load(open(sys.argv[1])); print(repr(d[sys.argv[2]]["input_cost_per_second"] == float(sys.argv[3])))' "$f" "${lm#openai/}" "$per_s")"
    assert_eq "$got" True || { echo "$p $m" >&2; exit 1; }
  done
}

test_costs_and_summary_sections() {
  : > "$ENV_FILE"
  assert_contains "$(stt_costs_section)" "Speech-to-text: browser (Web Speech)"
  assert_eq "$(stt_summary_line)" ""
  printf 'STT_PROVIDER=openai\nSTT_API_KEY=%s\n' "$OKEY" > "$ENV_FILE"
  out="$(stt_costs_section)"
  assert_contains "$out" "OpenAI gpt-4o-mini-transcribe"
  assert_contains "$out" '$0.003 per minute'
  assert_contains "$out" "open-webui key"
  assert_contains "$(stt_summary_line)" "Voice calls"
  assert_contains "$(sed -n '/^cmd_costs() {/,/^}/p' "$STACK_DIR/lib/commands.sh")" "stt_costs_section"
  assert_contains "$(cmd_help)" "stt "
}

test_setup_runs_stt_step_before_bringup() {
  body="$(sed -n '/^cmd_setup() {/,/^}/p' "$STACK_DIR/lib/commands.sh" | tr -d ' ')"
  case "$body" in *setup_stt*setup_bringup_and_probe*) ;; *) echo "setup_stt must run before setup_bringup_and_probe" >&2; return 1 ;; esac
  assert_contains "$(sed -n '/^setup_keys_and_ui() {/,/^}/p' "$STACK_DIR/lib/commands.sh")" "stt_sync_owui"
  assert_contains "$(sed -n '/^cmd_up() {/,/^}/p' "$STACK_DIR/lib/commands.sh")" "stt_after_up"
  assert_contains "$(cat "$STACK_DIR/stack")" "cmd_stt"
}

test_env_example_documents_stt() {
  e="$(cat "$STACK_DIR/.env.example")"
  assert_contains "$e" "STT_PROVIDER="
  assert_contains "$e" "STT_API_KEY="
  assert_contains "$e" "STT_MODEL="
}
