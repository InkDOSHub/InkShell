#!/bin/sh
# Checks overlay/etc/inksoc/wasm-catalog: every URL downloads, is a WebAssembly module (or a .whl zip), and has the listed size and sha256.
# usage: tools/check-wasm-catalog.sh [catalog]   (CI: test.yml, job catalog)
cat=${1:-$(dirname "$0")/../overlay/etc/inksoc/wasm-catalog}
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
bad=0
while IFS="$(printf '\t')" read -r name url sum size lic files desc; do
  case "$name" in ''|'#'*) continue ;; esac
  if [ -z "$files" ] || [ -z "$lic" ]; then echo "FAIL $name: needs name url sha256 size license files"; bad=1; continue; fi
  # GPL (also AGPL) is refused; LGPL (Lesser GPL: programs may use it without becoming GPL) is allowed
  # GPL only for the programs the owner allowed as separate catalog programs with their source published (26/11): grep, nano, git, make
  case "$(printf '%s' "$lic" | sed 's/LGPL//g')" in *GPL*) case "$name" in grep|nano|git|make) ;; *) echo "FAIL $name: GPL license ($lic)"; bad=1; continue ;; esac ;; esac
  if ! curl -fsSL -o "$tmp" "$url"; then echo "FAIL $name: download $url"; bad=1; continue; fi
  got=$(sha256sum "$tmp" | cut -d' ' -f1); n=$(wc -c < "$tmp" | tr -d ' '); magic=$(head -c 4 "$tmp" | od -An -tx1 | tr -d ' \n')
  want=0061736d; case "$url" in *.whl) want=504b0304 ;; esac # a Python wheel (py3-pip) is a zip
  if [ "$got" = "$sum" ] && [ "$n" = "$size" ] && [ "$magic" = "$want" ]; then echo "ok   $name ($lic, $n bytes)"
  else echo "FAIL $name: sha256 $got size $n magic $magic"; bad=1; fi
done < "$cat"
exit $bad
