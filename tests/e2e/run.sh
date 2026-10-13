#!/usr/bin/env bash
# Opt-in end-to-end suite (run by hand; not part of tests/run.sh or CI). Builds a THROWAWAY bedrock-now stack from
# this checkout under its own Compose project and ports, drives every page in a pinned Playwright container, runs
# the safe ./stack subcommands against it, then removes it again. Costs real Bedrock money (well under $0.10;
# the total is printed and checked at the end).
#
#   tests/e2e/run.sh --aws-env FILE   AWS_* keys from FILE (only those lines are read; values are never printed)
#   tests/e2e/run.sh                  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION_NAME from the environment
#
# Options:
#   --out DIR        results, logs, screenshots (default tests/e2e/out, gitignored)
#   --work DIR       where the throwaway checkout lives while the stack runs (default tests/e2e/work/PROJECT,
#                    gitignored). Keep it out of temporary folders: Docker bind-mounts files from it, and a
#                    cleaned-up /tmp would break a kept stack.
#   --project NAME   Compose project of the throwaway (default bne2e; never "bedrock-now"); its host is NAME.localhost
#   --aws-env FILE   where the AWS key comes from (copies only AWS_* lines)
#   --keep           leave the throwaway running afterwards (tear it down later with --teardown)
#   --reuse          reuse a throwaway kept by an earlier --keep run (skips staging and setup)
#   --teardown       only remove a kept throwaway, then exit
#   --skip-cli-mutating   skip backup/restore, down/up, rotate-aws, update and rollback (the slow part)
#   --deep-update    also a real update to a new (local) commit and a rollback from it (two more setups)
#   --no-claude      skip the claude-bedrock check
#
# Never touches the default install: refuses the project name bedrock-now, never uses ports 80/4000/8765 (or the
# other ports listed in AVOID_PORTS), never changes ~/.local/bin/claude-bedrock (checked before and after), never
# prunes anything (it removes only its own containers, volumes and <project>/… images, by exact name).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# mcr.microsoft.com/playwright/python v1.55.0-noble (multi-arch), pinned by digest; requirements.txt pins the same.
PW_IMAGE="mcr.microsoft.com/playwright/python:v1.55.0-noble@sha256:640d578aae63cfb632461d1b0aecb01414e4e020864ac3dd45a868dc0eff3078"
AVOID_PORTS=" 80 443 3000 3009 4000 8080 8081 8090 8765 8800 "
SPEND_LIMIT="0.10"

OUT="$ROOT/tests/e2e/out"; WORK=''; PROJECT=bne2e; AWS_ENV_FILE=''; KEEP=0; REUSE=0; TEARDOWN_ONLY=0
SKIP_MUTATING=0; DEEP_UPDATE=0; NO_CLAUDE=0
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
    -h | --help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (tests/e2e/run.sh --help)" >&2; exit 2 ;;
  esac
done

case "$PROJECT" in bedrock-now | '') echo "refusing project name '$PROJECT': that is the default install" >&2; exit 2 ;; esac
case "$PROJECT" in [a-z0-9]*) case "$PROJECT" in *[!a-z0-9-]*) echo "project: lowercase letters, digits, - only" >&2; exit 2 ;; esac ;;
  *) echo "project must start with a lowercase letter or digit" >&2; exit 2 ;; esac

mkdir -p "$OUT" || exit 2
OUT="$(cd "$OUT" && pwd)"
WORK="${WORK:-$ROOT/tests/e2e/work/$PROJECT}"
mkdir -p "$(dirname "$WORK")" || exit 2
STACK="$(cd "$(dirname "$WORK")" && pwd)/$(basename "$WORK")"   # the throwaway checkout (.env, .state/, backups/; deleted at teardown)
LOGS="$OUT/logs"; RESULTS="$OUT/results.tsv"
HOST="$PROJECT.localhost"

say()  { printf '\033[1m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '!!  %s\n' "$*" >&2; }
die()  { printf 'xx  %s\n' "$*" >&2; exit 1; }

# --- results: one TSV line per check (suite, id, status PASS|FAIL|SKIP, seconds, message) ---
record() { # record SUITE ID STATUS SECONDS MESSAGE
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$(printf '%s' "$5" | tr '\t\n' '  ' | cut -c1-400)" >> "$RESULTS"
  case "$3" in PASS) printf '  ok    %s\n' "$2" >&2 ;; SKIP) printf '  skip  %s (%s)\n' "$2" "$5" >&2 ;;
    *) printf '  FAIL  %s: %s\n' "$2" "$5" >&2 ;; esac
}

