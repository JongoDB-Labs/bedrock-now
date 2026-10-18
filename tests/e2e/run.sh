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
#   E2E_CHECKS=REGEX only the browser checks whose suite/id matches (a Python regex, on top of each pass's own
#                    filter): a focused run that spends less on Bedrock, e.g. E2E_CHECKS='code-settings-row|code-auto'
#   (default)        the Code page and its browser terminal are on, as on a new install: setup turns them on by
#                    default, in a workspace folder next to the checkout (TERMINAL_WORKSPACE, seeded): the terminal's
#                    isolation probe, the browser suite's terminal checks and, with the claude part, one
#                    claude-bedrock -p inside it (~$0.02); the Code page's isolation probe, its Caddy combinations, the
#                    browser suite's code checks (a few dozen Haiku turns, ~$0.17 on the terminal's key, whose budget
#                    becomes $0.30) and, after the suite, a hostile stand-in on bn-coded's socket
#   --no-code        the Code page off, as a person who turned it off (CODE_ENABLED=false; E2E_NO_CODE=1 does the
#                    same): its tab's "off" page; the terminal off too, unless --terminal (./stack terminal enable,
#                    its own key with a budget of $0.06)
#   --terminal       with --no-code: the browser terminal on (E2E_TERMINAL=1 does the same)
#   --code           the default (kept for older scripts; E2E_CODE=1 does the same)
#   --git-server     the Git panel's remotes against a git server of the suite's own (E2E_GIT_SERVER=1 does the same):
#                    tests/e2e/gitsrv — HTTPS with a token and its own CA, SSH taking any key — started after setup on
#                    the throwaway's terminal-out network as "gitsrv", which needs TERMINAL_EGRESS=host there (the egress
#                    proxy never reaches private addresses): the throwaway is set up that way, and terminal-isolation
#                    (whose checks are the proxy's) skips. browser/code-ui-git-remotes then connects both kinds of Git
#                    host, clones, pushes, publishes, pulls. Never a real git host; no model calls.
#   --helper         also run the throwaway's update helper (E2E_HELPER=1 does the same), so the settings/* checks run:
#                    its own bin/bedrock-now-helper in the foreground, as a background child of this run (never
#                    ./stack helper install: no launchd agent, no systemd unit), SETTINGS_MIN_INTERVAL_S=5, log in
#                    OUT/logs/helper.log. The browser part then runs in three passes: every other check first (those
#                    that fake the helper or need it absent), settings/* while the helper runs, then final/ (sign-out).
#                    It is stopped right after settings/* — and on any exit (failure, Ctrl-C). helper/update-helper in
#                    the results says whether it ran.
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
TERMINAL=0; [ "${E2E_TERMINAL:-0}" != 1 ] || TERMINAL=1
CODE=1; [ "${E2E_NO_CODE:-0}" != 1 ] || CODE=0   # (on by default, as on a new install; E2E_CODE=1 is that too)
HELPER=0; [ "${E2E_HELPER:-0}" != 1 ] || HELPER=1
GIT_SERVER=0; [ "${E2E_GIT_SERVER:-0}" != 1 ] || GIT_SERVER=1
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
    --terminal) TERMINAL=1; shift ;;
    --code) CODE=1; shift ;;
    --no-code) CODE=0; shift ;;
    --helper) HELPER=1; shift ;;
    --git-server) GIT_SERVER=1; shift ;;
    --only) ONLY="${2:?--only needs a list (cli,browser,voice,claude,mutating)}"; shift 2 ;;
    -h | --help) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (tests/e2e/run.sh --help)" >&2; exit 2 ;;
  esac
done

[ "$CODE" = 0 ] || TERMINAL=1   # (the Code page runs in the terminal's sandbox)

# shellcheck source=tests/e2e/lib.sh
. "$HERE/lib.sh"
# shellcheck source=lib/ports.sh
. "$ROOT/lib/ports.sh"   # port_in_use (lsof → ss → /dev/tcp), the same check ./stack uses

for part in $(printf '%s' "$ONLY" | tr ',' ' '); do
  case "$part" in cli | browser | voice | claude | mutating) ;; *) echo "--only: unknown part '$part' (cli, browser, voice, claude, mutating)" >&2; exit 2 ;; esac
done
part_on() { case ",$ONLY," in *",$1,"*) return 0 ;; esac; return 1; }   # part_on PART -> 0 when --only includes it
# The terminal's claude-bedrock -p (browser suite) is a second Claude Code run, on the terminal's own key.
if [ "$TERMINAL" = 1 ]; then BUDGETS="$BUDGETS BUDGET_TERMINAL=0.06"; SPEND_LIMIT="0.16"; fi
# The Code page's checks: a few dozen Haiku turns (each new session writes ~26k tokens of prompt cache) on that key —
# about $0.17 of it in a full run (Read only and Bypass permissions included), with the terminal's claude-bedrock -p
# after them on the same key.
if [ "$CODE" = 1 ]; then BUDGETS="${BUDGETS% BUDGET_TERMINAL=*} BUDGET_TERMINAL=0.30"; SPEND_LIMIT="0.40"; fi
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
  [ -z "$HELPER_PID" ] || { warn "stopping the update helper"; e2e_helper_stop; }
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
  # The Code page (on by default) and its terminal: setup turns them on in a folder of the suite's own next to the
  # checkout (never one in your home folder); --no-code turns it off as a person would (and the terminal unless
  # --terminal, which ./stack terminal enable turns on after setup)
  if [ "$CODE" = 1 ]; then
    tws="$(terminal_workspace_dir)"
    [ ! -e "$tws" ] || [ -f "$tws/.bedrock-now-e2e" ] || die "$tws exists and was not created by this suite — nothing was changed"
    ( umask 077; mkdir -p "$tws" ) && : > "$tws/.bedrock-now-e2e"
    set_env TERMINAL_WORKSPACE "$tws"
  else
    set_env CODE_ENABLED false
    [ "$TERMINAL" = 1 ] || set_env TERMINAL_ENABLED false
  fi
  # --git-server: the sandbox on the terminal-out network, where the suite's git server joins it
  [ "$GIT_SERVER" = 0 ] || set_env TERMINAL_EGRESS host
  ( umask 022; mkdir -p "$STACK/.state/update-check" )
  chmod 700 "$STACK/.state"; : > "$STACK/.state/portal-password-shown"
  # The portal's daily release check counts as done: no GitHub call during the run, and nothing races the update
  # card's own (fake) latest.json. Its age decides the next check (24 h; Home asks for one after 3 h), so the portal
  # never asks GitHub here.
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

