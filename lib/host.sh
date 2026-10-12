# shellcheck shell=bash
# Host integration (sourced by lib/commands.sh):
#   - AWS credentials from the machine's IAM role on EC2 (AWS_AUTH=instance-role: no keys stored in .env);
#   - ./stack serve: keep the stack up and the Mac awake while it serves (caffeinate; systemd-inhibit on Linux);
#   - ./stack ssh-info: how to run claude-bedrock from a phone over SSH (never a web terminal).
# See docs/cloud-vm.md and docs/phone-claude-code.md.

IMDS_URL="${IMDS_URL:-http://169.254.169.254}"

host_os() { uname -s; }   # overridable in tests
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# --- AWS credentials from the EC2 instance role ---------------------------------------------------------------

# uses_instance_role -> 0 when .env says AWS_AUTH=instance-role (LiteLLM and aws-cli then get no keys: boto3's
# default chain finds the instance profile through IMDS).
uses_instance_role() { [ "$(get_env AWS_AUTH)" = instance-role ]; }

# imds_get PATH -> a value from EC2's instance metadata service (IMDSv2). Short timeouts, so off EC2 this is a
# single ~1 s "no". The session token goes to curl on stdin, never on argv. BEDROCK_NOW_NO_IMDS=1 skips it.
imds_get() {
  local tok
  [ "${BEDROCK_NOW_NO_IMDS:-0}" != 1 ] || return 1
  tok="$(curl -fsS --connect-timeout 1 -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
    "$IMDS_URL/latest/api/token" 2>/dev/null)" || return 1
  case "$tok" in '' | *[!A-Za-z0-9_=+/-]*) return 1 ;; esac
  printf 'header = "X-aws-ec2-metadata-token: %s"\n' "$tok" |
    curl -fsS --connect-timeout 1 -m 2 -K - "$IMDS_URL/latest/$1" 2>/dev/null
}

# instance_role_name -> the IAM role attached to this EC2 instance (fails off EC2 or without a role).
instance_role_name() {
  local r
  r="$(imds_get meta-data/iam/security-credentials/)" || return 1
  r="$(printf '%s\n' "$r" | head -n 1)"
  case "$r" in '' | *[!A-Za-z0-9+=,.@_-]*) return 1 ;; esac
  printf '%s\n' "$r"
}

# aws_run_role REGION ARGS... — aws-cli in a throwaway container with no credentials passed in: it uses the
# instance role through IMDS (reachable from a container only with the IMDSv2 hop limit at 2).
aws_run_role() {
  local region="$1"; shift
  ( unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
    AWS_DEFAULT_REGION="$region" docker run --rm -e AWS_DEFAULT_REGION "$AWS_CLI_IMAGE" "$@" </dev/null )
}

# _role_hint -> how to let containers reach IMDS (with this instance's id when IMDS answers).
_role_hint() {
  local iid; iid="$(imds_get meta-data/instance-id 2>/dev/null || true)"
  case "$iid" in i-*) ;; *) iid='<instance-id>' ;; esac
  printf '%s' "Containers reach the instance role only with the IMDSv2 hop limit at 2 (Amazon Linux 2023's default; other AMIs use 1): aws ec2 modify-instance-metadata-options --instance-id $iid --http-tokens required --http-put-response-hop-limit 2 — and the role needs Bedrock permissions (docs/cloud-vm.md)"
}

# _verify_role REGION -> prints the role ARN, or dies with the error and the hop-limit hint.
_verify_role() {
  local arn errf
  docker pull -q "$AWS_CLI_IMAGE" >/dev/null || die "could not pull $AWS_CLI_IMAGE (network/Docker Hub?)"
  errf="$(mktemp)"
  if ! arn="$(aws_run_role "$1" sts get-caller-identity --query Arn --output text 2>"$errf")"; then
    arn="$(tr '\n' ' ' < "$errf")"; rm -f "$errf"
    die "the instance role did not work from a container: ${arn:-no output}. $(_role_hint)${2:+ — $2}"
  fi
  rm -f "$errf"
  printf '%s\n' "$arn"
}

