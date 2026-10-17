# shellcheck shell=bash
# The models of the Code page and claude-bedrock (lib/code_models.sh): every enabled chat model of the catalog and the
# enabled OpenRouter ones, how each fares as Claude Code's model (catalog/code-models.tsv), Settings › Claude Code ›
# Models (CODE_MODELS, CODE_DEFAULT_MODEL), litellm/code-models.tsv and LiteLLM's bn_* model_info.
. "$STACK_DIR/lib/commands.sh"   # also sources lib/openrouter.sh and lib/code_models.sh
FIXJ="$STACK_DIR/tests/fixtures/openrouter_models.json"

# A catalog of its own: two Anthropic models, a Meta one, a Mistral one, an embedder and a speech model; their names,
# prices and compatibility rows; STACK_DIR in $TMP (nothing of this checkout's litellm/ is read or written).
_cm_env() {
  local repo="$STACK_DIR"
  STACK_DIR="$TMP"; mkdir -p "$TMP/litellm" "$TMP/catalog"
  printf 'claude-big\tchat\tbedrock/invoke/us.anthropic.big\t-\t-\nclaude-small\tchat\tbedrock/invoke/us.anthropic.small\t-\t-\nllama-x\tchat\tbedrock/us.meta.llama-x\t-\t-\nmistral-y\tchat\tbedrock/mistral.y\t-\t-\nemb\tembedding\tbedrock/emb\t-\t-\nvox\tstt\tbedrock/vox\t-\t-\n' > "$TMP/cat.tsv"
  printf '# name\tdisplay_name\ticon\ttags\nclaude-big\tClaude Big\t-\tAnthropic\nclaude-small\tClaude Small\t-\tAnthropic\nllama-x\tLlama X\t-\tMeta,Open\nmistral-y\tMistral "Y"\t-\t-\n' > "$TMP/disp.tsv"
  printf '# name\tin\tout\tcr\tcw\timg\tq\nclaude-big\t4.40\t22.00\t0.22\t5.50\t-\t-\nclaude-small\t0.11\t0.55\t0.011\t0.1375\t-\t-\nllama-x\t0.72\t0.72\t-\t-\t-\t-\n' > "$TMP/prices.tsv"
  printf '# pattern\tstatus\tmax_out\tnote\nclaude-*\tworks\t-\tAnthropic.\nllama-x\tchat-only\t8192\tText tool calls.\nor/meta-llama/*\tfails\t4096\tOurs wins.\n' > "$TMP/compat.tsv"
  export CATALOG="$TMP/cat.tsv" CODE_DISPLAY_TSV="$TMP/disp.tsv" PRICES="$TMP/prices.tsv" CODE_COMPAT="$TMP/compat.tsv"
  printf 'CLAUDE_BEDROCK_OPUS_MODEL=claude-big\n%s' "${1:-}" > "$ENV_FILE"
  : "$repo"
}
_or_cache() {
  printf 'OPENROUTER_API_KEY=sk-or-v1-abc\n' >> "$ENV_FILE"
  { printf '# fetched_at: 2026-10-12T00:00:00Z\n'; or_models_tsv < "$FIXJ" | or_classify; } > "$TMP/litellm/openrouter-models.tsv"
}
_col() { awk -F'\t' -v c="$1" -v id="$2" '$1 == id { print $c }'; }

test_rows_every_enabled_chat_model_with_names_vendors_prices_and_compat() {
  _cm_env
  printf 'claude-big\nclaude-small\nllama-x\nmistral-y\nemb\nvox\n' > "$TMP/en"
  out="$(code_models_rows "$TMP/en")"
  assert_eq "$(printf '%s\n' "$out" | cut -f1 | tr '\n' ' ')" "claude-big claude-small llama-x mistral-y "   # chat only: no embedder, no speech
  assert_eq "$(printf '%s\n' "$out" | _col 0 llama-x | cut -f2-15)" "$(printf 'Llama X\tBedrock\tMeta\t0.72\t0.72\t-\t-\t0\tchat-only\t1\t0\t8192\t-\tText tool calls.')"
  assert_eq "$(printf '%s\n' "$out" | _col 2 mistral-y)" 'Mistral Y'          # quotes never reach YAML or JSON
  assert_eq "$(printf '%s\n' "$out" | _col 4 mistral-y)" Other               # no vendor tag
  assert_eq "$(printf '%s\n' "$out" | _col 5 mistral-y)" -                   # no price
  assert_eq "$(printf '%s\n' "$out" | _col 10 mistral-y)" untested           # no compat row
  assert_eq "$(printf '%s\n' "$out" | _col 12 claude-big)" 1                 # the main model is the default
  printf 'claude-small\nllama-x\n' > "$TMP/en"
  out="$(code_models_rows "$TMP/en")"
  assert_eq "$(printf '%s\n' "$out" | cut -f1 | tr '\n' ' ')" "claude-small llama-x "
  assert_eq "$(printf '%s\n' "$out" | awk -F'\t' '$12 == 1 { print $1 }')" claude-small   # main not enabled: the first listed
}