# --- 1b. the browser terminal (--terminal): on, with a workspace folder of the suite's own next to the checkout ---
# terminal_probe CONTAINER HOST_ADDR — inside the terminal: what it can reach. Prints "name<TAB>result" lines.
# HOST_ADDR: Docker's address for this computer (host-gateway; on Docker Desktop its loopback services answer there).
terminal_probe() {
  docker exec -i -e HG="$2" -e LP="$(get_env LITELLM_PORT)" -e PP="$(get_env PORTAL_PORT)" "$1" bash -s <<'SH'
tcp() { if timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; then echo open; else echo closed; fi; }
for t in portal:8000 open-webui:8080 postgres:5432 rustfs:9000 litellm:4000 shared-mcp:8000 stt:8000 caddy:8080 \
         gateway:8080 gateway:8090 gateway:8081 gateway:7681 gateway:7682 gateway:80; do
  printf '%s\t%s\n' "$t" "$(tcp "${t%%:*}" "${t##*:}")"
done
g=http://gateway:8091
code() { curl -s -m 10 -o /dev/null -w '%{http_code}' "$@" || true; }
printf 'gateway-litellm\t%s\n' "$(code $g/health/liveliness)"
printf 'gateway-mcp-no-token\t%s\n' "$(code -X POST $g/mcp)"
printf 'gateway-mcp-tools\t%s\n' "$(curl -s -m 20 -H "Authorization: Bearer $SHARED_MCP_TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' $g/mcp | grep -c search_knowledge)"
printf 'gateway-key\t%s\n' "$(code -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" $g/key/info)"
printf 'gateway-models\t%s\n' "$(code -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" $g/v1/models)"
# Claude Code's token count, within the key's routes (no model call)
printf 'gateway-count-tokens\t%s\n' "$(code -X POST -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$ANTHROPIC_DEFAULT_HAIKU_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" $g/v1/messages/count_tokens)"
# LiteLLM's admin UI and API, and the Bedrock pass-through that signs with the stack's AWS credentials: not here
printf 'gateway-ui\t%s\n' "$(code $g/ui/)"
printf 'gateway-key-generate\t%s\n' "$(code -X POST -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" $g/key/generate)"
printf 'gateway-bedrock\t%s\n' "$(code -X POST -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" $g/bedrock/model/x/converse)"
printf 'gateway-spend-logs\t%s\n' "$(code -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" $g/spend/logs)"
printf 'gateway-chat-completions\t%s\n' "$(code -X POST -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" $g/v1/chat/completions)"
# paths the gateway would match cleaned but forward as sent (to LiteLLM's /bedrock/… pass-through)
printf 'gateway-unclean\t%s\n' "$(for p in /bedrock/model/x/converse/../../../../v1/messages /v1/messages/../../bedrock/model/x/converse \
  /v1/messages/%2e%2e/%2e%2e/bedrock/model/x/converse /v1/messages/..%2f..%2fbedrock/model/x/converse //v1/messages; do
  code --path-as-is -X POST -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" "$g$p"; printf ' '; done)"
# LiteLLM past the gateway, through this computer's loopback (Docker Desktop): the key works only on its routes
lb=http://$HG:$LP
printf 'loopback-litellm\t%s\n' "$(code -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" $lb/v1/models; printf ' '
  for p in /bedrock/model/x/converse /v1/chat/completions /v1/embeddings; do
    code -X POST -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -H 'Content-Type: application/json' -d '{}' "$lb$p"; printf ' '; done
  code --path-as-is -X POST -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -d '{}' "$lb/v1/messages/../../bedrock/model/x/converse")"
# ttyd: no TCP listener at all (only Docker's DNS on 127.0.0.11); its socket answers in here (it is this shell)
printf 'ttyd-tcp\t%s\n' "$(code http://127.0.0.1:7681/)"
printf 'tcp-listeners\t%s\n' "$(awk '$4 == "0A" && $2 !~ /^0B00007F:/' /proc/net/tcp /proc/net/tcp6 | wc -l | tr -d ' ')"
printf 'ttyd-socket\t%s\n' "$(code --unix-socket /run/bn-ttyd/ttyd.sock http://terminal/)"
# bn-preview (the Code page's previews) on its socket in here, no TCP listener; without a port it answers 400
printf 'preview-socket\t%s\n' "$(code --unix-socket /run/bn-preview/preview.sock http://preview/)"
printf 'preview-secret-in-env\t%s\n' "$(cat /proc/1/environ /proc/self/environ 2>/dev/null | tr '\0' '\n' | grep -c PREVIEW_PROXY_SECRET || true)"
printf 'proxy-secret-in-env\t%s\n' "$(cat /proc/1/environ /proc/self/environ 2>/dev/null | tr '\0' '\n' | grep -c TERMINAL_PROXY_SECRET || true)"
# (getent hosts asks for IPv6 first, from /etc/hosts or else Docker's DNS; ahostsv4 for IPv4)
printf 'host-docker-internal\t%s\n' "$(for h in host.docker.internal gateway.docker.internal; do getent hosts "$h"; getent ahostsv4 "$h"; done | awk '{ print $1 }' | sort -u | tr '\n' ' ')"
printf 'internet\t%s\n' "$(code https://registry.npmjs.org/)"
printf 'master-key-in-env\t%s\n' "$(env | grep -c LITELLM_MASTER_KEY || true)"
printf 'user\t%s\n' "$(id -u)"
printf 'workspace\t%s\n' "$(ls -a /workspace | tr '\n' ' ')"
printf 'docker-socket\t%s\n' "$(ls /var/run/docker.sock /run/docker.sock 2>&1 | grep -c 'No such file')"
printf 'claude\t%s\n' "$(claude --version 2>&1 | head -n 1)"
printf 'make\t%s\n' "$(make --version 2>&1 | head -n 1)"
# --- its way out (TERMINAL_EGRESS=internet, the default): the egress proxy alone. Every process is told about it; nothing
# has a route around it; through it, public addresses work (curl, npm, pip, git, Node's fetch, ssh to port 22) and this
# computer, its published ports (this stack's own: LiteLLM's and the portal's), private, link-local, ULA and loopback
# addresses — also behind a public name — are refused (403) before any connection is made.
printf 'egress-env\t%s %s %s\n' "${HTTPS_PROXY:-none}" "${NODE_USE_ENV_PROXY:-none}" "$(printf '%s' "${NO_PROXY:-}" | tr ',' '\n' | grep -cx gateway)"
x() { env -u NO_PROXY -u no_proxy curl -g -x http://egress:3128 -s -m 15 "$@" || true; }
# no DNS way out: the internal networks resolve no outside names (Docker Engine 26+, CVE-2024-29018)
printf 'dns-outside\t%s\n' "$(getent hosts example.com >/dev/null 2>&1 && echo resolved || echo none)"
printf 'direct-internet\t%s\n' "$(curl --noproxy '*' -s -m 5 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/ || true)"
printf 'direct-host\t%s %s\n' "$(curl --noproxy '*' -s -m 5 -o /dev/null -w '%{http_code}' "http://$HG:$LP/" || true)" \
  "$(curl --noproxy '*' -s -m 5 -o /dev/null -w '%{http_code}' "http://$HG:$PP/" || true)"
# (the proxy logs at most 20 refusals per 10 s: a fresh window, and the ones the log is checked for first)
sleep 11
# (each: 1 = refused for the address the name resolves to; dns = nip.io itself did not resolve — an outside outage, not
# the proxy's doing: not counted as a failure)
printf 'proxy-rebind\t%s\n' "$(for u in http://127.0.0.1.nip.io/ http://10.255.255.1.nip.io/ http://169.254.169.254.nip.io/; do
  r="$(x "$u")"; case "$r" in *'resolves to'*) echo 1 ;; *'does not resolve'*) echo dns ;; *) echo 0 ;; esac; done | tr '\n' ' ')"
