# shellcheck shell=bash
# Remote access (./stack remote): the portal from your other devices, over HTTPS, through Tailscale.
#
#   off        (default) only this computer: http://PORTAL_HOST on 127.0.0.1, exactly as without this file.
#   tailscale  a tailscale/tailscale sidecar (compose.tailscale.yaml) hosts four Tailscale Services —
#              svc:<base>, svc:<base>-chat, svc:<base>-admin, svc:<base>-files — each HTTPS on 443 with a
#              Tailscale certificate, forwarding to Caddy's internal remote listener (caddy:8081,
#              caddy/remote-tailscale.caddy). Hosts: <base>[-app].<tailnet>.ts.net.
#   domain     your own name (REMOTE_HOST=bedrock.example.com plus chat./admin./files.): the sidecar forwards raw
#              TCP 443 to Caddy (caddy:8443), which holds a Let's Encrypt wildcard certificate obtained by DNS-01
#              (a Caddy build with a DNS plugin: caddy/Dockerfile, compose.domain.yaml). DNS points at the
#              sidecar's Tailscale address (100.x), so only your tailnet can reach it.
#
# The local site never changes: http://PORTAL_HOST stays on 127.0.0.1. The remote site is a second set of host
# names (REMOTE_*), served by Caddy with X-Portal-Remote: 1 so the portal knows which cookie/origin to use.
# Nothing here listens on a public interface.

TS_TAG_DEFAULT="tag:bedrock-now"
REMOTE_APPS="chat admin files"

# remote_mode -> off | tailscale | domain (REMOTE_MODE in .env; blank or anything else = off)
remote_mode() {
  case "$(get_env REMOTE_MODE)" in tailscale) echo tailscale ;; domain) echo domain ;; *) echo off ;; esac
}
remote_on() { [ "$(remote_mode)" != off ]; }

# ts_base -> the Tailscale Service base label: TS_SERVICE in .env, else bedrock-now for the default project and
# bedrock-now-<project> for a second copy (so two copies never advertise the same Services).
ts_base() {
  local b p
  b="$(get_env TS_SERVICE)"
  if [ -z "$b" ]; then
    p="$(project_name)"
    if [ "$p" = "$DEFAULT_PROJECT" ]; then b=bedrock-now
    else b="bedrock-now-$(printf '%s' "$p" | tr '_' '-' | sed 's/-*$//')"; fi
  fi
  printf '%s\n' "$b"
}

# valid_ts_label NAME -> 0 for a DNS label Tailscale accepts as a Service name (we add -chat/-admin/-files, so
# the base stays <= 57 characters)
valid_ts_label() {
  case "$1" in '' | -* | *- | *[!a-z0-9-]*) return 1 ;; esac
  [ "${#1}" -le 57 ]
}

# ts_service_names -> "svc:<base> svc:<base>-chat svc:<base>-admin svc:<base>-files" (+ svc:<base>-terminal while the
# browser terminal is shared remotely: REMOTE_TERMINAL=true, lib/terminal.sh; + svc:<base>-code with the Code page)
ts_service_names() {
  local b a out; b="$(ts_base)"; out="svc:$b"
  for a in $REMOTE_APPS $(terminal_remote_app) $(code_remote_app); do out="$out svc:$b-$a"; done
  printf '%s\n' "$out"
}

# ts_node_name -> the sidecar's own tailnet machine name (must differ from the Service names: same DNS space)
ts_node_name() { local h; h="$(get_env TS_HOSTNAME)"; printf '%s\n' "${h:-$(ts_base)-node}"; }
ts_tag() { local t; t="$(get_env TS_TAG)"; printf '%s\n' "${t:-$TS_TAG_DEFAULT}"; }

# valid_ts_tag TAG -> 0 for tag:<letters, digits, dashes>
valid_ts_tag() { case "$1" in tag:[a-z0-9]*) case "${1#tag:}" in *[!a-z0-9-]*) return 1 ;; esac ;; *) return 1 ;; esac; }

# valid_tailnet NAME -> 0 for a MagicDNS suffix like tail1234.ts.net
valid_tailnet() { valid_hostname "$1" && case "$1" in ?*.ts.net) return 0 ;; esac; return 1; }

# --- the sidecar's own Docker network (REMOTE_SUBNET; compose.tailscale.yaml) ---

REMOTE_SUBNET_DEFAULT="10.255.255.248/29"

# valid_cidr NET -> 0 for an IPv4 network /24../29 with no host bits set (10.255.255.248/29 yes, …249/29 no)
valid_cidr() {
  case "$1" in *[!0-9./]* | */*/* | */ | /*) return 1 ;; */*) ;; *) return 1 ;; esac
  printf '%s' "${1%/*}" | awk -F. -v b="${1#*/}" 'NF == 4 && b ~ /^[0-9]+$/ && b + 0 >= 24 && b + 0 <= 29 {
    for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || $i + 0 > 255) exit 1
    size = 2 ^ (32 - b); if (($4 + 0) % size != 0) exit 1; exit 0 } { exit 1 }'
}

# remote_subnet -> REMOTE_SUBNET from .env, or the default
remote_subnet() { local s; s="$(get_env REMOTE_SUBNET)"; printf '%s\n' "${s:-$REMOTE_SUBNET_DEFAULT}"; }

