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
_listen() { # start a listener on 127.0.0.1:$1, echo its pid
  # stdout/stderr redirected so the background job doesn't hold the caller's $(...) open.
  if command -v python3 >/dev/null; then
    python3 -c 'import socket,sys,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(); time.sleep(30)' "$1" >/dev/null 2>&1 &
  else # BusyBox nc (e.g. the bash:5.2 image): persistent listener
    nc -lk -p "$1" -s 127.0.0.1 -e cat >/dev/null 2>&1 &
  fi
  echo $!
}
_wait_listening() { for _ in 1 2 3 4 5 6 7 8 9 10; do port_in_use "$1" && return 0; sleep 0.3; done; return 1; }
# Fake compose for resolve_port: our stack holds no ports.
dc() { return 1; }

test_free_port_is_not_in_use() {
  p="$(next_free_port 41000)"
  if port_in_use "$p"; then return 1; fi
}

test_listening_port_is_in_use() {
  _skip_unless_can_listen || return
  p="$(next_free_port 41100)"; pid="$(_listen "$p")"
  if _wait_listening "$p"; then rc=0; else rc=1; fi
  kill "$pid"
  [ "$rc" -eq 0 ]
}

test_next_free_port_skips_used() {
  _skip_unless_can_listen || return
  p="$(next_free_port 41200)"; pid="$(_listen "$p")"
  _wait_listening "$p" || true
  n="$(next_free_port "$p")" || n=0
  kill "$pid"
  [ "$n" -gt "$p" ]
}

test_dev_tcp_fallback_detects_listener() {
  _skip_unless_can_listen || return
  lsof() { return 1; }; ss() { return 1; }   # force the /dev/tcp path
  p="$(next_free_port 41300)"; pid="$(_listen "$p")"
  if _wait_listening "$p"; then rc=0; else rc=1; fi
  kill "$pid"
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
