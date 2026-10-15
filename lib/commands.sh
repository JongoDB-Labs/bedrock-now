# shellcheck shell=bash
# ./stack subcommands.

# Long-running services, in the order ./stack status lists them.
STACK_BASE_SERVICES="caddy portal open-webui litellm rustfs shared-mcp postgres"
STACK_SERVICES="$STACK_BASE_SERVICES"
# stack_services -> the stack's own services plus the optional ones .env turns on (stt: Bedrock speech-to-text).
# Built from STACK_BASE_SERVICES: callers keep a local STACK_SERVICES, which must not be extended twice.
stack_services() { local extra; extra="$(optional_services)"; printf '%s\n' "$STACK_BASE_SERVICES${extra:+ $extra}"; }
# optional_services -> the services .env turns on besides those: stt (Bedrock speech-to-text), terminal (./stack terminal)
optional_services() { local s t; s="$(stt_services)"; t="$(terminal_services)"; printf '%s\n' "$s${s:+${t:+ }}$t"; }

cmd_help() {
  cat <<'EOF'
Usage: ./stack <command> [--yes]

  setup        First-time (or repeat) setup: AWS creds, ports, model probe, keys (< $0.01 Bedrock)
  up | down    Start / stop the stack
  status       Services, health, URLs and disk use (the portal: one login for every browser UI)
               --disk measures disk use now (otherwise reused for 5 minutes)
  open         The installed bedrock-now app, else the portal in your browser, where
               "Install app" installs it (setup and up open it too; BEDROCK_NOW_NO_OPEN=1
               turns that off)
  logs [svc]   Follow logs (litellm, open-webui, rustfs, postgres, shared-mcp, portal, caddy, stt, terminal)
  test         Smoke-test every service end to end (~$0.0001 Bedrock)
  costs        Bedrock prices for your enabled models + spend per key
  prices       Check Bedrock prices now (public price lists; daily anyway)
               --accept applies a change the safety checks refused
  models       Which models your AWS key can use (last check)
               --recheck re-probes them (< $0.01 Bedrock)
  backup       Databases + buckets + .env → backups/<timestamp>/
               --nightly: the update helper's nightly backup (BACKUP_NIGHTLY; keeps BACKUP_KEEP)
  restore DIR  Restore from a backup directory (then runs test: ~$0.0001 Bedrock)
  update       Backup, new code (git), pinned images, re-run setup (< $0.01 Bedrock)
               --to <tag|branch> picks a version; local changes are never discarded;
               keeps one previous version of each image and removes older ones;
               nothing new: says so and stops (--force re-runs setup anyway)
  clean        Remove this project's old images (lists them first; keeps one previous version)
               --dry-run only lists them
  rollback     Back to the version before the last update: code, data (its backup) and images
  helper       One-click Update / Rollback / Clean on Home (setup offers it): install | uninstall
               | status | auto on [--hour N] | auto off | auto status   (automatic updates: a new
               release installs at night, N:00 to N+3:00 this computer's time; off by default, N=3)
  remote       The portal from your phone/laptop over HTTPS (Tailscale): status | enable tailscale
               | enable domain HOST | disable | test   (docs/remote.md)
  rotate-aws   Replace the AWS access key (then runs test: ~$0.0001 Bedrock)
               --use-instance-role / --use-keys switch between an EC2 IAM role and a key
  serve        Keep the stack up and this Mac awake until Ctrl-C (caffeinate; prints the URLs)
               --background holds it without a terminal, --stop ends that
  ssh-info     How to use claude-bedrock from your phone over SSH (Tailscale name, apps, tmux)
  openrouter   Optional OpenRouter models: status | set | apply | remove | refresh | list
               | models all|free|paid|<ids>   (no Bedrock calls; see README)
               apply uses the key pasted after OPENROUTER_API_KEY= in .env; set asks for one
  stt          Speech-to-text for the microphone and voice calls: Bedrock (Mistral Voxtral, no key;
               on by default when your AWS key can use it) or OpenAI/Groq (outside Bedrock):
               status | set bedrock [small|mini] | set openai|groq [model] | remove   (see docs/voice.md)
  terminal     Claude Code in the browser: a Terminal tab, a sandbox that sees only one folder of yours
               status | enable [--workspace DIR] | disable   (asks for the portal password again)
  password     Where the portal password is (PORTAL_PASSWORD in this folder's .env)
               --show prints it (only to a terminal)
  config       Every setting in .env, secrets masked (the portal's Settings tab shows the same):
               list | get KEY | set KEY [KEY…] (asks; hidden for secrets) | apply --stdin
               | check-aws (free) | report | regenerate rustfs|mcp-token
  restart      Restart one service: litellm | open-webui | shared-mcp | stt | rustfs | caddy
  uninstall    Remove the containers, ALL data volumes and this install's built images
               (keeps .env and backups/)

  Commands without a $ note make no Bedrock calls.  ./stack <command> --help shows one command.
  --yes        Accept defaults (non-interactive). AWS creds can come from
               AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION_NAME.
  BEDROCK_NOW_VERBOSE=1 ./stack setup   shows the full docker compose output.
  NO_COLOR=1   turns colours off.
EOF
}

# cmd_help_for COMMAND -> that command's lines of ./stack help (fails for an unknown command)
cmd_help_for() {
  local sect
  sect="$(cmd_help | C="$1" awk '
    /^  [a-z]/ { lab = substr($0, 3); sub(/   .*/, "", lab); n = split(lab, w, /[ |]+/); on = 0
                 for (i = 1; i <= n; i++) if (w[i] == ENVIRON["C"]) on = 1
                 if (on) print; next }
    on && /^               / { print; next }
    { on = 0 }')"
  [ -n "$sect" ] || return 1
  printf 'Usage: ./stack %s [options] [--yes]\n\n%s\n' "$1" "$sect"
}

# cmd_password — ./stack password: where the portal password is; --show prints it, only to a terminal
cmd_password() {
  case "${1:-}" in '' | --show) ;; *) die "usage: ./stack password [--show]" ;; esac
  [ -f "$ENV_FILE" ] && [ -n "$(get_env PORTAL_PASSWORD)" ] || die "no portal password yet — run ./stack setup"
  if [ "${1:-}" = --show ]; then
    _stdout_tty || die "not printing the password: stdout is not a terminal (it is PORTAL_PASSWORD in $(env_file_display))"
    printf '%s\n' "$(get_env PORTAL_PASSWORD)"
    return 0
  fi
  printf 'The portal password is PORTAL_PASSWORD in %s (project %s).\n' "$(env_file_display)" "$(project_name)"
  printf 'Print it: ./stack password --show   Change it: Settings in the portal, or ./stack config set PORTAL_PASSWORD\n'
}

check_prereqs() {
  require_cmd docker "install Docker Desktop (macOS) or Docker Engine (Linux)"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin is required"
  check_docker_daemon
  check_docker_engine
  require_cmd curl; require_cmd openssl; require_cmd awk; require_cmd sed
}

check_docker_daemon() { # dies with an actionable message when `docker info` fails
  local err
  err="$(docker info 2>&1 >/dev/null)" && return 0
  case "$err" in
    *"permission denied"*) die "cannot use the Docker daemon: permission denied on its socket — add yourself to the docker group (sudo usermod -aG docker \$USER, then log out and back in), or use Docker Desktop" ;;
    *) die "the Docker daemon is not running — start Docker Desktop (macOS) or the docker service (Linux: sudo systemctl start docker)" ;;
  esac
}

check_docker_engine() { # Linux: Docker Engine < 28 can expose 127.0.0.1-published ports to the local network
  local ver major
  [ "$(uname -s)" = Linux ] || return 0
  ver="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"; major="${ver%%.*}"
  case "$major" in '' | *[!0-9]*) return 0 ;; esac
  [ "$major" -ge 28 ] || warn "Docker Engine $ver: versions before 28.0 can let other machines on your local network reach ports published on 127.0.0.1 — please update Docker Engine (https://docs.docker.com/engine/install/)"
}

_docker_rootless() { docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q rootless; }

# --- quiet, phased bring-up (BEDROCK_NOW_VERBOSE=1 shows all compose output) ---

fmt_elapsed() { # fmt_elapsed SECONDS -> "16s" / "2m05s"
  local s="${1:-0}"
  if [ "$s" -lt 60 ]; then printf '%ss\n' "$s"; else printf '%dm%02ds\n' $((s / 60)) $((s % 60)); fi
}
phase_line() { printf '%s ready (%s)\n' "$1" "$(fmt_elapsed "$2")"; }   # phase_line LABEL SECONDS
_now() { date +%s; }
is_verbose() { [ "${BEDROCK_NOW_VERBOSE:-0}" = 1 ]; }

# quiet_compose — for the rest of this command, Compose leaves out its per-container progress lines ("Container x
# Waiting", "… Healthy": dozens per restore) and still prints its errors. BEDROCK_NOW_VERBOSE=1 shows them, and a
# COMPOSE_PROGRESS of your own is kept. compose_quiet_env -> the same as an env(1) argument, for child processes.
quiet_compose() { is_verbose || export COMPOSE_PROGRESS="${COMPOSE_PROGRESS:-quiet}"; }
compose_quiet_env() { is_verbose || printf 'COMPOSE_PROGRESS=%s\n' "${COMPOSE_PROGRESS:-quiet}"; }

# _failed_services SVCS... -> the ones that are not running, or are unhealthy/still starting (all if none match)
_failed_services() {
  local ps s state bad=''
  ps="$(dc ps -a --format '{{.Service}}	{{.State}}	{{.Health}}' 2>/dev/null || true)"
  for s in "$@"; do
    state="$(printf '%s\n' "$ps" | awk -F'\t' -v s="$s" '$1 == s { print $2 "/" $3 }')"
    case "$state" in running/healthy | running/) ;; *) bad="$bad $s" ;; esac
  done
  [ -n "$bad" ] || bad=" $*"
  printf '%s\n' "${bad# }"
}

# run_phase LABEL "SERVICES" CMD... — runs CMD (usually a dc call) with its output hidden, then prints
# "==> LABEL ready (16s)". On failure: the last 30 output lines, the last 30 log lines of each failed
# service, and the ./stack logs hint; then dies.
run_phase() {
  local label="$1" svcs="$2" start rc=0 out s failed first
  shift 2
  start="$(_now)"
  if is_verbose; then
    log "$label: starting…"
    "$@" || rc=$?
  else
    out="$(mktemp)"; _cleanup_on_signal "$out"
    [ ! -t 2 ] || printf '%s==>%s %s: starting…' "$C_GRN" "$C_OFF" "$label" >&2
    "$@" > "$out" 2>&1 || rc=$?
    [ ! -t 2 ] || printf '\r\033[K' >&2
  fi
  [ -z "${out:-}" ] || trap - INT TERM
  if [ "$rc" -eq 0 ]; then
    [ -z "${out:-}" ] || rm -f "$out"
    log "$(phase_line "$label" $(($(_now) - start)))"
    return 0
  fi
  warn "$label failed after $(fmt_elapsed $(($(_now) - start)))"
  if [ -n "${out:-}" ]; then
    printf '  --- last 30 lines of output ---\n' >&2; tail -n 30 "$out" | sed 's/^/    /' >&2; rm -f "$out"
  fi
  # shellcheck disable=SC2086  # word-split the service list on purpose
  failed="$(_failed_services $svcs)"
  for s in $failed; do
    printf '  --- last 30 log lines of %s ---\n' "$s" >&2
    dc logs --no-color --tail 30 "$s" 2>&1 | sed 's/^/    /' >&2 || true
  done
  first="${failed%% *}"
  die "$label did not come up — full logs: ./stack logs ${first:-<service>}   (BEDROCK_NOW_VERBOSE=1 ./stack setup shows all compose output)"
}

image_size_mb() { # rough on-disk size of a pinned image, for the first-run download notice
  case "$1" in
    *litellm*) echo 1750 ;; *open-webui*) echo 950 ;; *aws-cli*) echo 680 ;; *pgvector*) echo 660 ;; *rustfs*) echo 360 ;;
    *caddy*) echo 90 ;; *) echo 300 ;;
  esac
}

# missing_images -> compose images not present locally (locally built ones excluded)
missing_images() {
  local img
  dc config --images 2>/dev/null | while IFS= read -r img; do
    case "$img" in '' | */shared-mcp:local | */portal:local | */stt:local | */caddy-dns:local | */terminal:local) continue ;; esac
    docker image inspect "$img" >/dev/null 2>&1 || printf '%s\n' "$img"
  done
}

# ensure_images [RERUN_CMD] — downloads missing pinned images up front, with Docker's own progress output.
ensure_images() {
  local rerun="${1:-./stack setup}" missing img n=0 mb=0
  missing="$(missing_images)"
  [ -n "$missing" ] || return 0
  for img in $missing; do n=$((n + 1)); mb=$((mb + $(image_size_mb "$img"))); done
  log "downloading $n image(s) (~$(awk -v m="$mb" 'BEGIN { printf "%.1f", m / 1000 }') GB on disk; on a first run this takes several minutes)"
  for img in $missing; do
    docker pull "$img" || die "could not download $img — check your network / registry access and re-run $rerun"
  done
}