# remote_sidecar_ip NET -> the sidecar's fixed address: the subnet's last usable host (…254 for the default). Docker
# hands out addresses from the bottom (gateway first, then Caddy), so the top one never collides — and the gateway,
# through which host processes reach the network on Linux, is not it: Caddy trusts exactly this one address.
remote_sidecar_ip() {
  printf '%s' "${1%/*}" | awk -F. -v b="${1#*/}" '{ last = $4 + 2 ^ (32 - b) - 2; printf "%d.%d.%d.%d\n", $1, $2, $3, last }'
}

# cidr_overlap A B -> 0 when two IPv4 networks overlap
cidr_overlap() {
  awk -v a="$1" -v b="$2" 'function lo(n,  p, q) { split(n, p, "/"); split(p[1], q, ".")
      return ((q[1] * 256 + q[2]) * 256 + q[3]) * 256 + q[4] }
    function hi(n,  p) { split(n, p, "/"); return lo(n) + 2 ^ (32 - p[2]) - 1 }
    BEGIN { exit !(lo(a) <= hi(b) && lo(b) <= hi(a)) }'
}

# _docker_network_subnets -> "name subnet…" per Docker network (empty when Docker does not answer)
_docker_network_subnets() {
  local ids
  ids="$(docker network ls -q 2>/dev/null || true)"
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086  # one argument per network id
  docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' $ids 2>/dev/null || true
}

# remote_net_ok -> 0 when REMOTE_SUBNET is valid and no other Docker network uses an overlapping range (this
# project's own remote network excepted); otherwise prints why, with the fix
remote_net_ok() {
  local net own name subs s
  net="$(remote_subnet)"
  valid_cidr "$net" || { printf 'REMOTE_SUBNET=%s in .env is not an IPv4 network from /24 to /29 without host bits (e.g. %s)\n' "$net" "$REMOTE_SUBNET_DEFAULT"; return 1; }
  own="$(project_name)_remote"
  while read -r name subs; do
    [ -n "$name" ] && [ "$name" != "$own" ] || continue
    for s in $subs; do
      case "$s" in *:*) continue ;; esac   # IPv6
      if cidr_overlap "$net" "$s"; then
        printf 'REMOTE_SUBNET %s overlaps Docker network %s (%s) — set REMOTE_SUBNET in .env to a free /29, e.g. 10.254.254.248/29\n' "$net" "$name" "$s"
        return 1
      fi
    done
  done <<EOF
$(_docker_network_subnets)
EOF
  return 0
}

# remote_ensure_proxy_secret — PORTAL_PROXY_SECRET of at least 32 characters (the portal ignores a shorter one,
# which would leave remote access unusable): generated when missing or too short
remote_ensure_proxy_secret() {
  local v; v="$(get_env PORTAL_PROXY_SECRET)"
  [ "${#v}" -ge 32 ] || set_env PORTAL_PROXY_SECRET "$(gen_hex 32)"
}

# remote_net_preflight — before ./stack up / setup start containers with remote access on: keeps REMOTE_SIDECAR_IP
# in line with REMOTE_SUBNET; if the network cannot be used, warns and leaves remote access out of THIS run
# (REMOTE_DEGRADED=1: no overlay, no sidecar) so the local portal still comes up.
REMOTE_DEGRADED="${REMOTE_DEGRADED:-0}"
remote_net_preflight() {
  local why
  remote_on || return 0
  if ! why="$(remote_net_ok)"; then
    warn "$why"
    warn "remote access is left out of this run (the local portal is not affected); fix it, then ./stack up"
    REMOTE_DEGRADED=1
    return 0
  fi
  [ "$(get_env REMOTE_SIDECAR_IP)" = "$(remote_sidecar_ip "$(remote_subnet)")" ] || set_env REMOTE_SIDECAR_IP "$(remote_sidecar_ip "$(remote_subnet)")"
}

# valid_login LOGIN -> 0 for a Tailscale login name (you@example.com, you@github, …): no spaces, quotes or $
valid_login() {
  case "$1" in '' | *[!A-Za-z0-9@._+-]* | @* | *@) return 1 ;; *@*) return 0 ;; esac
  return 1
}

# remote_app_host [SUB] -> the remote host name of the portal (no SUB) or of chat/admin/files
remote_app_host() {
  case "${1:-}" in
    '') get_env REMOTE_HOST ;;
    chat) get_env REMOTE_CHAT_HOST ;;
    admin) get_env REMOTE_ADMIN_HOST ;;
    files) get_env REMOTE_FILES_HOST ;;
    terminal) get_env REMOTE_TERMINAL_HOST ;;
    code) get_env REMOTE_CODE_HOST ;;
    *) return 1 ;;
  esac
  echo
}

# remote_url [SUB] -> https://<remote host> (empty when remote access is off or the name is not valid)
remote_url() {
  local h
  remote_on || return 0
  h="$(remote_app_host "${1:-}")"
  ! valid_hostname "$h" || printf 'https://%s\n' "$h"
}