# (port 22 is open through it: this computer's address on it is refused for the address itself)
printf 'proxy-host-ssh\t%s\n' "$(x -o /dev/null -w '%{http_connect}' "https://$HG:22/")"
printf 'proxy-host\t%s\n' "$(for u in "http://host.docker.internal:$LP/" "http://gateway.docker.internal:$LP/" "http://$HG:$LP/v1/models" "http://$HG:$PP/" \
  "http://127.0.0.1:$LP/" "http://localhost:$PP/" "http://[::1]:$LP/" "http://[::ffff:127.0.0.1]:$LP/"; do x -o /dev/null -w '%{http_code} ' "$u"; done)"
printf 'proxy-private\t%s\n' "$(for u in http://10.255.255.1/ http://172.31.255.254/ http://192.168.255.254/ http://100.100.100.100/ \
  http://169.254.169.254/latest/meta-data/ "http://[fd00::1]/" "http://[fe80::1]/" http://portal:8000/ http://litellm:4000/; do x -o /dev/null -w '%{http_code} ' "$u"; done)"
printf 'proxy-tls-private\t%s\n' "$(for u in https://10.255.255.1/ "https://$HG:$LP/" https://169.254.169.254/; do x -o /dev/null -w '%{http_connect} ' "$u"; done)"
printf 'proxy-port\t%s\n' "$(x -o /dev/null -w '%{http_connect}' https://registry.npmjs.org:25/)"
printf 'proxy-public\t%s %s\n' "$(curl -s -m 20 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/is-number || true)" \
  "$(curl -s -m 20 -o /dev/null -w '%{http_code}' http://example.com/ || true)"
printf 'node-fetch\t%s\n' "$(</dev/null node -e "fetch('https://registry.npmjs.org/is-number').then((r) => console.log(r.status), (e) => console.log('error', e.cause && e.cause.code))" 2>&1 | head -n 1)"
d="$(mktemp -d)"
printf 'npm-install\t%s\n' "$(cd "$d" && </dev/null npm install --no-audit --no-fund --loglevel=error is-number@7.0.0 >/dev/null 2>&1 && test -f node_modules/is-number/package.json && echo ok || echo failed)"
printf 'pip-download\t%s\n' "$(python3 -m pip download --no-deps -q -d "$d/pip" six==1.16.0 </dev/null >/dev/null 2>&1 && ls "$d/pip" | grep -c '^six-' || echo failed)"
rm -rf "$d"
printf 'git-https\t%s\n' "$(GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote </dev/null https://github.com/octocat/Hello-World.git HEAD 2>/dev/null | wc -l | tr -d ' ')"
# Claude Code's own WebFetch through the proxy (one Haiku turn, about a cent; informational: a model may decline)
printf 'claude-webfetch\t%s\n' "$(cd /tmp && timeout 150 claude -p --model "$ANTHROPIC_DEFAULT_HAIKU_MODEL" --allowedTools WebFetch --output-format text \
  'Use the WebFetch tool to fetch https://example.com/ and reply with only the text of its h1 heading.' </dev/null 2>&1 | tr '\n' ' ' | cut -c1-120)"
