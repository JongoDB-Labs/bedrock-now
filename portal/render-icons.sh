#!/usr/bin/env bash
# Redraws the bedrock-now icon set: portal/portal/appicons.py writes the SVG sources, then rsvg-convert (in a
# pinned Alpine container, so every machine renders the same pixels) and optipng make the PNGs in
# portal/portal/static/icons/. Writes static/icons/SOURCES: the sha256 of each SVG rendered, which the portal
# tests compare with the SVGs in the tree (a stale PNG fails the build). Needs python3 and Docker.
set -euo pipefail
cd "$(dirname "$0")"
IMAGE="alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
PKGS="rsvg-convert=2.58.5-r0 optipng=0.7.8-r0"

python3 -m portal.appicons
# "size source name" per PNG, from appicons.FILES
list="$(python3 -c 'from portal import appicons
for n, (s, src) in appicons.FILES.items(): print(s, src, n)')"

docker run --rm -e LIST="$list" -e PKGS="$PKGS" -e OWNER="$(id -u):$(id -g)" \
  -v "$PWD/portal/static:/s" -w /s "$IMAGE" sh -euc '
    apk add --no-cache $PKGS >/dev/null
    echo "$LIST" | while read -r size src name; do
      rsvg-convert -w "$size" -h "$size" "$src" -o "icons/$name"
      optipng -quiet -o7 -nb -strip all "icons/$name"
    done
    echo "$LIST" | awk "{print \$2}" | sort -u | xargs sha256sum > icons/SOURCES
    chown "$OWNER" icons/*.png icons/SOURCES'
echo "rendered $(echo "$list" | wc -l | tr -d ' ') icons into portal/portal/static/icons/" >&2
