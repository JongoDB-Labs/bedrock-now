#!/usr/bin/env bash
# Opt-in end-to-end suite (run by hand; not part of tests/run.sh or CI). Builds a THROWAWAY bedrock-now stack from
# this checkout under its own Compose project and ports, drives every page in a pinned Playwright container, runs
# the safe ./stack subcommands against it, then removes it again. Costs real Bedrock money: about half a cent per
# full run (measured; every key of the throwaway has a budget of a few cents, and the run fails at $0.10).
#
#   tests/e2e/run.sh --aws-env FILE   AWS_* keys from FILE (only those lines are read; values are never printed)
#   tests/e2e/run.sh                  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION_NAME from the environment
#
# Options:
#   --out DIR        results, logs, screenshots (default tests/e2e/out, gitignored)
#   --work DIR       where the throwaway checkout lives while the stack runs (default tests/e2e/work/PROJECT,
#                    gitignored). Keep it out of temporary folders: Docker bind-mounts files from it, and a
#                    cleaned-up /tmp would break a kept stack.
#   --project NAME   Compose project of the throwaway: bne2e (default) or bne2e-<suffix>; its host is NAME.localhost
#   --aws-env FILE   where the AWS key comes from (copies only AWS_* lines)
#   --keep           leave the throwaway running afterwards (tear it down later with --teardown)
#   --reuse          reuse a throwaway kept by an earlier --keep run (skips staging and setup)
#   --teardown       only remove a kept throwaway (refused unless it is this suite's own), then exit
#   --skip-cli-mutating   skip backup/restore, down/up, rotate-aws, update and rollback (the slow part)
#   --deep-update    also a real update to a new (local) commit and a rollback from it (two more setups)
#   --no-claude      skip the claude-bedrock check
#   --only PARTS     run only these parts (comma list of cli, browser, voice, claude, mutating; default all).
#                    Setup, the spend guard and the claude-bedrock link check always run.
#
# Never touches the default install: only project names bne2e[-…] are accepted, and teardown touches Docker only
# after the project was found to be this suite's own (or free); ports 80/4000/8765 (and the others in AVOID_PORTS)
# are never used; ~/.local/bin/claude-bedrock is checked before and after (link and file); nothing is pruned.
set -uo pipefail
umask 077   # logs, results and screenshots are private; the throwaway checkout itself is cloned with umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# mcr.microsoft.com/playwright/python v1.55.0-noble (multi-arch), pinned by digest; requirements.txt pins the same.
PW_IMAGE="mcr.microsoft.com/playwright/python:v1.55.0-noble@sha256:640d578aae63cfb632461d1b0aecb01414e4e020864ac3dd45a868dc0eff3078"
AVOID_PORTS=" 80 443 3000 3009 4000 8080 8081 8090 8765 8800 "
SPEND_LIMIT="0.10"
# The throwaway's monthly budgets (USD): LiteLLM itself refuses requests beyond them during the run.
BUDGETS="BUDGET_CLAUDE_CODE=0.04 BUDGET_OPENWEBUI=0.04 BUDGET_SETUP=0.02"
NOTTY="$HERE/notty"

OUT="$ROOT/tests/e2e/out"; WORK=''; PROJECT=bne2e; AWS_ENV_FILE=''; KEEP=0; REUSE=0; TEARDOWN_ONLY=0
SKIP_MUTATING=0; DEEP_UPDATE=0; NO_CLAUDE=0; ONLY="cli,browser,voice,claude,mutating"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out needs a directory}"; shift 2 ;;
    --work) WORK="${2:?--work needs a directory}"; shift 2 ;;
    --project) PROJECT="${2:?--project needs a name}"; shift 2 ;;
    --aws-env) AWS_ENV_FILE="${2:?--aws-env needs a file}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --reuse) REUSE=1; KEEP=1; shift ;;
    --teardown) TEARDOWN_ONLY=1; shift ;;
    --skip-cli-mutating) SKIP_MUTATING=1; shift ;;
    --deep-update) DEEP_UPDATE=1; shift ;;
    --no-claude) NO_CLAUDE=1; shift ;;
    --only) ONLY="${2:?--only needs a list (cli,browser,voice,claude,mutating)}"; shift 2 ;;
    -h | --help) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (tests/e2e/run.sh --help)" >&2; exit 2 ;;
  esac
