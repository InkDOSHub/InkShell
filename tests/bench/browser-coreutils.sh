#!/bin/sh
# Item 56 (tests/bench/browser-coreutils.mjs): busybox x86 (JIT) vs uutils coreutils WebAssembly, same run, same files.
# "bb-X" = busybox applet (explicit "busybox X"), "wa-X" = the same program of the WebAssembly multicall (explicit "coreutils X",
# so every program is measured whether the catalog links it or not).
# Markers "@@T begin:X.N" / "@@T end:X.N" (the host stamps each line), "@@RC X.N rc" per rep, "@@V X text" = check.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
R=${REPS:-3}
m() { echo "@@T $1"; }
t() { # t NAME COMMAND: R timed reps of "sh -c COMMAND", output to /tmp/o.NAME (last rep kept)
  n=$1; shift; i=1
  while [ $i -le $R ]; do
    m begin:$n.$i; sh -c "$*" > /tmp/o.$n 2>&1; rc=$?; m end:$n.$i
    echo "@@RC $n.$i $rc"; i=$((i + 1))
  done
}
pair() { # pair NAME COMMAND: in COMMAND each "@" is the program prefix: "busybox " for bb-NAME, "coreutils " for wa-NAME
  t bb-$1 "$(echo "$2" | sed 's/@/busybox /g')"
  t wa-$1 "$(echo "$2" | sed 's/@/coreutils /g')"
  a=$(busybox md5sum < /tmp/o.bb-$1 | cut -c1-32); b=$(busybox md5sum < /tmp/o.wa-$1 | cut -c1-32)
  [ "$a" = "$b" ] && echo "@@V same-$1 yes" || echo "@@V same-$1 NO"
}
B=/mnt/b/big.bin; C=/mnt/b/big.csv
busybox mkdir -p /tmp/d && cd /tmp/d
# data (not timed): a folder of 3000 files, and a 10 MB csv cut from the mounted one
busybox seq 1 3000 | busybox xargs busybox touch
busybox head -c 10485760 $C > /tmp/s10.csv
echo "@@V files $(busybox ls /tmp/d | busybox wc -l) s10 $(busybox wc -c < /tmp/s10.csv) which $(command -v coreutils sort cp | busybox tr '\n' ' ')"
cd /tmp
# start: the 1st rep of wa-start compiles coreutils.wasm in this browser (cold); the next ones are warm
t bb-start busybox basename /a/b/c.txt
t wa-start coreutils basename /a/b/c.txt
# 20 runs in a row of a tiny command (shell loop overhead is the same for both)
t bb-loop 'i=0; while [ $i -lt 20 ]; do busybox basename /a/b/c.txt; i=$((i + 1)); done'
t wa-loop 'i=0; while [ $i -lt 20 ]; do coreutils basename /a/b/c.txt; i=$((i + 1)); done'
pair ls "@ls -la /tmp/d"
pair sort "@sort /tmp/s10.csv"
pair sortn "@sort -t, -k3,3n /tmp/s10.csv"
pair wc "@wc -l $C"
pair wcc "@wc -c $B"
pair cat "@cat $B"
pair cp "@cp $B /tmp/cp.out; busybox cmp $B /tmp/cp.out && echo cp-ok; busybox rm -f /tmp/cp.out"
pair cut "@cut -d, -f2 /tmp/s10.csv"
pair tr "@tr a-z A-Z < /tmp/s10.csv"
pair uniq "@cut -d, -f2 /tmp/s10.csv | @sort | @uniq -c"
pair head "@head -n 5 $C; @tail -n 5 $C"
pair seq "@seq 1 500000"
pair cpr "d=/tmp/d2.\$\$; @cp -r /tmp/d \$d; busybox ls \$d | busybox wc -l"
echo "@@T done"