# --- the throwaway's environment: nothing from this shell leaks into ./stack except what is listed here ---
KEEP_VARS=" PATH HOME USER LOGNAME TMPDIR DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_CERT_PATH DOCKER_TLS_VERIFY "
# clean_env [EXTRA...] — in a subshell: unexports every variable except KEEP_VARS and EXTRA (values stay in the
# environment, never on a command line), then sets the throwaway's fixed ones.
clean_env() {
  local v keep="$KEEP_VARS $* "
  for v in $(compgen -e); do case "$keep" in *" $v "*) ;; *) unset "$v" 2>/dev/null || true ;; esac; done
  export SHELL=/bin/bash TERM=dumb NO_COLOR=1 BEDROCK_NOW_NO_OPEN=1 LANG=C
}

# load_aws — AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION_NAME into this process only (never printed,
# never on a command line): from --aws-env FILE (only AWS_* lines) or from the environment.
AWS_OK=0
load_aws() {
  local k v line
  if [ -n "$AWS_ENV_FILE" ]; then
    [ -r "$AWS_ENV_FILE" ] || die "cannot read --aws-env $AWS_ENV_FILE"
    unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION_NAME AWS_REGION
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in AWS_ACCESS_KEY_ID=* | AWS_SECRET_ACCESS_KEY=* | AWS_REGION_NAME=* | AWS_REGION=*) ;; *) continue ;; esac
      k="${line%%=*}"; v="${line#*=}"; v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
      [ -n "$v" ] || continue
      export "$k=$v"
    done < "$AWS_ENV_FILE"
  fi
  [ -n "${AWS_REGION_NAME:-}" ] || [ -z "${AWS_REGION:-}" ] || export AWS_REGION_NAME="$AWS_REGION"
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] && AWS_OK=1
  [ "$AWS_OK" = 1 ] || die "no AWS key: pass --aws-env FILE or export AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY"
  return 0
}

# st [--aws] ARGS... — the throwaway's ./stack with a clean environment, run in its folder (ST_CWD=DIR: from DIR
# instead); stdin is /dev/null.
st() {
  # Never let a command default to the bedrock-now project: the throwaway .env must name ours.
  [ "$(get_env COMPOSE_PROJECT_NAME)" = "$PROJECT" ] || { echo "xx  throwaway .env does not name project $PROJECT" >&2; return 99; }
  if [ "${1:-}" = --aws ]; then
    shift
    ( export AWS_REGION_NAME="${AWS_REGION_NAME:-us-east-1}" COMPOSE_PROJECT_NAME="$PROJECT"
      clean_env AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION_NAME COMPOSE_PROJECT_NAME
      cd "$STACK" && exec "$STACK/stack" "$@" </dev/null )
  else
    # The folder is read before clean_env, which unexports ST_CWD with everything else.
    local cwd="${ST_CWD:-$STACK}"
    ( clean_env; cd "$cwd" && exec "$STACK/stack" "$@" </dev/null )
  fi
}

# redact FILE — replaces every secret of the throwaway .env (and the AWS key) in FILE with ***
redact() {
  local f="$1" t
  [ -f "$f" ] || return 0
  t="$(mktemp "$f.XXXXXX")" || return 0
  AWSK="${AWS_ACCESS_KEY_ID:-}" AWSS="${AWS_SECRET_ACCESS_KEY:-}" awk '
    BEGIN { if (length(ENVIRON["AWSK"]) >= 8) s[++n] = ENVIRON["AWSK"]; if (length(ENVIRON["AWSS"]) >= 8) s[++n] = ENVIRON["AWSS"] }
    NR == FNR { i = index($0, "="); k = substr($0, 1, i - 1); v = substr($0, i + 1)
                if (i > 1 && k ~ /(PASSWORD|SECRET|KEY|TOKEN|SALT)/ && length(v) >= 8) s[++n] = v; next }
    { for (j = 1; j <= n; j++) while ((p = index($0, s[j])) > 0) $0 = substr($0, 1, p - 1) "***" substr($0, p + length(s[j])); print }
  ' "$STACK/.env" "$f" > "$t" 2>/dev/null && mv "$t" "$f" || rm -f "$t"
}