# setup_instance_role -> 0 when this setup uses the machine's IAM role (decided, verified and written to .env);
# 1 = use an access key (the normal flow). The role is offered only when no key is configured in the shell or
# .env; an install already in role mode keeps it (an exported key is ignored, with a warning).
setup_instance_role() {
  local role='' region arn
  if uses_instance_role; then
    if [ "${ASSUME_YES:-0}" != 1 ] && _have_tty && ! confirm "Keep using this machine's AWS IAM role (no keys stored)?"; then
      unset_env AWS_AUTH; return 1
    fi
    [ -z "${AWS_ACCESS_KEY_ID:-}" ] ||
      warn "ignoring AWS_ACCESS_KEY_ID in your shell: this install uses the machine's IAM role (./stack rotate-aws --use-keys switches to a key)"
  else
    [ -z "${AWS_ACCESS_KEY_ID:-}" ] || return 1
    [ -z "$(get_env AWS_ACCESS_KEY_ID)" ] || return 1
    role="$(instance_role_name)" || return 1
    confirm "This machine has an AWS IAM role ($role). Use it instead of an access key (nothing stored in .env)?" || return 1
  fi
  region="${AWS_REGION_NAME:-${AWS_REGION:-}}"
  [ -n "$region" ] || region="$(get_env AWS_REGION_NAME)"
  [ -n "$region" ] || region="$(imds_get meta-data/placement/region 2>/dev/null || true)"
  valid_region "$region" || region=us-east-1
  region="$(ask "AWS region" "$region")"; region="${region:-us-east-1}"
  valid_region "$region" || die "invalid AWS region: '$region' (expected something like us-east-1)"
  log "verifying the instance role from a container…"
  arn="$(_verify_role "$region")" || exit 1   # (explicit: callers may have set -e off)
  set_env AWS_AUTH instance-role; set_env AWS_REGION_NAME "$region"
  unset_env AWS_ACCESS_KEY_ID; unset_env AWS_SECRET_ACCESS_KEY
  log "authenticated as $arn (this machine's IAM role: AWS rotates its credentials; no keys in .env)"
}

# rotate_to_instance_role — ./stack rotate-aws --use-instance-role: verify the role first, then drop the keys.
rotate_to_instance_role() {
  local role region arn old
  role="$(instance_role_name)" ||
    die "no IAM role found on this machine (an EC2 instance profile, via IMDSv2) — attach one first (docs/cloud-vm.md). .env was NOT changed"
  region="$(get_env AWS_REGION_NAME)"; region="${region:-us-east-1}"
  log "verifying the instance role ($role) from a container before changing anything…"
  arn="$(_verify_role "$region" ".env was NOT changed")" || exit 1
  log "authenticated as $arn"
  old="$(get_env AWS_ACCESS_KEY_ID)"
  set_env AWS_AUTH instance-role; unset_env AWS_ACCESS_KEY_ID; unset_env AWS_SECRET_ACCESS_KEY
  log "restarting LiteLLM with the instance role…"
  dc up -d --wait litellm   # env changed → the container is recreated without keys
  cmd_test
  if [ -n "$old" ]; then log "switched to the instance role. The old key ($old) is no longer in .env — deactivate it in IAM, or ask your AWS admin to."
  else log "switched to the instance role."; fi
}

instance_role_rotate_info() {
  log "this install uses the machine's AWS IAM role (AWS_AUTH=instance-role in .env): there is no key to rotate — AWS rotates the role's temporary credentials itself."
  log "to use an access key instead: ./stack rotate-aws --use-keys"
}

# --- ./stack serve ---------------------------------------------------------------------------------------------

SERVE_PID_FILE_NAME=serve.pid

# spawn_detached CMD... -> starts CMD in the background, immune to hangups and this terminal; prints its pid.
spawn_detached() { nohup "$@" >/dev/null 2>&1 </dev/null & printf '%s\n' "$!"; }