done

# shellcheck source=tests/e2e/lib.sh
. "$HERE/lib.sh"
# shellcheck source=lib/ports.sh
. "$ROOT/lib/ports.sh"   # port_in_use (lsof → ss → /dev/tcp), the same check ./stack uses

for part in $(printf '%s' "$ONLY" | tr ',' ' '); do
  case "$part" in cli | browser | voice | claude | mutating) ;; *) echo "--only: unknown part '$part' (cli, browser, voice, claude, mutating)" >&2; exit 2 ;; esac
done
part_on() { case ",$ONLY," in *",$1,"*) return 0 ;; esac; return 1; }   # part_on PART -> 0 when --only includes it
valid_project "$PROJECT" || { echo "--project: only bne2e or bne2e-<lowercase letters, digits, ->, not '$PROJECT' (teardown deletes the project's volumes)" >&2; exit 2; }

mkdir -p "$OUT" || exit 2
OUT="$(cd "$OUT" && pwd -P)"
WORK="${WORK:-$ROOT/tests/e2e/work/$PROJECT}"
mkdir -p "$(dirname "$WORK")" || exit 2
STACK="$(cd "$(dirname "$WORK")" && pwd -P)/$(basename "$WORK")"   # the throwaway checkout (.env, .state/, backups/)
LOGS="$OUT/logs"; RESULTS="$OUT/results.tsv"
HOST="$PROJECT.localhost"

command -v docker >/dev/null || die "docker is required"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running"

if [ "$TEARDOWN_ONLY" = 1 ]; then teardown_only; exit 0; fi

command -v git >/dev/null || die "git is required"
command -v perl >/dev/null || die "perl is required (tests/e2e/notty runs ./stack without a terminal)"
if [ -n "$AWS_ENV_FILE" ]; then
  [ -r "$AWS_ENV_FILE" ] || die "cannot read --aws-env $AWS_ENV_FILE"
  load_aws_file "$AWS_ENV_FILE"
fi
[ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] ||
  die "no AWS key: pass --aws-env FILE or export AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY"

LINK_BEFORE="$(link_state)"
mkdir -p "$LOGS"; : > "$RESULTS"
START_TS="$(now)"

# st [--aws] ARGS... — the throwaway's ./stack with a clean environment and no controlling terminal (notty), run in
# its folder (ST_CWD=DIR: from DIR instead; ST_TIMEOUT=SECS: ended after SECS); stdin is /dev/null.
st() {
  # Never let a command default to the bedrock-now project: the throwaway .env must name ours.
  [ "$(get_env COMPOSE_PROJECT_NAME)" = "$PROJECT" ] || { echo "xx  throwaway .env does not name project $PROJECT" >&2; return 99; }
  local cwd="${ST_CWD:-$STACK}" timeout=()   # read before clean_env, which unexports them with everything else
  [ -z "${ST_TIMEOUT:-}" ] || timeout=(--timeout "$ST_TIMEOUT")
  if [ "${1:-}" = --aws ]; then
    shift
    ( export AWS_REGION_NAME="${AWS_REGION_NAME:-us-east-1}" COMPOSE_PROJECT_NAME="$PROJECT"
      clean_env AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION_NAME COMPOSE_PROJECT_NAME
      cd "$cwd" && exec "$NOTTY" ${timeout[@]+"${timeout[@]}"} "$STACK/stack" "$@" </dev/null )
  else
    ( clean_env; cd "$cwd" && exec "$NOTTY" ${timeout[@]+"${timeout[@]}"} "$STACK/stack" "$@" </dev/null )
  fi
}