# remote_set_hosts PORTAL CHAT ADMIN FILES — the remote site in .env (empty strings clear it)
remote_set_hosts() {
  set_env REMOTE_HOST "$1"; set_env REMOTE_CHAT_HOST "$2"; set_env REMOTE_ADMIN_HOST "$3"; set_env REMOTE_FILES_HOST "$4"
  if [ -n "$1" ]; then set_env REMOTE_ORIGIN "https://$1"; else set_env REMOTE_ORIGIN ""; fi
  terminal_remote_sync   # lib/terminal.sh: the terminal's remote name follows (only with REMOTE_TERMINAL=true)
  code_remote_sync       # lib/code.sh: the Code page's too (the same switch)
}
# remote_hosts_tailscale TAILNET — <base>.<tailnet>, <base>-chat.<tailnet>, … (ts.net is a public suffix, so all
# four share the "site" <tailnet>.ts.net: same-site for SameSite cookies; each cookie stays host-only).
# (ts.net is a public suffix, so <tailnet>.ts.net is the registrable "site" all four names share).
remote_hosts_tailscale() {
  local b t="$1"; b="$(ts_base)"
  remote_set_hosts "$b.$t" "$b-chat.$t" "$b-admin.$t" "$b-files.$t"
}

# remote_hosts_domain HOST — HOST plus chat./admin./files.HOST
remote_hosts_domain() {
  remote_set_hosts "$1" "chat.$1" "admin.$1" "files.$1"
}

# check_remote_domain HOST — dies unless HOST is a real name we may request a certificate for
check_remote_domain() {
  valid_hostname "$1" || die "'$1' is not a valid host name (lowercase letters, digits, dots and dashes, e.g. bedrock.example.com)"
  case "$1" in
    *.localhost | localhost) die "$1 is a .localhost name — remote access needs a domain you own (e.g. bedrock.example.com)" ;;
    *.ts.net) die "$1 is a Tailscale name — use ./stack remote enable tailscale for that" ;;
    *.*) ;;
    *) die "$1 has no dot — use a name under a domain you own (e.g. bedrock.example.com)" ;;
  esac
}

# --- Tailscale serve config (TS_SERVE_CONFIG; containerboot reads ipn.ServeConfig JSON and re-reads it when the
# --- file in tailscale/ changes; with TS_EXPERIMENTAL_SERVICE_AUTO_ADVERTISEMENT, the default since v1.96, it
# --- advertises every Service in it at start)

TS_SERVE_DIR_REL=tailscale
# (TS_SERVE_DIR overrides the folder for tests; compose always mounts ./tailscale)
ts_serve_file() { printf '%s/serve.json\n' "${TS_SERVE_DIR:-$STACK_DIR/$TS_SERVE_DIR_REL}"; }

# ts_serve_config MODE [TAILNET] -> JSON on stdout
#   tailscale: every Service terminates HTTPS on 443 (Tailscale certificate for <svc>.<tailnet>) and proxies to
#              Caddy's remote listener; Host stays <svc>.<tailnet>, Tailscale adds X-Forwarded-Proto: https and,
#              for devices owned by a user (not tagged ones), Tailscale-User-Login.
#   domain:    no Services; the node forwards TCP 443 untouched to Caddy, which terminates TLS itself.
ts_serve_config() {
  local mode="$1" t="${2:-}" b s first=1 term='' codes=''
  case "$mode" in
    tailscale)
      valid_tailnet "$t" || return 1
      b="$(ts_base)"
      [ -z "$(terminal_remote_app)" ] || term="$b-terminal"
      [ -z "$(code_remote_app)" ] || codes="$b-code"
      printf '{\n  "Services": {'
      for s in "$b" "$b-chat" "$b-admin" "$b-files" ${term:+"$term"} ${codes:+"$codes"}; do
        [ "$first" = 1 ] || printf ','
        first=0
        printf '\n    "svc:%s": {\n      "TCP": { "443": { "HTTPS": true } },\n      "Web": { "%s.%s:443": { "Handlers": { "/": { "Proxy": "http://caddy:8081" } } } }\n    }' "$s" "$s" "$t"
      done
      printf '\n  }\n}\n' ;;
    domain)
      printf '{\n  "TCP": { "443": { "TCPForward": "caddy:8443" } }\n}\n' ;;
    *) printf '{}\n' ;;
  esac
}

# write_ts_serve_config MODE [TAILNET] — atomic; mode 644 (no secrets; the sidecar reads it as another user)
write_ts_serve_config() {
  local f tmp; f="$(ts_serve_file)"
  mkdir -p "${f%/*}"; chmod a+rx "${f%/*}"
  tmp="$(mktemp "$f.XXXXXX")" || die "cannot create a temp file next to $f"
  if ! ts_serve_config "$@" > "$tmp"; then rm -f "$tmp"; die "cannot write the Tailscale serve config ($1 ${2:-})"; fi
  chmod 644 "$tmp"; mv "$tmp" "$f"
}

# normalize_ts_authkey KEY -> the value for TS_AUTHKEY. An OAuth client secret (tskey-client-…) makes ephemeral
# nodes unless told otherwise; ours must survive restarts, so ?ephemeral=false&preauthorized=true is added.
normalize_ts_authkey() {
  case "$1" in
    tskey-client-*\?*) printf '%s\n' "$1" ;;
    tskey-client-*) printf '%s?ephemeral=false&preauthorized=true\n' "$1" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# valid_ts_authkey KEY -> 0 for tskey-auth-… / tskey-client-… (optionally with ?options)
valid_ts_authkey() {
  case "$1" in tskey-auth-?* | tskey-client-?*) ;; *) return 1 ;; esac
  case "$1" in *[!A-Za-z0-9_?=\&-]*) return 1 ;; esac
}

# --- the sidecar ---

_ts() { dc exec -T tailscale tailscale "$@" 2>/dev/null; }