# fix_bind_mount_perms — containers read litellm/, postgres/init.sql, caddy/Caddyfile and catalog/ (the portal)
# as non-owner users, so a strict umask (077) on clone must not make them unreadable.
fix_bind_mount_perms() {
  local f
  chmod a+rX "$STACK_DIR/litellm" "$STACK_DIR/postgres" "$STACK_DIR/caddy" "$STACK_DIR/catalog"
  chmod 644 "$STACK_DIR/postgres/init.sql" "$STACK_DIR/caddy/Caddyfile" "$STACK_DIR"/catalog/*.tsv
  for f in "$STACK_DIR"/caddy/*.caddy "$STACK_DIR/caddy/Dockerfile"; do [ ! -f "$f" ] || chmod 644 "$f"; done   # remote access
  [ ! -f "$STACK_DIR/litellm/config.yaml" ] || chmod 644 "$STACK_DIR/litellm/config.yaml"
}

# persist_project_name — on the FIRST setup only (no POSTGRES_PASSWORD yet), a COMPOSE_PROJECT_NAME from the
# shell (second copy of the stack) is validated and stored in .env so every later ./stack command targets
# that project. On later runs a different shell value stops setup before anything is changed.
persist_project_name() {
  local want="${COMPOSE_PROJECT_NAME:-}" cur
  if [ -n "$(get_env POSTGRES_PASSWORD)" ]; then
    cur="$(project_name)"
    [ -z "$want" ] || [ "$want" = "$cur" ] ||
      die "this checkout is project '$cur' but COMPOSE_PROJECT_NAME=$want is set in your shell — unset it (or use the other checkout). Nothing was changed."
    return 0
  fi
  [ -n "$want" ] || return 0
  case "$want" in
    [a-z0-9]*) case "$want" in *[!a-z0-9_-]*) die "COMPOSE_PROJECT_NAME must be lowercase letters, digits, - or _ (got '$want')" ;; esac ;;
    *) die "COMPOSE_PROJECT_NAME must start with a lowercase letter or digit (got '$want')" ;;
  esac
  set_env COMPOSE_PROJECT_NAME "$want"
}

# --- one Compose project per checkout: lib/guard.sh (guard_project, guard_uninstall) ---

# aws_cli ARGS... — runs aws-cli in a throwaway container with creds from .env (never on argv).
# AWS_REGION_OVERRIDE=<region> calls a different region than .env's AWS_REGION_NAME (per-model regions).
# AWS_AUTH=instance-role (lib/host.sh): no creds at all, the container uses the EC2 instance role via IMDS.
aws_cli() {
  if uses_instance_role; then
    aws_run_role "${AWS_REGION_OVERRIDE:-$(get_env AWS_REGION_NAME)}" "$@"
  else
    aws_run "$(get_env AWS_ACCESS_KEY_ID)" "$(get_env AWS_SECRET_ACCESS_KEY)" "${AWS_REGION_OVERRIDE:-$(get_env AWS_REGION_NAME)}" "$@"
  fi
}

# aws_run KEY_ID SECRET REGION ARGS... — same, with explicit creds (handed to docker via -e NAME, not argv).
aws_run() {
  local id="$1" secret="$2" region="$3"; shift 3
  AWS_ACCESS_KEY_ID="$id" AWS_SECRET_ACCESS_KEY="$secret" AWS_DEFAULT_REGION="$region" \
    docker run --rm -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION "$AWS_CLI_IMAGE" "$@" </dev/null
}

# _reject_temporary_creds KEY_ID [SESSION_TOKEN] — STS credentials expire within hours and LiteLLM
# would then fail mid-session, so only long-lived IAM user keys (AKIA…) are accepted.
_reject_temporary_creds() {
  case "$1" in ASIA*) ;; *) [ -n "${2:-}" ] || return 0 ;; esac
  die "temporary AWS credentials (an ASIA… key or AWS_SESSION_TOKEN) aren't supported — they expire and LiteLLM would stop working. Use a long-lived IAM user access key (starts with AKIA); if it came from your shell, unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN"
}

# _env_aws_creds_chosen -> 0 if the AWS_* creds exported in this shell should be used: always when
# non-interactive (--yes or no terminal), only after an explicit "y" when someone is at the keyboard.
_env_aws_creds_chosen() {
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || return 1
  if [ "${ASSUME_YES:-0}" = 1 ] || ! _have_tty; then return 0; fi
  # Default Yes only for a long-lived IAM user key (AKIA…, no session token); temporary ones are refused later.
  local yn="[y/N]" def=n
  case "$AWS_ACCESS_KEY_ID" in AKIA*) [ -n "${AWS_SESSION_TOKEN:-}" ] || { yn="[Y/n]"; def=y; } ;; esac
  case "$(ask "found AWS_ACCESS_KEY_ID=$(printf '%s' "$AWS_ACCESS_KEY_ID" | cut -c1-8)… in your environment — use it? $yn" "$def")" in
    [Yy]*) return 0 ;; *) return 1 ;;
  esac
}

setup_aws_creds() {
  local id='' secret='' region arn errf
  setup_instance_role && return 0   # EC2 with an IAM role and no key configured: no keys at all (lib/host.sh)
  region="${AWS_REGION_NAME:-${AWS_REGION:-}}"
  if _env_aws_creds_chosen; then
    id="$AWS_ACCESS_KEY_ID"; secret="$AWS_SECRET_ACCESS_KEY"
    _reject_temporary_creds "$id" "${AWS_SESSION_TOKEN:-}"
  elif [ -n "$(get_env AWS_ACCESS_KEY_ID)" ] && confirm "Keep the AWS key already in .env ($(get_env AWS_ACCESS_KEY_ID | cut -c1-8)…)?"; then
    id="$(get_env AWS_ACCESS_KEY_ID)"; secret="$(get_env AWS_SECRET_ACCESS_KEY)"
  fi
  [ -n "$id" ] || id="$(ask "AWS access key ID" "")"
  [ -n "$secret" ] || [ -z "$id" ] || ! _have_tty || [ "${ASSUME_YES:-0}" = 1 ] || secret="$(ask_secret "AWS secret access key (hidden)")"
  [ -n "$id" ] && [ -n "$secret" ] ||
    die "AWS credentials are required (non-interactive: export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or run ./setup.sh in a terminal; on EC2, attach an IAM role instead — docs/cloud-vm.md)"
  _reject_temporary_creds "$id"
  region="$(ask "AWS region" "${region:-$(get_env AWS_REGION_NAME)}")"; region="${region:-us-east-1}"
  valid_region "$region" || die "invalid AWS region: '$region' (expected something like us-east-1)"
  # Leaving the instance role: the key is proven first, so a bad key never ends role mode (lib/host.sh).
  ! uses_instance_role || verify_key_leaving_role "$id" "$secret" "$region"
  set_env AWS_ACCESS_KEY_ID "$id"; set_env AWS_SECRET_ACCESS_KEY "$secret"; set_env AWS_REGION_NAME "$region"
  unset_env AWS_AUTH
  docker pull -q "$AWS_CLI_IMAGE" >/dev/null || die "could not pull $AWS_CLI_IMAGE (network/Docker Hub?)"
  log "verifying AWS credentials…"
  errf="$(mktemp)"
  if ! arn="$(aws_cli sts get-caller-identity --query Arn --output text 2>"$errf")"; then
    arn="$(cat "$errf")"; rm -f "$errf"; die "AWS rejected the credentials: $arn"
  fi
  rm -f "$errf"
  log "authenticated as $arn"
}

setup_ports() {
  migrate_direct_ports
  setup_portal_host
  resolve_portal_port
  resolve_port LITELLM_PORT 4000 litellm 4000
  resolve_port SHARED_MCP_PORT 8765 shared-mcp 8000
}

# litellm_password_ok PASSWORD -> 0 when it meets LiteLLM's default policy: 12+ chars with an upper- and a
# lowercase letter, a digit and a symbol.
litellm_password_ok() {
  [ "${#1}" -ge 12 ] || return 1
  case "$1" in *[[:upper:]]*) ;; *) return 1 ;; esac
  case "$1" in *[[:lower:]]*) ;; *) return 1 ;; esac
  case "$1" in *[[:digit:]]*) ;; *) return 1 ;; esac
  case "$1" in *[![:alnum:]]*) ;; *) return 1 ;; esac
}

# upgrade_litellm_password — runs before LiteLLM starts, so it always starts with a password its policy
# accepts. Older installs have hex passwords: they get a "Bn9-" prefix (once). Anything else that still
# fails the policy is replaced by a new generated one.
upgrade_litellm_password() {
  local pw; pw="$(get_env LITELLM_UI_PASSWORD)"
  litellm_password_ok "$pw" && return 0
  case "$pw" in
    Bn9-*) ;;
    *) if litellm_password_ok "Bn9-$pw"; then
         set_env LITELLM_UI_PASSWORD "Bn9-$pw"
         log "LITELLM_UI_PASSWORD in .env now starts with Bn9- (LiteLLM requires upper/lowercase, a digit and a symbol)"
         return 0
       fi ;;
  esac
  set_env LITELLM_UI_PASSWORD "Bn9-$(gen_hex 12)"
  warn "LITELLM_UI_PASSWORD in .env did not meet LiteLLM's password policy (12+ characters, upper/lowercase, digit, symbol) — generated a new one (see .env)"
}

# A newly generated portal password (first setup, or the first setup after an update from v0.1.x) is shown by
# the next summary that gets printed (marker .state/portal-password-shown), even if this run fails first.
setup_secrets() {
  [ -n "$(get_env PORTAL_PASSWORD)" ] || rm -f "$STATE_DIR/portal-password-shown"
  ensure_env PORTAL_PASSWORD "$(gen_hex 10)"
  ensure_portal_password_hash   # lib/settings.sh: the portal gets the hash, never the password
  ensure_env PORTAL_SECRET "$(gen_hex 32)"
  ensure_env POSTGRES_PASSWORD "$(gen_hex 24)"
  ensure_env LITELLM_MASTER_KEY "sk-$(gen_hex 24)"
  ensure_env LITELLM_SALT_KEY "sk-$(gen_hex 24)"   # never change after first run: encrypts stored creds
  ensure_env LITELLM_UI_PASSWORD "Bn9-$(gen_hex 12)"   # LiteLLM's policy: upper+lower case, digit, symbol
  upgrade_litellm_password
  ensure_env WEBUI_SECRET_KEY "$(gen_hex 32)"
  ensure_env OPENWEBUI_ADMIN_PASSWORD "$(gen_hex 12)"
  ensure_env RUSTFS_ACCESS_KEY "bn-$(gen_hex 6)"
  ensure_env RUSTFS_SECRET_KEY "$(gen_hex 24)"
  ensure_env SHARED_MCP_TOKEN "$(gen_hex 32)"
  remote_ensure_proxy_secret   # Caddy → portal: proves a request came through Caddy (lib/remote.sh)
  ensure_env BUDGET_CLAUDE_CODE 200
  ensure_env BUDGET_OPENWEBUI 50
  ensure_env BUDGET_SETUP 5
  ensure_env LITELLM_STORE_PROMPTS false
  local email src def
  owner_email_lowercase   # lib/settings.sh: Chat keeps emails in lowercase
  email="$(get_env OPENWEBUI_ADMIN_EMAIL)"
  if [ -n "$email" ]; then
    src="from OPENWEBUI_ADMIN_EMAIL in .env"
  else
    def="$(git config user.email 2>/dev/null || true)"
    if [ -n "$def" ]; then src="from git config"; else def=admin@bedrock-now.local; src="default"; fi
    email="$(ask "Open WebUI admin email" "$def")"
    [ "$email" = "$def" ] || src="entered"
    email="$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')"   # (as Chat keeps it)
    case "$email" in *@*.*) set_env OPENWEBUI_ADMIN_EMAIL "$email" ;; *) die "invalid email: $email" ;; esac
    src="$src; to use another address, set OPENWEBUI_ADMIN_EMAIL in .env before the first setup"
  fi
  log "Open WebUI admin: $email ($src)"
}

cmd_setup() {
  check_prereqs
  [ ! -f "$ENV_FILE" ] || stack_lock setup
  forget_setup_commit   # lib/rollback.sh: written again only if this setup succeeds
  [ -f "$ENV_FILE" ] || { cp "$STACK_DIR/.env.example" "$ENV_FILE"; chmod 600 "$ENV_FILE"; }
  # Never share a Compose project (or its volumes) with another checkout. On a first setup the name may still
  # come from the shell, so check that name before persist_project_name saves it.
  if [ -z "$(get_env POSTGRES_PASSWORD)" ] && [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then guard_project "$COMPOSE_PROJECT_NAME"
  else guard_project; fi
  persist_project_name   # a mismatching shell project name stops setup before any change
  chmod 600 "$ENV_FILE"
  mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
  ensure_portal_dirs; write_version_file   # lib/version.sh: what the portal mounts, and the installed version
  fix_bind_mount_perms
  setup_aws_creds
  setup_ports
  setup_remote_choice   # lib/remote.sh: asks once — this computer only (default), or your devices too
  remote_net_preflight  # remote access on: its Docker network usable? else this run goes on without it
  setup_secrets
  setup_openrouter   # optional; lib/openrouter.sh
  setup_stt          # optional; lib/stt.sh
  setup_bringup_and_probe
  stt_after_probe    # lib/stt.sh: Bedrock speech-to-text on by default when Voxtral is usable
  setup_keys_and_ui
  write_mcp_config
  terminal_setup_hook   # lib/terminal.sh: the browser terminal, when on — rebuilt with the current keys; never fatal
  cmd_test
  offer_symlink
  offer_helper   # lib/helper.sh: asks once; --yes installs it only with BEDROCK_NOW_HELPER=1
  if [ -n "$SETUP_REMOTE_MODE" ]; then remote_enable "$SETUP_REMOTE_MODE"; else remote_up_hook; fi
  record_setup_commit   # lib/rollback.sh: ./stack update calls "nothing new" only for this commit
  print_summary
  [ "$(host_os)" != Darwin ] || docker_autostart_hint_weekly   # lib/host.sh: read-only check, at most weekly
  maybe_auto_open
}

# --- setup part 2: bring-up, model probe, virtual keys, Open WebUI ---

# render_config ENABLED_FILE("" = all) [OUT] — atomic: OUT is replaced only if rendering succeeds.
render_config() {
  local out="${2:-$STACK_DIR/litellm/config.yaml}" tmp
  tmp="$(mktemp "$out.XXXXXX")" || die "cannot create a temp file next to $out"
  if ! (render_litellm_config "$1" "$(get_env AWS_REGION_NAME)" "$(get_env LITELLM_STORE_PROMPTS)" \
        "$([ -n "$(get_env ALERT_WEBHOOK_URL)" ] && echo true || echo false)" "$(get_env LITELLM_DB_ADMIN_READY)") > "$tmp"; then
    rm -f "$tmp"; die "could not render $out"
  fi
  chmod 644 "$tmp"   # read by the litellm container
  mv "$tmp" "$out"
}

# litellm_ui_user -> the LiteLLM UI login name: the database admin's email once setup created it, else "admin"
litellm_ui_user() {
  if [ "$(get_env LITELLM_DB_ADMIN_READY)" = true ]; then get_env OPENWEBUI_ADMIN_EMAIL; echo; else echo admin; fi
}

valid_budget() { # valid_budget VALUE -> 0 if a plain non-negative number (e.g. 200 or 12.50)
  case "$1" in '' | . | *[!0-9.]* | *.*.*) return 1 ;; esac
}

parse_virtual_key() { # parse_virtual_key < /key/generate JSON -> the sk-… key, or fails
  local k; k="$(json_get key)"
  case "$k" in sk-?*) printf '%s\n' "$k" ;; *) return 1 ;; esac
}

# _pinned PIN_KEY EN -> the model PIN_KEY in .env pins (Settings, ./stack config set) while it is an enabled chat
# model; nothing when unpinned; a warning when the pinned one is no longer enabled (the automatic choice is used)
_pinned() {
  local p; p="$(get_env "$1")"
  [ -n "$p" ] || return 0
  if grep -qxF "$p" "$2" 2>/dev/null && catalog_rows | P="$p" awk -F'\t' '$1 == ENVIRON["P"] && $2 == "chat" { f = 1 } END { exit !f }'; then
    printf '%s\n' "$p"
  else
    warn "$1=$p is not a chat model your AWS key can use now — using the automatic choice (Settings → AWS & models)"
  fi
  return 0
}

choose_defaults() { # derive model choices from litellm/enabled-models.txt (pins in .env win while enabled)
  local en="$STACK_DIR/litellm/enabled-models.txt" m p
  p="$(_pinned CLAUDE_MODEL_OPUS "$en")"; set_env CLAUDE_BEDROCK_OPUS_MODEL "${p:-$(first_enabled "$en" claude-opus-5-5 claude-sonnet-5-5 claude-sonnet-4-5)}"
  p="$(_pinned CLAUDE_MODEL_SONNET "$en")"; set_env CLAUDE_BEDROCK_SONNET_MODEL "${p:-$(first_enabled "$en" claude-sonnet-5-5 claude-sonnet-4-5)}"
  p="$(_pinned CLAUDE_MODEL_HAIKU "$en")"; set_env CLAUDE_BEDROCK_HAIKU_MODEL "${p:-$(first_enabled "$en" claude-haiku-5-5 claude-sonnet-4-5)}"
  [ -n "$(get_env CLAUDE_BEDROCK_OPUS_MODEL)" ] || warn "no Claude model is usable with this key — claude-bedrock will not work"

  # Open WebUI: default chat model, and the cheap model for titles/tags/follow-up suggestions.
  m="$(first_enabled "$en" claude-sonnet-5-5 claude-sonnet-4-5 claude-haiku-5-5)"
  p="$(_pinned CHAT_DEFAULT_MODEL "$en")"; set_env OWUI_DEFAULT_MODEL "${p:-$m}"
  p="$(_pinned CHAT_TASK_MODEL "$en")"; set_env OWUI_TASK_MODEL "${p:-$(first_enabled "$en" claude-haiku-5-5)}"
  [ -n "$(get_env OWUI_TASK_MODEL)" ] || set_env OWUI_TASK_MODEL "$m"

  # Bedrock-only rule: never let Open WebUI fall back to a local (Hugging Face-downloaded) embedder.
  m="$(first_enabled "$en" cohere-embed-v4 titan-embed-v2)"
  set_env OWUI_EMBED_ENGINE openai; set_env OWUI_EMBED_MODEL "$m"
  [ -n "$m" ] || warn "no Bedrock embedding model is enabled for your key — document upload/RAG in Open WebUI won't work until your AWS admin enables Cohere Embed v4 or Titan Embed v2"

  m="$(first_enabled "$en" cohere-rerank-3-5)"
  if [ -n "$m" ]; then set_env OWUI_HYBRID_SEARCH true; set_env OWUI_RERANK_ENGINE external; set_env OWUI_RERANK_MODEL "$m"
  else set_env OWUI_HYBRID_SEARCH false; set_env OWUI_RERANK_ENGINE ""; set_env OWUI_RERANK_MODEL ""; fi

  m="$(first_enabled "$en" sd3-5-large stable-image-ultra stable-image-core)"
  if [ -n "$m" ]; then set_env OWUI_ENABLE_IMAGES true; set_env OWUI_IMAGE_MODEL "$m"
  else set_env OWUI_ENABLE_IMAGES false; set_env OWUI_IMAGE_MODEL ""; fi
}

# If setup dies while LiteLLM runs the full probing catalog, put the last known-good config back.
_restore_litellm_config() {
  local en="$STACK_DIR/litellm/enabled-models.txt"
  rm -f "$en.new"
  [ -s "$en" ] || return 0
  warn "setup stopped during the model probe — restoring the previous LiteLLM config"
  (render_config "$en" && dc up -d --no-deps --force-recreate litellm >/dev/null 2>&1) || warn "could not restore it; re-run ./stack setup"
}

setup_bringup_and_probe() {
  local en="$STACK_DIR/litellm/enabled-models.txt"
  # Today's prices before LiteLLM's config is rendered (lib/prices.sh; never fatal). The portal image runs the
  # updater, so build it first: an image from before an update would not have it.
  ensure_prices_dir
  if dc build -q portal >/dev/null 2>&1; then refresh_prices 1
  else warn "could not build the portal image yet — prices stay as they are (./stack logs portal after setup)"; fi
  log "rendering LiteLLM config with the full catalog for probing"
  on_exit _restore_litellm_config
  render_config ""
  ensure_images
  run_phase "Postgres + RustFS" "postgres rustfs" _up_data_services
  warn "LiteLLM restarts while probing models; active claude-bedrock/Open WebUI requests may fail for ~1 min"
  run_phase "LiteLLM (full catalog, for probing)" litellm dc up -d --no-deps --force-recreate --wait litellm
  # Probe and smoke-test spend is booked on its own key, so ./stack costs shows what setup itself cost.
  ensure_virtual_key LITELLM_KEY_SETUP setup "$(get_env BUDGET_SETUP)"
  log "probing which models your AWS key can use (chat/embedding/rerank/speech-to-text: 1-token requests, < \$0.01 total; images: free check)"
  probe_models "$en.new" "$STACK_DIR/litellm/probe-results.tsv"
  [ -s "$en.new" ] || die "no models are usable with this AWS key — check with your AWS admin"
  mv "$en.new" "$en"
  render_config "$en"
  off_exit _restore_litellm_config
  choose_defaults
  run_phase "LiteLLM ($(wc -l < "$en" | tr -d ' ') models)" litellm dc up -d --no-deps --force-recreate --wait litellm
}

_up_data_services() { dc up -d --wait postgres rustfs && dc up -d rustfs-init; }
_build_and_up_mcp() { dc build -q shared-mcp && dc up -d --wait shared-mcp; }

# _build_and_up_portal — portal, then Caddy (recreated: with its admin API off, a changed Caddyfile is only
# read at start). If Docker refuses to publish port 80 after all, falls back to 8800 once.
_build_and_up_portal() {
  local out rc=0
  ensure_portal_password_hash   # lib/settings.sh: the portal starts only with a hash that matches PORTAL_PASSWORD
  dc build -q portal && dc up -d --wait portal || return 1
  out="$(dc up -d --wait --force-recreate caddy 2>&1)" || rc=$?
  printf '%s\n' "$out"
  [ "$rc" -ne 0 ] || return 0
  # Only a refused port 80 (rootless/unprivileged engines) moves the portal; any other failure is reported.
  [ "$(portal_port)" = 80 ] && printf '%s\n' "$out" | grep -qiE 'bind|privileged|port is already allocated|ports are not available' || return 1
  PORTAL_PORT_FELL_BACK=1
  set_env PORTAL_PORT "$PORTAL_FALLBACK_PORT"
  resolve_port PORTAL_PORT "$PORTAL_FALLBACK_PORT" caddy 8080
  save_portal_origin
  dc up -d --wait portal && dc up -d --wait --force-recreate caddy   # portal: its PORTAL_PORT changed too
}

# up_portal — the portal phase of setup (and models --recheck): new code, settings and Caddyfile take effect.
up_portal() {
  PORTAL_PORT_FELL_BACK=0
  run_phase "Portal ($(portal_url))" "portal caddy" _build_and_up_portal
  [ "$PORTAL_PORT_FELL_BACK" = 0 ] || warn "Docker could not publish port 80 → using $(portal_port) for the portal (PORTAL_PORT): $(portal_url)"
}

# portal_session_or_die — a portal session for setup's Open WebUI calls (they go through Caddy like a browser).
portal_session_or_die() {
  portal_session_start || {
    portal_session_end
    die "could not sign in to the portal at $(portal_url) (HTTP ${PORTAL_LOGIN_CODE:-?}) — see ./stack logs portal and ./stack logs caddy"
  }
}

ensure_virtual_key() { # ensure_virtual_key ENV_KEY ALIAS BUDGET [ROUTES_JSON]
  # ROUTES_JSON (a JSON list of paths): the only LiteLLM routes the key may call, set on a new key and on every
  # run on an existing one (so older keys get it too); LiteLLM answers 403 to the rest.
  local envk="$1" alias="$2" budget="$3" routes="${4:-}" cur tmp code key soft
  valid_budget "$budget" || die "budget for $alias must be a number of USD, got '$budget' (see BUDGET_* in .env)"
  soft="$(soft_budget_of "$budget")"   # BUDGET_ALERT_PCT (default 80%): LiteLLM alerts there (ALERT_WEBHOOK_URL); only max_budget blocks
  cur="$(get_env "$envk")"
  if [ -n "$cur" ]; then
    # /key/info with the key itself as bearer (keeps the key out of URLs/argv).
    code="$(litellm_key_status "$cur")"
    case "$code" in
      200)
        # keep the key; sync max_budget + soft_budget (budget_duration untouched so the reset date stays put)
        tmp="$(mktemp)"
        code="$(litellm_api POST /key/update "{\"key\":\"$cur\",\"max_budget\":$budget,\"soft_budget\":$soft${routes:+,\"allowed_routes\":$routes}}" "$tmp")"
        [ "$code" = 200 ] || warn "could not update the budget of LiteLLM key '$alias' (HTTP $code): $(head -c 300 "$tmp")"
        rm -f "$tmp"
        log "kept existing LiteLLM key '$alias' (monthly budget \$$budget, resets on the date shown by ./stack costs)"
        return 0 ;;
      401 | 403 | 404) warn "LiteLLM key '$alias' in .env is no longer valid (HTTP $code) — creating a new one" ;;
      *) die "LiteLLM returned HTTP $code while checking key '$alias' — not creating a duplicate; see ./stack logs litellm" ;;
    esac
  fi
  tmp="$(mktemp)"
  code="$(litellm_api POST /key/generate "{\"key_alias\":\"$alias\",\"max_budget\":$budget,\"soft_budget\":$soft,\"budget_duration\":\"30d\"${routes:+,\"allowed_routes\":$routes}}" "$tmp")"
  [ "$code" = 200 ] || { head -c 500 "$tmp" >&2; rm -f "$tmp"; die "could not create LiteLLM key '$alias' (HTTP $code)"; }
  key="$(parse_virtual_key < "$tmp")" || { head -c 300 "$tmp" >&2; rm -f "$tmp"; die "unexpected /key/generate response for '$alias' (no sk- key found)"; }
  set_env "$envk" "$key"
  log "created LiteLLM key '$alias' (monthly budget \$$budget, resets on the date shown by ./stack costs)"
  rm -f "$tmp"
}

# Open WebUI publishes no port: setup reaches it through Caddy with a portal session ($PORTAL_JAR), exactly
# like the browser. Sign-in uses the trusted header Caddy adds for that session (the admin's email).
ensure_openwebui_api_key() {
  local cur tmp token key
  cur="$(get_env OPENWEBUI_API_KEY)"
  # Validity check on an endpoint shared-mcp really uses (v0.12 refuses API keys on /api/v1/auths/:
  # "A human session is required").
  if [ -n "$cur" ] && portal_curl_auth "$cur" chat /api/v1/knowledge/ -fsS -m 30 -o /dev/null 2>/dev/null; then
    log "kept existing Open WebUI API key"; return 0
  fi
  tmp="$(mktemp)"
  # In trusted-header mode Open WebUI ignores the password and signs in the header's user; the form still needs both fields.
  printf '{"email":"","password":""}' |
    portal_curl chat /api/v1/auths/signin -fsS -m 30 -o "$tmp" -H 'Content-Type: application/json' --data-binary @- ||
    { rm -f "$tmp"; die "could not sign in to Open WebUI through the portal as $(get_env OPENWEBUI_ADMIN_EMAIL) — see ./stack logs open-webui"; }
  token="$(json_get token < "$tmp")"
  [ -n "$token" ] || { rm -f "$tmp"; die "Open WebUI sign-in returned no token"; }
  portal_curl_auth "$token" chat /api/v1/auths/api_key -fsS -m 30 -X POST -o "$tmp" || { rm -f "$tmp"; die "could not create Open WebUI API key"; }
  key="$(json_get api_key < "$tmp")"; rm -f "$tmp"
  case "$key" in sk-?*) ;; *) die "unexpected Open WebUI API key response" ;; esac
  set_env OPENWEBUI_API_KEY "$key"
  log "created Open WebUI API key for shared-mcp"
}

setup_keys_and_ui() {
  log "creating LiteLLM virtual keys with monthly budgets"
  ensure_virtual_key LITELLM_KEY_CLAUDE_CODE claude-code "$(get_env BUDGET_CLAUDE_CODE)"
  ensure_virtual_key LITELLM_KEY_OPENWEBUI open-webui "$(get_env BUDGET_OPENWEBUI)"
  alert_pct_mark || true   # lib/settings.sh: all three keys alert at BUDGET_ALERT_PCT now
  setup_litellm_admin
  stt_setup_service   # lib/stt.sh: the stt container (Bedrock speech-to-text) before Open WebUI; never fatal
  run_phase "Open WebUI" open-webui dc up -d --wait open-webui
  up_portal
  portal_session_or_die
  settings_reconcile   # lib/settings.sh: Chat's owner and the Admin sign-in match .env (a change cut short, a restore)
  ensure_openwebui_api_key
  run_phase "shared-mcp" shared-mcp _build_and_up_mcp
  sync_openwebui_models
  openrouter_sync_owui   # optional; lib/openrouter.sh
  stt_sync_owui          # optional; lib/stt.sh
  owui_install_cost_filter
  sync_budget_banner
  portal_session_end
}

# --- ./stack models ---

# models_recheck — re-runs the model probe (LiteLLM restarts with the full catalog), then recreates the
# services whose settings depend on the enabled models and refreshes the Open WebUI price descriptions.
models_recheck() {
  [ -f "$ENV_FILE" ] && [ -n "$(get_env LITELLM_MASTER_KEY)" ] || die "run ./stack setup first"
  stack_lock models   # lib/lock.sh: the model choices in .env are rewritten
  check_prereqs
  setup_bringup_and_probe
  stt_after_probe   # lib/stt.sh: Voxtral may have become usable (or not)
  stt_setup_service
  ensure_portal_password_hash
  run_phase "Open WebUI + shared-mcp + portal" "open-webui shared-mcp portal" dc up -d --wait open-webui shared-mcp portal
  portal_session_or_die
  sync_openwebui_models
  openrouter_sync_owui   # optional; lib/openrouter.sh
  stt_sync_owui          # lib/stt.sh
  owui_install_cost_filter
  portal_session_end
}

cmd_models() {
  local f="$STACK_DIR/litellm/probe-results.tsv" ts bad
  case "${1:-}" in
    --recheck) models_recheck; return ;;
    '') ;;
    *) die "usage: ./stack models [--recheck]" ;;
  esac
  [ -s "$f" ] || die "no saved model check yet — run ./stack models --recheck (or ./stack setup)"
  ts="$(awk -F'\t' '!/^#/ && NF >= 6 { print $6; exit }' "$f")"
  bad="$(awk -F'\t' '!/^#/ && NF > 0 && NF < 6' "$f" | wc -l | tr -d ' ')"
  [ "$bad" -eq 0 ] || warn "$f looks corrupt ($bad incomplete line(s) skipped) — run ./stack models --recheck"
  printf 'Model access for your AWS key, as checked %s (no Bedrock calls; ./stack models --recheck re-checks, < $0.01)\n\n' "${ts:-at the last setup}"
  awk -F'\t' '/^#/ || NF >= 6' "$f" | models_table
  printf '\n  Prices: %s (the PRICE column shows them)\n' "$(prices_source_text)"
  prices_notes
  openrouter_models_section
}

# --- cost transparency ---

_enabled_or_all() { # -> path of enabled-models.txt, or "" (= whole catalog) if setup hasn't probed yet
  local en="$STACK_DIR/litellm/enabled-models.txt"
  if [ -s "$en" ]; then echo "$en"; else echo ""; fi
}

cmd_costs() {
  local en name _ mregion cr age j reset label envk alias tmp total code bw
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  en="$(_enabled_or_all)"
  printf 'Bedrock on-demand prices (USD) as of %s — https://aws.amazon.com/bedrock/pricing/\n' "$(prices_as_of)"
  printf '  Source: %s\n' "$(prices_source_text)"
  prices_notes
  [ -n "$en" ] || printf '  (setup has not probed your AWS key yet, so this lists the whole catalog)\n'
  printf '  %-20s %s\n' MODEL PRICE
  while IFS=$'\t' read -r name _ _ _ mregion <&3; do
    is_enabled "$name" "$en" || continue
    label="$(price_label "$name")"; cr="$(price_field "$name" cache_read)"
    [ -z "$cr" ] || label="$label   (cache read $(money "$cr"))"
    case "$mregion" in '' | -) ;; *) label="$label   [$mregion]" ;; esac
    printf '  %-20s %s\n' "$name" "$label"
  done 3< <(catalog_rows)
  printf '\nSpend this budget period (monthly budget per key; each resets on the date shown)\n'
  # + the browser terminal's own key (claude-code-terminal, shown as "terminal") once ./stack terminal made one
  for alias in claude-code open-webui setup $([ -z "$(get_env LITELLM_KEY_TERMINAL)" ] || echo terminal); do
    case "$alias" in claude-code) envk=LITELLM_KEY_CLAUDE_CODE ;; open-webui) envk=LITELLM_KEY_OPENWEBUI ;; terminal) envk=LITELLM_KEY_TERMINAL ;; *) envk=LITELLM_KEY_SETUP ;; esac
    if [ -z "$(get_env "$envk")" ]; then printf '  %-12s no key yet — run ./stack setup\n' "$alias"; continue; fi
    if ! j="$(key_info "$(get_env "$envk")")" || ! label="$(printf '%s' "$j" | spend_text)"; then
      printf '  %-12s unavailable — LiteLLM did not answer (is the stack up? ./stack status)\n' "$alias"; continue
    fi
    reset="$(printf '%s' "$j" | json_get budget_reset_at | cut -c1-10)"
    bw="$(printf '%s' "$j" | budget_warning)" || bw=''
    printf '  %-12s %s%s%s\n' "$alias" "$label" "${reset:+   (resets $reset)}" "${bw:+   $bw}"
  done
  # /global/spend sums LiteLLM's spend log over the last 30 days: every key, including master-key calls.
  tmp="$(mktemp)"
  code="$(litellm_api GET /global/spend "" "$tmp")"
  case "$code" in
    200) total="$(json_num spend < "$tmp")"   # null (no spend logged yet) -> $0.00
         printf '  Total (all keys, last 30 days): %s\n' "$(usd "${total:-0}")" ;;
    000 | '') printf '  Total (all keys, last 30 days): unavailable — LiteLLM did not answer (is the stack up? ./stack status)\n' ;;
    *) printf '  Total (all keys, last 30 days): unavailable (HTTP %s)\n' "$code" ;;
  esac
  rm -f "$tmp"
  openrouter_costs_section
  stt_costs_section
  printf '\nBreakdown by model and day: %s/ui → Usage (portal Admin tab; its sign-in is on the portal Home page)\n' "$(portal_url admin)"
  printf 'Budgets: Settings in the portal, or ./stack config set BUDGET_CLAUDE_CODE (BUDGET_OPENWEBUI, BUDGET_SETUP%s)\n' \
    "$([ -z "$(get_env LITELLM_KEY_TERMINAL)" ] || echo ', BUDGET_TERMINAL')"
  printf 'Alerts at %s%%: Settings → Budgets & alerts, or ./stack config set ALERT_WEBHOOK_URL (%s)\n' "$(alert_pct)" \
    "$([ -n "$(get_env ALERT_WEBHOOK_URL)" ] && echo 'webhook set' || echo 'none set')"
  [ "$PRICES_SOURCE" = catalog ] || return 0   # the daily update keeps them current (and says so above when it fails)
  age="$(prices_age_days)"
  if [ -z "$age" ]; then warn "catalog/prices.tsv has no '# as_of:' date — prices may be stale"
  elif [ "$age" -gt 90 ]; then warn "prices are $age days old — check https://aws.amazon.com/bedrock/pricing/ and update catalog/prices.tsv"; fi
}

# Open WebUI model names/prices, the cost filter and budget banners: lib/owui.sh

# The portal password is printed once: by the first summary after setup generated it (first setup, or the first
# setup after an update from v0.1.x); afterwards the summary points at .env so re-runs and updates don't leave
# it in scrollback/logs. The LiteLLM and RustFS sign-ins are on the portal's Home page (copy buttons).
print_summary() {
  local login cb haiku O_RED O_GRN O_YEL O_OFF
  out_colors
  # Shown once, and only to a terminal: a CI or script log never captures it (and it stays unshown until then).
  if [ ! -e "$STATE_DIR/portal-password-shown" ] && [ -n "$(get_env PORTAL_PASSWORD)" ] && _stdout_tty; then
    login="password $(get_env PORTAL_PASSWORD)   (shown once; also PORTAL_PASSWORD in .env)"
    mkdir -p "$STATE_DIR" && : > "$STATE_DIR/portal-password-shown"
  else
    login="password: PORTAL_PASSWORD in $(env_file_display)   (./stack password --show)"
  fi
  cb="$(claude_bedrock_cmd)"; haiku="$(get_env CLAUDE_BEDROCK_HAIKU_MODEL)"
  cat <<SUMMARY

  ${O_GRN}bedrock-now is up.${O_OFF}

  Portal          $(portal_url)   $login
                  Home, Chat (Open WebUI), Admin (LiteLLM) and Files (RustFS) behind one login
  Claude Code     $cb   (plain \`claude\` is unchanged)
SUMMARY
  [ -z "$haiku" ] || printf '  Try it          CLAUDE_BEDROCK_MODEL=%s %s -p "Say hello in five words"   (~$0.02)\n' "$haiku" "$cb"
  cat <<SUMMARY
  LiteLLM API     http://127.0.0.1:$(get_env LITELLM_PORT)   (for tools; keys in .env)
  Costs           ./stack costs             (Bedrock prices as of $(prices_as_of) + spend per key)
  Models          ./stack models            (which models your AWS key can use)
SUMMARY
  openrouter_summary_line
  stt_summary_line
  terminal_summary_line
  remote_summary_line
  printf '\n  All credentials live in .env (mode 600).\n'
}

# claude_bedrock_cmd -> "claude-bedrock" when that name on PATH runs this checkout's wrapper, else its
# absolute path (shell-quoted), so the summary always shows a command that works as typed.
claude_bedrock_cmd() {
  local want="$STACK_DIR/bin/claude-bedrock" found
  found="$(command -v claude-bedrock 2>/dev/null || true)"
  if [ -n "$found" ] && { [ "$found" = "$want" ] || [ "$(readlink "$found" 2>/dev/null)" = "$want" ]; }; then
    echo claude-bedrock
  else
    printf '%q\n' "$want"
  fi
}

# --- Claude Code: MCP config for claude-bedrock + optional symlink ---

write_mcp_config() {
  local f="$STATE_DIR/mcp.json" tmp port token
  port="$(get_env SHARED_MCP_PORT)"; token="$(get_env SHARED_MCP_TOKEN)"
  [ -n "$port" ] && [ -n "$token" ] || die "cannot write $f: SHARED_MCP_PORT/SHARED_MCP_TOKEN missing from $ENV_FILE — re-run ./stack setup"
  mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
  tmp="$(mktemp "$f.XXXXXX")"; chmod 600 "$tmp"
  printf '{"mcpServers":{"bedrock-shared":{"type":"http","url":"http://127.0.0.1:%s/mcp","headers":{"Authorization":"Bearer %s"}}}}\n' \
    "$port" "$token" > "$tmp"
  mv "$tmp" "$f"
}

# offer_symlink — interactive runs only: --yes never creates or replaces ~/.local/bin/claude-bedrock,
# and a link to a DIFFERENT checkout is replaced only after an explicit "y".
offer_symlink() {
  local target="$HOME/.local/bin/claude-bedrock" want="$STACK_DIR/bin/claude-bedrock" cur
  cur="$(readlink "$target" 2>/dev/null || true)"
  [ "$cur" = "$want" ] && return 0
  if [ "${ASSUME_YES:-0}" = 1 ] || ! _have_tty; then
    if [ -n "$cur" ]; then log "left $target alone (it points to $cur)"
    else log "to put claude-bedrock on your PATH: ln -s $want $target"; fi
    return 0
  fi
  [ -e "$target" ] && ! [ -L "$target" ] && { warn "$target exists and is not a symlink; not touching it"; return 0; }
  if [ -n "$cur" ]; then
    case "$(ask "$target points to $cur (another checkout) — replace it with this one? [y/N]" "n")" in
      [Yy]*) ;; *) log "kept $target → $cur"; return 0 ;;
    esac
  elif ! confirm "Link claude-bedrock into ~/.local/bin?"; then
    return 0
  fi
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$want" "$target"
  log "linked $target"
  # shellcheck disable=SC2088  # literal ~ in a message
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) warn "~/.local/bin is not on your PATH; add it yourself (setup won't edit shell rc files)" ;; esac
}

# --- day-2 commands ---

cmd_up() {
  local repriced=0 restart=0 before own=1
  local extra; extra="$(optional_services)"
  local STACK_SERVICES="$STACK_BASE_SERVICES${extra:+ $extra}"   # + stt / terminal while .env turns them on
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  # lib/lock.sh: never while a settings change, setup, update or restore writes .env. Released when up returns (not at
  # exit): ./stack serve goes on keeping the machine awake for hours, and must not block everything else meanwhile.
  ! stack_lock_ours || own=0   # (setup, restore and update call up holding the lock: theirs to release)
  stack_lock up
  aws_auth_check   # lib/host.sh: a key in .env, or the instance role on EC2
  check_portal_host "$(portal_host)"
  if remote_on; then remote_ensure_proxy_secret; remote_net_preflight; fi   # lib/remote.sh: before any compose call
  terminal_up_hook     # lib/terminal.sh: its remote name, and a missing workspace folder said out loud
  save_portal_origin   # Caddy's frame-ancestors follows PORTAL_HOST / PORTAL_PORT edited by hand in .env
  ensure_portal_password_hash   # lib/settings.sh: PORTAL_PASSWORD edited by hand gets a new hash
  owner_email_lowercase         # lib/settings.sh: as Chat keeps it
  settings_pending_check        # a settings change cut short: reconciled below
  ensure_portal_dirs; write_version_file   # lib/version.sh
  ensure_images "./stack up"
  # Prices (lib/prices.sh): refresh if the last check is older than 12 h (fast: LiteLLM's list only, at most
  # 20 s; the portal's daily run does the AWS cross-check). OpenRouter's hook comes next: when its models
  # changed it re-renders (with these prices) and recreates LiteLLM itself, so reprice_litellm_config then finds
  # nothing to change. Otherwise a running LiteLLM is recreated once here, before the rest comes up.
  refresh_prices 12 --no-crosscheck --timeout 20
  # The prices the running config carries, before OpenRouter's hook: if the hook re-renders with newer prices
  # (the portal's daily job updated them), Bedrock's descriptions/tiers must re-sync too (repriced, no restart).
  before="$(config_prices_line)"
  openrouter_up_hook   # optional; refreshes OpenRouter models/prices when a key is set
  [ "$(config_prices_line)" = "$before" ] || repriced=1
  # lib/stt.sh: STT_* edited by hand in .env — re-renders, and a running LiteLLM must pick the change up
  if stt_up_hook && [ -n "$(dc ps -q --status running litellm 2>/dev/null)" ]; then restart=1; fi
  if reprice_litellm_config; then
    repriced=1
    [ -z "$(dc ps -q --status running litellm 2>/dev/null)" ] || restart=1
  fi
  if [ "$restart" = 1 ]; then
    log "restarting LiteLLM so it uses the new configuration from .env and the price list (~30 s; requests in flight may fail)"
    run_phase "LiteLLM (new configuration)" litellm dc up -d --no-deps --force-recreate --wait litellm
  fi
  stt_before_up   # lib/stt.sh: removes a stt container left from Bedrock speech-to-text
  # The stack's own services only: the Tailscale sidecar (remote access) is started afterwards without waiting.
  # shellcheck disable=SC2086  # word-split the service list on purpose
  run_phase "bedrock-now" "$STACK_SERVICES" dc up -d --wait $STACK_SERVICES
  terminal_after_up   # TERMINAL_EGRESS=off: the network to the internet goes once the container has left it
  remote_up_hook
  # Open WebUI keeps banners in memory only: re-apply the budget banner (through the portal, like setup).
  # The same session updates Open WebUI's prices once: after Bedrock price changes, on_prices_changed (cost
  # filter, which also carries OpenRouter's prices, and model descriptions) plus OpenRouter's label sync if
  # its models changed too; after OpenRouter changes alone, openrouter_after_up.
  if portal_session_start; then
    settings_reconcile; budget_sync_quiet   # lib/settings.sh: sign-ins, budgets and alert thresholds as .env says
    # lib/owui.sh: MODELS_HIDDEN changed while the stack was stopped (one call per model: only when it changed)
    [ "$(models_hidden_applied)" = "$(get_env MODELS_HIDDEN)" ] || owui_apply_hidden
    sync_budget_banner
    stt_after_up   # lib/stt.sh: hides the speech-to-text model after ./stack stt set while stopped
    if [ "$PRICES_CHANGED" = 1 ] || [ "$repriced" = 1 ]; then
      on_prices_changed
      [ "${OR_UP_CHANGED:-0}" != 1 ] || ! declare -F openrouter_sync_owui >/dev/null || openrouter_sync_owui || true
    else
      openrouter_after_up
    fi
  else
    warn "could not sign in to the portal — budget banner and Open WebUI prices not refreshed"
  fi
  portal_session_end
  [ "$own" = 0 ] || stack_unlock
  cmd_status
  maybe_auto_open
}
cmd_down()   { dc down; }
cmd_logs()   { dc logs -f --tail=200 "$@"; }
status_url() { # status_url SERVICE -> where to open it (browser UIs: through the portal)
  case "$1" in
    portal) echo "$(portal_url)   (Home: one login for all)" ;;
    caddy) echo "- (serves the portal URLs)" ;;
    open-webui) portal_url chat ;;
    litellm) echo "$(portal_url admin)/ui" ;;
    rustfs) portal_url files ;;
    shared-mcp) echo "http://127.0.0.1:$(get_env SHARED_MCP_PORT)/mcp" ;;
    tailscale) if [ -n "$(remote_url)" ]; then echo "$(remote_url)   (your devices; ./stack remote status)"; else echo "- (./stack remote status)"; fi ;;
    terminal) echo "$(portal_url terminal)   (the Terminal tab; ./stack terminal status)" ;;
    terminal-gateway) echo "- (the terminal's only way into the stack)" ;;
    *) echo "- (internal only)" ;;
  esac
}

# status_table < "service<TAB>state<TAB>health<TAB>exit code" lines (dc ps -a --format) -> SERVICE STATE HEALTH URL
status_table() {
  local ps s row state health sc hc O_RED O_GRN O_YEL O_OFF
  local extra; extra="$(optional_services)"
  local STACK_SERVICES="$STACK_BASE_SERVICES${extra:+ $extra}"
  out_colors
  ps="$(cat)"
  printf '  %-11s %-12s %-10s %s\n' SERVICE STATE HEALTH URL
  for s in $STACK_SERVICES $(remote_on && echo tailscale); do
    row="$(printf '%s\n' "$ps" | awk -F'\t' -v s="$s" '$1 == s { print $2 "\t" $3; exit }')"
    state="${row%%	*}"; health="${row#*	}"
    [ -n "$row" ] || { state="not created"; health=''; }
    [ -n "$health" ] || health='-'
    sc="$O_RED"; [ "$state" = running ] && sc="$O_GRN"
    case "$health" in healthy) hc="$O_GRN" ;; unhealthy) hc="$O_RED" ;; -) hc='' ;; *) hc="$O_YEL" ;; esac
    printf '  %-11s %s%-12s%s %s%-10s%s %s\n' "$s" "$sc" "$state" "$O_OFF" "$hc" "$health" "$O_OFF" "$(status_url "$s")"
  done
  row="$(printf '%s\n' "$ps" | awk -F'\t' '$1 == "rustfs-init" && $4 != "" && $4 != "0" { print $4 }')"
  [ -z "$row" ] || warn "bucket setup (rustfs-init) exited with code $row — see ./stack logs rustfs-init"
}

# shellcheck disable=SC2120  # arguments come from the ./stack dispatcher
cmd_status() {
  local ps upd fresh='' O_RED O_GRN O_YEL O_OFF
  case "${1:-}" in '') ;; --disk) fresh=--fresh ;; *) die "usage: ./stack status [--disk]   (--disk: measure disk use now)" ;; esac
  out_colors
  check_docker_daemon   # a stopped daemon would otherwise look like "not created" everywhere
  ps="$(dc ps -a --format '{{.Service}}	{{.State}}	{{.Health}}	{{.ExitCode}}' 2>/dev/null || true)"
  printf '%s\n' "$ps" | status_table
  if ! printf '%s\n' "$ps" | grep -q '	running	'; then
    printf '\n  The stack is not running — start it with ./stack up\n'
  else
    printf '\n  Open %s (one login: PORTAL_PASSWORD in .env)   LiteLLM API: http://127.0.0.1:%s\n' "$(portal_url)" "$(get_env LITELLM_PORT)"
    printf '  Logs: ./stack logs <service>   Costs: ./stack costs   Models: ./stack models\n'
    ! remote_on || printf '  Remote: %s   (./stack remote status)\n' "$(remote_url || true)"
  fi
  printf '  %s\n' "$(disk_line_cached $fresh)"   # names ./stack clean when it would free something
  if update_unfinished; then   # lib/rollback.sh: its pull or setup failed, or it was stopped
    printf '  %sThe last update did not finish — ./stack update finishes it, ./stack rollback goes back%s\n' "$O_YEL" "$O_OFF"
  elif upd="$(update_available)"; then
    printf '  %sUpdate available: %s%s (you have %s) — ./stack update   (release notes on Home)\n' "$O_YEL" "$upd" "$O_OFF" "$(installed_version)"
  fi
  printf '  %s\n' "$(helper_status_line)"   # lib/helper.sh: one-click and automatic updates
}

_check() { # _check LABEL GOT WANT — uses the caller's `fails` counter
  if [ "$2" = "$3" ]; then printf '  ok    %s\n' "$1"; else printf '  FAIL  %s (got %s, want %s)\n' "$1" "${2:-nothing}" "$3"; fails=$((fails + 1)); fi
}
_skip() { printf '  skip  %s (%s)\n' "$1" "$2"; }

# _hdr NAME < curl -D headers -> the value of header NAME (case-insensitive; CR stripped; empty if absent)
_hdr() { tr -d '\r' | N="$1" awk -F': ' 'tolower($1) == tolower(ENVIRON["N"]) { sub(/^[^:]*: /, ""); print; exit }'; }

# _test_portal — the browser path: Caddy + portal login + the three apps behind it (uses cmd_test's `fails`).
# Open WebUI publishes no port, so its checks go through Caddy too. The session cookie lives in a mode-600 file
# in .state/ and is deleted at the end.
_test_portal() {
  local code hdr loc csp origin opus
  origin="$(portal_url)"; opus="$(get_env CLAUDE_BEDROCK_OPUS_MODEL)"; hdr="$(mktemp)"
  # shellcheck disable=SC2034  # read by portal_curl (lib/portal.sh)
  PORTAL_JAR=''
  code="$(portal_curl '' /login -s -m 10 -o /dev/null -w '%{http_code}' || true)"
  _check "portal login page ($origin)" "$code" 200
  code="$(portal_curl chat / -s -m 10 -o /dev/null -D "$hdr" -w '%{http_code}' -H 'Accept: text/html' || true)"
  loc="$(_hdr location < "$hdr")"
  _check "chat without a session → login" "$code ${loc%%\?*}" "302 $origin/login"
  code="$(portal_curl chat /api/v1/auths/signin -s -m 10 -o /dev/null -w '%{http_code}' -H 'X-Portal-User: '"$(get_env OPENWEBUI_ADMIN_EMAIL)" \
    -H 'Content-Type: application/json' -d '{"email":"","password":""}' || true)"
  _check "spoofed X-Portal-User without a session is refused" "$code" 401
  code="$(portal_curl nope / -s -m 10 -o /dev/null -w '%{http_code}' || true)"
  _check "unknown host name is refused" "$code" 404
  if ! portal_session_start; then
    _check "portal login (PORTAL_PASSWORD)" "${PORTAL_LOGIN_CODE:-}" 303
    _skip "checks behind the portal login" "login failed"
    portal_session_end; rm -f "$hdr"; return 0
  fi
  _check "portal login (PORTAL_PASSWORD)" 303 303
  code="$(portal_curl '' /login?next=http://evil.example/ -s -m 10 -o /dev/null -D "$hdr" -w '%{http_code}' || true)"
  _check "login refuses a foreign next= (no open redirect)" "$code $(_hdr location < "$hdr")" "303 /"
  code="$(portal_curl '' /api/summary -s -m 30 -o /dev/null -w '%{http_code}' -H 'X-Requested-With: bedrock-now' || true)"
  _check "portal Home data (/api/summary)" "$code" 200
  code="$(portal_curl chat /health -s -m 10 -o /dev/null -w '%{http_code}' || true)"
  _check "open-webui health (chat.)" "$code" 200
  if [ -n "$opus" ]; then
    code="$(portal_curl_auth "$(get_env OPENWEBUI_API_KEY)" chat /api/models -s -m 60 2>/dev/null | grep -c "\"$opus\"" || true)"
    _check "open-webui sees litellm models" "$([ "${code:-0}" -gt 0 ] && echo yes || echo no)" yes
  else
    _skip "open-webui sees litellm models" "no Claude model enabled"
  fi
  for k in chat:/ admin:/ui/ files:/rustfs/console/; do
    code="$(portal_curl "${k%%:*}" "${k#*:}" -s -m 20 -o /dev/null -D "$hdr" -w '%{http_code}' || true)"
    csp="$(_hdr content-security-policy < "$hdr")"
    _check "${k%%:*}. loads, framable only by the portal" "$code|$csp|$(_hdr x-frame-options < "$hdr")" "200|frame-ancestors $origin|"
  done
  portal_session_end; rm -f "$hdr"
}

# Every probe below is `|| true` inside its substitution: under set -e/pipefail a transport error or a
# grep without match must turn into a FAIL line, not silently end the test run.
cmd_test() {
  local fails=0 tmp lp mp code haiku opus sk alias envk k
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  tmp="$(mktemp)"; lp="$(get_env LITELLM_PORT)"; mp="$(get_env SHARED_MCP_PORT)"
  haiku="$(get_env CLAUDE_BEDROCK_HAIKU_MODEL)"; opus="$(get_env CLAUDE_BEDROCK_OPUS_MODEL)"
  sk="$(get_env LITELLM_KEY_SETUP)"

  code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$lp/health/liveliness" || true)"
  _check "litellm alive" "$code" 200
  # Free: every virtual key is checked with /key/info. Paid (~$0.0001): the calls below use the setup key only.
  for alias in claude-code open-webui setup $([ -z "$(get_env LITELLM_KEY_TERMINAL)" ] || echo claude-code-terminal); do
    case "$alias" in claude-code) envk=LITELLM_KEY_CLAUDE_CODE ;; open-webui) envk=LITELLM_KEY_OPENWEBUI ;; claude-code-terminal) envk=LITELLM_KEY_TERMINAL ;; *) envk=LITELLM_KEY_SETUP ;; esac
    k="$(get_env "$envk")"
    if [ -n "$k" ]; then code="$(litellm_key_status "$k")"; else code=missing; fi
    _check "LiteLLM key '$alias' is valid" "$code" 200
  done
  if [ -n "$haiku" ] && [ -n "$sk" ]; then
    code="$(curl_auth "$sk" -s -m 120 -o "$tmp" -w '%{http_code}' -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' \
      -d "{\"model\":\"$haiku\",\"max_tokens\":5,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" "http://127.0.0.1:$lp/v1/messages" || true)"
    _check "anthropic /v1/messages ($haiku)" "$code" 200
    code="$(curl_auth "$sk" -s -m 120 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' \
      -d "{\"model\":\"$haiku\",\"max_tokens\":5,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" "http://127.0.0.1:$lp/v1/messages" || true)"
    _check "anthropic streaming" "$code" 200
  elif [ -z "$haiku" ]; then
    _skip "anthropic /v1/messages" "no Claude model enabled"
  else
    _skip "anthropic /v1/messages" "no setup key — run ./stack setup"
  fi
  if [ -n "$(get_env OWUI_EMBED_MODEL)" ] && [ -n "$sk" ]; then
    code="$(curl_auth "$sk" -s -m 120 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
      -d "{\"model\":\"$(get_env OWUI_EMBED_MODEL)\",\"input\":\"ping\"}" "http://127.0.0.1:$lp/v1/embeddings" || true)"
    _check "embeddings ($(get_env OWUI_EMBED_MODEL))" "$code" 200
  elif [ -z "$(get_env OWUI_EMBED_MODEL)" ]; then
    _skip "embeddings" "no embedding model enabled"
  else
    _skip "embeddings" "no setup key — run ./stack setup"
  fi
  _test_portal
  code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$mp/healthz" || true)"
  _check "shared-mcp health" "$code" 200
  code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$mp/mcp" || true)"
  _check "shared-mcp rejects no token" "$code" 401
  code="$(curl_auth "$(get_env SHARED_MCP_TOKEN)" -s -m 30 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "http://127.0.0.1:$mp/mcp" 2>/dev/null | grep -o '"search_knowledge"' | head -n1 || true)"
  _check "shared-mcp lists tools" "$code" '"search_knowledge"'
  stt_test_checks   # lib/stt.sh: Bedrock speech-to-text, when on (~$0.00005)
  terminal_test_checks   # lib/terminal.sh: the browser terminal's checks, when on (no Bedrock calls)
  rm -f "$tmp"
  [ "$fails" -eq 0 ] || die "$fails check(s) failed — see ./stack logs"
  log "all checks passed"
}

# --- backup / restore / update / rotate-aws / uninstall ---

# s3_job HOST_DIR MODE SCRIPT — runs aws-cli (the rustfs-init service: RustFS creds, stack network) with
# HOST_DIR mounted at /backup (MODE "ro" = read-only; ":z" relabels for SELinux, a no-op elsewhere).
# Runs as the calling user so files in backups/ stay deletable on Linux — except on rootless Docker, where
# container root already maps to the calling user. HOME=/tmp gives aws-cli a writable cache dir.
s3_job() {
  local user=()
  _docker_rootless || user=(--user "$(id -u):$(id -g)")
  dc run --rm --no-deps ${user[@]+"${user[@]}"} -e HOME=/tmp -v "$1:/backup:${2:+$2,}z" \
    --entrypoint /bin/sh rustfs-init -c "$3"
}

# Postgres + RustFS must be running for backup/restore (harmless if they already are).
_data_services_up() {
  dc up -d --wait postgres rustfs >/dev/null 2>&1 || die "could not start postgres/rustfs — see ./stack logs postgres"
}

# A failed backup must not leave a half-written directory behind (globals: the EXIT trap outlives locals).
_BACKUP_PARTIAL=''
_cleanup_partial_backup() { [ -z "$_BACKUP_PARTIAL" ] || rm -rf "$_BACKUP_PARTIAL"; }

# shellcheck disable=SC2120  # arguments come from the ./stack dispatcher
cmd_backup() {
  local own=1
  [ -f "$ENV_FILE" ] || die "nothing to back up — run ./stack setup first"
  ! stack_lock_ours || own=0   # (restore, rollback and clean ask for one holding their own lock)
  stack_lock backup   # lib/lock.sh: ./stack up must not recreate Postgres or RustFS halfway
  case "${1:-}" in
    '') [ $# -eq 0 ] || die "usage: ./stack backup [--nightly | --portal]"; _backup_named "" ;;
    # the update helper's nightly backup (BACKUP_NIGHTLY=on): backups/<timestamp>-nightly/, the newest BACKUP_KEEP kept
    --nightly) [ $# -eq 1 ] || die "usage: ./stack backup [--nightly | --portal]"; _backup_named nightly; prune_backups nightly "$(backup_keep)" ;;
    # Back up now in the portal's Settings (through the update helper): backups/<timestamp>-portal/, the newest 5 kept
    --portal) [ $# -eq 1 ] || die "usage: ./stack backup [--nightly | --portal]"; _backup_named portal; prune_backups portal "$PORTAL_BACKUPS_KEEP" ;;
    *) die "usage: ./stack backup [--nightly | --portal]   (writes backups/<timestamp>/)" ;;
  esac
  write_backups_json   # lib/settings.sh: the list Settings shows
  [ "$own" = 0 ] || stack_unlock
}

PORTAL_BACKUPS_KEEP=5   # backups made from the portal (Back up now): the newest 5 are kept

# _backup_space_check — refuses a backup that would not fit: at least twice the newest backup's size must be free
# (a full disk stops the databases too)
_backup_space_check() {
  local last='' d kb free
  for d in "$STACK_DIR"/backups/*/; do [ -d "$d" ] || continue; case "$d" in *.partial/) ;; *) last="$d" ;; esac; done   # newest last
  [ -n "$last" ] || return 0
  kb="$(du -sk "$last" 2>/dev/null | cut -f1 || true)"; case "$kb" in '' | *[!0-9]*) return 0 ;; esac
  free="$(df -Pk "$STACK_DIR/backups" 2>/dev/null | awk 'NR == 2 { print $4 }' || true)"; case "$free" in '' | *[!0-9]*) return 0 ;; esac
  [ "$free" -ge $((kb * 2)) ] ||
    die "not enough free disk space for a backup: $((free / 1024)) MB free, and one needs about $((kb / 1024 + 1)) MB (twice that is kept free) — delete old backups in backups/ first"
}