# get_env KEY — a value from the throwaway .env (for non-secret keys only: ports, host, model names)
get_env() { awk -v k="$1" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { printf "%s", v }' "$STACK/.env" 2>/dev/null; }
set_env() { # set_env KEY VALUE (non-secret values only; the throwaway .env)
  local t; t="$(mktemp "$STACK/.env.XXXXXX")"
  K="$1" V="$2" awk 'index($0, ENVIRON["K"] "=") == 1 { if (!d) print ENVIRON["K"] "=" ENVIRON["V"]; d = 1; next } { print }
    END { if (!d) print ENVIRON["K"] "=" ENVIRON["V"] }' "$STACK/.env" > "$t" && chmod 600 "$t" && mv "$t" "$STACK/.env"
}

# --- teardown: only this project's own things, by exact name ---
teardown() {
  say "teardown: project $PROJECT"
  docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || warn "docker compose -p $PROJECT down failed"
  docker volume rm "${PROJECT}_bedrock-now-owner" >/dev/null 2>&1 || true
  local img id
  for img in "$PROJECT/portal:local" "$PROJECT/shared-mcp:local" "$PROJECT/portal:previous" "$PROJECT/shared-mcp:previous" \
             "$PROJECT/caddy-dns:local" "$PROJECT/e2e-playwright:local"; do
    docker image rm "$img" >/dev/null 2>&1 || true
  done
  for id in $(docker image ls -q --no-trunc --filter dangling=true --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null); do
    docker image rm "$id" >/dev/null 2>&1 || true
  done
  docker rm -f "$PROJECT-playwright" >/dev/null 2>&1 || true
  # Only a folder this suite created (it carries the marker) is ever deleted.
  if [ -f "$STACK/.bedrock-now-e2e" ]; then chmod -R u+rwX "$STACK" 2>/dev/null; rm -rf "$STACK" || warn "could not delete $STACK"
  elif [ -d "$STACK" ] && [ -z "$(ls -A "$STACK" 2>/dev/null)" ]; then rmdir "$STACK"
  elif [ -e "$STACK" ]; then warn "not deleting $STACK: it was not created by this suite (no .bedrock-now-e2e marker)"; fi
  local left
  left="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"; docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")"
  if [ -z "$left" ] && [ ! -e "$STACK" ]; then say "teardown complete: no containers, volumes or checkout of $PROJECT left"
  else warn "teardown left something behind: $left $( [ -e "$STACK" ] && echo "$STACK")"; fi
}

if [ "$TEARDOWN_ONLY" = 1 ]; then teardown; exit 0; fi

# --- preflight ---
command -v docker >/dev/null || die "docker is required"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running"
command -v git >/dev/null || die "git is required"
command -v lsof >/dev/null || die "lsof is required (free-port detection)"
load_aws

LINK="$HOME/.local/bin/claude-bedrock"
link_state() { if [ -L "$LINK" ]; then printf 'symlink -> %s\n' "$(readlink "$LINK")"; elif [ -e "$LINK" ]; then echo "file"; else echo "absent"; fi; }
LINK_BEFORE="$(link_state)"

: > "$RESULTS"; mkdir -p "$LOGS"
START_TS="$(date +%s)"
# Teardown however the run ends (also Ctrl-C / a closed terminal / kill); only kill -9 skips it, and the next run
# then removes the leftovers first (stale_check).
if [ "$KEEP" = 0 ]; then
  trap 'teardown' EXIT
  trap 'warn "interrupted"; exit 130' INT TERM HUP
fi

# stale_check — the project's containers/volumes from an earlier run that never tore down (killed, or its checkout
# deleted under it) are removed first, but only when they are this suite's own: started from $STACK, or recorded
# for it by the owner marker, or from a folder that no longer exists. Anything else stops the run.
stale_check() {
  local dirs owner d
  dirs="$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Label "com.docker.compose.project.working_dir"}}' | sort -u)"
  owner="$(docker volume inspect --format '{{index .Labels "io.bedrock-now.dir"}}' "${PROJECT}_bedrock-now-owner" 2>/dev/null || true)"
  if [ -z "$dirs$owner" ] && ! docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | grep -q .; then return 0; fi
  for d in $dirs $owner; do
    [ "$d" = "$STACK" ] || [ ! -e "$d" ] || case "$d" in */tests/e2e/work/*) ;; *)
      die "project $PROJECT belongs to $d, not to this suite — pick another --project (nothing was changed)" ;; esac
  done
  [ -n "$dirs$owner" ] || die "project $PROJECT has data volumes of unknown origin — pick another --project (nothing was changed)"
  warn "project $PROJECT has leftovers of an earlier run that did not tear down ($dirs$owner) — removing them first"
  teardown
}

port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1 && case "$AVOID_PORTS" in *" $1 "*) return 1 ;; esac; }
free_port() { # free_port START -> the first free port from START (skipping AVOID_PORTS and ports already chosen)
  local p="$1"
  while ! port_free "$p" || case " ${CHOSEN:-} " in *" $p "*) true ;; *) false ;; esac; do p=$((p + 1)); done
  CHOSEN="${CHOSEN:-} $p"; printf '%s\n' "$p"
}

# --- 1. the throwaway checkout: HEAD plus this working tree's uncommitted changes, committed locally ---
stage() {
  say "staging the throwaway checkout in $STACK"
  stale_check
  if [ -e "$STACK" ]; then
    [ -f "$STACK/.bedrock-now-e2e" ] || [ -z "$(ls -A "$STACK" 2>/dev/null)" ] ||
      die "$STACK exists and was not created by this suite — pick another --work (nothing was changed)"
    chmod -R u+rwX "$STACK" 2>/dev/null; rm -rf "$STACK"
  fi
  git clone --quiet --no-hardlinks "$ROOT" "$STACK" || die "git clone failed"
  : > "$STACK/.bedrock-now-e2e"   # marks the folder as the suite's own (teardown deletes only such a folder)
  printf '/.bedrock-now-e2e\n' >> "$STACK/.git/info/exclude"
  ( cd "$ROOT" && git diff HEAD --binary ) | git -C "$STACK" apply --whitespace=nowarn 2>/dev/null || true
  ( cd "$ROOT" && git ls-files --others --exclude-standard -z ) | while IFS= read -r -d '' f; do
    case "$f" in tests/e2e/out/* | tests/e2e/work/*) continue ;; esac
    mkdir -p "$STACK/$(dirname "$f")" && cp -p "$ROOT/$f" "$STACK/$f"
  done
  git -C "$STACK" add -A
  git -C "$STACK" -c user.name=bedrock-now-e2e -c user.email=e2e@example.invalid commit -q -m "e2e: working tree" --allow-empty
  # Seed .env: names and ports for this throwaway (setup keeps what is set). The portal password is generated
  # here and marked as shown, so setup's summary never prints it.
  cp "$STACK/.env.example" "$STACK/.env"; chmod 600 "$STACK/.env"
  local pp lp mp
  pp="$(free_port 18480)"; lp="$(free_port 14480)"; mp="$(free_port 18865)"
  set_env COMPOSE_PROJECT_NAME "$PROJECT"; set_env PORTAL_HOST "$HOST"; set_env PORTAL_PORT "$pp"; set_env LITELLM_PORT "$lp"; set_env SHARED_MCP_PORT "$mp"
  set_env OPENWEBUI_ADMIN_EMAIL "e2e-admin@example.com"
  set_env PORTAL_PASSWORD "$(openssl rand -hex 10)"
  mkdir -p "$STACK/.state" && chmod 700 "$STACK/.state" && : > "$STACK/.state/portal-password-shown"
  say "throwaway: project $PROJECT, http://$HOST:$pp  (LiteLLM 127.0.0.1:$lp, shared-mcp 127.0.0.1:$mp)"
}

# timed ID SUITE CMD... — runs CMD (output to $LOGS/ID.log, redacted), records PASS/FAIL by exit status
now() { date +%s; }

# cli ID EXPECT_RC PATTERN [--aws] ARGS... — ./stack ARGS; PASS when the exit status is EXPECT_RC ("any" = any)
# and the (redacted) output matches the extended regex PATTERN ("" = anything).
cli() {
  local id="$1" want="$2" pat="$3" t0 rc log msg
  shift 3
  log="$LOGS/cli-$id.log"; t0="$(now)"
  st "$@" > "$log" 2>&1; rc=$?
  redact "$log"
  msg="exit $rc"
  if [ "$want" != any ] && [ "$rc" != "$want" ]; then
    record cli "$id" FAIL "$(( $(now) - t0 ))" "exit $rc (want $want): $(grep -E 'xx|FAIL|!!' "$log" | tail -n 2 | tr '\n' ' ')"
    return 1
  fi
  if [ -n "$pat" ] && ! grep -Eq -- "$pat" "$log"; then
    record cli "$id" FAIL "$(( $(now) - t0 ))" "output lacks /$pat/ (exit $rc; log $log)"
    return 1
  fi
  record cli "$id" PASS "$(( $(now) - t0 ))" "$msg"
}

# follow_logs ID SERVICE — ./stack logs SVC follows forever: read 6 s of it, then stop it
follow_logs() {
  local id="$1" svc="$2" log pid t0
  log="$LOGS/cli-$id.log"; t0="$(now)"
  ( set -m; st logs "$svc" > "$log" 2>&1 & pid=$!; sleep 6; kill -TERM -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null ) 2>/dev/null
  redact "$log"
  if [ -s "$log" ] && grep -q "$svc" "$log"; then record cli "$id" PASS "$(( $(now) - t0 ))" "$(wc -l < "$log" | tr -d ' ') lines"
  else record cli "$id" FAIL "$(( $(now) - t0 ))" "no log lines for $svc"; fi
}

# spend_now -> LiteLLM's 30-day spend of every key (master key via curl -K stdin, never argv)
spend_now() {
  local lp mk
  lp="$(get_env LITELLM_PORT)"
  mk="$(awk 'index($0, "LITELLM_MASTER_KEY=") == 1 { v = substr($0, 20) } END { printf "%s", v }' "$STACK/.env")"
  printf 'header = "Authorization: Bearer %s"\n' "$mk" | curl -sS -m 20 -K - "http://127.0.0.1:$lp/global/spend" 2>/dev/null |
    sed -n 's/.*"spend"[[:space:]]*:[[:space:]]*\([0-9.eE+-]*\).*/\1/p' | head -n 1
}
spend_ok() { awk -v s="${1:-0}" -v l="$2" 'BEGIN { exit !(s + 0 < l + 0) }'; }

# ======================================================================================================
if [ "$REUSE" = 1 ]; then
  [ -f "$STACK/.env" ] || die "--reuse: no kept throwaway in $STACK"
  # A half-dead kept stack (Docker restarted, a service crashed) must not be reused: every service healthy first.
  bad="$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Label "com.docker.compose.service"}} {{.State}} {{.Status}}' |
    awk '$1 != "rustfs-init" && ($2 != "running" || $0 ~ /unhealthy|starting/)')"
  [ -z "$bad" ] || die "--reuse: the kept throwaway is not healthy ($bad) — tests/e2e/run.sh --teardown, then a full run"
  say "reusing the throwaway in $STACK"