# ts_backend_state < `tailscale status --json` -> Running / NeedsLogin / Starting / …
ts_backend_state() { json_get BackendState; }
# ts_dns_suffix < `tailscale status --json` -> tail1234.ts.net (the MagicDNSSuffix)
ts_dns_suffix() { json_get MagicDNSSuffix; }

# ts_wait_running SECONDS -> 0 once the sidecar is logged in; prints the last BackendState on failure
TS_POLL_DELAY="${TS_POLL_DELAY:-2}"
ts_wait_running() {
  local n=0 max="$1" st=''
  while [ "$n" -lt "$max" ]; do
    st="$(_ts status --json | ts_backend_state)" || st=''
    [ "$st" != Running ] || return 0
    sleep "$TS_POLL_DELAY"; n=$((n + (TS_POLL_DELAY > 0 ? TS_POLL_DELAY : 1)))
  done
  printf '%s\n' "${st:-no answer}"
  return 1
}

# ts_ipv4 -> the sidecar's Tailscale IPv4 address (100.x.y.z), empty if unknown
ts_ipv4() { _ts ip -4 | sed -n '1p' | tr -d '\r' || true; }

# --- one-time steps in the Tailscale admin console (printed by enable / status / test) ---

# ts_policy_snippet MODE -> the tailnet policy file additions (Access controls → JSON editor), as JSON fragments
ts_policy_snippet() {
  local mode="$1" tag login src svcs s dst=''
  tag="$(ts_tag)"; login="$(get_env TAILSCALE_ALLOWED_LOGIN)"
  if [ -n "$login" ]; then src="\"$login\""; else src='"autogroup:member"'; fi
  if [ "$mode" = tailscale ]; then
    svcs="$(ts_service_names)"
    for s in $svcs; do dst="$dst${dst:+, }\"$s\""; done
    cat <<EOF
  "tagOwners": {
    "$tag": ["autogroup:admin"]
  },
  "autoApprovers": {
    "services": {
$(first=1; for s in $svcs; do [ "$first" = 1 ] || printf ',\n'; first=0; printf '      "%s": ["%s"]' "$s" "$tag"; done; printf '\n')
    }
  },
  "grants": [
    { "src": [$src], "dst": [$dst], "ip": ["443"] }
  ]
EOF
  else
    cat <<EOF
  "tagOwners": {
    "$tag": ["autogroup:admin"]
  },
  "grants": [
    { "src": [$src], "dst": ["$tag"], "ip": ["443"] }
  ]
EOF
  fi
}

# ts_admin_steps MODE — the one-time admin-console checklist (https://login.tailscale.com/admin)
ts_admin_steps() {
  local mode="$1" tag b
  tag="$(ts_tag)"; b="$(ts_base)"
  cat <<EOF
One-time steps in the Tailscale admin console (https://login.tailscale.com/admin):

  1. DNS (https://login.tailscale.com/admin/dns): MagicDNS on$([ "$mode" = tailscale ] && printf ' and HTTPS Certificates enabled').
  2. Access controls (https://login.tailscale.com/admin/acls/file): merge this into your policy file —
     it lets you tag the sidecar $tag$([ "$mode" = tailscale ] && printf ', approves its Services automatically') and lets
     $( [ -n "$(get_env TAILSCALE_ALLOWED_LOGIN)" ] && get_env TAILSCALE_ALLOWED_LOGIN || printf 'every member of your tailnet') reach it on port 443 (nothing else):

$(ts_policy_snippet "$mode")

     This grant is the ONLY access to bedrock-now only if your policy has no allow-all rule. A new tailnet's
     default policy lets every device reach every other on every port ("src": ["*"], "dst": ["*"]) — remove or
     narrow that rule, or the snippet adds access without limiting it.
  3. Keys (https://login.tailscale.com/admin/settings/keys): generate a one-off auth key — not reusable, not
     ephemeral, pre-approved, Tags: $tag, short expiry. ./stack remote enable asks for it (hidden), and once
     the sidecar is logged in removes it from .env and recreates the container, so it is gone from docker
     inspect too; the login itself lives in the tailscale-state volume. (An OAuth client secret also works —
     ./stack adds ?ephemeral=false — but it can mint further keys: revoke or rotate it after enrolment.)
EOF
  if [ "$mode" = tailscale ]; then
    cat <<EOF
  4. Services (https://login.tailscale.com/admin/services): Advertise → Define a Service, once for each
     of these names, each with port tcp:443:  $(ts_service_names | sed 's/svc://g; s/ /   /g')
     The sidecar ($(ts_node_name)) advertises them on start; with the autoApprovers above they are approved
     at once — otherwise approve it under "Service hosts" of each Service.
  5. Your devices: install Tailscale and sign in$( [ -n "$(get_env TAILSCALE_ALLOWED_LOGIN)" ] && printf ' as %s' "$(get_env TAILSCALE_ALLOWED_LOGIN)").
     Clients need v1.94+ (Linux clients up to v1.93: sudo tailscale set --accept-routes).
EOF
  else
    cat <<EOF
  4. Your devices: install Tailscale and sign in$( [ -n "$(get_env TAILSCALE_ALLOWED_LOGIN)" ] && printf ' as %s' "$(get_env TAILSCALE_ALLOWED_LOGIN)").
EOF
  fi
}

# remote_dns_records IP -> the two DNS records domain mode needs
remote_dns_records() {
  local h ip="${1:-}"
  [ -n "$ip" ] || ip='<the sidecar address: ./stack remote status>'
  h="$(get_env REMOTE_HOST)"
  printf '  %-34s A   %s\n' "$h" "$ip"
  printf '  %-34s A   %s\n' "*.$h" "$ip"
}

# --- ./stack remote ---

remote_usage() {
  cat <<'EOF'
Usage: ./stack remote <command>

  status                 Remote access: mode, URLs, the Tailscale sidecar and the identity check
  enable tailscale       Reach the portal from your devices through Tailscale Services (HTTPS, *.ts.net)
  enable domain HOST     … under your own name (HOST=bedrock.example.com; Cloudflare DNS, wildcard certificate)
  disable                Back to this computer only (the sidecar stops; its login is kept)
  test                   Checks what can be checked from here, then a checklist for your phone/laptop

  Non-interactive (--yes): TS_AUTHKEY, TAILSCALE_ALLOWED_LOGIN, CLOUDFLARE_API_TOKEN from the environment.
  Details, the admin-console steps and the caveats: docs/remote.md
EOF
}

cmd_remote() {
  local sub="${1:-status}"; [ $# -eq 0 ] || shift
  case "$sub" in
    status) remote_status ;;
    enable)
      case "${1:-}" in
        tailscale) [ $# -eq 1 ] || die "usage: ./stack remote enable tailscale"; remote_enable tailscale ;;
        domain) [ -n "${2:-}" ] && [ $# -eq 2 ] || die "usage: ./stack remote enable domain bedrock.example.com"; remote_enable domain "$2" ;;
        *) remote_usage >&2; die "usage: ./stack remote enable tailscale | enable domain HOST" ;;
      esac ;;
    disable) remote_disable ;;
    test) remote_test ;;
    help | -h | --help) remote_usage ;;
    *) remote_usage >&2; die "unknown: ./stack remote $sub" ;;
  esac
}