# serve_pid -> the pid of a running `./stack serve --background` wake lock (removes a stale pid file).
serve_pid() {
  local f="$STATE_DIR/$SERVE_PID_FILE_NAME" pid comm
  [ -f "$f" ] || return 1
  pid="$(cat "$f")"
  case "$pid" in '' | *[!0-9]*) rm -f "$f"; return 1 ;; esac
  comm="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
  case "$comm" in *caffeinate*) printf '%s\n' "$pid" ;; *) rm -f "$f"; return 1 ;; esac
}

serve_stop() {
  local pid
  if pid="$(serve_pid)"; then
    kill "$pid" 2>/dev/null || true
    rm -f "$STATE_DIR/$SERVE_PID_FILE_NAME"
    log "stopped keeping this Mac awake (pid $pid): it can sleep again. The stack keeps running (./stack down stops it)."
  else
    log "./stack serve --background is not running"
  fi
}

on_battery() { pmset -g batt 2>/dev/null | head -n 1 | grep -q "Battery Power"; }

# docker_autostart_hint — macOS: Docker Desktop's "Start when you sign in" is read from its settings file
# (read-only; we never edit Docker Desktop's settings) and, when off, how to turn it on.
docker_autostart_hint() {
  local f="$HOME/Library/Group Containers/group.com.docker/settings-store.json"
  [ -f "$f" ] || return 0
  grep -Eq '"AutoStart"[[:space:]]*:[[:space:]]*true' "$f" && return 0
  warn "Docker Desktop doesn't start by itself: turn on Docker Desktop › Settings › General › \"Start Docker Desktop when you sign in to your computer\", so bedrock-now comes back after a restart"
}

serve_urls() {
  local r=''
  log "portal: $(portal_url)"
  if declare -F remote_url >/dev/null; then r="$(remote_url 2>/dev/null || true)"; fi
  [ -z "$r" ] || log "remote: $r"
}

_serve_mac() {
  local pid
  docker_autostart_hint
  if ! on_battery; then :
  else warn "on battery power: macOS keeps the Mac awake only while idle (caffeinate -i); system sleep is only held on AC power (-s), and closing the lid sleeps it — plug it in"; fi
  if pid="$(serve_pid)"; then log "already kept awake by ./stack serve --background (pid $pid; ./stack serve --stop ends it)"; return 0; fi
  if [ "$1" = bg ]; then
    pid="$(spawn_detached caffeinate -i -s)"
    printf '%s\n' "$pid" > "$STATE_DIR/$SERVE_PID_FILE_NAME"
    log "keeping this Mac awake in the background (caffeinate, pid $pid) — ./stack serve --stop lets it sleep again"
    return 0
  fi
  log "keeping this Mac awake while bedrock-now serves (caffeinate -i -s). Ctrl-C stops that; the stack keeps running (./stack down stops it)."
  trap ':' INT
  caffeinate -i -s || true
  trap - INT
  log "stopped keeping the Mac awake: it can sleep again (the stack is still up)"
}

_serve_linux() {
  if ! have_cmd systemd-inhibit; then
    log "Linux: nothing to hold — servers don't sleep. (On a Linux laptop, turn off suspend in its power settings.)"
    return 0
  fi
  if [ "$1" = bg ]; then
    log "Linux: --background isn't needed on a server (they don't sleep); on a laptop run ./stack serve in tmux"
    return 0
  fi
  log "holding a sleep inhibitor while bedrock-now serves (systemd-inhibit). Ctrl-C releases it; the stack keeps running."
  trap ':' INT
  systemd-inhibit --what=sleep:idle --who=bedrock-now --why="serving bedrock-now" --mode=block sleep infinity || true
  trap - INT
  log "released the sleep inhibitor (the stack is still up)"
}