# _backup_named SUFFIX — writes backups/<ts>[-SUFFIX]/ and sets LAST_BACKUP (backups/<ts>…) for callers
# that want to name it in messages. ./stack update uses SUFFIX=auto so it can prune its own backups.
_backup_named() {
  local dir tmp db
  [ -f "$ENV_FILE" ] || die "nothing to back up — run ./stack setup first"
  _backup_space_check
  dir="$STACK_DIR/backups/$(date +%Y%m%d-%H%M%S)${1:+-$1}"; tmp="$dir.partial"
  mkdir -p "$tmp"; chmod 700 "$STACK_DIR/backups" "$tmp"
  _BACKUP_PARTIAL="$tmp"; on_exit _cleanup_partial_backup
  _data_services_up
  for db in litellm openwebui; do
    if ! dc exec -T postgres pg_dump -U postgres -Fc "$db" > "$tmp/$db.dump"; then
      die "could not dump database $db — the incomplete backup was removed; is postgres healthy? ./stack status"
    fi
  done
  mkdir -p "$tmp/s3/openwebui" "$tmp/s3/shared"
  s3_job "$tmp" "" 'set -e; for b in openwebui shared; do aws --endpoint-url http://rustfs:9000 s3 sync --only-show-errors s3://$b /backup/s3/$b; done' ||
    die "could not copy the object-store buckets — the incomplete backup was removed; see ./stack logs rustfs"
  cp "$ENV_FILE" "$tmp/.env"   # encrypted DB fields need the same secrets
  chmod -R go-rwx "$tmp"       # dumps hold chats, hashed keys and encrypted credentials
  mv "$tmp" "$dir"
  _BACKUP_PARTIAL=''; off_exit _cleanup_partial_backup
  LAST_BACKUP="${dir#"$STACK_DIR"/}"
  log "backup written to ${dir#"$STACK_DIR"/} ($(du -sh "$dir" 2>/dev/null | cut -f1 | tr -d ' ')) — databases, buckets and a copy of .env (contains secrets; keep it private)"
}