printf 'git-ssh\t%s\n' "$(timeout 30 ssh -n -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -T git@github.com 2>&1 | grep -c 'Permission denied (publickey)')"
SH
}
if [ "$TERMINAL" = 1 ]; then
  if [ "$(get_env TERMINAL_ENABLED)" != true ]; then
    tws="$(terminal_workspace_dir)"
    [ ! -e "$tws" ] || [ -f "$tws/.bedrock-now-e2e" ] || die "$tws exists and was not created by this suite — nothing was changed"
    ( umask 077; mkdir -p "$tws" ) && : > "$tws/.bedrock-now-e2e"
    say "terminal: ./stack terminal enable (its image is built the first time: a few minutes)"
    cli terminal-enable 0 'Terminal: on' terminal enable --workspace "$tws" || die "terminal enable failed — see $LOGS/cli-terminal-enable.log"
  fi
  cli terminal-status 0 'Workspace .*-workspace → /workspace' terminal status
  t0="$(now)"
  tc="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=terminal)"
  if [ "$GIT_SERVER" = 1 ]; then record terminal terminal-isolation SKIP 0 "TERMINAL_EGRESS=host for the suite's git server (--git-server): the egress proxy's checks do not apply"
  elif [ -z "$tc" ]; then record terminal terminal-isolation FAIL 0 "no running terminal container"
  else
    # (on Docker's default bridge: with --network none, --add-host writes no hosts entry)
    hg="$(docker run --rm --add-host hg:host-gateway --entrypoint getent "$PROJECT/terminal:local" ahostsv4 hg 2>/dev/null | awk 'NR == 1 { print $1 }')"
    probe="$(terminal_probe "$tc" "${hg:-192.0.2.1}" 2>&1)"; printf '%s\n' "$probe" > "$LOGS/terminal-isolation.log"; redact "$LOGS/terminal-isolation.log"
    bad=''
    for k in portal:8000 open-webui:8080 postgres:5432 rustfs:9000 litellm:4000 shared-mcp:8000 stt:8000 caddy:8080 \
             gateway:8080 gateway:8090 gateway:8081 gateway:7681 gateway:7682 gateway:80; do
      printf '%s\n' "$probe" | grep -q "^$k	closed" || bad="$bad $k-reachable"
    done
    for kv in gateway-litellm=200 gateway-mcp-no-token=401 gateway-mcp-tools=1 gateway-key=200 gateway-models=200 gateway-count-tokens=200 gateway-ui=404 \
              gateway-key-generate=404 gateway-bedrock=404 gateway-spend-logs=404 gateway-chat-completions=404 \
              gateway-unclean="404 404 404 404 404 " ttyd-tcp=000 tcp-listeners=0 ttyd-socket=200 proxy-secret-in-env=0 \
              preview-socket=400 preview-secret-in-env=0 \
              host-docker-internal="100::1 192.0.2.1 " internet=200 master-key-in-env=0 docker-socket=2 \
              egress-env="http://egress:3128 1 1" dns-outside=none direct-internet=000 direct-host="000 000" \
              proxy-host="403 403 403 403 403 403 403 403 " proxy-private="403 403 403 403 403 403 403 403 403 " \
              proxy-host-ssh=403 proxy-tls-private="403 403 403 " proxy-port=403 proxy-public="200 200" node-fetch=200 \
              npm-install=ok pip-download=1 git-https=1 git-ssh=1; do
      printf '%s\n' "$probe" | grep -q "^${kv%%=*}	${kv#*=}\$" || bad="$bad ${kv%%=*}:$(printf '%s\n' "$probe" | awk -F'\t' -v k="${kv%%=*}" '$1 == k { print $2 }')"
    done
    [ "$(printf '%s\n' "$probe" | awk -F'\t' '$1 == "user" { print $2 }')" = "$(id -u)" ] || bad="$bad not-your-uid"
    # DNS rebinding: a public name resolving to a refused address is refused for the address; when nip.io itself is
    # unreachable (an outside DNS outage) that one is not checked, and said
    rebind_note=""; rb="$(printf '%s\n' "$probe" | awk -F'\t' '$1 == "proxy-rebind" { print $2 }')"
    case "$rb" in *0*|"") bad="$bad proxy-rebind:$rb" ;; *dns*) rebind_note=" (DNS rebinding not checked: nip.io did not resolve)" ;; esac
    # LiteLLM through this computer's loopback: with the egress proxy (the default) refused by it, and no route around
    # it (direct-host above); with TERMINAL_EGRESS=host reachable on Docker Desktop (the 200 shows it), but the key gets
    # 403 off its routes (and 404 for a ../ path, which LiteLLM routes nowhere)
    lbr="$(printf '%s\n' "$probe" | awk -F'\t' '$1 == "loopback-litellm" { print $2 }')"
    case "$(uname -s):$lbr" in *:"403 403 403 403 403") ;; *) bad="$bad loopback-litellm:$lbr" ;; esac
    printf '%s\n' "$probe" | grep -q '^claude	[0-9.]* (Claude Code)' || bad="$bad no-claude"
    printf '%s\n' "$probe" | grep -q '^make	GNU Make [0-9]' || bad="$bad no-make"
    # the proxy's log: each refusal, with the address and why — never a path
    eg="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=terminal-egress)"
    elog="$(docker logs "$eg" 2>&1)"; printf '%s\n' "$elog" > "$LOGS/terminal-egress.log"
    printf '%s\n' "$elog" | grep -q '"event":"refused".*"host":"169.254.169.254".*"why":"link-local' || bad="$bad egress-log-no-refusal"
    printf '%s\n' "$elog" | grep -q 'meta-data' && bad="$bad egress-log-has-a-path"
    case "$rb" in 1*) printf '%s\n' "$elog" | grep -q '"address":"127.0.0.1".*resolves to 127.0.0.1' || bad="$bad egress-log-no-rebind" ;; esac
    printf '%s\n' "$elog" | grep -q "\"port\":22,\"address\":\"$hg\",\"status\":403" || bad="$bad egress-log-no-host-gateway"
    [ "$(docker inspect -f '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}' "$eg" 2>/dev/null)" = "65534:65534 true [ALL]" ] ||
      bad="$bad egress-not-hardened"
    # Its key is its own (claude-code-terminal), never the claude-code key of claude-bedrock on this computer
    ins="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$tc" 2>/dev/null)"
    ! env_has LITELLM_KEY_CLAUDE_CODE "$ins" || bad="$bad has-the-claude-code-key"
    env_has LITELLM_KEY_TERMINAL "$ins" || bad="$bad no-terminal-key"
    unset ins
    # The main Caddy shares no network with the terminal; through the gateway, ttyd wants the secret header
    cad="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=caddy)"
    out="$(docker exec "$cad" sh -c 'wget -q -T 4 -O /dev/null http://terminal:7681/ 2>&1 | head -n 1; wget -S -T 10 -O /dev/null --header "X-Portal-User: admin@example.com" http://terminal-upstream:7681/ 2>&1 | awk "/^  HTTP\// { print \$2; exit }"' 2>&1)"
    case "$out" in *"bad address"*407* | *"resolve"*407*) ;; *) bad="$bad main-caddy:$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-80)" ;; esac
    # The gateway's own neighbours: LiteLLM (and shared-mcp, the main Caddy), never the portal, Open WebUI or the data
    tgw="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=terminal-gateway)"
    out="$(docker exec "$tgw" sh -c 'for h in portal:8000 open-webui:8080 postgres:5432 rustfs:9000 stt:8000; do wget -q -T 3 -O /dev/null "http://$h/" 2>&1 | head -n 1 | grep -q "bad address" || echo "$h"; done; wget -q -T 5 -O /dev/null http://litellm:4000/health/liveliness || echo litellm-unreachable' 2>&1)"
    [ -z "$out" ] || bad="$bad gateway-neighbours:$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-80)"
    if [ -z "$bad" ]; then
      record terminal terminal-isolation PASS "$(( $(now) - t0 ))" "only the gateway's paths (LiteLLM's Anthropic API with its own key, shared-mcp's tools with the token and 401 without; 404 for /ui/, /key/generate, /bedrock/…, /spend/logs, /v1/chat/completions and ../ or // paths) and the internet through its egress proxy alone (no direct route: 000 to the registry and this computer, no outside names in its DNS; curl, Node's fetch, npm install, pip download, git over https and ssh work through it; refused with 403 before any connection: host.docker.internal, gateway.docker.internal, the host gateway's LiteLLM and portal ports, 127.0.0.1, localhost, ::1, ::ffff:127.0.0.1, 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254.169.254, fd00::1, fe80::1, the stack's containers by name, CONNECT to private addresses, port 25, and public names resolving to 127.0.0.1, 10.x and the metadata address; refusals logged without paths; the proxy runs as 65534, read-only, no capabilities); LiteLLM via the loopback ($lbr): refused; Claude Code's WebFetch: $(printf '%s\n' "$probe" | awk -F'\t' '$1 == "claude-webfetch" { print substr($2, 1, 60) }'); make there; no portal, Open WebUI, Postgres, RustFS, LiteLLM/shared-mcp directly, stt, main Caddy or other gateway ports; ttyd on a socket only (no TCP listener), 407 at the gateway without the secret, which is nowhere in the sandbox; the gateway's neighbours: LiteLLM, not the portal, Open WebUI or the data; Docker's host names → 192.0.2.1 / 100::1; your uid; no Docker socket; no master or claude-code key; $(printf '%s\n' "$probe" | awk -F'\t' '$1 == "claude" { print $2 }')${rebind_note:-}"
    else record terminal terminal-isolation FAIL "$(( $(now) - t0 ))" "unexpected:$bad (log $LOGS/terminal-isolation.log)"; fi
    # A failed request to ttyd (the terminal stopped) writes no request headers — so not the secret — into the
    # gateway's log; the secret goes to the main Caddy's wget on stdin, never onto a command line here
    t0="$(now)"; sec="$(get_env TERMINAL_PROXY_SECRET)"
    docker stop -t 5 "$tc" >/dev/null 2>&1
    code="$(printf '%s\n' "$sec" | docker exec -i "$cad" sh -c 'read -r s; wget -S -T 10 -O /dev/null --header "X-Bn-Terminal-0$s: 1" http://terminal-upstream:7681/ 2>&1 | awk "/^  HTTP\// { print \$2; exit }"' 2>&1)"
    docker start "$tc" >/dev/null 2>&1
    for _ in $(seq 1 45); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$tc" 2>/dev/null)" = healthy ] && break; sleep 2; done
    logs="$(docker logs "$tgw" 2>&1)"
    n_sec="$(printf '%s\n' "$logs" | grep -c "$sec" || true)"; n_dial="$(printf '%s\n' "$logs" | grep -c 'dial unix /run/bn-ttyd/ttyd.sock' || true)"
    unset logs sec
    hl="$(docker inspect -f '{{.State.Health.Status}}' "$tc" 2>/dev/null)"
    if [ "$code" = 502 ] && [ "$n_dial" -ge 1 ] && [ "$n_sec" = 0 ] && [ "$hl" = healthy ]; then
      record terminal gateway-log-no-secret PASS "$(( $(now) - t0 ))" "ttyd stopped: 502, $n_dial dial error(s) logged without request headers (the secret 0 times); the terminal healthy again"
    else record terminal gateway-log-no-secret FAIL "$(( $(now) - t0 ))" "code $code, dial errors $n_dial, secret in the log $n_sec times, terminal $hl"; fi
  fi
  # Caddy's own check of every terminal/remote combination of the main Caddyfile, and of the gateway's file, with the
  # pinned binary in the running containers (own-domain mode needs the DNS-plugin build: not here)
  t0="$(now)"; bad=''
  cad="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=caddy)"
  tgw="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=terminal-gateway)"
  for tm in off on; do for cm in off on; do for rm in off tailscale; do
    [ "$tm:$cm" != off:on ] || continue                    # the Code page only with the terminal
    [ "$cm" = off ] || [ "$CODE" = 1 ] || continue           # (its snippets need CODE_* only while it is on)
    # (the code site's names: this runs before ./stack code enable gives the container its own)
    # (the previews' site comes with the Code page: preview-on.caddy)
    # (and the remote preview host: remote_preview, with the same-site guard on every app host)
    docker exec -e TERMINAL_MODE="$tm" -e CODE_MODE="$cm" -e PREVIEW_MODE="$cm" -e REMOTE_MODE="$rm" -e CODE_HOST="code.$HOST" \
      -e CODE_PROXY_SECRET=0123456789abcdef0123456789abcdef -e PREVIEW_PROXY_SECRET=0123456789abcdef0123456789abcdef \
      -e PREVIEW_DOMAIN="$PROJECT-preview.localhost" -e CODE_ORIGIN="http://code.$HOST" -e REMOTE_PREVIEW_HOST="$PROJECT-preview.tail0000.ts.net" \
      "$cad" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
      > "$LOGS/terminal-caddy-$tm-$cm-$rm.log" 2>&1 || bad="$bad terminal-$tm/code-$cm/remote-$rm"
  done; done; done
  docker exec "$tgw" caddy validate --config /etc/caddy/terminal-gateway.caddy --adapter caddyfile > "$LOGS/terminal-caddy-gateway.log" 2>&1 ||
    bad="$bad gateway"
  if [ -z "$bad" ]; then record terminal caddy-configs-validate PASS "$(( $(now) - t0 ))" "caddy validate: Caddyfile with the terminal off/on$( [ "$CODE" = 1 ] && echo ' × the Code page (and its previews, local and remote) off/on') × remote off/tailscale, and terminal-gateway.caddy (own-domain mode: tests/caddy-validate.sh with the plugin build)"
  else record terminal caddy-configs-validate FAIL "$(( $(now) - t0 ))" "caddy validate failed for:$bad (logs $LOGS/terminal-caddy-*.log)"; fi
