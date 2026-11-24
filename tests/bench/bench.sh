#!/bin/sh
# Terminal benchmark: the same script runs natively (Ubuntu runner) and in Alpine on the engine.
# usage: sh bench.sh cpu | py | pystart | io MB | wasmio MB   (several sections allowed)
# wasmio: the same big file through sha256sum, zip, unzip, 7zz a/x (on the engine the catalog's
# WebAssembly builds in /usr/local/bin); BENCH_RSS=1 (native) adds "@@RSS name KB" per step.
# Prints "@@T begin:NAME" / "@@T end:NAME" markers; the host stamps the time of each line.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
H=$(cd "$(dirname "$0")" && pwd)
D=${BENCH_DIR:-/tmp/bench}
mkdir -p "$D"
# natively the script stamps itself (BENCH_STAMP=1: the reader starts later than the script);
# on the engine the host stamps each line, so no extra date process runs there
if [ -n "$BENCH_STAMP" ]; then m() { echo "@@T $1 $(date +%s%N)"; }; else m() { echo "@@T $1"; }; fi
# MB of data: 1 MB block, half random, half zeros (compresses about 2:1), doubled up to the size
mk() {
  dd if=/dev/urandom of="$D/b1" bs=512k count=1 2>/dev/null
  dd if=/dev/zero bs=512k count=1 2>/dev/null >> "$D/b1"
  n=1
  while [ $n -lt "$1" ]; do cat "$D/b$n" "$D/b$n" > "$D/b$((n * 2))" && rm -f "$D/b$n"; n=$((n * 2)); done
  mv "$D/b$n" "$D/big"
  ls -l "$D/big"
}
# one timed step: r NAME CMD... (output dropped); native with BENCH_RSS: peak RSS of the command
r() {
  n=$1; shift; m begin:$n
  if [ -n "$BENCH_RSS" ]; then /usr/bin/time -o "$D/rss" -f %M "$@" > /dev/null; else "$@" > /dev/null; fi
  m end:$n
  [ -n "$BENCH_RSS" ] && echo "@@RSS $n $(tail -1 "$D/rss")"
}
while [ $# -gt 0 ]; do
  case $1 in
    cpu) m begin:cpu; "${CPUBENCH:-$H/cpubench}"; m end:cpu ;;
    py)
      m begin:py-start; python3 -c pass; m end:py-start
      m begin:py-bench; python3 "$H/pybench.py"; m end:py-bench ;;
    pystart) # python3 start, twice each (1st = cold): plain, without site (-S), isolated (-I)
      for v in c S I; do
        case $v in c) o= ;; *) o=-$v ;; esac
        for i in 1 2; do m begin:ps-$v-$i; python3 $o -c pass; m end:ps-$v-$i; done
      done ;;
    io)
      mb=$2; shift
      m begin:io-make-$mb; mk "$mb"; m end:io-make-$mb
      m begin:io-copy-$mb; cp "$D/big" "$D/big2"; m end:io-copy-$mb
      rm -f "$D/big2"
      m begin:io-sha256-$mb; sha256sum "$D/big"; m end:io-sha256-$mb
      m begin:io-zip-$mb; (cd "$D" && zip -q -1 big.zip big); ls -l "$D/big.zip"; m end:io-zip-$mb
      rm -f "$D/big"
      m begin:io-unzip-$mb; (cd "$D" && unzip -q -o big.zip); m end:io-unzip-$mb
      rm -f "$D/big" "$D/big.zip" ;;
    wasmio)
      mb=$2; shift; z=${SZ:-7zz}
      rm -f "$D/big" "$D/big.zip" "$D/big.7z"
      m begin:w-make-$mb; mk "$mb"; m end:w-make-$mb
      r w-sha256-$mb sha256sum "$D/big"
      r w-zip-$mb zip -q -1 -j "$D/big.zip" "$D/big"
      r w-7za-$mb "$z" a -bd -mx1 -mmt1 "$D/big.7z" "$D/big"
      ls -l "$D/big.zip" "$D/big.7z"; rm -f "$D/big"
      r w-unzip-$mb unzip -q -o "$D/big.zip" -d "$D"
      ls -l "$D/big"; rm -f "$D/big"
      r w-7zx-$mb "$z" x -bd -y -o"$D" "$D/big.7z"
      ls -l "$D/big"; rm -f "$D/big" "$D/big.zip" "$D/big.7z" ;;
  esac
  shift
done
m done