else
  stage
  say "setup (non-interactive; a few minutes; log: $LOGS/cli-setup.log)"
  cli setup 0 'bedrock-now is up' --aws setup --yes || {
    tail -n 40 "$LOGS/cli-setup.log" >&2; die "setup failed — see $LOGS/cli-setup.log (redacted)"; }
fi
[ -z "$(get_env PORTAL_PASSWORD)" ] && die "the throwaway .env has no PORTAL_PASSWORD"
PP="$(get_env PORTAL_PORT)"; LP="$(get_env LITELLM_PORT)"; MP="$(get_env SHARED_MCP_PORT)"
for p in "$PP" "$LP" "$MP"; do case "$AVOID_PORTS" in *" $p "*) die "throwaway uses a reserved port ($p)";; esac; done

# --- 2. read-only CLI checks ---
say "CLI: read-only commands"
cli help 0 'Usage: ./stack' help
cli unknown-command 1 'unknown command' bogus-command
cli status 0 'portal +running +healthy' status
cli status-disk 0 'Disk: images' status --disk
cli costs 0 'Spend this budget period' costs
cli models 0 'Model access for your AWS key' models
cli test 0 'all checks passed' test
for s in portal caddy litellm; do follow_logs "logs-$s" "$s"; done
if st clean --help 2>&1 | grep -q -- '--dry-run'; then cli clean-dry-run 0 '' clean --dry-run
else cli clean 0 'nothing to clean|Would remove|freed' clean --yes; fi
cli helper-status 0 'Update helper: not installed' helper status
cli stt-status 0 'Speech-to-text' stt status
cli remote-status any '[Rr]emote' remote status
cli openrouter-status 0 'OpenRouter' openrouter status
cli serve-stop any '' serve --stop
cli ssh-info any 'claude-bedrock|ssh' ssh-info
if st help 2>&1 | grep -qE '^  password'; then
  cli password 0 'PORTAL_PASSWORD in .*\.env' password
  # --show prints only to a terminal: here (no terminal) it must refuse and the raw output must not hold the password
  t0="$(now)"; raw="$(st password --show 2>&1)"; rc=$?
  if [ "$rc" != 0 ] && ! printf '%s' "$raw" | grep -qF -- "$(get_env PORTAL_PASSWORD)"; then
    record cli password-show-no-tty PASS "$(( $(now) - t0 ))" "refused without a terminal (exit $rc), password not printed"
  else record cli password-show-no-tty FAIL "$(( $(now) - t0 ))" "exit $rc; password printed without a terminal?"; fi