# _remote_secret VAR PROMPT -> value from the shell environment, else .env, else a hidden prompt
_remote_secret() {
  local var="$1" v
  v="${!var:-}"
  [ -n "$v" ] || v="$(get_env "$var")"
  if [ -z "$v" ] && [ "${ASSUME_YES:-0}" != 1 ] && _have_tty; then v="$(ask_secret "$2")"; fi
  printf '%s\n' "$v"
}

# remote_ask_login — TAILSCALE_ALLOWED_LOGIN: shell env, else asked (default: the value in .env); blank = any
# member of the tailnet, password only
remote_ask_login() {
  local cur v
  cur="$(get_env TAILSCALE_ALLOWED_LOGIN)"
  v="${TAILSCALE_ALLOWED_LOGIN:-}"
  [ -n "$v" ] || v="$(ask "Your Tailscale login — only it may use the portal remotely (blank: anyone in your tailnet, password only)" "$cur")"
  v="$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')"
  [ -z "$v" ] || valid_login "$v" || die "'$v' does not look like a Tailscale login (e.g. you@example.com or you@github)"
  set_env TAILSCALE_ALLOWED_LOGIN "$v"
}

# remote_enable MODE [HOST]
remote_enable() {
  local mode="$1" host="${2:-}" key token st suffix tag ip ts_oauth why
  [ -f "$ENV_FILE" ] && [ -n "$(get_env PORTAL_SECRET)" ] || die "run ./stack setup first"
  stack_lock remote   # lib/lock.sh (already ours when setup calls this)
  check_prereqs
  [ "$mode" != domain ] || check_remote_domain "$host"
  tag="$(ts_tag)"; valid_ts_tag "$tag" || die "TS_TAG=$tag in .env is not a tag (e.g. tag:bedrock-now)"
  valid_ts_label "$(ts_base)" || die "TS_SERVICE=$(ts_base) is not a valid Service name (lowercase letters, digits, dashes; at most 57)"
  why="$(remote_net_ok)" || die "$why"
  set_env REMOTE_SIDECAR_IP "$(remote_sidecar_ip "$(remote_subnet)")"
  remote_ask_login
  remote_ensure_proxy_secret   # Caddy → portal: only Caddy may mark requests remote
  if [ "$mode" = domain ]; then
    token="$(_remote_secret CLOUDFLARE_API_TOKEN "Cloudflare API token (Zone:Read + DNS:Edit, for the zone of $host only; hidden)")"
    [ -n "$token" ] || die "domain mode needs CLOUDFLARE_API_TOKEN (a Cloudflare API token with Zone → Zone → Read and Zone → DNS → Edit, limited to that one zone) — see docs/remote.md"
    set_env CLOUDFLARE_API_TOKEN "$token"
  fi
  key="$(_remote_secret TS_AUTHKEY "Tailscale auth key (tskey-auth-… or OAuth tskey-client-…; hidden; blank if the sidecar is already logged in)")"
  if [ -n "$key" ]; then
    valid_ts_authkey "$key" || die "that is not a Tailscale auth key (tskey-auth-… or tskey-client-…)"
    set_env TS_AUTHKEY "$(normalize_ts_authkey "$key")"
  fi
  set_env TS_TAG "$tag"
  set_env TS_HOSTNAME "$(ts_node_name)"
  set_env REMOTE_MODE "$mode"
  # The tailscale names need the tailnet's DNS name, which the sidecar tells us once it is logged in.
  if [ "$mode" = domain ]; then remote_hosts_domain "$host"; write_ts_serve_config domain
  elif valid_tailnet "$(get_env TS_TAILNET)"; then remote_hosts_tailscale "$(get_env TS_TAILNET)"; write_ts_serve_config tailscale "$(get_env TS_TAILNET)"
  else remote_set_hosts "" "" "" ""; write_ts_serve_config off; fi
  if [ "$mode" = domain ]; then run_phase "Caddy with the DNS plugin (build)" caddy dc build -q caddy; fi
  run_phase "Tailscale sidecar (start)" tailscale dc up -d tailscale
  log "waiting for the sidecar to log in to your tailnet…"
  if ! st="$(ts_wait_running 90)"; then
    warn "the sidecar did not log in (state: $st)"
    ts_admin_steps "$mode" >&2
    die "no Tailscale login — check the auth key (step 3 above; ./stack logs tailscale), then re-run ./stack remote enable $mode${host:+ $host}. Remote access stays configured but unreachable until then; ./stack remote disable undoes it."
  fi
  if [ -n "$(get_env TS_AUTHKEY)" ]; then
    # Logged in: the node key lives in the tailscale-state volume. Drop the auth key from .env AND from the
    # container's environment (docker inspect), by recreating it without one.
    case "$(get_env TS_AUTHKEY)" in tskey-client-*) ts_oauth=1 ;; *) ts_oauth=0 ;; esac
    unset_env TS_AUTHKEY
    run_phase "Tailscale sidecar (without the auth key)" tailscale dc up -d --no-deps --force-recreate tailscale
    [ "$ts_oauth" = 0 ] || warn "you enrolled with an OAuth client secret: it can create more auth keys — revoke or rotate it in the admin console (Settings → OAuth clients) now that the sidecar is logged in"
  fi
  if [ "$mode" = tailscale ]; then
    suffix="$(_ts status --json | ts_dns_suffix)"
    suffix="${suffix%.}"
    valid_tailnet "$suffix" || suffix="$(get_env TS_TAILNET)"
    valid_tailnet "$suffix" || die "could not read your tailnet's DNS name from the sidecar — set TS_TAILNET=<tailnet>.ts.net in .env and re-run"
    set_env TS_TAILNET "$suffix"
    remote_hosts_tailscale "$suffix"
    write_ts_serve_config tailscale "$suffix"
  fi
  remote_restart_front
  remote_status
  printf '\n'; ts_admin_steps "$mode"
  if [ "$mode" = domain ]; then
    ip="$(ts_ipv4)"
    printf '\nDNS at your provider (only these two records; 100.x addresses are reachable only inside your tailnet):\n\n'
    remote_dns_records "$ip"
    printf '\nCaddy asks Let'"'"'s Encrypt for the certificates in the background (DNS-01, a minute or two):\n./stack logs caddy\n'
  fi
  remote_login_warning
  printf '\nThen: ./stack remote test\n'
}

