#!/usr/bin/env bash
# Summary table + JUnit XML for tests/e2e/run.sh.
# report.sh RESULTS.tsv KNOWN_ISSUES.tsv OUT_DIR SECONDS SPEND
# RESULTS: suite<TAB>id<TAB>PASS|FAIL|SKIP<TAB>seconds<TAB>message. KNOWN_ISSUES: id<TAB>reason (# comments):
# a listed check that fails counts as XFAIL (a known product bug, not a suite failure); one that passes is XPASS
# (the bug is fixed: drop the line). Exit status: 1 if any check FAILed or there are no results at all, else 0.
set -uo pipefail
results="$1"; known="$2"; out="$3"; secs="$4"; spend="$5"
[ -s "$results" ] || { printf 'xx  no results in %s — the run did not get as far as its first check\n' "$results" >&2; exit 1; }
[ -f "$known" ] || known=/dev/null

final="$out/results-final.tsv"
awk -F'\t' -v OFS='\t' '
  FILENAME == ARGV[1] { if ($0 !~ /^#/ && NF >= 2) why[$1] = $2; next }
  NF >= 3 {
    st = $3; msg = $5
    if ($2 in why) { if (st == "FAIL") { st = "XFAIL"; msg = "known issue: " why[$2] " | " msg } else if (st == "PASS") { st = "XPASS"; msg = "listed as a known issue but passed: " why[$2] } }
    print $1, $2, st, $4, msg
  }' "$known" "$results" > "$final"

printf '\n%-9s %-44s %-6s %5s  %s\n' SUITE CHECK RESULT SECS DETAIL
awk -F'\t' '{ d = $5; if (length(d) > 110) d = substr(d, 1, 107) "..."; printf "%-9s %-44s %-6s %5s  %s\n", $1, substr($2, 1, 44), $3, $4, d }' "$final"
pass="$(awk -F'\t' '$3 == "PASS"' "$final" | wc -l | tr -d ' ')"
fail="$(awk -F'\t' '$3 == "FAIL"' "$final" | wc -l | tr -d ' ')"
skip="$(awk -F'\t' '$3 == "SKIP"' "$final" | wc -l | tr -d ' ')"
xfail="$(awk -F'\t' '$3 == "XFAIL"' "$final" | wc -l | tr -d ' ')"
xpass="$(awk -F'\t' '$3 == "XPASS"' "$final" | wc -l | tr -d ' ')"
total=$((pass + fail + skip + xfail + xpass))
printf '\n%s checks: %s passed, %s failed, %s known issues (xfail), %s xpass, %s skipped — %ss, Bedrock spend $%s\n' \
  "$total" "$pass" "$fail" "$xfail" "$xpass" "$skip" "$secs" "$spend"
printf 'Details: %s (logs in %s/logs, screenshots and network logs in %s/browser)\n' "$final" "$out" "$out"

# JUnit: one <testsuite> per suite; XFAIL = skipped with a message (known bug), FAIL = failure.
awk -F'\t' -v secs="$secs" '
  function x(s) { gsub(/&/, "\\&amp;", s); gsub(/</, "\\&lt;", s); gsub(/>/, "\\&gt;", s); gsub(/"/, "\\&quot;", s); return s }
  { n[$1]++; if ($3 == "FAIL") f[$1]++; if ($3 == "SKIP" || $3 == "XFAIL") s[$1]++; row[NR] = $0
    if (!($1 in order)) { order[$1] = ++k; name[k] = $1 } }
  END {
    print "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
    printf "<testsuites name=\"bedrock-now-e2e\" time=\"%s\">\n", secs
    for (i = 1; i <= k; i++) {
      su = name[i]
      printf "  <testsuite name=\"%s\" tests=\"%d\" failures=\"%d\" skipped=\"%d\">\n", x(su), n[su], f[su] + 0, s[su] + 0
      for (r = 1; r <= NR; r++) {
        split(row[r], c, "\t"); if (c[1] != su) continue
        printf "    <testcase classname=\"e2e.%s\" name=\"%s\" time=\"%s\"", x(su), x(c[2]), c[4] + 0
        if (c[3] == "FAIL") printf ">\n      <failure message=\"%s\"/>\n    </testcase>\n", x(c[5])
        else if (c[3] == "SKIP" || c[3] == "XFAIL") printf ">\n      <skipped message=\"%s%s\"/>\n    </testcase>\n", (c[3] == "XFAIL" ? "XFAIL: " : ""), x(c[5])
        else if (c[3] == "XPASS") printf ">\n      <system-out>%s</system-out>\n    </testcase>\n", x(c[5])
        else printf "/>\n"
      }
      print "  </testsuite>"
    }
    print "</testsuites>"
  }' "$final" > "$out/junit.xml"
printf 'JUnit XML: %s\n' "$out/junit.xml"
[ "$fail" -eq 0 ]
