#!/usr/bin/env bash
# Re-renders the model logos in catalog/icons/ from lobe-icons (https://github.com/lobehub/lobe-icons, MIT; see
# LICENSE-lobe-icons). Needs Docker; run it after changing an icon key in catalog/display.tsv or
# catalog/openrouter-icons.tsv:  catalog/icons/build.sh
#   catalog/icons/<key>.png     128x128, every icon key in catalog/display.tsv (Bedrock models)
#   catalog/icons/or/<key>.png   64x64, every icon in catalog/openrouter-icons.tsv plus "openrouter" (fallback)
# Each logo is centred on a white disc, so black marks (OpenAI, Grok, ...) stay visible in dark mode too, then
# quantised (pngquant) and stripped (optipng). Open WebUI only keeps png/jpeg/gif/webp data URIs, hence PNG.
set -euo pipefail
cd "$(dirname "$0")"
PKG=@lobehub/icons-static-png
VER=1.97.1   # upstream commit 0f1017c798d7713e2b79f5b08efc51fbcbfc3b0b
SHA256=2e7ad23a41ea3b56104310962fe19b2a2c3bc80766e5ec891c80bcc5b4abb37e

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
docker run --rm -v "$work:/w" -w /w node:22-alpine npm pack --silent "$PKG@$VER" >/dev/null
tgz="$work/lobehub-icons-static-png-$VER.tgz"
[ "$(openssl dgst -sha256 < "$tgz" | awk '{print $NF}')" = "$SHA256" ] || { echo "checksum mismatch for $PKG@$VER" >&2; exit 1; }
mkdir "$work/src"; tar -xzf "$tgz" -C "$work/src" package/light

keys() { tr -d '\r' < "$1" | awk -F'\t' -v c="$2" '!/^[[:space:]]*#/ && NF >= c && $c != "-" { print $c }' | sort -u; }
big="$(keys ../display.tsv 3)"
small="$({ keys ../openrouter-icons.tsv 2; echo openrouter; } | sort -u)"

rm -f ./*.png or/*.png; mkdir -p or
docker run --rm -v "$work/src/package/light:/src:ro" -v "$PWD:/out" -e BIG="$big" -e SMALL="$small" alpine:3.20 sh -euc '
  apk add -q imagemagick pngquant optipng >/dev/null
  render() { # KEY SIZE OUT
    s=$2; l=$((s * 64 / 100)); c=$(awk -v s="$s" "BEGIN { print (s - 1) / 2 }")
    [ -r "/src/$1.png" ] || { echo "lobe-icons has no $1.png" >&2; exit 1; }
    magick -size "${s}x${s}" xc:none -fill white -draw "circle $c,$c $c,0" \
      \( "/src/$1.png" -resize "${l}x${l}" \) -gravity center -composite -strip "$3"
    pngquant --force --skip-if-larger --quality 60-95 --speed 1 --output "$3" -- "$3" || true
    optipng -quiet -o7 -strip all "$3"
  }
  for k in $BIG; do render "$k" 128 "/out/$k.png"; done
  for k in $SMALL; do render "$k" 64 "/out/or/$k.png"; done
  chown -R "$(stat -c %u:%g /out)" /out'
set -- ./*.png or/*.png
printf '%d logos, %d bytes\n' "$#" "$(cat "$@" | wc -c)"