# _restore_key_trio BACKUP_DIR — the restored databases only know the keys that existed at backup time, so
# the matching LiteLLM virtual keys and Open WebUI API key come back from the backup's .env.
_restore_key_trio() {
  local k v n=0
  [ -f "$1/.env" ] || { warn "the backup has no .env — run ./stack setup --yes after the restore to recreate the keys"; return 0; }
  for k in LITELLM_KEY_CLAUDE_CODE LITELLM_KEY_OPENWEBUI LITELLM_KEY_SETUP OPENWEBUI_API_KEY; do
    v="$(ENV_FILE="$1/.env" get_env "$k")"
    if [ -z "$v" ]; then
      warn "$k is missing from the backup's .env — run ./stack setup --yes after the restore to create a new one"; continue
    fi
    [ "$v" = "$(get_env "$k")" ] || { set_env "$k" "$v"; n=$((n + 1)); }
  done
  # The browser terminal's key (lib/terminal.sh), when there is one: the backup's, or none — ./stack up and
  # ./stack terminal enable then make a new one for the restored database.
  v="$(ENV_FILE="$1/.env" get_env LITELLM_KEY_TERMINAL)"
  [ "$v" = "$(get_env LITELLM_KEY_TERMINAL)" ] || { set_env LITELLM_KEY_TERMINAL "$v"; n=$((n + 1)); }
  log "restored the backup's keys (LiteLLM virtual keys, Open WebUI API key) into .env ($n changed)"
}

