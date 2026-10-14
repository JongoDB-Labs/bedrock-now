# shellcheck shell=bash
# Test helper only (the stack itself proposes ports in resolve_port).
next_free_port() { # next_free_port START -> first free port in [START, START+100)
  local p="$1" end=$(($1 + 100))
  while [ "$p" -lt "$end" ]; do
    port_in_use "$p" || { echo "$p"; return 0; }
    p=$((p + 1))
  done
  return 1
}
_can_listen() {
  command -v python3 >/dev/null && return 0
  # Not `nc --help | grep -q`: grep exits early, nc gets SIGPIPE, and pipefail reports 141.
  case "$(nc --help 2>&1 || true)" in *BusyBox*) return 0 ;; esac
  return 1
}
_skip_unless_can_listen() {
  _can_listen && return 0
  echo "skip: no python3 or BusyBox nc to open a listener" >&2
  return 77
}
_listen() { # start a listener on 127.0.0.1:$1, echo its pid (python3: it creates $TMP/listening.$1 once it listens)
  # stdout/stderr redirected so the background job doesn't hold the caller's $(...) open.
  if command -v python3 >/dev/null; then
    python3 -c 'import socket,sys,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(); open(sys.argv[2], "w").close(); time.sleep(120)' "$1" "$TMP/listening.$1" >/dev/null 2>&1 &
  else # BusyBox nc (e.g. the bash:5.2 image): persistent listener
    nc -lk -p "$1" -s 127.0.0.1 -e cat >/dev/null 2>&1 &
  fi
  echo $!
}
# _listen_free START — our own listener on a free port from START: sets LPORT and LPID. Another program, or another
# copy of this suite running at the same time, can take the port between next_free_port and the bind: then ours
# dies and the next port is tried. It listens within a second; up to 20 s on a busy machine. (BusyBox nc leaves no
# marker: there the port itself is watched, as before.)
_listen_free() {
  local start="$1" tries=0 i
  while [ "$tries" -lt 10 ]; do
    LPORT="$(next_free_port "$start")" || return 1
    LPID="$(_listen "$LPORT")"
    i=0
    while kill -0 "$LPID" 2>/dev/null && [ "$i" -lt 100 ]; do
      if command -v python3 >/dev/null; then [ ! -f "$TMP/listening.$LPORT" ] || return 0
      elif port_in_use "$LPORT"; then return 0; fi
      sleep 0.2; i=$((i + 1))
    done
    kill "$LPID" 2>/dev/null || true
    start=$((LPORT + 1)); tries=$((tries + 1))
  done
  return 1
}
# Fake compose for resolve_port: our stack holds no ports.
dc() { return 1; }

test_free_port_is_not_in_use() {
  p="$(next_free_port 41000)"
  if port_in_use "$p"; then return 1; fi
}

test_listening_port_is_in_use() {
  _skip_unless_can_listen || return
  _listen_free 41100 || { echo "no listener came up" >&2; return 1; }
  if port_in_use "$LPORT"; then rc=0; else rc=1; fi
  kill "$LPID"
  [ "$rc" -eq 0 ]
}

test_next_free_port_skips_used() {
  _skip_unless_can_listen || return
  _listen_free 41200 || { echo "no listener came up" >&2; return 1; }
  n="$(next_free_port "$LPORT")" || n=0
  kill "$LPID"
  [ "$n" -gt "$LPORT" ]
}

test_dev_tcp_fallback_detects_listener() {
  _skip_unless_can_listen || return
  lsof() { return 1; }; ss() { return 1; }   # force the /dev/tcp path
  _listen_free 41300 || { echo "no listener came up" >&2; return 1; }
  if port_in_use "$LPORT"; then rc=0; else rc=1; fi
  kill "$LPID"
  [ "$rc" -eq 0 ]
}

test_resolve_port_keeps_free_default() {
  p="$(next_free_port 41400)"
  ASSUME_YES=1 resolve_port A_PORT "$p" svc 80
  assert_eq "$(get_env A_PORT)" "$p"
}

test_resolve_port_moves_off_port_owned_by_other_key() {
  p="$(next_free_port 41500)"
  set_env LITELLM_PORT "$p"
  ASSUME_YES=1 resolve_port WEBUI_PORT "$p" svc 8080
  w="$(get_env WEBUI_PORT)"
  [ "$w" != "$p" ] || { echo "WEBUI_PORT reused $p" >&2; return 1; }
  if port_in_use "$w"; then return 1; fi
}

test_resolve_port_rejects_out_of_range() {
  set_env A_PORT 80
  if ( ASSUME_YES=1 resolve_port A_PORT 4000 svc 4000 ) 2>"$TMP/err"; then return 1; fi
  assert_contains "$(cat "$TMP/err")" "1024"
  set_env A_PORT 70000
  if ( ASSUME_YES=1 resolve_port A_PORT 4000 svc 4000 ) 2>"$TMP/err"; then return 1; fi
  assert_contains "$(cat "$TMP/err")" "65535"
}
