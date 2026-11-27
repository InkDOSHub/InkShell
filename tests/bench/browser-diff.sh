#!/bin/sh
# Item 71 (tests/bench/browser-diff.mjs): busybox x86 (JIT) diff/cmp vs WebAssembly GNU diffutils 3.12, same run, ~10 MB files, one rep.
# "bb" = busybox applet (explicit "busybox diff"), "wa" = the WebAssembly program by its full path in /usr/local/bin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
m() { echo "@@T $1"; }
v() { echo "@@V $1 $2"; }
t() { n=$1; c=$2; m begin:$n.1; sh -c "$c" > /tmp/o.$n 2>&1; rc=$?; m end:$n.1; echo "@@RC $n.1 $rc"; }
W=/usr/local/bin; B=busybox
cd /tmp
v setup "wa: $(command -v diff) $(command -v cmp)"
$B seq 1 1500000 > /tmp/a.txt # about 10.9 MB
$B sed 's/^1234/x1234/; s/^77777/y/' /tmp/a.txt > /tmp/b.txt
v size "$($B wc -c < /tmp/a.txt) bytes"
t bb-diff "$B diff /tmp/a.txt /tmp/b.txt | $B wc -l"
t wa-diff "$W/diff /tmp/a.txt /tmp/b.txt | $B wc -l"
t bb-du "$B diff -u /tmp/a.txt /tmp/b.txt | $B wc -l"
t wa-du "$W/diff -u /tmp/a.txt /tmp/b.txt | $B wc -l"
t bb-cmp "$B cmp /tmp/a.txt /tmp/a.txt; echo rc=\$?"
t wa-cmp "$W/cmp /tmp/a.txt /tmp/a.txt; echo rc=\$?"
ok() { [ "$($B cat /tmp/o.bb-$1)" = "$($B cat /tmp/o.wa-$1)" ] && v "$1" "yes ($($B cat /tmp/o.wa-$1 | $B tr '\n' ' '))" || v "$1" "NO ($($B cat /tmp/o.bb-$1 | $B tr '\n' ' ') / $($B cat /tmp/o.wa-$1 | $B tr '\n' ' '))"; }
ok diff; ok du; ok cmp
echo "@@T done"
