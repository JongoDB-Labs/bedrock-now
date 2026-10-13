# shellcheck shell=bash
# The suite never reaches the real machine: tests/run.sh puts tests/shims first on PATH, so docker, aws and
# tailscale refuse (exit 97, logged) and curl refuses this computer except the closed port 9. Run with a private
# log here, so these deliberate calls don't trip the suite's isolation guard.

test_docker_aws_tailscale_are_shims_that_refuse_and_log() {
  local c
  for c in docker aws tailscale; do
    assert_eq "$(command -v "$c")" "$STACK_DIR/tests/shims/$c"
    if BN_SHIM_LOG="$TMP/log" "$c" compose -p bedrock-now ps 2>/dev/null; then return 1; fi
    BN_SHIM_LOG="$TMP/log" "$c" x 2>/dev/null || assert_eq "$?" 97
  done
  assert_contains "$(cat "$TMP/log")" "real docker called by test test_docker_aws_tailscale_are_shims_that_refuse_and_log: compose -p bedrock-now ps"
  assert_contains "$(cat "$TMP/log")" "real tailscale called"
}

test_curl_never_reaches_this_computer() {
  local u
  for u in http://127.0.0.1:4000/key/info http://bedrock-now.localhost/login http://127.0.0.1:8765/mcp; do
    BN_SHIM_LOG="$TMP/log" curl -s -m 2 "$u" 2>/dev/null && return 1
    BN_SHIM_LOG="$TMP/log" curl -s -m 2 "$u" 2>/dev/null || assert_eq "$?" 97
  done
  BN_SHIM_LOG="$TMP/log" curl -s -m 2 --resolve chat.bedrock-now.localhost:80:127.0.0.1 http://example.invalid/ 2>/dev/null || assert_eq "$?" 97
  assert_eq "$(grep -c 'real curl to this computer' "$TMP/log" | tr -d ' ')" 7
  # the closed port 9 is real curl (connection refused, not the shim)
  BN_SHIM_LOG="$TMP/log" curl -s -m 2 http://127.0.0.1:9/ 2>/dev/null || [ "$?" != 97 ]
  assert_eq "$(grep -c 'real curl' "$TMP/log" | tr -d ' ')" 7
}