test_scope_all_anthropic_and_a_list_and_the_default_always_listed() {
  _cm_env 'CODE_MODELS=anthropic
'
  out="$(code_models_rows "")"
  assert_eq "$(printf '%s\n' "$out" | awk -F'\t' '$11 == 1 { print $1 }' | tr '\n' ' ')" "claude-big claude-small "
  _cm_env 'CODE_MODELS=llama-x, mistral-y ,nope
CODE_DEFAULT_MODEL=claude-small
'
  out="$(code_models_rows "")"
  assert_eq "$(printf '%s\n' "$out" | awk -F'\t' '$11 == 1 { print $1 }' | tr '\n' ' ')" "claude-small llama-x mistral-y "   # + the default
  assert_eq "$(printf '%s\n' "$out" | awk -F'\t' '$12 == 1 { print $1 }')" claude-small
  _cm_env 'CODE_DEFAULT_MODEL=not-enabled
'
  assert_eq "$(code_models_rows "" | awk -F'\t' '$12 == 1 { print $1 }')" claude-big   # not enabled: as blank
  assert_eq "$(CODE_MODELS=x code_models_scope)" all   # .env decides, not the shell
}

test_openrouter_rows_free_at_zero_tools_and_the_output_cap() {
  _cm_env; _or_cache
  out="$(code_models_rows "")"
  free="$(printf '%s\n' "$out" | awk -F'\t' '$1 == "or/google/gemma-4-31b-it:free"')"
  assert_eq "$(printf '%s' "$free" | cut -f2-14)" "$(printf 'Gemma 4 31B (free)\tOpenRouter\tGoogle\t0\t0\t-\t-\t1\tuntested\t1\t0\t32768\t262144')"
  assert_contains "$(printf '%s' "$free" | cut -f15)" "OpenRouter lists tool use"
  paid="$(printf '%s\n' "$out" | awk -F'\t' '$1 == "or/anthropic/claude-haiku-5.5"')"
  assert_eq "$(printf '%s' "$paid" | cut -f4-9)" "$(printf 'Anthropic\t0.1\t0.5\t0.01\t0.125\t0')"
  # a row of ours wins over OpenRouter's (status and cap); no "~" alias ids (the code server refuses them)
  assert_eq "$(printf '%s\n' "$out" | _col 10 or/meta-llama/llama-3.3-70b-instruct)" fails
  assert_eq "$(printf '%s\n' "$out" | _col 13 or/meta-llama/llama-3.3-70b-instruct)" 4096
  assert_not_contains "$out" "~anthropic"
  printf 'OPENROUTER_INCLUDE_ALIASES=true\n' >> "$ENV_FILE"   # listed by OpenRouter's selection, still never a model here
  assert_not_contains "$(code_models_rows "")" "~anthropic"
  sed -i.bak '/^OPENROUTER_INCLUDE_ALIASES=/d' "$ENV_FILE"
  # anthropic scope: OpenRouter's Anthropic models count too
  printf 'CODE_MODELS=anthropic\n' >> "$ENV_FILE"
  assert_eq "$(code_models_rows "" | awk -F'\t' '$11 == 1 && $3 == "OpenRouter" { print $1 }')" "or/anthropic/claude-haiku-5.5"
  # no key: no OpenRouter rows
  printf 'CLAUDE_BEDROCK_OPUS_MODEL=claude-big\n' > "$ENV_FILE"
  assert_not_contains "$(code_models_rows "")" "or/"
}