# cli ID EXPECT_RC PATTERN [--aws] ARGS... — ./stack ARGS; PASS when the exit status is EXPECT_RC ("any" = any)
# and the (redacted) output matches the extended regex PATTERN ("" = anything).
cli() {
  local id="$1" want="$2" pat="$3" t0 rc log
  shift 3
  log="$LOGS/cli-$id.log"; t0="$(now)"
  st "$@" > "$log" 2>&1; rc=$?
  redact "$log"
  if [ "$want" != any ] && [ "$rc" != "$want" ]; then
    record cli "$id" FAIL "$(( $(now) - t0 ))" "exit $rc (want $want): $(grep -E 'xx|FAIL|!!' "$log" | tail -n 2 | tr '\n' ' ')"
    return 1
  fi
  if [ -n "$pat" ] && ! grep -Eq -- "$pat" "$log"; then
    record cli "$id" FAIL "$(( $(now) - t0 ))" "output lacks /$pat/ (exit $rc; log $log)"
    return 1
  fi
  record cli "$id" PASS "$(( $(now) - t0 ))" "exit $rc"
}

# follow_logs ID SERVICE — ./stack logs SVC follows forever: read 6 s of it (notty --timeout ends the whole group)
follow_logs() {
  local id="$1" svc="$2" log t0
  log="$LOGS/cli-$id.log"; t0="$(now)"
  ST_TIMEOUT=6 st logs "$svc" > "$log" 2>&1
  redact "$log"
  if [ -s "$log" ] && grep -q "$svc" "$log"; then record cli "$id" PASS "$(( $(now) - t0 ))" "$(wc -l < "$log" | tr -d ' ') lines"
  else record cli "$id" FAIL "$(( $(now) - t0 ))" "no log lines for $svc"; fi
}

# finish — whatever ends the run: logs redacted, and the throwaway removed unless --keep (Docker only once it is
# known to be ours: claim_project / reuse_check set OWNED=1)
finish() {
  local rc=$?
  trap - EXIT INT TERM HUP
  redact_outputs
  if [ "$KEEP" = 0 ]; then teardown; fi
  exit "$rc"
}
trap finish EXIT
trap 'warn "interrupted"; exit 130' INT TERM HUP

