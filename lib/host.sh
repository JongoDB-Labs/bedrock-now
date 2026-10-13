# shellcheck shell=bash
# Host integration (sourced by lib/commands.sh):
#   - AWS credentials from the machine's IAM role on EC2 (AWS_AUTH=instance-role: no keys stored in .env);
#   - ./stack serve: keep the stack up and the Mac awake while it serves (caffeinate; systemd-inhibit on Linux);
#   - ./stack ssh-info: how to run claude-bedrock from a phone over SSH (never a web terminal).
# See docs/cloud-vm.md and docs/phone-claude-code.md.

host_os() { uname -s; }   # overridable in tests
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# Only the test suite (BEDROCK_NOW_TESTING=1) can point these at fakes; a stray variable in a user's shell
# never changes where credentials come from.
_sysfs() {
  if [ "${BEDROCK_NOW_TESTING:-}" = 1 ] && [ -n "${BEDROCK_NOW_TEST_SYSFS:-}" ]; then printf '%s\n' "$BEDROCK_NOW_TEST_SYSFS"
  else printf '/sys\n'; fi
}
_imds_url() {
  if [ "${BEDROCK_NOW_TESTING:-}" = 1 ] && [ -n "${BEDROCK_NOW_TEST_IMDS_URL:-}" ]; then printf '%s\n' "$BEDROCK_NOW_TEST_IMDS_URL"
  else printf 'http://169.254.169.254\n'; fi
}

# --- AWS credentials from the EC2 instance role ---------------------------------------------------------------

# uses_instance_role -> 0 when .env says AWS_AUTH=instance-role (LiteLLM and aws-cli then get no keys: boto3's
# default chain finds the instance profile through IMDS).
uses_instance_role() { [ "$(get_env AWS_AUTH)" = instance-role ]; }

_sysfs_read() { head -c 200 "$(_sysfs)/$1" 2>/dev/null | tr -d '\n' || true; }

# is_ec2_host -> 0 only on Linux whose firmware says EC2 (DMI asset tag i-…, vendor "Amazon EC2", or a Xen/DMI
# UUID starting with ec2). These come from the hypervisor, so a network that answers 169.254.169.254 (a hotel
# Wi-Fi, a malicious router) can't fake them; on macOS IMDS is never asked at all.
is_ec2_host() {
  [ "$(host_os)" = Linux ] || return 1
  case "$(_sysfs_read devices/virtual/dmi/id/board_asset_tag)" in i-[0-9a-f]*) return 0 ;; esac
  [ "$(_sysfs_read devices/virtual/dmi/id/sys_vendor)" = "Amazon EC2" ] && return 0
  case "$(_sysfs_read hypervisor/uuid)" in ec2* | EC2*) return 0 ;; esac
  case "$(_sysfs_read devices/virtual/dmi/id/product_uuid)" in ec2* | EC2*) return 0 ;; esac
  return 1
}

# imds_get PATH -> a value from EC2's instance metadata service (IMDSv2), only on an EC2 host. Short timeouts;
# the session token goes to curl on stdin, never on argv. BEDROCK_NOW_NO_IMDS=1 skips it.
imds_get() {
  local tok url
  [ "${BEDROCK_NOW_NO_IMDS:-0}" != 1 ] || return 1
  is_ec2_host || return 1
  url="$(_imds_url)"
  tok="$(curl -fsS --connect-timeout 1 -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
    "$url/latest/api/token" 2>/dev/null)" || return 1
  case "$tok" in '' | *[!A-Za-z0-9_=+/-]*) return 1 ;; esac
  printf 'header = "X-aws-ec2-metadata-token: %s"\n' "$tok" |
    curl -fsS --connect-timeout 1 -m 2 -K - "$url/latest/$1" 2>/dev/null
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

_not_ec2_msg() {
  printf '%s' "AWS_AUTH=instance-role in .env, but this machine doesn't look like an EC2 instance — refusing to take AWS credentials from a metadata service here (any network can answer 169.254.169.254). Use an access key: ./stack rotate-aws --use-keys"
}

