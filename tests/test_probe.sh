# shellcheck shell=bash
_body() { printf '%s' "$1" > "$TMP/body"; echo "$TMP/body"; }
verdict() { classify_probe "$@" | cut -f1; }
reason() { classify_probe "$@" | cut -f2; }

test_litellm_200_is_enabled() {
  assert_eq "$(verdict litellm 200 "$(_body '{"choices":[]}')")" "ENABLED"
  assert_eq "$(reason litellm 200 "$(_body '{}')")" "ok"
}
test_litellm_marketplace_denial_is_disabled_with_it_hint() {
  b="$(_body '{"error":{"message":"litellm.BadRequestError: BedrockException - {\"message\":\"Model access is denied due to IAM user or service role is not authorized to perform the required AWS Marketplace actions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe) to enable access to this model.\"}","code":"400"}}')"
  assert_eq "$(verdict litellm 400 "$b")" "DISABLED"
  assert_contains "$(reason litellm 400 "$b")" "ask your AWS admin"
}
test_litellm_on_demand_unsupported_is_disabled() {
  b="$(_body '{"error":{"message":"BedrockException - Invocation of model ID x with on-demand throughput isn'"'"'t supported.","code":"400"}}')"
  assert_eq "$(verdict litellm 400 "$b")" "DISABLED"
  assert_contains "$(reason litellm 400 "$b")" "inference profile"
}
test_litellm_throttled_is_enabled_and_explained() {
  b="$(_body '{"error":{"message":"ThrottlingException: Too many requests"}}')"
  assert_eq "$(verdict litellm 429 "$b")" "ENABLED"
  assert_contains "$(reason litellm 429 "$b")" "throttled"
}
test_litellm_server_error_is_enabled_and_explained() {
  b="$(_body '{"error":{"message":"ServiceUnavailableException"}}')"
  assert_eq "$(verdict litellm 503 "$b")" "ENABLED"
  assert_contains "$(reason litellm 503 "$b")" "HTTP 503"
}
test_litellm_timeout_is_enabled_and_explained() {
  assert_eq "$(verdict litellm 000 "$(_body '')")" "ENABLED"
  assert_contains "$(reason litellm 000 "$(_body '')")" "no response"
}
test_litellm_missing_body_file_is_enabled_and_explained() {
  # Called directly (not in $(...)/a pipe) so set -e applies, as it does inside ./stack.
  classify_probe litellm 000 "$TMP/does-not-exist" > "$TMP/out"
  assert_eq "$(cut -f1 "$TMP/out")" "ENABLED"
  assert_contains "$(cut -f2 "$TMP/out")" "no response"
}
test_litellm_unexpected_4xx_is_enabled_with_excerpt() {
  b="$(_body '{"error":{"message":"some new error text"}}')"
  assert_eq "$(verdict litellm 400 "$b")" "ENABLED"
  assert_contains "$(reason litellm 400 "$b")" "some new error text"
}
test_bedrock_validation_exception_is_enabled() {
  b="$(_body 'An error occurred (ValidationException) when calling the InvokeModel operation: Malformed input request')"
  assert_eq "$(verdict bedrock 254 "$b")" "ENABLED"
}
test_bedrock_access_denied_is_disabled() {
  b="$(_body 'An error occurred (AccessDeniedException) when calling the InvokeModel operation: denied')"
  assert_eq "$(verdict bedrock 254 "$b")" "DISABLED"
}
test_bedrock_not_found_is_disabled() {
  b="$(_body 'An error occurred (ResourceNotFoundException) when calling the InvokeModel operation: This model version has reached the end of its life. Legacy model')"
  assert_eq "$(verdict bedrock 254 "$b")" "DISABLED"
  assert_contains "$(reason bedrock 254 "$b")" "not available"
}
test_reason_has_no_tabs_or_newlines() {
  b="$(_body "$(printf 'line1\n\tline2')")"
  r="$(reason litellm 400 "$b")"
  assert_not_contains "$r" "$(printf '\t')"
  assert_eq "$(classify_probe litellm 400 "$b" | wc -l | tr -d ' ')" "1"
}

test_not_found_reason_without_region_set() {
  b="$(_body 'ResourceNotFoundException')"
  assert_contains "$(reason bedrock 254 "$b")" "not available in this region"
  set_env AWS_REGION_NAME eu-west-1
  assert_contains "$(reason bedrock 254 "$b")" "not available in eu-west-1"
}

test_not_found_reason_names_probed_region() {
  set_env AWS_REGION_NAME us-east-1
  b="$(_body 'ResourceNotFoundException')"
  assert_contains "$(classify_probe bedrock 254 "$b" us-west-2 | cut -f2)" "not available in us-west-2"
}