fi

# --- 1c. the Code page (--code): on, in the terminal's sandbox ---
# code_probe CONTAINER — inside the code container (its own node): what it reaches and what it holds. "name<TAB>result".
code_probe() {
  docker exec -i "$1" node --input-type=module - <<'JS'
import net from 'node:net';
import fs from 'node:fs';
const tcp = (host, port) => new Promise((r) => { const s = net.connect({ host, port, timeout: 4000 });
  const d = (x) => { s.destroy(); r(x); }; s.on('connect', () => d('open')); s.on('timeout', () => d('closed')); s.on('error', () => d('closed')); });
for (const [h, p] of [['litellm', 4000], ['portal', 8000], ['open-webui', 8080], ['postgres', 5432], ['rustfs', 9000], ['shared-mcp', 8000],
  ['stt', 8000], ['terminal', 7681], ['gateway', 8091], ['terminal-upstream', 7681], ['1.1.1.1', 443], ['host.docker.internal', 80], ['caddy', 8080]]) {
  console.log(`${h}:${p}\t${await tcp(h, p)}`);
}
console.log(`secrets-in-env\t${Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD/.test(k)).sort().join(',')}`);
console.log(`workspace\t${fs.existsSync('/workspace') ? 'present' : 'absent'}`);
const mounts = fs.readFileSync('/proc/self/mounts', 'utf8').split('\n').map((l) => l.split(' ')[1]).filter(Boolean);
console.log(`mounts\t${mounts.filter((m) => !/^\/(proc|sys|dev)(\/|$)/.test(m) && !['/', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf'].includes(m)).sort().join(',')}`);
let w = 'no'; try { fs.writeFileSync('/opt/code/x', 'x'); w = 'yes'; } catch { /* read-only */ }
console.log(`rootfs-writable\t${w}`);
let s = 'no'; try { fs.writeFileSync('/run/bn-code/x', 'x'); s = 'yes'; } catch { /* :ro */ }
console.log(`socket-dir-writable\t${s}`);
console.log(`uid\t${process.getuid()}`);
console.log(`claude-binary\t${fs.existsSync('/usr/local/bin/claude') || fs.readdirSync('/opt/code/node_modules/@anthropic-ai').some((n) => n !== 'claude-agent-sdk') ? 'present' : 'absent'}`);
JS
}
if [ "$CODE" = 1 ]; then
  if [ "$(get_env CODE_ENABLED)" != true ]; then
    say "code: ./stack code enable (its image is built the first time)"
    cli code-enable 0 'Code page: on' code enable || die "code enable failed — see $LOGS/cli-code-enable.log"
  elif [ "$REUSE" = 0 ]; then
    # on by default: setup turned it on (with the terminal, in the seeded folder) and said so
    if grep -q 'The Code page is now on by default' "$LOGS/cli-setup.log" && [ "$(get_env TERMINAL_ENABLED)" = true ] &&
       [ "$(get_env TERMINAL_WORKSPACE)" = "$(cd "$(terminal_workspace_dir)" && pwd -P)" ]; then
      record cli code-on-by-default PASS 0 "setup turned the Code page and the terminal on (TERMINAL_WORKSPACE next to the checkout) and said so"
    else record cli code-on-by-default FAIL 0 "after setup: CODE_ENABLED=$(get_env CODE_ENABLED) TERMINAL_ENABLED=$(get_env TERMINAL_ENABLED), or no 'now on by default' line"; fi
  fi
  cli code-status 0 'Container  running' code status
  t0="$(now)"; bad=''
  cc="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=code)"
  tc="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=terminal)"
  cad="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=caddy)"
  if [ -z "$cc" ] || [ -z "$tc" ]; then record code code-isolation FAIL 0 "no running code or terminal container"
  else
    probe="$(code_probe "$cc" 2>&1)"; printf '%s\n' "$probe" > "$LOGS/code-isolation.log"; redact "$LOGS/code-isolation.log"
    for k in litellm:4000 portal:8000 open-webui:8080 postgres:5432 rustfs:9000 shared-mcp:8000 stt:8000 terminal:7681 gateway:8091 \
             terminal-upstream:7681 1.1.1.1:443 host.docker.internal:80; do
      printf '%s\n' "$probe" | grep -q "^$k	closed" || bad="$bad $k-reachable"
    done
    for kv in caddy:8080=open secrets-in-env=CODE_PROXY_SECRET workspace=absent mounts=/run/bn-code,/tmp,/usr/sbin/docker-init,/var/lib/bn-code rootfs-writable=no \
              socket-dir-writable=no claude-binary=absent; do
      printf '%s\n' "$probe" | grep -q "^${kv%%=*}	${kv#*=}\$" || bad="$bad ${kv%%=*}:$(printf '%s\n' "$probe" | awk -F'\t' -v k="${kv%%=*}" '$1 == k { print $2 }')"
    done
    [ "$(printf '%s\n' "$probe" | awk -F'\t' '$1 == "uid" { print $2 }')" = "$(id -u)" ] || bad="$bad not-your-uid"
    # From the sandbox: no route to the code container; bn-coded's socket in a folder of its own (mode 700)
    out="$(docker exec "$tc" sh -c 'curl --noproxy "*" -s -m 4 -o /dev/null -w "%{http_code}" http://code-upstream:8095/ || true; printf " %s" "$(stat -c %a /run/bn-code)"; test -S /run/bn-code/coded.sock && printf " socket"' 2>&1)"
    [ "$out" = "000 700 socket" ] || bad="$bad sandbox:$out"
    # The main Caddy reaches it, but it answers nothing without the secret header
    out="$(docker exec "$cad" sh -c 'wget -S -T 10 -O /dev/null http://code-upstream:8095/api/state 2>&1 | awk "/^  HTTP\// { print \$2; exit }"' 2>&1)"
    [ "$out" = 407 ] || bad="$bad no-secret:$out"
    # its LiteLLM-free, key-free environment
    ins="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cc" 2>/dev/null)"
    for k in LITELLM_KEY_TERMINAL LITELLM_KEY_CLAUDE_CODE LITELLM_MASTER_KEY SHARED_MCP_TOKEN TERMINAL_PROXY_SECRET; do ! env_has "$k" "$ins" || bad="$bad has-$k"; done
    unset ins
    if [ -z "$bad" ]; then
      record code code-isolation PASS "$(( $(now) - t0 ))" "code container: only Caddy (code-link), no LiteLLM, portal, Open WebUI, data, stt, sandbox, gateway or internet; no workspace mount (mounts: the socket folder :ro, /tmp, Docker's init, its own state volume for Git hosts), read-only, no Claude Code binary, its only secret CODE_PROXY_SECRET, your uid; 407 without the secret; the sandbox cannot reach it; bn-coded's socket folder 700"
    else record code code-isolation FAIL "$(( $(now) - t0 ))" "unexpected:$bad (log $LOGS/code-isolation.log)"; fi
  fi