test_write_inject_resolve_and_the_picker() {
  _cm_env; _or_cache
  code_models_write ""
  f="$TMP/litellm/code-models.tsv"
  assert_eq "$(sed -n 2p "$f")" "# scope: all"
  assert_eq "$(ls -l "$f" | cut -c1-10)" "-rw-r--r--"
  # LiteLLM's model_info: the bn_* keys after each chat model's mode
  yaml="$(printf '  - model_name: "llama-x"\n    model_info:\n      mode: "chat"\n  - model_name: "emb"\n    model_info:\n      mode: "embedding"\n  - model_name: "or/google/gemma-4-31b-it:free"\n    model_info:\n      mode: "chat"\n' | code_models_inject "$f")"
  assert_contains "$yaml" "$(printf '      mode: "chat"\n      bn_id: "llama-x"\n      bn_name: "Llama X"\n      bn_vendor: "Meta"\n      bn_compat: "chat-only"\n      bn_code: true\n  - model_name: "emb"')"
  assert_contains "$yaml" "$(printf '      bn_name: "Gemma 4 31B (free)"\n      bn_vendor: "Google"\n      bn_compat: "untested"\n      bn_code: true')"
  assert_eq "$(printf '%s\n' "$yaml" | grep -c 'bn_default: true')" 0   # claude-big is the default, not in this YAML
  assert_eq "$(code_model_resolve claude-big)" claude-big
  assert_eq "$(code_model_resolve 'LLAMA X')" llama-x
  assert_eq "$(code_model_resolve google/gemma-4-31b-it:free)" or/google/gemma-4-31b-it:free
  assert_eq "$(code_model_resolve opus)" claude-big
  assert_eq "$(code_model_resolve nope)" ""
  assert_eq "$(code_models_default)" claude-big
  j="$(code_picker_json "" 1)"
  printf '%s' "$j" | python3 -I -c 'import json, sys; d = json.load(sys.stdin); o = d["modelPicker"]["options"]
assert d["disableAutoMode"] == "disable" and d["modelPicker"]["replaceBuiltInOptions"] is True, d
assert o[0] == {"model": "claude-big", "label": "Claude Big", "description": "Anthropic · $4.40/$22.00 per 1M · works"}, o[0]
assert {"model": "or/google/gemma-4-31b-it:free", "label": "Gemma 4 31B (free) · OpenRouter", "description": "Google · free ($0) · not tested"} in o'
  assert_not_contains "$(code_picker_json "" 0)" disableAutoMode
  # at most CODE_PICKER_MAX rows, the default always among them
  CODE_PICKER_MAX=3 code_picker_json "" 0 | python3 -I -c 'import json, sys; o = json.load(sys.stdin)["modelPicker"]["options"]; assert len(o) == 3 and o[0]["model"] == "claude-big", o'
  table="$(code_models_table "")"
  assert_contains "$table" "* claude-big"
  assert_contains "$table" "chat only (no tools) · Meta on Bedrock"
}

test_render_config_writes_the_file_and_litellm_gets_the_bn_keys_and_the_hook() {
  _cm_env 'CODE_MODELS=claude-small
'
  printf 'AWS_REGION_NAME=us-east-1\n' >> "$ENV_FILE"
  printf 'claude-big\nclaude-small\nllama-x\n' > "$TMP/en"
  mkdir -p "$TMP/lib/litellm-hooks"; printf '# the hook\n' > "$TMP/lib/litellm-hooks/bn_hooks.py"
  render_config "$TMP/en"
  assert_eq "$(cat "$TMP/litellm/bn_hooks.py")" "# the hook"   # copied next to the config that names it
  assert_eq "$(ls -l "$TMP/litellm/bn_hooks.py" | cut -c1-10)" "-rw-r--r--"
  cfg="$(cat "$TMP/litellm/config.yaml")"
  assert_contains "$cfg" "$(printf '      bn_id: "claude-big"\n      bn_name: "Claude Big"\n      bn_vendor: "Anthropic"\n      bn_compat: "works"\n      bn_code: true\n      bn_default: true')"
  assert_contains "$cfg" "$(printf '      bn_name: "Llama X"\n      bn_vendor: "Meta"\n      bn_compat: "chat-only"\n      bn_code: false')"
  assert_contains "$cfg" '  callbacks: ["bn_hooks.proxy_handler_instance"]'
  assert_eq "$(_code_rows "$TMP/litellm/code-models.tsv" | awk -F'\t' '$11 == 1 { print $1 }' | tr '\n' ' ')" "claude-big claude-small "
  rm "$TMP/lib/litellm-hooks/bn_hooks.py"
  render_config "$TMP/en"
  assert_not_contains "$(cat "$TMP/litellm/config.yaml")" callbacks   # no hook source, no hook (LiteLLM would not start)
}