else record cli password SKIP 0 "no ./stack password on this branch"; fi
# --help for every command (never runs the command itself)
t0="$(now)"; bad=''
for c in $(st help 2>/dev/null | awk '/^  [a-z]/ { print $1 }'); do
  out="$(st "$c" --help 2>&1)" && printf '%s' "$out" | grep -q "Usage: ./stack $c" || bad="$bad $c"
done
if [ -z "$bad" ]; then record cli help-every-command PASS "$(( $(now) - t0 ))" "every ./stack <command> --help prints its usage"
else record cli help-every-command FAIL "$(( $(now) - t0 ))" "no usage from --help:$bad"; fi
cli uninstall-abort 1 'aborted' uninstall --yes
case "$(uname -s)" in Darwin) record cli open SKIP 0 "opens a GUI browser window on macOS (no headless mode)" ;;
  *) record cli open SKIP 0 "opens a browser window (no headless mode)" ;; esac

# --- 3. the browser suite (Playwright container) ---
say "browser suite (Playwright container)"
"$HERE/browser.sh" "$STACK" "$OUT" "$PROJECT" "$PW_IMAGE" || warn "the browser suite exited with an error (see $OUT/browser/run.log)"
[ -f "$OUT/browser/results.tsv" ] && cat "$OUT/browser/results.tsv" >> "$RESULTS"
[ -f "$OUT/browser/run.log" ] && redact "$OUT/browser/run.log"