# _is_backup DIR -> 0 when DIR holds both database dumps ./stack backup writes
_is_backup() { [ -f "$1/litellm.dump" ] && [ -f "$1/openwebui.dump" ]; }

# backup_dir_arg DIR -> the backup DIR names, as an absolute path: an absolute DIR as given; a relative one from the
# current folder, or else inside this checkout — every message says "./stack restore backups/<ts>" and ./stack can
# be run from any folder (e.g. ~/bedrock-now/stack restore …). Dies when a relative DIR is a backup in both places
# and they are different folders. Prints DIR unchanged when it is no backup at all (the caller prints its usage).
backup_dir_arg() {
  local d="$1" here='' there=''
  case "$d" in '' | /*) printf '%s\n' "$d"; return 0 ;; esac
  if _is_backup "$d"; then here="$(cd "$d" && pwd -P)"; fi
  if _is_backup "$STACK_DIR/$d"; then there="$(cd "$STACK_DIR/$d" && pwd -P)"; fi
  [ -z "$here" ] || [ -z "$there" ] || [ "$here" = "$there" ] ||
    die "ambiguous backup path '$d': it is $here (from this folder) and also $there (in this checkout) — pass an absolute path. Nothing was changed."
  printf '%s\n' "${here:-${there:-$d}}"
}

# _validate_backup DIR — before anything is stopped or dropped: both bucket folders are there, and each dump is an
# archive pg_restore (inside the postgres container) can list, with at least one entry. A damaged or empty backup
# must never get as far as DROP DATABASE.
_validate_backup() {
  local dir="$1" b db n
  for b in openwebui shared; do
    [ -d "$dir/s3/$b" ] || die "$dir has no s3/$b folder, so it is not a complete ./stack backup — nothing was changed"
  done
  # First that commands run in the postgres container at all: a failing exec must not read as an unreadable dump.
  dc exec -T postgres true </dev/null >/dev/null 2>&1 ||
    die "cannot run commands in the postgres container (./stack status; ./stack logs postgres) — nothing was changed"
  for db in litellm openwebui; do
    n="$(dc exec -T postgres pg_restore --list < "$dir/$db.dump" 2>/dev/null | grep -c '^[0-9]' || true)"
    [ "${n:-0}" -gt 0 ] ||
      die "$dir/$db.dump is not a readable database dump (pg_restore --list finds nothing in it) — nothing was changed"
  done
}

cmd_restore() {
  local dir db k hint
  dir="$(backup_dir_arg "${1:-}")" || exit 1
  case "${dir%/}" in *.partial) die "${dir%/} is an incomplete backup (it failed or is still being written) — pick a complete one from backups/" ;; esac
  [ -n "$dir" ] && _is_backup "$dir" ||
    die "usage: ./stack restore backups/<timestamp>   (a directory written by ./stack backup)"
  [ -f "$ENV_FILE" ] || die "run ./stack setup first (on a new machine: copy the backup's .env to ./.env, run ./stack setup, then restore)"
  stack_lock restore
  quiet_compose
  dir="$(cd "$dir" && pwd -P)"
  log "backup to restore: $dir"
  if [ -f "$dir/.env" ]; then
    for k in LITELLM_SALT_KEY WEBUI_SECRET_KEY LITELLM_MASTER_KEY; do
      [ "$(ENV_FILE="$dir/.env" get_env "$k")" = "$(get_env "$k")" ] ||
        warn "$k differs from the backup's .env — stored credentials/sessions may not work after restoring; to restore exactly, copy $dir/.env over .env first"
    done
  fi
  [ "${ASSUME_YES:-0}" = 1 ] || _have_tty ||
    die "restore replaces all data; re-run with --yes to do it non-interactively — nothing was changed"
  _data_services_up
  _validate_backup "$dir"
  warn "restore REPLACES all current chats, knowledge bases, files, LiteLLM keys and spend history with $dir"
  confirm "Restore $dir now?" || die "aborted — nothing was changed"
  if confirm "Take a backup of the current state first?"; then
    cmd_backup
    hint="your pre-restore state is in $LAST_BACKUP — run ./stack restore $LAST_BACKUP"
  else
    warn "no pre-restore backup — if this restore fails, the current data cannot be recovered"
    hint="no pre-restore backup was taken (you declined it), so fix the cause and re-run ./stack restore ${dir#"$STACK_DIR"/}"
  fi
  _data_services_up
  log "stopping Open WebUI, LiteLLM and shared-mcp while the databases are replaced"
  dc stop open-webui litellm shared-mcp
  for db in litellm openwebui; do
    dc exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
      -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" -c "CREATE DATABASE \"$db\"" >/dev/null ||
      die "could not recreate database $db (services are stopped); $hint"
    dc exec -T postgres pg_restore -U postgres -d "$db" --no-owner --exit-on-error < "$dir/$db.dump" ||
      die "pg_restore of $db failed, the databases are only partly restored (services are stopped); $hint"
  done
  # Each bucket becomes an exact copy of the backup's folder. `aws s3 sync` alone cannot do that: uploading, it
  # skips a file of unchanged size unless the file is NEWER than the object, and a backup's files keep the objects'
  # dates from backup time — a file overwritten since then with the same size would keep its new content. So
  # `cp --recursive` first uploads every file whatever its size or date (objects are replaced in place: the bucket
  # is never empty), then `sync --delete` removes the objects the backup does not have (it uploads nothing more:
  # each object now has its file's size and a newer date; were the clocks off, it would only upload a file again).
  # Unlike re-dating a copy of the backup first, this needs no extra disk space and no clocks that agree.
  # No bucket folder in the backup: the bucket is emptied.
  s3_job "$dir" ro 'set -e; S3="aws --endpoint-url http://rustfs:9000"
    for b in openwebui shared; do
      if [ -d /backup/s3/$b ]; then
        $S3 s3 cp --recursive --only-show-errors /backup/s3/$b s3://$b
        $S3 s3 sync --delete --only-show-errors /backup/s3/$b s3://$b
      else $S3 s3 rm --recursive --only-show-errors s3://$b; fi
    done' || die "restoring the object-store buckets failed (databases are restored, services are stopped); $hint"
  _restore_key_trio "$dir"
  ensure_portal_password_hash   # lib/settings.sh: a .env copied from an older backup has no PORTAL_PASSWORD_HASH yet
  write_mcp_config
  # .env may have changed: recreate the containers that read these keys, then start everything else.
  remote_net_preflight
  log "starting the services again (waits until each one is healthy)"
  dc up -d --wait --force-recreate open-webui shared-mcp
  # shellcheck disable=SC2046  # word-split the service list on purpose
  dc up -d --wait $(stack_services)
  remote_up_hook
  settings_reconcile_with_session   # lib/settings.sh: the backup's databases may carry an older owner email or Admin password
  log "restored $dir; running the smoke test (if keys fail, ./stack setup --yes re-validates them)"
  cmd_test
}

# prune_auto_backups KEEP — keeps the newest KEEP backups/*-auto directories (made by ./stack update) and, however
# old, the one the update record names (what ./stack rollback restores, lib/rollback.sh); manual backups and
# incomplete (*.partial) ones are never touched.
prune_auto_backups() {
  local keep="$1" d i=0 removed=0 all=() rec
  rec="$(_record_get backup)"; rec="${rec%/}"
  for d in "$STACK_DIR"/backups/*-auto; do [ -d "$d" ] && all+=("$d"); done   # glob order = oldest first
  while [ $((${#all[@]} - i)) -gt "$keep" ]; do
    [ -n "$rec" ] && [ "${all[$i]}" = "$STACK_DIR/$rec" ] || { rm -rf "${all[$i]}"; removed=$((removed + 1)); }
    i=$((i + 1))
  done
  [ "$removed" -eq 0 ] ||
    log "removed $removed old automatic backup(s); ./stack update keeps the newest $keep and the one ./stack rollback needs (manual backups are never pruned)"
  write_backups_json
}

# newest_release_tag GIT_DIR -> newest vX.Y.Z tag, pre-releases (anything with "-") excluded.
# install.sh has its own copy (latest_release_tag); tests/test_update_git.sh checks both agree.
newest_release_tag() {
  git -C "$1" -c versionsort.suffix=- tag -l 'v[0-9]*' --sort=-v:refname | grep -v -- '-' | sed -n '1p' || true
}

_git() { git -C "$STACK_DIR" "$@"; }
_require_clean_tree() { # ./stack update never starts (no backup, no pruning) over local changes to tracked files
  [ -e "$STACK_DIR/.git" ] || return 0
  [ -z "$(_git status --porcelain --untracked-files=no)" ] ||
    die "this checkout has local changes to tracked files — commit or stash them (git stash), then re-run ./stack update. Nothing was changed."
}
# _rollback_cmd COMMIT [BRANCH] -> the git command that puts the code back; branch users stay on their branch
_rollback_cmd() {
  if [ -n "${2:-}" ]; then printf 'git -C %q switch -C %q %s' "$STACK_DIR" "$2" "$1"
  else printf 'git -C %q checkout %s' "$STACK_DIR" "$1"; fi
}

# _signed_tags_required — UPDATE_REQUIRE_SIGNED_TAGS=true in .env: ./stack update only checks out a release tag
# whose signature git verify-tag accepts (trusted keys: docs/security.md#code-provenance)
_signed_tags_required() { [ "$(get_env UPDATE_REQUIRE_SIGNED_TAGS)" = true ]; }

# update_nothing_new [REF] -> 0 when ./stack update would leave the code exactly as it is (fetches first): the last
# successful setup ran on HEAD (setup_ran_on_head, lib/rollback.sh), and HEAD is already the target update_checkout
# would pick, in the same state (a branch up to date with its origin branch, or a detached HEAD at the tag/commit). Whatever it cannot tell (no git, no network, an unknown ref, a branch that
# follows another remote, a switch between a branch and a tag) counts as something to do: update_checkout decides.
update_nothing_new() {
  local to="${1:-}" head branch up target
  [ -e "$STACK_DIR/.git" ] || return 1
  setup_ran_on_head || return 1   # the last successful setup ran on other code (or none is recorded): every step
  _git fetch --quiet --tags origin 2>/dev/null || return 1
  _UPDATE_FETCHED=1   # update_checkout does not fetch a second time
  head="$(_git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null)" || return 1
  branch="$(_git symbolic-ref -q --short HEAD || true)"
  if [ -n "$branch" ]; then
    # on a branch: git pull --ff-only (--to the same branch: checkout, then the same pull)
    [ -z "$to" ] || [ "$to" = "$branch" ] || return 1
    ! _signed_tags_required || return 1   # a branch cannot be verified: update_checkout refuses it and says why
    [ "$(_git config "branch.$branch.remote" 2>/dev/null || true)" = origin ] || return 1
    up="$(_git rev-parse -q --verify "$branch@{upstream}^{commit}" 2>/dev/null)" || return 1
    _git merge-base --is-ancestor "$up" "$head"   # nothing to fast-forward
    return
  fi
  if [ -n "$to" ]; then
    ! _git show-ref -q --verify "refs/heads/$to" || return 1   # a local branch: checkout would attach HEAD to it
    ! _signed_tags_required || return 1   # update_checkout checks that it is a signed tag
    target="$to"
  else
    target="$(newest_release_tag "$STACK_DIR")"; [ -n "$target" ] || return 1
  fi
  [ "$(_git rev-parse -q --verify "$target^{commit}" 2>/dev/null)" = "$head" ]
}

# update_checkout [REF] — moves this checkout to newer code; sets CODE_CHANGED=1 when HEAD moved.
#   on a branch: git pull --ff-only;  on a tag / detached HEAD (install.sh): the newest release tag, never
#   older than HEAD;  REF given (--to): exactly that tag/branch/commit. Local changes to tracked files stop it.
update_checkout() {
  local to="${1:-}" branch target before cur
  CODE_CHANGED=0
  if [ ! -e "$STACK_DIR/.git" ]; then warn "$STACK_DIR is not a git checkout — skipping the code update (images and setup still run)"; return 0; fi
  _require_clean_tree
  before="$(_git rev-parse HEAD)"; cur="$(_git describe --tags --always 2>/dev/null || echo "$before")"
  [ "${_UPDATE_FETCHED:-0}" = 1 ] ||
    _git fetch --quiet --tags origin || die "could not fetch updates from origin (network?) — the code was not changed"
  branch="$(_git symbolic-ref -q --short HEAD || true)"
  if [ -n "$to" ]; then
    target="$to"
  elif [ -n "$branch" ] && _signed_tags_required; then
    die "UPDATE_REQUIRE_SIGNED_TAGS=true: a branch cannot be verified — use ./stack update --to <signed tag> (the code was not changed)"
  elif [ -n "$branch" ]; then
    _git pull --quiet --ff-only || die "could not fast-forward branch $branch (it has diverged from origin) — the code was not changed; merge it yourself or use ./stack update --to <tag>"
    if [ "$(_git rev-parse HEAD)" = "$before" ]; then log "branch $branch is already up to date"
    else log "updated branch $branch: $cur → $(_git describe --tags --always)"; CODE_CHANGED=1; fi
    return 0
  else
    target="$(newest_release_tag "$STACK_DIR")"
    [ -n "$target" ] || die "no release tags found on origin — use ./stack update --to main"
    _git merge-base --is-ancestor HEAD "$target" ||
      die "your checkout is ahead of $target — use ./stack update --to <ref> (the code was not changed)"
  fi
  if _signed_tags_required; then
    _git rev-parse -q --verify "refs/tags/$target" >/dev/null ||
      die "UPDATE_REQUIRE_SIGNED_TAGS=true: '$target' is not a tag — the code was not changed"
    _git verify-tag "$target" >/dev/null 2>&1 ||
      die "UPDATE_REQUIRE_SIGNED_TAGS=true: the signature of tag $target could not be verified (git verify-tag $target; docs/security.md#code-provenance) — the code was not changed"
    log "tag $target: signature verified"
  fi
  _git -c advice.detachedHead=false checkout --quiet "$target" ||
    die "could not check out '$target' (see git's message above) — the code was not changed"
  if [ -n "$(_git symbolic-ref -q HEAD || true)" ]; then
    _git pull --quiet --ff-only || die "could not fast-forward $target — merge it yourself"
  fi
  if [ "$(_git rev-parse HEAD)" = "$before" ]; then log "already on $target"; return 0; fi
  log "updating $cur → $target"
  CODE_CHANGED=1
}

# _update_reexec_genuine — BEDROCK_NOW_CODE_UPDATED=1 counts only in the process ./stack update exec'd itself into
# (exec keeps the pid): it holds the update lock (BEDROCK_NOW_LOCK_HELD = $$). A version from before the lock (v0.2.1
# and older) passes no lock: then the commit it came from must be a real one other than HEAD, with its complete
# pre-update backup from the last hour.
_update_reexec_genuine() {
  local from="${BEDROCK_NOW_UPDATE_FROM:-}" b="${BEDROCK_NOW_UPDATE_BACKUP:-}"
  [ "${BEDROCK_NOW_CODE_UPDATED:-0}" = 1 ] || return 1
  if [ -n "${BEDROCK_NOW_LOCK_HELD:-}" ]; then
    [ "$BEDROCK_NOW_LOCK_HELD" = "$$" ] && [ "$(head -c 20 "$(lock_dir)/pid" 2>/dev/null)" = "$$" ]
    return
  fi
  case "$from" in '' | *[!0-9a-f]*) return 1 ;; esac
  case "$b" in *..* | *[[:space:]]*) return 1 ;; backups/?*-auto) ;; *) return 1 ;; esac
  [ -e "$STACK_DIR/.git" ] && _git cat-file -e "$from^{commit}" 2>/dev/null || return 1
  [ "$(_git rev-parse HEAD)" != "$(_git rev-parse "$from^{commit}")" ] || return 1
  _is_backup "$STACK_DIR/$b" && [ -n "$(find "$STACK_DIR/$b" -maxdepth 0 -mmin -60 2>/dev/null)" ]
}

# ./stack update: 1/4 backup (current code) → 2/4 code → [re-exec new code] → 3/4 images → 4/4 setup.
# The re-exec gets BEDROCK_NOW_CODE_UPDATED=1, the backup dir, the previous commit and branch, so a later failure
# can tell you exactly how to go back. Nothing new (update_nothing_new): it says so and stops before the backup
# (exit 0); --force runs every step anyway (re-runs setup: model probe, LiteLLM restart, smoke test).
# An update that moved the code but did not finish (update_unfinished: pull or setup failed, or it was stopped) is
# finished first: images and setup, with no new backup or snapshot, so ./stack rollback keeps going back to the
# version and backup it recorded (--to moves the code on first, e.g. to a fix; BEDROCK_NOW_UPDATE_FINISHING=1).
# The record is written right after the checkout, before the exec, so a stop at any point after it counts as such.
cmd_update() {
  local to='' backup from='' branch='' hint moved=0 force=0 finishing=0 reexec=0 yes=() usage="usage: ./stack update [--to <tag|branch>] [--force]"
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) case "${2:-}" in '' | -*) die "$usage" ;; esac; to="$2"; shift 2 ;;
      --force) force=1; shift ;;
      *) die "$usage" ;;
    esac
  done
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  if [ "${BEDROCK_NOW_CODE_UPDATED:-0}" = 1 ]; then   # before stack_lock, which would take the lock as ours
    if _update_reexec_genuine; then reexec=1
    else   # e.g. v0.1.1 or a stale v0.2.1 hand-over: the code may have moved, so nothing is skipped
      warn "BEDROCK_NOW_CODE_UPDATED=1 in the environment is ignored (./stack update sets it only for itself) — running every step"
      force=1
    fi
  fi
  stack_lock update   # lib/lock.sh: one update/rollback/clean/restore/setup at a time (kept across the re-exec)
  [ "${ASSUME_YES:-0}" != 1 ] || yes=(--yes)
  if [ "$reexec" = 0 ] && update_unfinished; then
    _require_clean_tree
    finishing=1; moved=1
    from="$(_record_get from)"; branch="$(_record_get branch)"; backup="$(_record_get backup)"
    log "update: the last update (from $(_record_get from_version)) did not finish — finishing it; no new backup: ./stack rollback still goes back with $backup"
    hint="./stack update finishes it, or ./stack rollback goes back (by hand: $(_rollback_cmd "$from" "$branch") && ./stack restore $backup)"
    if [ -n "$to" ]; then
      log "update: 2/4 code (git)"
      update_checkout "$to"
      [ "$CODE_CHANGED" != 1 ] ||
        exec env BEDROCK_NOW_CODE_UPDATED=1 BEDROCK_NOW_UPDATE_FINISHING=1 BEDROCK_NOW_UPDATE_BACKUP="$backup" \
          BEDROCK_NOW_UPDATE_FROM="$from" BEDROCK_NOW_UPDATE_BRANCH="$branch" "$STACK_DIR/stack" update ${yes[@]+"${yes[@]}"}
    fi
  elif [ "$reexec" = 0 ]; then
    _require_clean_tree
    if [ "$force" = 0 ] && update_nothing_new "$to"; then
      log "already on $(installed_version) — nothing to update (./stack update --force re-runs setup)"
      offer_helper --after-update   # lib/helper.sh: one-click updates, so this needs no terminal next time
      return 0
    fi
    log "update: 1/4 backup"
    _backup_named auto
    prune_auto_backups 5
    backup="$LAST_BACKUP"
    if [ -e "$STACK_DIR/.git" ]; then from="$(_git rev-parse HEAD)"; branch="$(_git symbolic-ref -q --short HEAD || true)"; fi
    log "update: 2/4 code (git)"
    update_checkout "$to"
    if [ "$CODE_CHANGED" = 1 ]; then
      # What ./stack rollback needs, now that the code moved: a stop before the new code runs is an unfinished update.
      update_record_write "$from" "$branch" "$backup"
      # Continue in a fresh process so images and setup run with the NEW scripts.
      exec env -u BEDROCK_NOW_UPDATE_FINISHING BEDROCK_NOW_CODE_UPDATED=1 BEDROCK_NOW_UPDATE_BACKUP="$backup" \
        BEDROCK_NOW_UPDATE_FROM="$from" BEDROCK_NOW_UPDATE_BRANCH="$branch" "$STACK_DIR/stack" update ${yes[@]+"${yes[@]}"}
    fi
    hint="./stack update runs it again; your pre-update backup is $backup (./stack restore $backup)"
  else
    backup="${BEDROCK_NOW_UPDATE_BACKUP:-}"; from="${BEDROCK_NOW_UPDATE_FROM:-}"; branch="${BEDROCK_NOW_UPDATE_BRANCH:-}"
    moved=1
    # finishing an unfinished update (set by the exec above): only while the record says so
    [ "${BEDROCK_NOW_UPDATE_FINISHING:-0}" != 1 ] || [ "$(_record_get result)" != running ] || finishing=1
    log "update: 1/4 backup and 2/4 code done (backup: ${backup:-none})"
    hint="./stack update finishes it, or ./stack rollback goes back (by hand: $(_rollback_cmd "$from" "$branch") && ./stack restore $backup)"
  fi
  # Only an update that moved the code is a new version: an update with nothing new keeps the rollback record
  # and the previous version's images exactly as they are. Finishing an update: its record and snapshot stand.
  if [ "$moved" = 1 ] && [ "$finishing" = 0 ]; then
    # What ./stack rollback needs (lib/rollback.sh), recorded before anything but the code has changed (already
    # written by this version before the exec; an older version's ./stack update did not).
    update_record_write "$from" "$branch" "$backup"
    # The images in use now (the old version's): kept after the update as the one previous version (lib/images.sh).
    images_snapshot_before "$from"
  elif [ "$finishing" = 1 ] && [ ! -f "$(images_dir)/before.tsv" ]; then
    images_snapshot_before "$from"   # stopped before it: setup has not run, so :local is still the old build
  fi
  log "update: 3/4 images (pulling the versions pinned in compose.yaml)"
  dc pull --ignore-buildable || {
    [ "$?" -lt 128 ] || die "update stopped during 3/4 images — $hint"   # Ctrl-C: Compose ends with 128 + the signal
    die "image pull failed or was stopped (network/registry?) — $hint"
  }
  log "update: 4/4 setup (non-interactive; keeps .env, keys and AWS creds)"
  # Separate process (keeps set -e working inside setup); AWS creds and the optional OpenRouter settings come
  # from .env, never from this shell (a removed OpenRouter key stays removed).
  env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_REGION_NAME -u AWS_REGION \
    -u OPENROUTER_API_KEY -u OPENROUTER_MODELS -u OPENROUTER_MAX_MODELS -u BEDROCK_NOW_OPENROUTER_FROM_ENV \
    -u STT_PROVIDER -u STT_API_KEY -u STT_MODEL -u BEDROCK_NOW_STT_FROM_ENV \
    -u COMPOSE_PROJECT_NAME -u BEDROCK_NOW_CODE_UPDATED -u BEDROCK_NOW_UPDATE_BACKUP -u BEDROCK_NOW_UPDATE_FROM -u BEDROCK_NOW_UPDATE_BRANCH \
    -u BEDROCK_NOW_UPDATE_FINISHING \
    "$STACK_DIR/stack" setup --yes ||
    die "update: setup failed (see the messages above) — $hint"
  if [ "$moved" != 1 ]; then
    log "update: done (no new version; ./stack rollback still goes back to the version before the last real update)"
    offer_helper --after-update; return 0
  fi
  update_record_done
  # Only now that the new version runs: remove what the update before this one replaced (keeps one previous).
  images_after_update || warn "could not clean up old images — ./stack clean tries again"
  [ -z "$from" ] || log "updated to $(installed_version). Something wrong? ./stack rollback goes back (code, data and images)"
  update_whats_new
  offer_helper --after-update   # lib/helper.sh: asks (default yes) unless declined before
}

# update_whats_new — after an update to a new version, at most 5 lines: voice, remote access and updates (each with
# the command that changes it, the last two only while off: the one-click helper, or on a release its automatic
# updates) and the release notes of a tag
update_whats_new() {
  local tag
  tag="$( [ ! -e "$STACK_DIR/.git" ] || _git describe --tags --exact-match HEAD 2>/dev/null || true)"
  printf "\nWhat's new in %s:\n" "$(installed_version)"
  if stt_enabled; then printf '  Voice: %s speech-to-text is on (./stack stt status)\n' "$(stt_provider_label "$(stt_provider)")"
  else printf '  Voice: browser speech only — ./stack stt set bedrock turns on Bedrock speech-to-text (docs/voice.md)\n'; fi
  remote_on || printf '  Remote access: off — ./stack remote enable tailscale (docs/remote.md)\n'
  if ! helper_installed; then printf '  One-click updates from Home: ./stack helper install\n'
  elif [ -n "$tag" ] && ! auto_on; then printf '  Automatic updates: off — ./stack helper auto on installs new releases at night\n'; fi
  case "$tag" in v[0-9]*) case "$tag" in *[!A-Za-z0-9._-]*) ;; *) printf '  Release notes: %s/tag/%s\n' "$BEDROCK_NOW_RELEASES_URL" "$tag" ;; esac ;; esac
  return 0
}

cmd_rotate_aws() {
  local id secret region arn errf old old_auth old_secret
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  stack_lock rotate-aws   # lib/lock.sh: .env is written below
  case "${1:-}" in   # instance-role mode: lib/host.sh
    '') if uses_instance_role; then instance_role_rotate_info; return 0; fi ;;
    --use-keys) ;;
    --use-instance-role) rotate_to_instance_role; return 0 ;;
    *) die "unknown option: $1 (./stack rotate-aws [--use-keys | --use-instance-role])" ;;
  esac
  id=''; secret=''
  if _env_aws_creds_chosen; then   # env creds: always non-interactively, only on "y" interactively
    id="$AWS_ACCESS_KEY_ID"; secret="$AWS_SECRET_ACCESS_KEY"
    _reject_temporary_creds "$id" "${AWS_SESSION_TOKEN:-}"
  elif [ "${ASSUME_YES:-0}" != 1 ] && _have_tty; then
    id="$(ask "New AWS access key ID" "")"
    [ -z "$id" ] || secret="$(ask_secret "New AWS secret access key (hidden)")"
  fi
  [ -n "$id" ] && [ -n "$secret" ] ||
    die "both a key ID and a secret are required (non-interactive: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY) — .env was NOT changed"
  _reject_temporary_creds "$id"
  old="$(get_env AWS_ACCESS_KEY_ID)"
  [ "$id" != "$old" ] || warn "that is the key already in .env — re-verifying it anyway"
  region="$(get_env AWS_REGION_NAME)"; region="${region:-us-east-1}"
  log "verifying the new key with AWS before changing anything…"
  errf="$(mktemp)"
  if ! arn="$(aws_run "$id" "$secret" "$region" sts get-caller-identity --query Arn --output text 2>"$errf")"; then
    arn="$(tr '\n' ' ' < "$errf")"; rm -f "$errf"
    die "AWS rejected the new key: $arn — .env was NOT changed; the old key is still in use. Check the values and re-run ./stack rotate-aws"
  fi
  rm -f "$errf"
  log "new key authenticated as $arn"
  # Bedrock itself, before switching (free: a deliberately invalid request): a key without Bedrock access never
  # replaces a working one.
  _prove_bedrock "$region" ".env was NOT changed; the old key is still in use" "$id" "$secret" || exit 1
  old_auth="$(get_env AWS_AUTH)"; old_secret="$(get_env AWS_SECRET_ACCESS_KEY)"
  set_env_batch AWS_ACCESS_KEY_ID "$id" AWS_SECRET_ACCESS_KEY "$secret" -AWS_AUTH ''
  log "restarting LiteLLM with the new key…"
  dc up -d --wait litellm ||   # env changed → the container is recreated with the new key
    _restore_aws_settings "$old_auth" "$old" "$old_secret" "LiteLLM did not come up with the new key"
  ( cmd_test ) || _restore_aws_settings "$old_auth" "$old" "$old_secret" "the smoke test failed with the new key"
  if [ -n "$old" ]; then log "rotated. Remember to deactivate the old key ($old) in IAM, or ask your AWS admin to."
  else log "now using the access key $(printf '%s' "$id" | cut -c1-8)… instead of the instance role."; fi
}

cmd_uninstall() {
  local target="$HOME/.local/bin/claude-bedrock"
  warn "This deletes all containers AND data volumes (chats, knowledge bases, files, spend history) and this install's built images."
  [ "$(ask "Type 'bedrock-now' to confirm" "")" = bedrock-now ] || die "aborted — nothing was removed"
  if confirm "Take a backup first?"; then cmd_backup; fi
  dc down -v --remove-orphans
  terminal_uninstall_cleanup   # lib/terminal.sh: its volume, networks and image, also while it is off
  local_builds_remove          # lib/images.sh: <project>/portal:local, …:previous, by exact name (never a prune)
  ! helper_installed || helper_uninstall
  if [ "$(readlink "$target" 2>/dev/null)" = "$STACK_DIR/bin/claude-bedrock" ]; then rm -f "$target"; log "removed the $target link"; fi
  log "removed. .env and backups/ were kept (they contain secrets) — delete this folder yourself if you're done."
  # claude-bedrock's own Claude Code folder (settings, plugins, sessions): yours, possibly shared by other copies
  if [ -d "$HOME/.claude-bedrock" ]; then
    log "~/.claude-bedrock (claude-bedrock's Claude Code settings and sessions) was kept — delete it yourself if you're done."
  fi
}

# One update/rollback/clean/restore/setup at a time (.state/lock).
. "$STACK_DIR/lib/lock.sh"
# Optional OpenRouter provider (setup step, ./stack openrouter, costs/models/summary sections).
. "$STACK_DIR/lib/openrouter.sh"
# Optional speech-to-text for Open WebUI's voice calls (setup step, ./stack stt, costs/summary lines).
. "$STACK_DIR/lib/stt.sh"
# Image cleanup and disk usage (./stack update, ./stack clean, ./stack status).
. "$STACK_DIR/lib/images.sh"
# Installed version, the portal's release check, and the .state folders the portal mounts.
. "$STACK_DIR/lib/version.sh"
# ./stack rollback (back to the version before the last update).
. "$STACK_DIR/lib/rollback.sh"
# The optional host helper (one-click Update / Rollback / Clean from the portal): ./stack helper.
. "$STACK_DIR/lib/helper.sh"
# Settings (./stack config, ./stack restart, the snapshot for the portal) and the helper's settings requests.
. "$STACK_DIR/lib/settings.sh"
. "$STACK_DIR/lib/settings_helper.sh"
# EC2 instance role, ./stack serve (keep the Mac awake), ./stack ssh-info.
. "$STACK_DIR/lib/host.sh"
# Remote access from your devices (./stack remote; Tailscale sidecar, remote Caddy site).
. "$STACK_DIR/lib/remote.sh"
# The optional browser terminal (./stack terminal; Claude Code in a sandbox container, the portal's Terminal tab).
. "$STACK_DIR/lib/terminal.sh"