# _verify_role REGION NOTE [ROLE] -> prints the caller ARN; dies with the error and the hop-limit hint, or when
# the credentials belong to a different role than IMDS named (NOTE is appended to every error).
_verify_role() {
  local arn errf
  docker pull -q "$AWS_CLI_IMAGE" >/dev/null || die "could not pull $AWS_CLI_IMAGE (network/Docker Hub?)${2:+ — $2}"
  errf="$(mktemp)"
  if ! arn="$(aws_run_role "$1" sts get-caller-identity --query Arn --output text 2>"$errf")"; then
    arn="$(tr '\n' ' ' < "$errf")"; rm -f "$errf"
    die "the instance role did not work from a container: ${arn:-no output}. $(_role_hint)${2:+ — $2}"
  fi
  rm -f "$errf"
  case "$arn" in arn:aws*:sts::[0-9]*:assumed-role/*) ;; *) die "unexpected identity from the instance role: '$arn'${2:+ — $2}" ;; esac
  if [ -n "${3:-}" ]; then
    case "$arn" in *":assumed-role/$3/"*) ;; *) die "the credentials a container got ($arn) are not this instance's role ($3) — refusing${2:+ — $2}" ;; esac
  fi
  printf '%s\n' "$arn"
}

arn_account() { printf '%s\n' "$1" | cut -d: -f5; }

# _role_probe_models -> "BEDROCK_ID<TAB>REGION" for the catalog's Haiku chat model(s), then its embedding models
# (at most 3). REGION "-" = the default region.
_role_probe_models() {
  awk -F'\t' '!/^#/ && NF >= 3 && $2 == "chat" && $1 ~ /haiku/ { print $3 "\t" ($5 == "" ? "-" : $5) }
              !/^#/ && NF >= 3 && $2 == "embedding" { e = e $3 "\t" ($5 == "" ? "-" : $5) "\n" }
              END { printf "%s", e }' "$CATALOG" |
    sed -e 's#^bedrock/##' -e 's#^invoke/##' -e 's#^converse/##' | head -n 3
}

# _prove_bedrock REGION NOTE — the role may really call Bedrock: a deliberately invalid invoke-model (free; IAM and
# model access are checked before the body, so ValidationException = authorized) on the catalog's Haiku model, then
# its embedding models. Dies (with NOTE) when none is authorized.
_prove_bedrock() {
  local id r errf last=''
  errf="$(mktemp)"
  while IFS="$(printf '\t')" read -r id r; do
    [ -n "$id" ] || continue
    [ "$r" != "-" ] || r="$1"
    aws_run_role "$r" bedrock-runtime invoke-model --model-id "$id" --body e30= /dev/null >/dev/null 2>"$errf" || true
    if grep -q ValidationException "$errf"; then
      rm -f "$errf"; log "Bedrock access confirmed with the role ($id; free check)"; return 0
    fi
    last="$id: $(tr '\n' ' ' < "$errf" | cut -c1-200)"
  done <<EOF
$(_role_probe_models)
EOF
  rm -f "$errf"
  die "the instance role can't use Bedrock (${last:-no model to check in $CATALOG}). Give the role the policy in docs/cloud-vm.md and enable model access${2:+ — $2}"
}

# _confirm_role_identity ARN — interactive runs show the account and role and ask before anything is written.
_confirm_role_identity() {
  local acct; acct="$(arn_account "$1")"
  log "the instance role is $1 (AWS account $acct)"
  if [ "${ASSUME_YES:-0}" != 1 ] && _have_tty; then
    confirm "Use AWS account $acct through $1?" || return 1
  fi
  return 0
}

# setup_instance_role -> 0 when this setup uses the machine's IAM role (decided, verified and written to .env);
# 1 = use an access key (the normal flow; a role install stays in role mode until a new key is verified).
# The role is offered only on an EC2 host and only when no key is configured in the shell or .env; an install
# already in role mode keeps it (an exported key is ignored, with a warning).
setup_instance_role() {
  local role='' region arn
  if uses_instance_role; then
    is_ec2_host || die "$(_not_ec2_msg)"
    if [ "${ASSUME_YES:-0}" != 1 ] && _have_tty && ! confirm "Keep using this machine's AWS IAM role (no keys stored)?"; then
      return 1
    fi
    [ -z "${AWS_ACCESS_KEY_ID:-}" ] ||
      warn "ignoring AWS_ACCESS_KEY_ID in your shell: this install uses the machine's IAM role (./stack rotate-aws --use-keys switches to a key)"
    role="$(instance_role_name || true)"
  else
    [ -z "${AWS_ACCESS_KEY_ID:-}" ] || return 1
    [ -z "$(get_env AWS_ACCESS_KEY_ID)" ] || return 1
    role="$(instance_role_name)" || return 1   # EC2 hosts only (imds_get)
    confirm "This EC2 instance has an AWS IAM role ($role). Use it instead of an access key (nothing stored in .env)?" || return 1
  fi
  region="$(get_env AWS_REGION_NAME)"
  [ -n "$region" ] || region="$(imds_get meta-data/placement/region 2>/dev/null || true)"
  valid_region "$region" || region=us-east-1
  region="$(ask "AWS region" "$region")"; region="${region:-us-east-1}"
  valid_region "$region" || die "invalid AWS region: '$region' (expected something like us-east-1)"
  log "verifying the instance role from a container…"
  arn="$(_verify_role "$region" "" "$role")" || exit 1   # (explicit: callers may have set -e off)
  _prove_bedrock "$region" "" || exit 1
  _confirm_role_identity "$arn" || return 1
  set_env AWS_AUTH instance-role; set_env AWS_REGION_NAME "$region"
  unset_env AWS_ACCESS_KEY_ID; unset_env AWS_SECRET_ACCESS_KEY
  log "using this machine's IAM role: AWS rotates its credentials; no keys in .env"
}

# verify_key_leaving_role KEY_ID SECRET REGION — a role install switching to a key: the key is proven before
# .env changes (AWS_AUTH is removed only after this).
verify_key_leaving_role() {
  local arn errf
  docker pull -q "$AWS_CLI_IMAGE" >/dev/null || die "could not pull $AWS_CLI_IMAGE (network/Docker Hub?)"
  errf="$(mktemp)"
  if ! arn="$(aws_run "$1" "$2" "$3" sts get-caller-identity --query Arn --output text 2>"$errf")"; then
    arn="$(tr '\n' ' ' < "$errf")"; rm -f "$errf"
    die "AWS rejected the key: $arn — .env was NOT changed (still using the instance role)"
  fi
  rm -f "$errf"
}

# _restore_aws_settings AUTH KEY_ID SECRET WHY — put the AWS settings back as they were (AUTH "" = key mode),
# recreate LiteLLM with them and die with WHY.
_restore_aws_settings() {
  if [ -n "$1" ]; then set_env AWS_AUTH "$1"; else unset_env AWS_AUTH; fi
  if [ -n "$2" ]; then set_env AWS_ACCESS_KEY_ID "$2"; set_env AWS_SECRET_ACCESS_KEY "$3"
  else unset_env AWS_ACCESS_KEY_ID; unset_env AWS_SECRET_ACCESS_KEY; fi
  if dc up -d --wait litellm; then
    die "$4 — restored the previous AWS settings in .env and restarted LiteLLM with them (./stack logs litellm shows what went wrong)"
  fi
  die "$4 — restored the previous AWS settings in .env, but LiteLLM did not come up with them either (./stack logs litellm; ./stack up retries)"
}

# rotate_to_instance_role — ./stack rotate-aws --use-instance-role: role identity and Bedrock access are proven
# before .env changes; if LiteLLM then doesn't start or the smoke test fails, the previous settings come back.
rotate_to_instance_role() {
  local role region arn old_auth old_id old_secret note=".env was NOT changed"
  role="$(instance_role_name)" ||
    die "no IAM role found on this machine (an EC2 instance profile, via IMDSv2) — attach one first (docs/cloud-vm.md). $note"
  region="$(get_env AWS_REGION_NAME)"; region="${region:-us-east-1}"
  log "verifying the instance role ($role) from a container before changing anything…"
  arn="$(_verify_role "$region" "$note" "$role")" || exit 1
  _prove_bedrock "$region" "$note" || exit 1
  _confirm_role_identity "$arn" || die "not switched — $note"
  old_auth="$(get_env AWS_AUTH)"; old_id="$(get_env AWS_ACCESS_KEY_ID)"; old_secret="$(get_env AWS_SECRET_ACCESS_KEY)"
  [ -z "$old_id" ] || log "the old key $old_id stays valid in IAM until you deactivate it (or ask your AWS admin to)"
  set_env AWS_AUTH instance-role; unset_env AWS_ACCESS_KEY_ID; unset_env AWS_SECRET_ACCESS_KEY
  log "restarting LiteLLM with the instance role…"
  dc up -d --wait litellm ||   # env changed → the container is recreated without keys
    _restore_aws_settings "$old_auth" "$old_id" "$old_secret" "LiteLLM did not come up with the instance role"
  ( cmd_test ) || _restore_aws_settings "$old_auth" "$old_id" "$old_secret" "the smoke test failed with the instance role"
  if [ -n "$old_id" ]; then log "switched to the instance role. The old key ($old_id) is no longer in .env — deactivate it in IAM."
  else log "switched to the instance role."; fi
}

instance_role_rotate_info() {
  log "this install uses the machine's AWS IAM role (AWS_AUTH=instance-role in .env): there is no key to rotate — AWS rotates the role's temporary credentials itself."
  log "to use an access key instead: ./stack rotate-aws --use-keys"
}

# warn_shell_aws_ignored — once per ./stack command: an exported key that isn't .env's is not used (dc() keeps
# shell AWS settings out of Compose). Not for setup / rotate-aws, which use exported keys on purpose.
warn_shell_aws_ignored() {
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] || return 0
  if uses_instance_role; then
    warn "AWS_ACCESS_KEY_ID in your shell is ignored: this install uses the machine's instance role (.env)"
  elif [ "$AWS_ACCESS_KEY_ID" != "$(get_env AWS_ACCESS_KEY_ID)" ]; then
    warn "AWS_ACCESS_KEY_ID in your shell is ignored: the stack uses the AWS key in .env (./stack rotate-aws changes it)"
  fi
}

# remote_url -> the remote portal URL when remote access is on (REMOTE_MODE set and not off, REMOTE_HOST in .env);
# nothing otherwise.
remote_url() {
  local mode host
  mode="$(get_env REMOTE_MODE)"; host="$(get_env REMOTE_HOST)"
  case "$mode" in '' | off | false | none | 0 | no) return 0 ;; esac
  case "$host" in '' | *[!A-Za-z0-9.:/_-]*) return 0 ;; esac
  case "$host" in http://* | https://*) printf '%s\n' "$host" ;; *) printf 'https://%s\n' "$host" ;; esac
}

# aws_auth_check — before ./stack up: role mode only on an EC2 host; key mode needs a key in .env.
aws_auth_check() {
  if uses_instance_role; then
    is_ec2_host || die "$(_not_ec2_msg)"
  elif [ -z "$(get_env AWS_ACCESS_KEY_ID)" ] || [ -z "$(get_env AWS_SECRET_ACCESS_KEY)" ]; then
    die "no AWS access key in .env (and AWS_AUTH is not instance-role) — run ./stack setup, or ./stack rotate-aws --use-keys"
  fi
}

# --- ./stack serve ---------------------------------------------------------------------------------------------

SERVE_PID_FILE_NAME=serve.pid

# spawn_detached CMD... -> starts CMD in the background, immune to hangups and this terminal; prints its pid.
spawn_detached() { nohup "$@" >/dev/null 2>&1 </dev/null & printf '%s\n' "$!"; }

_proc_start() { ps -p "$1" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true; }

# serve_pid -> the pid of the running `./stack serve --background` wake lock: the pid file holds the pid and its
# start time, and both must still match a caffeinate process (a reused pid is never taken for ours). A stale pid
# file is removed.
serve_pid() {
  local f="$STATE_DIR/$SERVE_PID_FILE_NAME" pid start comm
  [ -f "$f" ] || return 1
  pid="$(sed -n 1p "$f")"; start="$(sed -n 2p "$f")"
  case "$pid" in '' | *[!0-9]*) rm -f "$f"; return 1 ;; esac
  comm="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
  case "$comm" in *caffeinate*) ;; *) rm -f "$f"; return 1 ;; esac
  if [ -z "$start" ] || [ "$(_proc_start "$pid")" != "$start" ]; then rm -f "$f"; return 1; fi
  printf '%s\n' "$pid"
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

# docker_autostart_hint — macOS: Docker Desktop's "Start when you sign in", read (never edited) from its settings
# (settings-store.json "AutoStart"; older versions: settings.json "autoStart"). Warns only on an explicit false.
docker_autostart_hint() {
  local d="$HOME/Library/Group Containers/group.com.docker" f v=''
  for f in "$d/settings-store.json:AutoStart" "$d/settings.json:autoStart"; do
    [ -f "${f%:*}" ] || continue
    v="$(grep -Eo "\"${f##*:}\"[[:space:]]*:[[:space:]]*(true|false)" "${f%:*}" 2>/dev/null | head -n 1 | sed 's/.*://; s/[[:space:]]//g' || true)"
    [ -z "$v" ] || break
  done
  [ "$v" = false ] || return 0
  warn "Docker Desktop doesn't start by itself: turn on Docker Desktop › Settings › General › \"Start Docker Desktop when you sign in to your computer\", so bedrock-now comes back after a restart"
}

serve_urls() {
  local r=''
  log "portal: $(portal_url)"
  r="$(remote_url 2>/dev/null || true)"
  [ -z "$r" ] || log "remote: $r"
}

_serve_mac() {
  local pid start interrupted=0
  docker_autostart_hint
  if on_battery; then
    warn "on battery power: macOS keeps the Mac awake only while idle (caffeinate -i); system sleep is only held on AC power (-s), and closing the lid sleeps it — plug it in"
  fi
  if pid="$(serve_pid)"; then log "already kept awake by ./stack serve --background (pid $pid; ./stack serve --stop ends it)"; return 0; fi
  if [ "$1" = bg ]; then
    pid="$(spawn_detached caffeinate -i -s)"
    start="$(_proc_start "$pid")"
    printf '%s\n%s\n' "$pid" "$start" > "$STATE_DIR/$SERVE_PID_FILE_NAME"
    log "keeping this Mac awake in the background (caffeinate, pid $pid) — ./stack serve --stop lets it sleep again"
    return 0
  fi
  log "keeping this Mac awake while bedrock-now serves (caffeinate -i -s). Ctrl-C stops that; the stack keeps running (./stack down stops it)."
  trap 'interrupted=1' INT
  caffeinate -i -s || [ "$interrupted" = 1 ] || warn "caffeinate stopped unexpectedly — the Mac may sleep again"
  trap - INT
  log "stopped keeping the Mac awake: it can sleep again (the stack is still up)"
}

_has_battery() { ls "$(_sysfs)"/class/power_supply/BAT* >/dev/null 2>&1; }

_serve_linux() {
  local interrupted=0
  if ! _has_battery; then
    log "Linux without a battery: nothing to hold — servers don't sleep."
    return 0
  fi
  if ! have_cmd systemd-inhibit; then
    log "this Linux laptop has no systemd-inhibit: turn off suspend in its power settings while it serves bedrock-now"
    return 0
  fi
  if [ "$1" = bg ]; then
    log "Linux: --background isn't supported; run ./stack serve in tmux to hold the sleep inhibitor"
    return 0
  fi
  log "holding a sleep inhibitor while bedrock-now serves (systemd-inhibit). Ctrl-C releases it; the stack keeps running."
  trap 'interrupted=1' INT
  if ! systemd-inhibit --what=sleep:idle --who=bedrock-now --why="serving bedrock-now" --mode=block sleep infinity &&
    [ "$interrupted" != 1 ]; then
    trap - INT
    warn "could not hold a sleep inhibitor (systemd-inhibit failed; polkit may not allow it for your user) — the laptop can still suspend"
    return 0
  fi
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

_tcp22_open() { (exec 3<>/dev/tcp/127.0.0.1/22) 2>/dev/null; }

# ssh_server_up -> 0 when something listens on port 22 (nc, else ss, else bash's /dev/tcp)
ssh_server_up() {
  if have_cmd nc; then nc -z -w 1 127.0.0.1 22 >/dev/null 2>&1
  elif have_cmd ss; then ss -ltn 2>/dev/null | awk '{ print $4 }' | grep -Eq '[:.]22$'
  else _tcp22_open; fi
}

cmd_ssh_info() {
  local user name where cb os
  os="$(host_os)"
  user="$(id -un)"
  if name="$(tailscale_name)"; then
    where="Tailscale: reachable from your phone anywhere, once the Tailscale app on it is signed in to the same tailnet"
  else
    name="$(hostname 2>/dev/null || echo localhost)"; name="${name%%.*}"
    [ "$os" != Darwin ] || name="$name.local"
    if is_ec2_host; then
      where="EC2 without Tailscale: with no inbound ports, install it here (curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --ssh) and on your phone; until then use AWS Systems Manager Session Manager"
    else
      where="local network only — install Tailscale here and on your phone to reach it from anywhere (no open ports)"
    fi
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