# --- 4. claude-bedrock (the throwaway's wrapper, never the ~/.local/bin link) ---
if [ "$NO_CLAUDE" = 1 ]; then record claude claude-bedrock SKIP 0 "--no-claude"
elif ! command -v claude >/dev/null 2>&1; then record claude claude-bedrock SKIP 0 "Claude Code (claude) is not installed"
elif ! spend_ok "$(spend_now)" 0.07; then record claude claude-bedrock SKIP 0 "spend guard: already near \$$SPEND_LIMIT"
else
  say "claude-bedrock -p (Haiku, one short prompt)"
  t0="$(now)"; log="$LOGS/claude-bedrock.log"; haiku="$(get_env CLAUDE_BEDROCK_HAIKU_MODEL)"
  mkdir -p "$OUT/claude-config"
  # Its own CLAUDE_CONFIG_DIR: the run leaves your ~/.claude (history, settings) alone.
  ( export CLAUDE_CONFIG_DIR="$OUT/claude-config" CLAUDE_BEDROCK_MODEL="$haiku" CLAUDE_BEDROCK_SUMMARY=1
    clean_env CLAUDE_CONFIG_DIR CLAUDE_BEDROCK_MODEL CLAUDE_BEDROCK_SUMMARY
    exec "$STACK/bin/claude-bedrock" -p "Reply with exactly the word: ok" --max-turns 1 ) > "$log" 2>&1 </dev/null; rc=$?
  redact "$log"
  if [ "$rc" = 0 ] && grep -qiE '^ok\.?$' "$log" && grep -q '^bedrock · ' "$log"; then
    record claude claude-bedrock PASS "$(( $(now) - t0 ))" "answered ok via $haiku; cost line shown"
  else record claude claude-bedrock FAIL "$(( $(now) - t0 ))" "exit $rc: $(tail -n 3 "$log" | tr '\n' ' ')"; fi
  t0="$(now)"; out="$( (clean_env; exec "$STACK/bin/claude-bedrock" --help) 2>&1 </dev/null)"
  if printf '%s' "$out" | grep -q 'claude-bedrock: Claude Code on AWS Bedrock via bedrock-now'; then
    record claude claude-bedrock-help PASS "$(( $(now) - t0 ))" "wrapper header + claude --help"
  else record claude claude-bedrock-help FAIL "$(( $(now) - t0 ))" "no wrapper header"; fi
