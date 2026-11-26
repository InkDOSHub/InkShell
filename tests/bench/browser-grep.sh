#!/bin/sh
# Item 80 (tests/bench/browser-grep.mjs): busybox x86 (JIT) grep vs WebAssembly GNU grep 3.12, same run, one ~10 MB file, one rep.
# "bb" = busybox applet (explicit "busybox grep"), "wa" = the WebAssembly program by its full path in /usr/local/bin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
m() { echo "@@T $1"; }
v() { echo "@@V $1 $2"; }
t() { n=$1; c=$2; m begin:$n.1; sh -c "$c" > /tmp/o.$n 2>&1; rc=$?; m end:$n.1; echo "@@RC $n.1 $rc"; }
W=/usr/local/bin; B=busybox
cd /tmp
v setup "wa: $(command -v grep)"
$B seq 1 1500000 > /tmp/big.txt # about 10.9 MB
v size "$($B wc -c < /tmp/big.txt) bytes"
t bb-lit "$B grep -c 9999 /tmp/big.txt"
t wa-lit "$W/grep -c 9999 /tmp/big.txt"
t wa-lit2 "$W/grep -c 9999 /tmp/big.txt"
t bb-re "$B grep -cE '^[0-9]*77[0-9]\$' /tmp/big.txt"
t wa-re "$W/grep -cE '^[0-9]*77[0-9]\$' /tmp/big.txt"
t bb-vi "$B grep -cvi 1 /tmp/big.txt"
t wa-vi "$W/grep -cvi 1 /tmp/big.txt"
ok() { [ "$($B cat /tmp/o.bb-$1)" = "$($B cat /tmp/o.wa-$1)" ] && v "$1" "yes ($($B cat /tmp/o.wa-$1))" || v "$1" "NO ($($B cat /tmp/o.bb-$1) / $($B cat /tmp/o.wa-$1))"; }
ok lit; ok re; ok vi
echo "@@T done"