fi

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

# --- 2c. the suite's own git server (--git-server): on the sandbox's terminal-out network as gitsrv ---
# git_server_start -> 0 when tests/e2e/gitsrv runs there and answered: E2E_GIT_TOKEN (new each run) and E2E_GIT_CA_B64
# (its CA) exported for the browser suite
git_server_start() {
  local t0 n ok=0 i
  t0="$(now)"; n="${PROJECT}_terminal-out"
  E2E_GIT_TOKEN="$(openssl rand -hex 24)"
  docker network inspect "$n" >/dev/null 2>&1 || { record git git-server FAIL 0 "no network $n (TERMINAL_EGRESS=$(get_env TERMINAL_EGRESS))"; return 1; }
  docker build -q -t "$PROJECT/e2e-gitsrv:local" "$HERE/gitsrv" > "$LOGS/gitsrv-build.log" 2>&1 || { record git git-server FAIL 0 "docker build failed ($LOGS/gitsrv-build.log)"; return 1; }
  docker rm -f "$PROJECT-gitsrv" >/dev/null 2>&1 || true
  docker run -d --name "$PROJECT-gitsrv" --label "io.bedrock-now.e2e=$PROJECT" --network "$n" --network-alias gitsrv \
    -e GITSRV_TOKEN="$E2E_GIT_TOKEN" "$PROJECT/e2e-gitsrv:local" > /dev/null 2>> "$LOGS/gitsrv-build.log" ||
    { record git git-server FAIL 0 "docker run failed ($LOGS/gitsrv-build.log)"; return 1; }
  for i in $(seq 1 60); do docker logs "$PROJECT-gitsrv" 2>&1 | grep -q '^https on' && { ok=1; break; }; sleep 1; done
  if [ "$ok" = 1 ] && E2E_GIT_CA_B64="$(docker exec "$PROJECT-gitsrv" sh -c 'base64 -w0 /srv/ca.pem')" && [ -n "$E2E_GIT_CA_B64" ]; then
    export E2E_GIT_SERVER=1 E2E_GIT_TOKEN E2E_GIT_CA_B64
    record git git-server PASS "$(( $(now) - t0 ))" "tests/e2e/gitsrv on $n as gitsrv (https :8443 with a token of this run, ssh :2222)"
  else
    docker logs "$PROJECT-gitsrv" > "$LOGS/gitsrv.log" 2>&1
    record git git-server FAIL "$(( $(now) - t0 ))" "it did not answer ($LOGS/gitsrv.log)"; return 1
  fi
}
if [ "$GIT_SERVER" = 1 ]; then
  if [ "$CODE" = 1 ] && part_on browser; then git_server_start || true
  else record git git-server SKIP 0 "--git-server needs the Code page and the browser part"; fi
fi