# --- 1. the throwaway checkout: HEAD plus this working tree's uncommitted changes, committed locally ---
stage() {
  local f pp lp mp kv
  say "staging the throwaway checkout in $STACK"
  claim_project   # dies on a foreign project before anything is touched; OWNED=1 from here on
  [ "$OWN_STATE" != ours ] || { warn "project $PROJECT: $OWN_WHY — removing those leftovers first"; teardown; }
  if [ -e "$STACK" ]; then
    [ -f "$STACK/.bedrock-now-e2e" ] || [ -z "$(ls -A "$STACK" 2>/dev/null)" ] ||
      die "$STACK exists and was not created by this suite — pick another --work (nothing was changed)"
    chmod -R u+rwX "$STACK" 2>/dev/null; rm -rf "$STACK"
  fi
  # A normal checkout's permissions (umask 022): containers read some of these files as other users.
  ( umask 022; git clone --quiet --no-hardlinks "$ROOT" "$STACK" ) || die "git clone failed"
  : > "$STACK/.bedrock-now-e2e"   # marks the folder as the suite's own (teardown deletes only such a folder)
  printf '/.bedrock-now-e2e\n' >> "$STACK/.git/info/exclude"
  if ! (cd "$ROOT" && git diff --quiet HEAD); then
    ( cd "$ROOT" && git diff HEAD --binary ) | ( umask 022; git -C "$STACK" apply --whitespace=nowarn ) ||
      die "the uncommitted changes of $ROOT do not apply to a clean clone of HEAD — commit or stash them first"
  fi
  ( cd "$ROOT" && git ls-files --others --exclude-standard -z ) | while IFS= read -r -d '' f; do
    case "$f" in tests/e2e/out/* | tests/e2e/work/*) continue ;; esac
    ( umask 022; mkdir -p "$STACK/$(dirname "$f")" && cp -p "$ROOT/$f" "$STACK/$f" ) || exit 1
  done || die "could not copy the untracked files into $STACK"
  git -C "$STACK" add -A
  git -C "$STACK" -c user.name=bedrock-now-e2e -c user.email=e2e@example.invalid commit -q -m "e2e: working tree" --allow-empty
  # Seed .env: names, ports and small budgets for this throwaway (setup keeps what is set). The portal password is
  # generated here and marked as shown, so setup's summary never prints it.
  cp "$STACK/.env.example" "$STACK/.env"; chmod 600 "$STACK/.env"
  pick_port pp 18480; pick_port lp 14480; pick_port mp 18865
  set_env COMPOSE_PROJECT_NAME "$PROJECT"; set_env PORTAL_HOST "$HOST"; set_env PORTAL_PORT "$pp"
  set_env LITELLM_PORT "$lp"; set_env SHARED_MCP_PORT "$mp"
  set_env OPENWEBUI_ADMIN_EMAIL "e2e-admin@example.com"
  for kv in $BUDGETS; do set_env "${kv%%=*}" "${kv#*=}"; done
  set_env PORTAL_PASSWORD "$(openssl rand -hex 10)"
  ( umask 022; mkdir -p "$STACK/.state/update-check" )
  chmod 700 "$STACK/.state"; : > "$STACK/.state/portal-password-shown"
  # The portal's daily release check counts as done: no GitHub call during the run, and nothing races the update
  # card's own (fake) latest.json. Its age decides the next check (24 h), so the portal never asks GitHub here.
  printf '{"checked_at": "%s", "error": null}\n' "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)" > "$STACK/.state/update-check/latest.json"
  chmod 644 "$STACK/.state/update-check/latest.json"
  say "throwaway: project $PROJECT, http://$HOST:$pp  (LiteLLM 127.0.0.1:$lp, shared-mcp 127.0.0.1:$mp)"
}

# ======================================================================================================
if [ "$REUSE" = 1 ]; then
  reuse_check   # marker, .env project, owner marker = $STACK, every service running and healthy; OWNED=1
  say "reusing the throwaway in $STACK"
else
  stage
  say "setup (non-interactive; a few minutes; log: $LOGS/cli-setup.log)"
  cli setup 0 'bedrock-now is up' --aws setup --yes || {
    tail -n 40 "$LOGS/cli-setup.log" >&2; die "setup failed — see $LOGS/cli-setup.log (redacted)"; }
fi
[ -n "$(get_env PORTAL_PASSWORD)" ] || die "the throwaway .env has no PORTAL_PASSWORD"
for k in PORTAL_PORT LITELLM_PORT SHARED_MCP_PORT; do
  case "$AVOID_PORTS" in *" $(get_env "$k") "*) die "throwaway uses a reserved port ($k=$(get_env "$k"))" ;; esac
done
spend_start   # with --reuse: only this run's spend is counted

# --- 2. read-only CLI checks ---
if ! part_on cli; then record cli read-only SKIP 0 "--only $ONLY"; else
  say "CLI: read-only commands"
  cli help 0 'Usage: ./stack' help
  cli unknown-command 1 'unknown command' bogus-command
  cli status 0 'portal +running +healthy' status
  cli status-disk 0 'Disk: images' status --disk
  cli costs 0 'Spend this budget period' costs
  cli models 0 'Model access for your AWS key' models
  cli test 0 'all checks passed' test
  for s in portal caddy litellm; do follow_logs "logs-$s" "$s"; done
  imgs_before="$(docker image ls -q --no-trunc | sort)"
  if st clean --help 2>&1 | grep -q -- '--dry-run'; then
    cli clean-dry-run 0 'nothing to clean|Would remove' clean --dry-run
    if [ "$(docker image ls -q --no-trunc | sort)" = "$imgs_before" ]; then record cli clean-dry-run-removes-nothing PASS 0 "image list unchanged"
    else record cli clean-dry-run-removes-nothing FAIL 0 "images changed during clean --dry-run"; fi
  else record cli clean-dry-run SKIP 0 "no clean --dry-run on this branch"; fi
  cli helper-status 0 'Update helper: not installed' helper status
  # setup --yes turns Bedrock speech-to-text on when Voxtral's check succeeded (the throwaway's key can use it)
  cli stt-status 0 'Speech-to-text: on — Bedrock Mistral Voxtral Small.*estimated' stt status
  cli remote-status 0 'Remote access: off' remote status
  cli openrouter-status 0 'OpenRouter: off' openrouter status
  cli serve-stop 0 'is not running' serve --stop
  cli ssh-info 0 'Claude Code \(claude-bedrock\) from your phone' ssh-info
  if st help 2>&1 | grep -qE '^  password'; then
    cli password 0 'PORTAL_PASSWORD in .*\.env' password
    # --show prints only to a terminal: here (none) it must refuse, and the output must not hold the password
    t0="$(now)"; raw="$(st password --show 2>&1)"; rc=$?
    if [ "$rc" != 0 ] && ! env_has PORTAL_PASSWORD "$raw"; then
      record cli password-show-no-tty PASS "$(( $(now) - t0 ))" "refused without a terminal (exit $rc), password not printed"
    else record cli password-show-no-tty FAIL "$(( $(now) - t0 ))" "exit $rc; password printed without a terminal?"; fi
    unset raw
  else record cli password SKIP 0 "no ./stack password on this branch"; fi
  # --help for every command (never runs the command itself)
  t0="$(now)"; bad=''
  for c in $(st help 2>/dev/null | awk '/^  [a-z]/ { print $1 }') down; do
    out="$(st "$c" --help 2>&1)" && printf '%s' "$out" | grep -q "Usage: ./stack $c" || bad="$bad $c"
  done
  if [ -z "$bad" ]; then record cli help-every-command PASS "$(( $(now) - t0 ))" "every ./stack <command> --help prints its usage"
  else record cli help-every-command FAIL "$(( $(now) - t0 ))" "no usage from --help:$bad"; fi
  cli uninstall-abort 1 'aborted — nothing was removed' uninstall --yes
  record cli open SKIP 0 "opens a GUI browser window (no headless mode)"
fi

# --- 3. the browser suite (Playwright container) ---
# browser_run LABEL [FILTER [TAG]] — the suite (or the checks matching FILTER; their results named id@TAG), then a
# runner check: a crash, a non-zero exit or fewer results than selected checks is a FAIL
browser_run() {
  local label="$1" filter="${2:-}" tag="${3:-}" t0 rc got want
  t0="$(now)"; E2E_TAG="$tag" "$HERE/browser.sh" "$STACK" "$OUT" "$PROJECT" "$PW_IMAGE" "$filter"; rc=$?
  got="$(grep -c . "$OUT/browser/results.tsv" 2>/dev/null || true)"; got="${got:-0}"
  want="$(cat "$OUT/browser/expected.txt" 2>/dev/null || echo '?')"
  [ -f "$OUT/browser/results.tsv" ] && cat "$OUT/browser/results.tsv" >> "$RESULTS"
  if [ "$rc" != 0 ] || [ "$got" = 0 ] || [ "$got" != "$want" ]; then
    record browser "runner${tag:+@$tag}" FAIL "$(( $(now) - t0 ))" "$label: exit $rc, $got of $want checks reported (see $OUT/browser/run.log)"
  else record browser "runner${tag:+@$tag}" PASS "$(( $(now) - t0 ))" "$label: $got checks reported"; fi
}
if ! part_on browser; then record browser suite SKIP 0 "--only $ONLY"; else
  say "browser suite (Playwright container)"
  browser_run "full suite"
fi

# --- 3b. voice: the stt container's isolation, and Bedrock speech-to-text off and on again ---
# stt_probe — inside the stt container (its own Python): what it can reach. Prints "name<TAB>result" lines.
stt_probe() {
  docker exec -i "$1" python3 - <<'PY'
import http.client, socket
def tcp(host, port):
    try:
        socket.create_connection((host, port), 4).close(); return "open"
    except Exception as e:
        return "closed (%s)" % type(e).__name__
def get(path, host="caddy:8090"):
    try:
        c = http.client.HTTPConnection(host.split(":")[0], int(host.split(":")[1]), timeout=6)
        c.request("GET", path); return str(c.getresponse().status)
    except Exception as e:
        return "error (%s)" % type(e).__name__
for name, h, p in (("open-webui", "open-webui", 8080), ("portal", "portal", 8000), ("litellm", "litellm", 4000),
                   ("internet-ip", "1.1.1.1", 443), ("internet-dns", "example.com", 443), ("postgres", "postgres", 5432),
                   ("rustfs", "rustfs", 9000)):
    print("%s\t%s" % (name, tcp(h, p)))
for path in ("/healthz", "/v1/audio/transcriptions", "/v1/models", "/", "/api/v1/auths/"):
    print("caddy8090%s\t%s" % (path, get(path)))
PY
}
if ! part_on voice; then record voice voice SKIP 0 "--only $ONLY"
elif [ "$(get_env STT_PROVIDER)" != bedrock ]; then
  record voice bedrock-stt-on-after-setup FAIL 0 "setup did not turn Bedrock speech-to-text on (STT_PROVIDER=$(get_env STT_PROVIDER)) — see $LOGS/cli-setup.log"
else
  say "voice: speech-to-text isolation and off/on round trip"
  record voice bedrock-stt-on-after-setup PASS 0 "STT_PROVIDER=bedrock, Open WebUI engine $(get_env OWUI_STT_ENGINE)"
  t0="$(now)"
  sttc="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=stt)"
  owc="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=open-webui)"
  if [ -z "$sttc" ] || [ -z "$owc" ]; then record voice stt-isolation FAIL 0 "no running stt / open-webui container"
  else
    probe="$(stt_probe "$sttc" 2>&1)"; printf '%s\n' "$probe" > "$LOGS/voice-stt-isolation.log"
    bad=''
    for k in open-webui portal internet-ip internet-dns postgres rustfs; do
      printf '%s\n' "$probe" | grep -q "^$k	closed" || bad="$bad $k:$(printf '%s\n' "$probe" | awk -F'\t' -v k="$k" '$1 == k { print $2 }')"
    done
    printf '%s\n' "$probe" | grep -q '^litellm	open' || bad="$bad litellm-not-reachable"
    for kv in /healthz=200 /v1/audio/transcriptions=405 /v1/models=404 /=404 /api/v1/auths/=404; do
      printf '%s\n' "$probe" | grep -q "^caddy8090${kv%%=*}	${kv#*=}\$" || bad="$bad caddy:8090${kv%%=*}:$(printf '%s\n' "$probe" | awk -F'\t' -v k="caddy8090${kv%%=*}" '$1 == k { print $2 }')"
    done
    # Open WebUI reaches it only through Caddy's :8090 (it is not on the stt network)
    ow="$(docker exec "$owc" sh -c 'curl -s -m 5 -o /dev/null -w "%{http_code}" http://caddy:8090/healthz; echo " $(curl -s -m 3 -o /dev/null -w "%{http_code}" http://stt:8000/healthz || echo unreachable)"' 2>&1)"
    case "$ow" in "200 unreachable"* | "200 000"*) ;; *) bad="$bad open-webui-path:$ow" ;; esac
    if [ -z "$bad" ]; then
      record voice stt-isolation PASS "$(( $(now) - t0 ))" "stt reaches only LiteLLM (+ Caddy); no Open WebUI, portal, Postgres, RustFS or internet; Caddy :8090 serves only /healthz and /v1/audio/transcriptions; Open WebUI → caddy:8090 only"
    else record voice stt-isolation FAIL "$(( $(now) - t0 ))" "unexpected:$bad (log $LOGS/voice-stt-isolation.log)"; fi
  fi
  cli stt-remove 0 'speech-to-text removed' stt remove
  cli stt-status-off 0 'Speech-to-text: browser \(Web Speech\)' stt status
  browser_run "speech-to-text off" 'browser/(home-voice-line|chat-voice-call|stt-transcription)$' stt-off
  cli stt-set-bedrock 0 'Voxtral' stt set bedrock
  cli stt-status-on-again 0 'Speech-to-text: on — Bedrock Mistral Voxtral Small.*estimated' stt status
  browser_run "speech-to-text on again" 'browser/(home-voice-line|chat-voice-call|stt-transcription)$' stt-on-again
fi

# --- 4. claude-bedrock (the throwaway's wrapper, never the ~/.local/bin link) ---
if ! part_on claude; then record claude claude-bedrock SKIP 0 "--only $ONLY"
elif [ "$NO_CLAUDE" = 1 ]; then record claude claude-bedrock SKIP 0 "--no-claude"
elif ! command -v claude >/dev/null 2>&1; then record claude claude-bedrock SKIP 0 "Claude Code (claude) is not installed"
else
  say "claude-bedrock -p (Haiku, one short prompt)"
  t0="$(now)"; log="$LOGS/claude-bedrock.log"; haiku="$(get_env CLAUDE_BEDROCK_HAIKU_MODEL)"
  # Its own CLAUDE_CONFIG_DIR and an empty working folder: your ~/.claude and this checkout's files stay out of it.
  mkdir -p "$OUT/claude-config" "$OUT/claude-cwd"
  ( export CLAUDE_CONFIG_DIR="$OUT/claude-config" CLAUDE_BEDROCK_MODEL="$haiku" CLAUDE_BEDROCK_SUMMARY=1
    clean_env CLAUDE_CONFIG_DIR CLAUDE_BEDROCK_MODEL CLAUDE_BEDROCK_SUMMARY
    cd "$OUT/claude-cwd" && exec "$NOTTY" "$STACK/bin/claude-bedrock" -p "Reply with exactly the word: ok" --max-turns 1 ) > "$log" 2>&1 </dev/null; rc=$?
  redact "$log"
  if [ "$rc" = 0 ] && grep -qiE '^ok\.?$' "$log" && grep -q '^bedrock · ' "$log"; then
    record claude claude-bedrock PASS "$(( $(now) - t0 ))" "answered ok via $haiku; cost line shown"
  else record claude claude-bedrock FAIL "$(( $(now) - t0 ))" "exit $rc: $(tail -n 3 "$log" | tr '\n' ' ')"; fi
  t0="$(now)"; out="$( (clean_env; cd "$OUT/claude-cwd" && exec "$NOTTY" "$STACK/bin/claude-bedrock" --help) 2>&1 </dev/null)"
  if printf '%s' "$out" | grep -q 'claude-bedrock: Claude Code on AWS Bedrock via bedrock-now'; then
    record claude claude-bedrock-help PASS "$(( $(now) - t0 ))" "wrapper header + claude --help"
  else record claude claude-bedrock-help FAIL "$(( $(now) - t0 ))" "no wrapper header"; fi
fi

# --- 5. CLI commands that change the throwaway (backup/restore, down/up, rotate-aws, update, rollback) ---
if [ "$SKIP_MUTATING" = 1 ] || ! part_on mutating; then
  record cli mutating SKIP 0 "--skip-cli-mutating / --only $ONLY"
else
  say "CLI: commands that change the stack"
  cli backup 0 'backup written to backups/' backup
  bk=''
  for d in "$STACK"/backups/2*; do case "$d" in *-auto | *.partial) ;; *) [ -d "$d" ] && bk="$d" ;; esac; done
  miss=''
  if [ -n "$bk" ]; then
    for f in litellm.dump openwebui.dump .env s3/openwebui s3/shared; do [ -e "$bk/$f" ] || miss="$miss $f"; done
    for f in litellm.dump openwebui.dump; do [ -s "$bk/$f" ] || miss="$miss $f(empty)"; done
    [ "$(perm_of "$bk")" = 700 ] || miss="$miss mode-$(perm_of "$bk")"
  fi
  if [ -n "$bk" ] && [ -z "$miss" ]; then
    record cli backup-contents PASS 0 "litellm.dump openwebui.dump s3/openwebui s3/shared .env, mode 700"
    spend_cut
    cli restore 0 'all checks passed' restore "backups/${bk##*/}" --yes
    # The path ./stack prints ("./stack restore backups/<ts>") and ./stack rollback passes on is relative to the
    # checkout: it must work from another folder too (e.g. ~/bedrock-now/stack restore run from $HOME).
    ST_CWD=/ cli restore-from-another-folder 0 'all checks passed' restore "backups/${bk##*/}" --yes
    spend_resume
  else record cli backup-contents FAIL 0 "no complete backup directory (${bk:-none}; missing:${miss:- all})"; fi
  cli down 0 '' down
  cli status-after-down 0 'not running|not created|exited' status
  cli up 0 'portal +running +healthy' up --yes
  cli rotate-aws-same-key 0 'all checks passed' --aws rotate-aws --yes
  head="$(git -C "$STACK" rev-parse HEAD)"
  cli update-same-version 0 'already on|no new version' update --to "$head" --yes
  cli rollback-nothing 1 'nothing to roll back' rollback --yes
  if [ "$DEEP_UPDATE" = 1 ]; then
    git -C "$STACK" -c user.name=bedrock-now-e2e -c user.email=e2e@example.invalid commit -q --allow-empty -m "e2e: next version"
    next="$(git -C "$STACK" rev-parse HEAD)"; git -C "$STACK" -c advice.detachedHead=false checkout -q "$head"
    cli update-to-next 0 'updated to' update --to "$next" --yes
    # from another folder: rollback hands restore an absolute backup path
    spend_cut
    ST_CWD=/ cli rollback-from-another-folder 0 'rolled back to' rollback --yes
    spend_resume
    if [ "$(git -C "$STACK" rev-parse HEAD)" = "$head" ]; then record cli rollback-code PASS 0 "HEAD back at $(git -C "$STACK" rev-parse --short HEAD)"
    else record cli rollback-code FAIL 0 "HEAD is $(git -C "$STACK" rev-parse --short HEAD), want ${head:0:7}"; fi
  fi
  cli test-after-mutating 0 'all checks passed' test