cmd_serve() {
  local mode=fg holder
  case "${1:-}" in
    '') ;;
    --background) mode='bg' ;;
    --stop) serve_stop; return 0 ;;
    *) die "unknown option: $1 (./stack serve [--background | --stop])" ;;
  esac
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  mkdir -p "$STATE_DIR"
  # An update/rollback/clean/restore/setup in progress (a terminal or the host helper, lib/lock.sh) brings the
  # stack back itself: don't start it in the middle of that, just keep the machine awake.
  holder="$(stack_lock_holder 2>/dev/null || true)"
  if [ -n "$holder" ]; then
    warn "./stack ${holder#* } is running (pid ${holder%% *}): not starting the stack now — it does that itself; keeping the machine awake anyway"
  else
    BEDROCK_NOW_NO_OPEN=1 cmd_up
  fi
  serve_urls
  case "$(host_os)" in
    Darwin) _serve_mac "$mode" ;;
    Linux) _serve_linux "$mode" ;;
    *) log "nothing to keep awake on $(host_os)" ;;
  esac
}

# --- ./stack ssh-info ------------------------------------------------------------------------------------------

# tailscale_cli -> the tailscale CLI (PATH, or the macOS app's bundled one)
tailscale_cli() {
  if have_cmd tailscale; then echo tailscale; return 0; fi
  local app=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  [ -x "$app" ] && { echo "$app"; return 0; }
  return 1
}

# tailscale_name -> this machine's MagicDNS name on the tailnet (no trailing dot), if Tailscale runs here.
tailscale_name() {
  local t n
  t="$(tailscale_cli)" || return 1
  n="$("$t" status --json --peers=false 2>/dev/null | json_get DNSName)"
  n="${n%.}"
  [ -n "$n" ] || return 1
  printf '%s\n' "$n"
}

ssh_server_up() { nc -z -w 1 127.0.0.1 22 >/dev/null 2>&1; }

cmd_ssh_info() {
  local user name where cb os
  os="$(host_os)"
  user="$(id -un)"
  if name="$(tailscale_name)"; then
    where="Tailscale: reachable from your phone anywhere, once the Tailscale app on it is signed in to the same tailnet"
  else
    name="$(hostname 2>/dev/null || echo localhost)"; name="${name%%.*}"
    [ "$os" != Darwin ] || name="$name.local"
    where="local network only — install Tailscale here and on your phone to reach it from anywhere (no open ports)"
  fi
  cb="$(claude_bedrock_cmd 2>/dev/null || echo claude-bedrock)"
  cat <<EOF
Claude Code (claude-bedrock) from your phone: SSH into this machine — bedrock-now has no web terminal.

  This machine   $name
                 ($where)
EOF
  if ssh_server_up; then
    printf '  SSH server     on (port 22)\n'
  elif [ "$os" = Darwin ]; then
    printf '  SSH server     not reachable on port 22 — turn on System Settings › General › Sharing › Remote Login\n'
  else
    printf '  SSH server     not reachable on port 22 — install and start it: sudo apt install openssh-server (Debian/Ubuntu) or sudo dnf install openssh-server && sudo systemctl enable --now sshd\n'
  fi
  cat <<EOF
  Connect        ssh $user@$name
  Then           tmux new -A -s claude       (reattaches after the phone drops; detach: Ctrl-b d)
                 cd ~/your-project && $cb
EOF
  have_cmd tmux || printf '                 (install tmux first: brew install tmux on macOS, sudo apt/dnf install tmux on Linux)\n'
  cat <<EOF
  Phone apps     iOS: Blink Shell (has mosh) or Termius   Android: Termius or JuiceSSH
  Flaky network  mosh $user@$name   (survives switching networks; needs mosh installed on this machine too)
  Tailscale SSH  optional: sign-in through your tailnet instead of SSH keys — on Linux: sudo tailscale set --ssh
                 (on macOS only with the open-source tailscaled, not the App Store app)
  Note           Claude Code's Remote Control (claude.ai/code on the phone) doesn't work with Bedrock or a custom
                 API URL such as LiteLLM — use SSH as above.
  Guide          docs/phone-claude-code.md
EOF
}