# remote_login_warning — Tailscale mode without TAILSCALE_ALLOWED_LOGIN: say loudly what that means
remote_login_warning() {
  [ "$(remote_mode)" = tailscale ] && [ -z "$(get_env TAILSCALE_ALLOWED_LOGIN)" ] || return 0
  warn "TAILSCALE_ALLOWED_LOGIN is blank: ANY device your tailnet policy lets reach the Services gets the login page, and the portal password is the only thing left — set your login (./stack remote enable tailscale asks for it) unless you really want that"
}

# remote_restart_front — portal, Open WebUI and Caddy read the remote settings at start
remote_restart_front() {
  run_phase "Portal + Chat + Caddy (remote settings)" "portal open-webui caddy" _remote_up_front
}
_remote_up_front() { ensure_portal_password_hash && dc up -d --wait portal open-webui && dc up -d --wait --force-recreate caddy; }

remote_disable() {
  local mode
  [ -f "$ENV_FILE" ] || die "run ./stack setup first"
  mode="$(remote_mode)"
  if [ "$mode" = off ]; then log "remote access is already off"; return 0; fi
  stack_lock remote
  check_prereqs
  dc rm -sf tailscale >/dev/null 2>&1 || true   # still with the overlay: compose knows the service
  set_env REMOTE_MODE off
  remote_set_hosts "" "" "" ""   # also empties Open WebUI's WEBUI_URL (derived from REMOTE_CHAT_HOST)
  unset_env TS_AUTHKEY
  remote_restart_front
  log "remote access is off; the portal is only on $(portal_url) again"
  log "the sidecar's login is kept (volume tailscale-state) for a later ./stack remote enable; to forget it: remove the device $(ts_node_name) in the Tailscale admin console and run docker volume rm $(project_name)_tailscale-state"
  [ "$mode" != domain ] || log "you can delete the two DNS records for your remote name and its wildcard, and revoke the Cloudflare token (CLOUDFLARE_API_TOKEN in .env)"
}

# remote_identity_text -> how remote requests are tied to your Tailscale login (for status)
remote_identity_text() {
  local login seen
  login="$(get_env TAILSCALE_ALLOWED_LOGIN)"
  if [ "$(remote_mode)" = domain ]; then
    echo "password only (own-domain mode: TLS ends at Caddy, so Tailscale cannot pass your login; the tailnet grant limits who can connect)"
    return 0
  fi
  if [ -z "$login" ]; then
    echo "!! password only — TAILSCALE_ALLOWED_LOGIN is blank, so any device your tailnet policy lets in gets the login page"
    return 0
  fi
  seen="$(dc exec -T portal cat /state/remote-identity 2>/dev/null | head -n 1 | tr -d '\r' || true)"
  case "$seen" in
    present*) echo "Tailscale login $login AND the portal password; sessions are bound to it (Tailscale sent Tailscale-User-Login on remote requests, ${seen#present })" ;;
    absent*) echo "Tailscale login $login required — but remote requests (${seen#absent }) carried no Tailscale-User-Login and were REFUSED (Tailscale sends none from tagged devices; sign in to Tailscale as $login on that device)" ;;
    *) echo "Tailscale login $login required (Tailscale-User-Login, sent for devices signed in as a user; tagged devices are refused) AND the portal password — no remote request seen yet" ;;
  esac
}