# --- 3. the browser suite (Playwright container) ---
# browser_run LABEL [FILTER [TAG [RUNNER]]] — the suite (or the checks matching FILTER, a Python regex on suite/id;
# their results named id@TAG), then a runner check (browser/RUNNER, default runner[@TAG]): a crash, a non-zero exit
# or fewer results than selected checks is a FAIL. HELPER_ON=1: the update helper runs, so a settings/* check that
# finds none FAILs instead of skipping.
browser_run() {
  local label="$1" filter="${2:-}" tag="${3:-}" t0 rc got want runner
  runner="${4:-runner${tag:+@$tag}}"
  t0="$(now)"
  # the terminal's one real Claude Code call (browser/terminal-claude-bedrock-inside) only with the claude part
  E2E_TERMINAL_CLAUDE="$( [ "$TERMINAL" = 1 ] && part_on claude && [ "$NO_CLAUDE" = 0 ] && echo 1 || echo 0)" \
    E2E_TERMINAL_HOSTILE="${HOSTILE:-0}" E2E_CODE_HOSTILE="${CODE_HOSTILE:-0}" E2E_HELPER_ON="${HELPER_ON:-0}" E2E_TAG="$tag" \
    "$HERE/browser.sh" "$STACK" "$OUT" "$PROJECT" "$PW_IMAGE" "$filter"; rc=$?
  got="$(grep -c . "$OUT/browser/results.tsv" 2>/dev/null || true)"; got="${got:-0}"
  want="$(cat "$OUT/browser/expected.txt" 2>/dev/null || echo '?')"
  [ -f "$OUT/browser/results.tsv" ] && cat "$OUT/browser/results.tsv" >> "$RESULTS"
  # (E2E_CHECKS may leave a pass with no check at all: that is not a failure)
  if [ "$rc" != 0 ] || { [ "$got" = 0 ] && [ "$want" != 0 ]; } || [ "$got" != "$want" ]; then
    record browser "$runner" FAIL "$(( $(now) - t0 ))" "$label: exit $rc, $got of $want checks reported (see $OUT/browser/run.log)"
  else record browser "$runner" PASS "$(( $(now) - t0 ))" "$label: $got checks reported"; fi
}
if ! part_on browser; then
  record browser suite SKIP 0 "--only $ONLY"
  [ "$HELPER" = 0 ] || record helper update-helper SKIP 0 "--helper: not started (no browser part in --only $ONLY)"
elif [ "$HELPER" = 0 ]; then
  say "browser suite (Playwright container)"
  browser_run "full suite"
  record helper update-helper SKIP 0 "not started: the settings/* checks skip (tests/e2e/run.sh --helper runs them)"
else
  # Three passes, in the order of one run: the checks that fake the helper's heartbeat or need it absent; settings/*
  # with the real helper; final/ (sign-out revokes every session) last
  say "browser suite (Playwright container): every check but settings/* and final/*"
  browser_run "without settings/* and final/*" '^(?!settings/|final/)'
  say "update helper: $STACK/bin/bedrock-now-helper in the foreground ($HELPER_KNOBS; log: $LOGS/helper.log)"
  if e2e_helper_start 2> "$LOGS/helper-start.log"; then   # (not in a $( ) subshell: it keeps HELPER_PID)
    say "browser suite: settings/* (the update helper running)"
    HELPER_ON=1 browser_run "settings/* with the update helper" '^settings/' '' runner-settings
    nset="$(e2e_helper_jobs settings-jobs)"; ndiag="$(e2e_helper_jobs diag-jobs)"
    e2e_helper_stop
    if [ "$HELPER_ALIVE" = 1 ]; then
      record helper update-helper PASS "$(( $(now) - HELPER_T0 ))" "ran in the foreground for settings/* (not installed; $HELPER_KNOBS): $nset settings change(s), $ndiag diagnostic(s); stopped afterwards; log $LOGS/helper.log"
    else record helper update-helper FAIL "$(( $(now) - HELPER_T0 ))" "stopped by itself during settings/* (exit $HELPER_RC; $nset settings change(s), $ndiag diagnostic(s)) — see $LOGS/helper.log"; fi
  else
    e2e_helper_stop
    record helper update-helper FAIL "$(( $(now) - HELPER_T0 ))" "did not start: $(tail -n 2 "$LOGS/helper-start.log" | tr '\n' ' ')"
    browser_run "settings/* (no update helper: they skip)" '^settings/' '' runner-settings
  fi
  say "browser suite: final/* (sign-out)"
  browser_run "final/* (sign-out)" '^final/' '' runner-final