test_validators_for_the_settings() {
  for v in '' all anthropic claude-big 'claude-big,or/google/gemma-4-31b-it:free' 'llama-x,mistral-y'; do valid_code_models "$v" || { echo "refused: $v" >&2; return 1; }; done
  for v in ',a' 'a,' 'a,,b' 'a b' 'a;b' 'a"b'; do ! valid_code_models "$v" || { echo "taken: $v" >&2; return 1; }; done
  for v in '' claude-big or/google/gemma-4-31b-it:free; do valid_code_model "$v" || { echo "refused: $v" >&2; return 1; }; done
  for v in '-x' 'a b' 'a,b' "$(printf 'x%.0s' $(seq 1 129))"; do ! valid_code_model "$v" || { echo "taken: $v" >&2; return 1; }; done
  . "$STACK_DIR/lib/settings.sh"
  setting_validate CODE_MODELS 'anthropic' && setting_validate CODE_DEFAULT_MODEL 'or/x/y:free'
  ! setting_validate CODE_MODELS 'a b'
  assert_contains "$SV_ERR" "CODE_MODELS must be all, anthropic or a comma list of model ids"
}

# the hook: max_tokens lowered to a model's limit from code-models.tsv, nothing else, never an error
test_litellm_hook_caps_max_tokens_from_code_models() {
  command -v python3 >/dev/null 2>&1 || return 77
  mkdir -p "$TMP/h/litellm/integrations"
  printf '' > "$TMP/h/litellm/__init__.py"; printf '' > "$TMP/h/litellm/integrations/__init__.py"
  printf 'class CustomLogger:\n    pass\n' > "$TMP/h/litellm/integrations/custom_logger.py"
  cp "$STACK_DIR/lib/litellm-hooks/bn_hooks.py" "$TMP/h/bn_hooks.py"
  printf '# x\n# id\nllama-x\tL\tBedrock\tMeta\t1\t1\t-\t-\t0\tchat-only\t1\t0\t8192\t-\t-\nclaude-big\tC\tBedrock\tAnthropic\t1\t1\t-\t-\t0\tworks\t1\t1\t-\t-\t-\n' > "$TMP/h/code-models.tsv"
  PYTHONPATH="$TMP/h" python3 -c '
import asyncio, bn_hooks as h
d = asyncio.run(h.proxy_handler_instance.async_pre_call_hook(None, None, {"model": "llama-x", "max_tokens": 32000, "thinking": {"type": "enabled", "budget_tokens": 16000}}, "anthropic_messages"))
assert d["max_tokens"] == 8192 and d["thinking"]["budget_tokens"] == 4096, d
assert h.cap_request({"model": "llama-x", "max_tokens": 100})["max_tokens"] == 100
assert h.cap_request({"model": "claude-big", "max_tokens": 64000})["max_tokens"] == 64000
assert h.cap_request({"model": "llama-x", "max_completion_tokens": 9000})["max_completion_tokens"] == 8192
assert asyncio.run(h.proxy_handler_instance.async_pre_call_hook(None, None, {"model": ["odd"], "max_tokens": "x"}, "x")) == {"model": ["odd"], "max_tokens": "x"}
assert asyncio.run(h.proxy_handler_instance.async_pre_call_hook(None, None, None, "x")) is None
'
}


