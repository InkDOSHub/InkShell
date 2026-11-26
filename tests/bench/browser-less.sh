#!/bin/sh
# Item 73 (tests/bench/browser-less.mjs): busybox x86 (JIT) less vs WebAssembly less (less 692), same run, one size, one rep.
# Output goes to a file, not a terminal: both programs copy the file through (what "less -F" does for a short file, and what a pipe gets).
# "bb" = busybox applet (explicit "busybox less"), "wa" = the WebAssembly program by its full path in /usr/local/bin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
m() { echo "@@T $1"; }
v() { echo "@@V $1 $2"; }
t() { n=$1; c=$2; m begin:$n.1; sh -c "$c" > /tmp/o.$n 2>&1; rc=$?; m end:$n.1; echo "@@RC $n.1 $rc"; }
W=/usr/local/bin; B=busybox
cd /tmp
v setup "busybox-has: $($B --list | $B grep -x less | $B tr '\n' ' ') wa: $(command -v less)"
$B seq 1 400000 > /tmp/big.txt # about 2.6 MB
$B seq 1 20 > /tmp/small.txt
t bb-start "$B less -F /tmp/small.txt"
t wa-start "$W/less -F /tmp/small.txt"
t wa-start2 "$W/less -F /tmp/small.txt"
t bb-big "$B less /tmp/big.txt"
t wa-big "$W/less /tmp/big.txt"
t wa-big2 "$W/less /tmp/big.txt"
ok() { [ "$2" = "$3" ] && v "$1" yes || v "$1" "NO"; }
ok big "$($B md5sum < /tmp/o.bb-big)" "$($B md5sum < /tmp/o.wa-big)"
ok small "$($B md5sum < /tmp/o.bb-start)" "$($B md5sum < /tmp/o.wa-start)"
echo "@@T done"