remote_status() {
  local mode st sj ip s
  mode="$(remote_mode)"
  if [ "$mode" = off ]; then
    printf 'Remote access: off — the portal is only on this computer: %s\n' "$(portal_url)"
    printf '  To reach it from your phone/laptop: ./stack remote enable tailscale   (docs/remote.md)\n'
    return 0
  fi
  printf 'Remote access: %s\n' "$mode"
  if [ -z "$(get_env REMOTE_HOST)" ]; then
    printf '  not finished — the sidecar has not logged in yet: ./stack remote enable %s\n' "$mode"
  else
    printf '  Portal   %s\n' "$(remote_url)"
    for s in $REMOTE_APPS $(terminal_remote_app) $(code_remote_app); do printf '  %-8s %s\n' "$s" "$(remote_url "$s")"; done
  fi
  printf '  Local    %s (unchanged)\n' "$(portal_url)"
  sj="$(_ts status --json || true)"
  st="$(printf '%s' "$sj" | ts_backend_state)"
  if [ -z "$st" ]; then
    printf '  Sidecar  not running — ./stack up (or ./stack logs tailscale)\n'
  else
    ip="$(ts_ipv4)"
    printf '  Sidecar  %s (%s)%s\n' "$st" "$(ts_node_name)" "${ip:+, $ip}"
    [ "$st" != NeedsLogin ] || printf '           !! not logged in: ./stack remote enable %s with an auth key (admin-console step 3)\n' "$mode"
    case "$sj" in *"\"$(ts_tag)\""*) ;; *) [ "$st" != Running ] || printf '           !! not tagged %s — Tailscale Services need a tagged host (admin-console step 3)\n' "$(ts_tag)" ;; esac
  fi
  [ "$mode" != tailscale ] || printf '  Services %s\n' "$(ts_service_names)"
  printf '  Identity %s\n' "$(remote_identity_text)"
}

# _yes_if_contains TEXT NEEDLE -> yes / no
_yes_if_contains() { case "$1" in *"$2"*) echo yes ;; *) echo no ;; esac; }

# _caddy_remote_get FROM HOST PATH [HEADER] -> "status|location" of GET http://caddy:8081PATH (Host: HOST) sent
# from inside the FROM container: tailscale = where the sidecar's requests come from; caddy = any other container
# (Caddy's own 127.0.0.1 is outside REMOTE_SUBNET). "000|" when the connection was cut off.
_caddy_remote_get() {
  local from="$1" out code loc url=http://caddy:8081
  [ "$from" != caddy ] || url=http://127.0.0.1:8081
  out="$(dc exec -T "$from" wget -S -O /dev/null -T 10 --header "Host: $2" --header "Accept: text/html" \
    ${4:+--header "$4"} "$url$3" 2>&1 || true)"
  code="$(printf '%s\n' "$out" | awk '!f && /^  HTTP\// { print $2; f = 1 }')"
  loc="$(printf '%s\n' "$out" | awk '!f && tolower($1) == "location:" { print $2; f = 1 }' | tr -d '\r')"
  printf '%s|%s\n' "${code:-000}" "$loc"
}

remote_test() {
  local mode fails=0 want got sj st h login id
  mode="$(remote_mode)"
  [ "$mode" != off ] || die "remote access is off — ./stack remote enable tailscale first"
  remote_login_warning
  printf 'Checks from this computer:\n'
  sj="$(_ts status --json || true)"; st="$(printf '%s' "$sj" | ts_backend_state)"
  _check "sidecar logged in" "$st" Running
  got="$(_yes_if_contains "$sj" "\"$(ts_tag)\"")"
  _check "sidecar tagged $(ts_tag)" "$got" yes
  want="$(ts_serve_config "$mode" "$(get_env TS_TAILNET)" 2>/dev/null || true)"
  _check "serve config up to date ($TS_SERVE_DIR_REL/serve.json)" "$([ "$want" = "$(cat "$(ts_serve_file)" 2>/dev/null)" ] && echo yes || echo no)" yes
  if [ "$mode" = tailscale ]; then
    got="$(_ts serve status --json || true)"
    for h in $(ts_service_names); do
      _check "sidecar serves $h" "$(_yes_if_contains "$got" "\"$h\"")" yes
    done
    h="$(get_env REMOTE_HOST)"
    login="$(get_env TAILSCALE_ALLOWED_LOGIN)"
    id="${login:+Tailscale-User-Login: $login}"
    _check "remote login page via the sidecar's network ($h)" "$(_caddy_remote_get tailscale "$h" /login "$id" | cut -d'|' -f1)" 200
    got="$(_caddy_remote_get tailscale "$(get_env REMOTE_CHAT_HOST)" / "$id")"
    _check "remote chat without a session → hand-off on the portal host" "${got%%\?*}" "302|https://$h/auth/handoff"
    _check "unknown remote host refused" "$(_caddy_remote_get tailscale nope.invalid / | cut -d'|' -f1)" 404
    _check "remote listener refuses other containers" "$(_caddy_remote_get caddy "$h" /login | cut -d'|' -f1)" 000
    if [ -n "$login" ]; then
      _check "no Tailscale login → refused" "$(_caddy_remote_get tailscale "$h" /login | cut -d'|' -f1)" 403
      _check "another Tailscale login → refused" \
        "$(_caddy_remote_get tailscale "$h" /login "Tailscale-User-Login: someone-else@example.invalid" | cut -d'|' -f1)" 403
    else
      _skip "Tailscale login check" "TAILSCALE_ALLOWED_LOGIN is blank"
    fi
  else
    h="$(get_env REMOTE_HOST)"
    got="$(dc exec -T caddy find /data/caddy/certificates -name '*.crt' 2>/dev/null || true)"
    _check "certificate for $h" "$(_yes_if_contains "$got" "/$h.crt")" yes
    _check "wildcard certificate for *.$h" "$(_yes_if_contains "$got" "/wildcard_.$h.crt")" yes
    _check "sidecar forwards 443 to Caddy" "$(_yes_if_contains "$(_ts serve status --json || true)" 'caddy:8443')" yes
  fi
  cat <<EOF

