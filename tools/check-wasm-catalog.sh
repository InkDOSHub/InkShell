#!/bin/sh
# Checks overlay/etc/inksoc/wasm-catalog: every URL downloads, is a WebAssembly module, and has the listed size and sha256.
# usage: tools/check-wasm-catalog.sh [catalog]   (CI: test.yml, job catalog)
cat=${1:-$(dirname "$0")/../overlay/etc/inksoc/wasm-catalog}
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
bad=0
while IFS="$(printf '\t')" read -r name url sum size lic files desc; do
  case "$name" in ''|'#'*) continue ;; esac
  if [ -z "$files" ] || [ -z "$lic" ]; then echo "FAIL $name: needs name url sha256 size license files"; bad=1; continue; fi
  case "$lic" in *GPL*) echo "FAIL $name: GPL license ($lic)"; bad=1; continue ;; esac
  if ! curl -fsSL -o "$tmp" "$url"; then echo "FAIL $name: download $url"; bad=1; continue; fi
  got=$(sha256sum "$tmp" | cut -d' ' -f1); n=$(wc -c < "$tmp" | tr -d ' '); magic=$(head -c 4 "$tmp" | od -An -tx1 | tr -d ' \n')
  if [ "$got" = "$sum" ] && [ "$n" = "$size" ] && [ "$magic" = 0061736d ]; then echo "ok   $name ($lic, $n bytes)"
  else echo "FAIL $name: sha256 $got size $n magic $magic"; bad=1; fi
done < "$cat"
exit $bad
