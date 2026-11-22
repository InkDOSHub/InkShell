#!/bin/sh
# Terminal benchmark: the same script runs natively (Ubuntu runner) and in Alpine on the engine.
# usage: sh bench.sh cpu | py | io MB   (several sections allowed)
# Prints "@@T begin:NAME" / "@@T end:NAME" markers; the host stamps the time of each line.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
H=$(cd "$(dirname "$0")" && pwd)
D=${BENCH_DIR:-/tmp/bench}
mkdir -p "$D"
# natively the script stamps itself (BENCH_STAMP=1: the reader starts later than the script);
# on the engine the host stamps each line, so no extra date process runs there
if [ -n "$BENCH_STAMP" ]; then m() { echo "@@T $1 $(date +%s%N)"; }; else m() { echo "@@T $1"; }; fi
while [ $# -gt 0 ]; do
  case $1 in
    cpu) m begin:cpu; "${CPUBENCH:-$H/cpubench}"; m end:cpu ;;
    py)
      m begin:py-start; python3 -c pass; m end:py-start
      m begin:py-bench; python3 "$H/pybench.py"; m end:py-bench ;;
    io)
      mb=$2; shift
      # 1 MB block: half random, half zeros (compresses about 2:1), doubled up to the size
      m begin:io-make-$mb
      dd if=/dev/urandom of="$D/b1" bs=512k count=1 2>/dev/null
      dd if=/dev/zero bs=512k count=1 2>/dev/null >> "$D/b1"
      n=1
      while [ $n -lt "$mb" ]; do cat "$D/b$n" "$D/b$n" > "$D/b$((n * 2))" && rm -f "$D/b$n"; n=$((n * 2)); done
      mv "$D/b$n" "$D/big"
      ls -l "$D/big"
      m end:io-make-$mb
      m begin:io-copy-$mb; cp "$D/big" "$D/big2"; m end:io-copy-$mb
      rm -f "$D/big2"
      m begin:io-sha256-$mb; sha256sum "$D/big"; m end:io-sha256-$mb
      m begin:io-zip-$mb; (cd "$D" && zip -q -1 big.zip big); ls -l "$D/big.zip"; m end:io-zip-$mb
      rm -f "$D/big"
      m begin:io-unzip-$mb; (cd "$D" && unzip -q -o big.zip); m end:io-unzip-$mb
      rm -f "$D/big" "$D/big.zip" ;;
  esac
  shift
done
m done