fi

# --- 5. CLI commands that change the throwaway (backup/restore, down/up, rotate-aws, update, rollback) ---
if [ "$SKIP_MUTATING" = 1 ]; then
  record cli mutating SKIP 0 "--skip-cli-mutating"
else
  say "CLI: commands that change the stack"
  cli backup 0 'backup written to backups/' backup
  bk=''
  for d in "$STACK"/backups/2*; do case "$d" in *-auto | *.partial) ;; *) [ -d "$d" ] && bk="$d" ;; esac; done
  if [ -n "$bk" ] && [ -f "$bk/litellm.dump" ] && [ -f "$bk/openwebui.dump" ] && [ -f "$bk/.env" ]; then
    record cli backup-contents PASS 0 "litellm.dump openwebui.dump s3/ .env (mode $(stat -f %Lp "$bk" 2>/dev/null || stat -c %a "$bk"))"
    cli restore 0 'all checks passed' restore "backups/${bk##*/}" --yes
    # The path ./stack itself prints ("./stack restore backups/<ts>") and ./stack rollback passes on is relative to
    # the checkout: it must work from another folder too (e.g. ~/bedrock-now/stack rollback run from $HOME).
    ST_CWD=/ cli restore-from-another-folder 0 'all checks passed' restore "backups/${bk##*/}" --yes
  else record cli backup-contents FAIL 0 "no complete backup directory"; fi
  cli down 0 '' down
  cli status-after-down 0 'not running|not created|exited' status
  cli up 0 'portal +running +healthy' up --yes
  cli rotate-aws-same-key 0 'all checks passed' --aws rotate-aws
  head="$(git -C "$STACK" rev-parse HEAD)"
  cli update-same-version 0 'already on|no new version' update --to "$head" --yes
  cli rollback-nothing 1 'nothing to roll back' rollback --yes
  if [ "$DEEP_UPDATE" = 1 ]; then
    git -C "$STACK" -c user.name=bedrock-now-e2e -c user.email=e2e@example.invalid commit -q --allow-empty -m "e2e: next version"
    next="$(git -C "$STACK" rev-parse HEAD)"; git -C "$STACK" -c advice.detachedHead=false checkout -q "$head"
    cli update-to-next 0 'updated to' update --to "$next" --yes
    cli rollback 0 'rolled back to' rollback --yes
    [ "$(git -C "$STACK" rev-parse HEAD)" = "$head" ] && record cli rollback-code PASS 0 "HEAD back at ${head%"${head#???????}"}" ||
      record cli rollback-code FAIL 0 "HEAD is $(git -C "$STACK" rev-parse --short HEAD), want ${head%"${head#???????}"}"
  fi
  cli test-after-mutating 0 'all checks passed' test
fi

# --- 6. spend guard ---
spend="$(spend_now)"; [ -z "$spend" ] || spend="$(awk -v s="$spend" 'BEGIN { printf "%.4f", s }')"
if [ -z "$spend" ]; then record spend spend-guard FAIL 0 "LiteLLM /global/spend did not answer"
elif spend_ok "$spend" "$SPEND_LIMIT"; then record spend spend-guard PASS 0 "total Bedrock spend \$$spend < \$$SPEND_LIMIT"
else record spend spend-guard FAIL 0 "total Bedrock spend \$$spend >= \$$SPEND_LIMIT"; fi
printf 'Bedrock spend of this run (LiteLLM /global/spend): $%s\n' "${spend:-unknown}" > "$OUT/spend.txt"

# --- 7. the default install's claude-bedrock link is untouched ---
LINK_AFTER="$(link_state)"
if [ "$LINK_AFTER" = "$LINK_BEFORE" ]; then record safety claude-bedrock-link-untouched PASS 0 "$LINK_AFTER"
else record safety claude-bedrock-link-untouched FAIL 0 "before: $LINK_BEFORE, after: $LINK_AFTER"; fi

# --- 8. report ---
if [ "$KEEP" = 1 ]; then say "kept the throwaway (tests/e2e/run.sh --teardown --project $PROJECT removes it)"
else trap - EXIT; teardown; fi
"$HERE/report.sh" "$RESULTS" "$HERE/known-issues.tsv" "$OUT" "$(( $(now) - START_TS ))" "${spend:-unknown}"