fi

# --- 6. spend guard (this run's spend; restores put LiteLLM's spend log back, so it is summed around them) ---
spend="$(spend_total 2> "$LOGS/spend.err")"
if [ -z "$spend" ]; then record spend spend-guard FAIL 0 "LiteLLM /global/spend did not answer ($(cat "$LOGS/spend.err" 2>/dev/null)) — this run's spend is unknown"
elif spend_ok "$spend" "$SPEND_LIMIT"; then record spend spend-guard PASS 0 "Bedrock spend of this run \$$spend < \$$SPEND_LIMIT"
else record spend spend-guard FAIL 0 "Bedrock spend of this run \$$spend >= \$$SPEND_LIMIT"; fi
printf 'Bedrock spend of this run (LiteLLM /global/spend, summed around restores): $%s\n' "${spend:-unknown}" > "$OUT/spend.txt"

# --- 7. the default install's claude-bedrock link (and the file it points to) is untouched ---
LINK_AFTER="$(link_state)"
if [ "$LINK_AFTER" = "$LINK_BEFORE" ]; then record safety claude-bedrock-link-untouched PASS 0 "$LINK_AFTER"
else record safety claude-bedrock-link-untouched FAIL 0 "before: $LINK_BEFORE, after: $LINK_AFTER"; fi

# --- 8. report ---
redact_outputs
if [ "$KEEP" = 1 ]; then say "kept the throwaway (tests/e2e/run.sh --teardown --project $PROJECT removes it)"
else trap - EXIT INT TERM HUP; teardown; fi
"$HERE/report.sh" "$RESULTS" "$HERE/known-issues.tsv" "$OUT" "$(( $(now) - START_TS ))" "${spend:-unknown}"