# Names that YAML refuses or a terminal acts on (C1 controls such as U+009B, CSI; U+2028; bidi overrides; U+FFFE) never
# reach LiteLLM's config, the model list or a terminal; a config that is not valid YAML is never put in place
test_unsafe_model_names_never_reach_yaml_or_a_terminal() {
  _cm_env
  c1="$(printf '\302\233')"; ls2028="$(printf '\342\200\250')"; rlo="$(printf '\342\200\256')"; fffe="$(printf '\357\277\276')"; esc="$(printf '\033')"
  # OpenRouter's list: or_classify drops them
  out="$(printf 'a/b\tBad%s31mName%s x%sy%s\t1\t0\t0\t\t\ttext\t1\t1\t\n' "$c1" "$ls2028" "$rlo" "$fffe" | or_classify | cut -f2)"
  assert_eq "$out" "Bad31mName xy"
  # a cache edited by hand (or an older one): code_models_rows drops them too, and so does every reader of the file
  printf 'OPENROUTER_API_KEY=sk-or-v1-abc\n' >> "$ENV_FILE"
  printf '# fetched_at: x\na/b\tVendor: N%s1%s\t1\t0\t0\t\t\tfree\t1\t1\t\nc/d\tCafé %sOK\t1\t0\t0\t\t\tfree\t1\t1\t\n' "$c1" "$esc" "$rlo" > "$TMP/litellm/openrouter-models.tsv"
  code_models_write ""
  f="$TMP/litellm/code-models.tsv"
  ! LC_ALL=C grep -q "$(printf '\302[\200-\237]')" "$f" || { echo "C1 in the file" >&2; return 1; }
  ! LC_ALL=C grep -q "$(printf '\033')" "$f" || { echo "ESC in the file" >&2; return 1; }
  assert_eq "$(_col 2 or/a/b < "$f")" "N1"
  assert_eq "$(_col 2 or/c/d < "$f")" "Café OK"
  # LiteLLM's model_info: a name only when it is plain ASCII (the id stands in otherwise)
  yaml="$(printf '  - model_name: "or/c/d"\n    model_info:\n      mode: "chat"\n  - model_name: "or/a/b"\n    model_info:\n      mode: "chat"\n' | code_models_inject "$f")"
  assert_contains "$yaml" "$(printf '      bn_id: "or/c/d"\n      bn_vendor: "c"\n      bn_compat:')"
  assert_contains "$yaml" '      bn_name: "N1"'
  assert_not_contains "$yaml" "Café"
  # the host's table and /model menu: nothing a terminal acts on, even from a file edited by hand
  printf 'x/y\tE%s[2Jvil%s\tOpenRouter\tV%s]0;t\t0\t0\t-\t-\t1\tuntested\t1\t0\t-\t-\t-\n' "$esc" "$c1" "$esc" >> "$f"
  t="$(code_models_table "" all; code_picker_json "" 0)"
  ! printf '%s' "$t" | LC_ALL=C grep -q "$(printf '\033')" || { echo "ESC reaches the terminal" >&2; return 1; }
  ! printf '%s' "$t" | LC_ALL=C grep -q "$(printf '\302[\200-\237]')" || { echo "C1 reaches the terminal" >&2; return 1; }
  # the last guard: a config YAML would refuse is never put in place (the previous one stays)
  printf 'model_list:\n  - model_name: "ok"\n' > "$TMP/good.yaml"; litellm_config_safe "$TMP/good.yaml"
  for bad in "$c1" "$ls2028" "$fffe" "$(printf '\001')" "$(printf '\377')"; do
    printf 'model_list:\n  - model_name: "x%sy"\n' "$bad" > "$TMP/bad.yaml"
    ! litellm_config_safe "$TMP/bad.yaml" || { echo "taken: $(printf '%s' "$bad" | od -An -c)" >&2; return 1; }
  done
  printf 'AWS_REGION_NAME=us-east-1\n' >> "$ENV_FILE"; printf 'old config\n' > "$TMP/litellm/config.yaml"
  litellm_config_safe() { return 1; }
  if (render_config "") 2> "$TMP/err"; then return 1; fi
  assert_contains "$(cat "$TMP/err")" "not valid YAML — kept the previous one"
  assert_eq "$(cat "$TMP/litellm/config.yaml")" "old config"
}

# Settings' list of the models (the snapshot's choices): each with its price, a free one at $0, never an unusable id
test_settings_choices_name_each_models_price() {
  . "$STACK_DIR/lib/settings.sh"
  _cm_env
  printf '# x\nllama-x\tLlama X\tBedrock\tMeta\t0.72\t0.72\t-\t-\t0\tchat-only\t1\t0\t8192\t-\t-\nor/a/b:free\tB\tOpenRouter\tA\t0\t0\t-\t-\t1\tuntested\t0\t0\t-\t-\t-\nor/~a/x\tX\tOpenRouter\tA\t1\t1\t-\t-\t0\tworks\t1\t0\t-\t-\t-\n' > "$TMP/litellm/code-models.tsv"
  out="$(_settings_code_models)"
  assert_eq "$out" '["llama-x", "Llama X", "Bedrock", "Meta", "chat-only", false, true, "$0.72/$0.72 per 1M"], ["or/a/b:free", "B", "OpenRouter", "A", "untested", true, false, "free ($0)"]'
}