fi
if part_on browser; then
  # The terminal host whoever answers on ttyd's socket: as code in the sandbox could, a stand-in (terminal-stub.py)
  # takes the socket's path (ttyd's own moved aside: ttyd keeps listening on it), the browser check runs against it,
  # then the stand-in puts ttyd's socket back. The gateway restarts each time, so it keeps no connection to the other.
  # The main Caddy's policy for the terminal host must hold for the stand-in's page.
  if [ "$TERMINAL" = 1 ]; then
    tc="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=terminal)"
    tgw="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=terminal-gateway)"
    gw_fresh() { docker restart -t 5 "$tgw" >/dev/null 2>&1; for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$tgw" 2>/dev/null)" = healthy ] && return 0; sleep 1; done; return 1; }
    t0="$(now)"
    if [ -n "$tc" ] && [ -n "$tgw" ] && docker exec -i "$tc" sh -c 'cat > /tmp/bn-stub.py' < "$HERE/terminal-stub.py" &&
       docker exec -d "$tc" python3 /tmp/bn-stub.py /run/bn-ttyd/ttyd.sock; then
      for _ in $(seq 1 20); do docker exec "$tc" test -S /run/bn-ttyd/ttyd.real && break; sleep 0.5; done
      gw_fresh
      HOSTILE=1; browser_run "terminal: a stand-in on ttyd's socket" 'browser/terminal-hostile-upstream$' hostile; HOSTILE=0
    else record browser terminal-hostile-upstream@hostile FAIL "$(( $(now) - t0 ))" "could not start the stand-in on ttyd's socket"; fi
    # The stand-in stopped (it puts ttyd's socket back), ttyd answering again through a fresh gateway
    t0="$(now)"
    docker exec "$tc" pkill -f 'bn-stub[.]py' >/dev/null 2>&1
    for _ in $(seq 1 20); do docker exec "$tc" test -e /run/bn-ttyd/ttyd.real || break; sleep 0.5; done
    gw_fresh
    page="$(docker exec "$tc" curl -fsS -m 5 --unix-socket /run/bn-ttyd/ttyd.sock http://terminal/ 2>/dev/null || true)"
    case "$page" in *'<title>ttyd'*) record terminal stand-in-removed PASS "$(( $(now) - t0 ))" "ttyd answers on its socket again" ;;
      *) record terminal stand-in-removed FAIL "$(( $(now) - t0 ))" "ttyd's socket not back (docker exec $tc ls -la /run/bn-ttyd)" ;; esac
    unset page
  fi
  # The code host whoever answers on bn-coded's socket: a stand-in (code-stub.mjs, run with the sandbox's own node)
  # moves bn-coded's socket aside and answers with markup, bogus ids, an oversized frame and an endless line; the
  # browser check then runs against it, and the stand-in puts bn-coded's socket back.
  if [ "$CODE" = 1 ]; then
    tc="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=terminal)"
    cc="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=code)"
    t0="$(now)"
    if [ -n "$tc" ] && docker exec -i "$tc" sh -c 'cat > /tmp/code-stub.mjs' < "$HERE/code-stub.mjs" &&
       docker exec -d "$tc" node /tmp/code-stub.mjs /run/bn-code/coded.sock; then
      for _ in $(seq 1 20); do docker exec "$tc" test -S /run/bn-code/coded.real && break; sleep 0.5; done
      CODE_HOSTILE=1; browser_run "code: a stand-in on bn-coded's socket" 'browser/code-hostile-sandbox$' hostile-code; CODE_HOSTILE=0
    else record browser code-hostile-sandbox@hostile-code FAIL "$(( $(now) - t0 ))" "could not start the stand-in on bn-coded's socket"; fi
    t0="$(now)"
    docker exec "$tc" pkill -f 'code-stub[.]mjs' >/dev/null 2>&1
    for _ in $(seq 1 20); do docker exec "$tc" test -e /run/bn-code/coded.real || break; sleep 0.5; done
    st="$(docker inspect -f '{{.State.Health.Status}}' "$cc" 2>/dev/null)"
    mem="$(docker stats --no-stream --format '{{.MemUsage}}' "$cc" 2>/dev/null | awk '{ print $1 }')"
    back="$(docker exec "$tc" node -e 'const s = require("net").connect("/run/bn-code/coded.sock"); s.on("connect", () => { console.log("ok"); s.destroy(); }); s.on("error", () => console.log("no"))' 2>&1)"
    if [ "$st" = healthy ] && [ "$back" = ok ] && ! docker exec "$tc" test -e /run/bn-code/coded.real; then
      record code stand-in-removed PASS "$(( $(now) - t0 ))" "bn-coded answers on its socket again; the code container healthy, using $mem (limit 768 MiB)"
    else record code stand-in-removed FAIL "$(( $(now) - t0 ))" "code container $st, bn-coded's socket: $back"; fi
    # The code container's secret never reached the main Caddy's log
    sec="$(get_env CODE_PROXY_SECRET)"
    n="$(docker logs "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=caddy)" 2>&1 | grep -c "$sec" || true)"
    unset sec
    if [ "$n" = 0 ]; then record code caddy-log-no-secret PASS 0 "CODE_PROXY_SECRET appears 0 times in the main Caddy's log"
    else record code caddy-log-no-secret FAIL 0 "CODE_PROXY_SECRET appears $n times in the main Caddy's log"; fi
  fi
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
  # Its own config folder (the wrapper's lean CLAUDE_CONFIG_DIR, not ~/.claude-bedrock) and an empty working folder:
  # your ~/.claude, ~/.claude-bedrock and this checkout's files stay out of it. The config folder is the harness's own
  # and made afresh (a reused --out keeps none), so the wrapper creates it: mode 700.
  rm -rf "$OUT/claude-config"; mkdir -p "$OUT/claude-cwd"
  ( export CLAUDE_BEDROCK_CONFIG_DIR="$OUT/claude-config" CLAUDE_BEDROCK_MODEL="$haiku" CLAUDE_BEDROCK_SUMMARY=1
    clean_env CLAUDE_BEDROCK_CONFIG_DIR CLAUDE_BEDROCK_MODEL CLAUDE_BEDROCK_SUMMARY
    cd "$OUT/claude-cwd" && exec "$NOTTY" "$STACK/bin/claude-bedrock" -p "Reply with exactly the word: ok" --max-turns 1 ) > "$log" 2>&1 </dev/null; rc=$?
  redact "$log"
  if [ "$rc" = 0 ] && grep -qiE '^ok\.?$' "$log" && grep -q '^bedrock · ' "$log" && grep -q '^config: lean ' "$log" &&
    [ "$(perm_of "$OUT/claude-config")" = 700 ]; then
    record claude claude-bedrock PASS "$(( $(now) - t0 ))" "answered ok via $haiku; cost line shown; lean config folder (700)"
  else record claude claude-bedrock FAIL "$(( $(now) - t0 ))" "exit $rc: $(tail -n 3 "$log" | tr '\n' ' ')"; fi
  t0="$(now)"; out="$( (clean_env; cd "$OUT/claude-cwd" && exec "$NOTTY" "$STACK/bin/claude-bedrock" --help) 2>&1 </dev/null)"
  if printf '%s' "$out" | grep -q 'claude-bedrock: Claude Code on AWS Bedrock via bedrock-now'; then
    record claude claude-bedrock-help PASS "$(( $(now) - t0 ))" "wrapper header + claude --help"
  else record claude claude-bedrock-help FAIL "$(( $(now) - t0 ))" "no wrapper header"; fi
fi

# --- 5. CLI commands that change the throwaway (backup/restore, down/up, rotate-aws, update, rollback) ---
# bucket_job SCRIPT — sh -c SCRIPT in the throwaway's own aws-cli service (rustfs-init, on its network; the RustFS
# keys reach it from the throwaway .env through Compose, never on a command line); E2E_CANARY is passed on.
CANARY=shared/e2e-restore/canary.txt   # bucket/key, and its path under a backup's s3/
bucket_job() {
  ( clean_env E2E_CANARY; cd "$STACK" &&
    exec docker compose -p "$PROJECT" -f compose.yaml run --rm --no-deps -T -e E2E_CANARY --entrypoint /bin/sh rustfs-init -c "$1" ) </dev/null
}
# shellcheck disable=SC2016  # $E2E_CANARY expands in the container
canary_put() { E2E_CANARY="$1" bucket_job 'printf %s "$E2E_CANARY" > /tmp/canary && aws --endpoint-url http://rustfs:9000 s3 cp --only-show-errors /tmp/canary s3://'"$CANARY"; }
canary_get() { bucket_job 'aws --endpoint-url http://rustfs:9000 s3 cp --only-show-errors s3://'"$CANARY"' -'; }
if [ "$SKIP_MUTATING" = 1 ] || ! part_on mutating; then
  record cli mutating SKIP 0 "--skip-cli-mutating / --only $ONLY"
else
  say "CLI: commands that change the stack"
  # A file of the shared bucket overwritten after the backup with content of the SAME size: the restore must bring
  # back the backup's (aws s3 sync alone kept the newer one — it compares only size and date).
  n="$(printf '%05d' "$((RANDOM % 100000))")"; canary_a="canary-backup-$n"; canary_b="canary-latest-$n"
  canary_put "$canary_a" > "$LOGS/canary-put-backup.log" 2>&1 || warn "could not write the canary (log $LOGS/canary-put-backup.log)"
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
    t0="$(now)"
    canary_put "$canary_b" > "$LOGS/canary-put-latest.log" 2>&1 || warn "could not overwrite the canary (log $LOGS/canary-put-latest.log)"
    c_bk="$(cat "$bk/s3/$CANARY" 2>/dev/null)"; c_before="$(canary_get 2>/dev/null)"
    spend_cut
    cli restore 0 'all checks passed' restore "backups/${bk##*/}" --yes
    c_after="$(canary_get 2> "$LOGS/canary-get.log")"
    if [ "$c_bk" = "$canary_a" ] && [ "$c_before" = "$canary_b" ] && [ "$c_after" = "$canary_a" ]; then
      record cli restore-same-size-change PASS "$(( $(now) - t0 ))" "$CANARY: '$c_bk' in the backup, overwritten with '$c_before' (same size), '$c_after' after the restore"
    else record cli restore-same-size-change FAIL "$(( $(now) - t0 ))" "$CANARY: '$c_bk' in the backup (want '$canary_a'), '$c_before' before the restore (want '$canary_b'), '$c_after' after it (want '$canary_a')"; fi
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
