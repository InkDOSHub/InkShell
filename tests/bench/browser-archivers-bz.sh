#!/bin/sh
# Item 70 (tests/bench/browser-archivers.mjs, ARCH_SET=bz): busybox x86 (JIT) vs WebAssembly bzip2 (libbz2) and zstd (libzstd), same run, same files.
# busybox has no zstd: zstd is timed in WebAssembly only ("wa"), checked by md5 and -t.
# "bb" = busybox applet (explicit "busybox X"), "wa" = the WebAssembly program by its full path in /usr/local/bin (the catalog links it there,
# before busybox in PATH). Markers "@@T begin:X.N" / "@@T end:X.N" (the host stamps each line), "@@RC X.N rc" per rep, "@@V name text" = check.
# Compressed bytes differ between programs (different encoders): compression is checked by a round trip through the OTHER side's decoder,
# decompression and extraction by the md5 of the output / diff -r of the tree.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
R=${REPS:-3}
m() { echo "@@T $1"; }
v() { echo "@@V $1 $2"; }
t() { # t NAME COMMAND [BEFORE-EACH-REP]: R timed reps of "sh -c COMMAND" (the before-command is not timed), output to /tmp/o.NAME
  n=$1; c=$2; pre=${3:-true}; i=1
  while [ $i -le $R ]; do
    sh -c "$pre" > /dev/null 2>&1
    m begin:$n.$i; sh -c "$c" > /tmp/o.$n 2>&1; rc=$?; m end:$n.$i
    echo "@@RC $n.$i $rc"; i=$((i + 1))
  done
}
W=/usr/local/bin; T=/mnt/b/big.txt; B=busybox
md5() { $W/md5sum | $B cut -c1-32; }
ok() { [ "$2" = "$3" ] && v "$1" yes || v "$1" "NO ($2 / $3)"; }
$B mkdir -p /tmp/t && cd /tmp
ref=$($W/md5sum $T | $B cut -c1-32)
v setup "which $(for c in bzip2 bunzip2 bzcat zstd unzstd zstdcat md5sum; do command -v $c; done | $B tr '\n' ' ')"
# start: the 1st rep of wa-start compiles the module in this browser (cold); the next ones are warm
t bb-start "echo a b c | $B bzip2 -c | $B bunzip2 -c"
t wa-start "echo a b c | $W/bzip2 -c | $W/bunzip2 -c"
t wa-zstart "echo a b c | $W/zstd -c | $W/unzstd -c"
# bzip2 -c of the 64 MB text (1 rep: busybox is very slow), then the round trip through the OTHER side's decoder
R=1
t bb-bzc "$B bzip2 -c $T > /tmp/z.bb"
t wa-bzc "$W/bzip2 -c $T > /tmp/z.wa"
R=${REPS:-3}
v bzc-size "bb $($B wc -c < /tmp/z.bb) wa $($B wc -c < /tmp/z.wa)"
ok bzc-rt-wa-reads-bb "$ref" "$($W/bunzip2 -c /tmp/z.bb | md5)"
ok bzc-rt-bb-reads-wa "$ref" "$($B bunzip2 -c /tmp/z.wa | md5)"
$B cp /tmp/z.bb /tmp/t.bz2; $B rm -f /tmp/z.bb /tmp/z.wa
R=2
t bb-bzd "$B bunzip2 -c /tmp/t.bz2 > /dev/null"
R=${REPS:-3}
t wa-bzd "$W/bunzip2 -c /tmp/t.bz2 > /dev/null"
ok bzd-bb "$ref" "$($B bunzip2 -c /tmp/t.bz2 | md5)"
ok bzd-wa "$ref" "$($W/bunzip2 -c /tmp/t.bz2 | md5)"
ok bzcat-wa "$ref" "$($W/bzcat /tmp/t.bz2 | md5)"
# zstd (WebAssembly only): -c (level 3), -1, -d; md5 of the decoded output, -t, the stdin pipe
t wa-zsc "$W/zstd -c $T > /tmp/z.zst"
v zsc-size "wa-3 $($B wc -c < /tmp/z.zst)"
t wa-zsd "$W/zstd -dc /tmp/z.zst > /dev/null"
ok zsd-wa "$ref" "$($W/zstd -dc /tmp/z.zst | md5)"
ok zscat-wa "$ref" "$($W/zstdcat /tmp/z.zst | md5)"
ok zst-t "0" "$($W/zstd -t /tmp/z.zst > /dev/null 2>&1; echo $?)"
ok zst-bad "1" "$($B head -c 100000 /tmp/z.zst | $W/zstd -dc > /dev/null 2>&1; echo $?)"
ok zst-pipe "$ref" "$($B cat $T | $W/zstd -c | $W/unzstd -c | md5)"
$B rm -f /tmp/z.zst
t wa-zs1c "$W/zstd -1 -c $T > /tmp/z.zst"
v zs1c-size "wa-1 $($B wc -c < /tmp/z.zst)"
ok zs1-rt "$ref" "$($W/zstd -dc /tmp/z.zst | md5)"
$B rm -f /tmp/z.zst
echo "@@T done"
