#!/bin/sh
# Item 68 (tests/bench/browser-archivers.mjs): busybox x86 (JIT) vs WebAssembly gzip (zlib), xz (liblzma) and tar (bsdtar), same run, same files.
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
# data (not timed): a tree of 4000 files (40 folders x 100, 3 KB of text each, each starting with its own number), a gz and an xz of the 64 MB text
L=$($B head -c 3000 $T)
i=1; while [ $i -le 40 ]; do d=/tmp/t/d$i; $B mkdir -p $d; j=1; while [ $j -le 100 ]; do printf '%s %s\n' "$i-$j" "$L" > $d/f$j; j=$((j + 1)); done; i=$((i + 1)); done
ref=$($W/md5sum $T | $B cut -c1-32)
$W/gzip -c $T > /tmp/t.gz; $W/xz -1 -c $T > /tmp/t.xz
v setup "files $($B find /tmp/t -type f | $B wc -l) tree-bytes $($B du -sk /tmp/t | $B cut -f1)K gz $($B wc -c < /tmp/t.gz) xz $($B wc -c < /tmp/t.xz) which $(for c in gzip xz tar md5sum; do command -v $c; done | $B tr '\n' ' ')"
ok setup-gz "$ref" "$($B gunzip -c /tmp/t.gz | md5)"
ok setup-xz "$ref" "$($B xz -dc /tmp/t.xz | md5)"
# start: the 1st rep of wa-start compiles the module in this browser (cold); the next ones are warm
t bb-start "echo a b c | $B gzip -c | $B gunzip -c"
t wa-start "echo a b c | $W/gzip -c | $W/gunzip -c"
# gzip -c of the 64 MB text (2 reps: busybox is slow) and gunzip of it (to /dev/null: only the decoding is timed)
R=2
t bb-gzc "$B gzip -c $T > /tmp/z.bb"
t wa-gzc "$W/gzip -c $T > /tmp/z.wa"
R=${REPS:-3}
v gzc-size "bb $($B wc -c < /tmp/z.bb) wa $($B wc -c < /tmp/z.wa)"
ok gzc-rt-wa-reads-bb "$ref" "$($W/gunzip -c /tmp/z.bb | md5)"
ok gzc-rt-bb-reads-wa "$ref" "$($B gunzip -c /tmp/z.wa | md5)"
$B rm -f /tmp/z.bb /tmp/z.wa
t bb-gzd "$B gunzip -c /tmp/t.gz > /dev/null"
t wa-gzd "$W/gunzip -c /tmp/t.gz > /dev/null"
ok gzd-bb "$ref" "$($B gunzip -c /tmp/t.gz | md5)"
ok gzd-wa "$ref" "$($W/gunzip -c /tmp/t.gz | md5)"
# xz -d of the xz made above (busybox only decodes)
t bb-xzd "$B xz -dc /tmp/t.xz > /dev/null"
t wa-xzd "$W/xz -dc /tmp/t.xz > /dev/null"
ok xzd-wa "$ref" "$($W/xz -dc /tmp/t.xz | md5)"
R=1
t wa-xzc "$W/xz -1 -c $T > /tmp/z.xz"
R=${REPS:-3}
v xzc-size "wa-1 $($B wc -c < /tmp/z.xz)"
$B rm -f /tmp/z.xz
# tar: create the tree (names compared sorted without the trailing slash), extract the busybox archive, with and without gzip
t bb-tarc "$B tar -cf /tmp/t.bb -C /tmp t"
t wa-tarc "$W/tar -cf /tmp/t.wa -C /tmp t"
a=$($B tar -tf /tmp/t.bb | $B sed 's:/$::' | $B sort | md5); b=$($B tar -tf /tmp/t.wa | $B sed 's:/$::' | $B sort | md5); ok tarc-names "$a" "$b"
v tarc-size "bb $($B wc -c < /tmp/t.bb) wa $($B wc -c < /tmp/t.wa)"
t bb-tarx "$B tar -xf /tmp/t.bb -C /tmp/xb" "$B rm -rf /tmp/xb; $B mkdir /tmp/xb"
ok tarx-bb "same" "$($B diff -r /tmp/t /tmp/xb/t > /dev/null && echo same)"
t wa-tarx "$W/tar -xf /tmp/t.bb -C /tmp/xw" "$B rm -rf /tmp/xw; $B mkdir /tmp/xw"
ok tarx-wa "same" "$($B diff -r /tmp/t /tmp/xw/t > /dev/null && echo same)"
$B rm -rf /tmp/xb /tmp/xw /tmp/t.wa
t bb-tgzc "$B tar -czf /tmp/t.bb.tgz -C /tmp t"
t wa-tgzc "$W/tar -czf /tmp/t.wa.tgz -C /tmp t"
v tgzc-size "bb $($B wc -c < /tmp/t.bb.tgz) wa $($B wc -c < /tmp/t.wa.tgz)"
t bb-tgzx "$B tar -xzf /tmp/t.bb.tgz -C /tmp/xb" "$B rm -rf /tmp/xb; $B mkdir /tmp/xb"
t wa-tgzx "$W/tar -xzf /tmp/t.bb.tgz -C /tmp/xw" "$B rm -rf /tmp/xw; $B mkdir /tmp/xw"
ok tgzx-bb "same" "$($B diff -r /tmp/t /tmp/xb/t > /dev/null && echo same)"
ok tgzx-wa "same" "$($B diff -r /tmp/t /tmp/xw/t > /dev/null && echo same)"
ok tgzc-wa-reads-bb "$($B tar -tzf /tmp/t.bb.tgz | $B sed 's:/$::' | $B sort | md5)" "$($W/tar -tzf /tmp/t.bb.tgz | $B sed 's:/$::' | $B sort | md5)"
ok tgzc-bb-reads-wa "$($B tar -tzf /tmp/t.bb.tgz | $B sed 's:/$::' | $B sort | md5)" "$($B tar -tzf /tmp/t.wa.tgz | $B sed 's:/$::' | $B sort | md5)"
echo "@@T done"