Then, from your phone or laptop (Tailscale on, signed in$( [ -n "$(get_env TAILSCALE_ALLOWED_LOGIN)" ] && printf ' as %s' "$(get_env TAILSCALE_ALLOWED_LOGIN)")):

  [ ] open $(remote_url) — a padlock (valid certificate), the bedrock-now login page
  [ ] sign in with PORTAL_PASSWORD — Home loads; Chat, Admin and Files open in their tabs
  [ ] Chat answers a short question
  [ ] ./stack remote status → "Identity" names your login (Tailscale-User-Login was sent)
  [ ] a device that is NOT allowed (another tailnet user, or Tailscale off) gets no answer or "not your login"
EOF
  [ "$mode" != domain ] || printf '  [ ] the certificate is for %s / *.%s (Let'"'"'s Encrypt)\n' "$(get_env REMOTE_HOST)" "$(get_env REMOTE_HOST)"
  [ "$fails" -eq 0 ] || die "$fails check(s) failed — ./stack remote status, ./stack logs tailscale, ./stack logs caddy"
}

# --- hooks used by setup / up / status / summary ---

# remote_up_hook — after ./stack up / setup / restore brought up the stack itself: the serve config in line with
# .env, then the sidecar started WITHOUT waiting for it (the stack never depends on Tailscale being reachable);
# a short look whether it logged in, and a warning if not (details: ./stack remote status).
REMOTE_UP_WAIT="${REMOTE_UP_WAIT:-20}"
remote_up_hook() {
  local mode st; mode="$(remote_mode)"
  [ "$mode" != off ] || return 0
  [ "$REMOTE_DEGRADED" != 1 ] || return 0   # remote_net_preflight already said why
  if [ "$mode" = tailscale ] && valid_tailnet "$(get_env TS_TAILNET)"; then write_ts_serve_config tailscale "$(get_env TS_TAILNET)"
  elif [ "$mode" = domain ]; then write_ts_serve_config domain; fi
  dc up -d --no-deps tailscale >/dev/null 2>&1 || { warn "could not start the Tailscale sidecar — remote access is down (./stack logs tailscale); the local portal is fine"; return 0; }
  if st="$(ts_wait_running "$REMOTE_UP_WAIT")"; then log "remote access: $(remote_url)"
  else warn "the Tailscale sidecar is not logged in yet (state: $st) — remote access is down until it is (./stack remote status); the local portal is fine"; fi
  remote_login_warning
}

# setup_remote_choice — setup asks once (REMOTE_MODE blank in .env, as .env.example has it): this computer only (default), or your
# devices too. Sets SETUP_REMOTE_MODE for the end of setup.
# shellcheck disable=SC2034  # read by cmd_setup (lib/commands.sh)
SETUP_REMOTE_MODE=""
# shellcheck disable=SC2034  # SETUP_REMOTE_MODE is read by cmd_setup
setup_remote_choice() {
  local a
  SETUP_REMOTE_MODE=''
  [ -z "$(get_env REMOTE_MODE)" ] || return 0   # asked before: off, or a mode
  if [ "${ASSUME_YES:-0}" = 1 ] || ! _have_tty; then set_env REMOTE_MODE off; return 0; fi
  a="$(ask "Use the portal only on this computer, or also from your phone/laptop through Tailscale? [local/tailscale]" local)"
  case "$a" in
    t* | T*) SETUP_REMOTE_MODE=tailscale; log "remote access through Tailscale is set up at the end (./stack remote enable tailscale)" ;;
    *) set_env REMOTE_MODE off; log "local only (./stack remote enable tailscale adds your devices later)" ;;
  esac
}

# remote_summary_line — for print_summary / status: the remote URL, or nothing
remote_summary_line() {
  remote_on || return 0
  if [ -n "$(get_env REMOTE_HOST)" ]; then
    printf '  Remote          %s   (%s; your devices; ./stack remote status)\n' "$(remote_url)" "$(remote_mode)"
  else
    printf '  Remote          not finished — ./stack remote enable %s\n' "$(remote_mode)"
  fi
}
