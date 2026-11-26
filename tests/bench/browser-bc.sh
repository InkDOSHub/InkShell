#!/bin/sh
# Item 72 (tests/bench/browser-bc.mjs): busybox x86 (JIT) bc/dc vs WebAssembly bc/dc (Gavin Howard's bc), same run, same input.
# "bb" = busybox applet (explicit "busybox X"), "wa" = the WebAssembly program by its full path in /usr/local/bin (the catalog links it there).
# Markers "@@T begin:X.N" / "@@T end:X.N" (the host stamps each line), "@@RC X.N rc" per rep, "@@V name text" = check.
# Output is compared after removing bc's line wrapping (backslash-newline) and newlines, by md5.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
R=${REPS:-3}
m() { echo "@@T $1"; }
v() { echo "@@V $1 $2"; }
t() { # t NAME COMMAND: R timed reps of "sh -c COMMAND", output to /tmp/o.NAME
  n=$1; c=$2; i=1
  while [ $i -le $R ]; do
    m begin:$n.$i; sh -c "$c" > /tmp/o.$n 2>&1; rc=$?; m end:$n.$i
    echo "@@RC $n.$i $rc"; i=$((i + 1))
  done
}
W=/usr/local/bin; B=busybox
norm() { $B tr -d '\\\n'; }
sum() { norm < "$1" | $B md5sum | $B cut -c1-32; }
ok() { [ "$2" = "$3" ] && v "$1" yes || v "$1" "NO ($2 / $3)"; }
cd /tmp
v setup "which $(for c in bc dc; do command -v $c; done | $B tr '\n' ' ') busybox-has: $($B --list | $B grep -x -e bc -e dc | $B tr '\n' ' ')"
# start: the 1st rep of wa-start compiles the module in this browser (cold); the next ones are warm
t bb-start "echo 1+1 | $B bc"
t wa-start "echo 1+1 | $W/bc"
# 2^100000 (30103 digits): one rep for busybox (slow), R reps for WebAssembly
R=1
t bb-pow "echo '2^100000' | $B bc"
R=${REPS:-3}
t wa-pow "echo '2^100000' | $W/bc"
ok pow "$(sum /tmp/o.bb-pow)" "$(sum /tmp/o.wa-pow)"
v pow-digits "wa $(norm < /tmp/o.wa-pow | $B wc -c)"
# sqrt(2) to 2000 digits
R=1
t bb-sqrt "echo 'scale=2000; sqrt(2)' | $B bc"
R=${REPS:-3}
t wa-sqrt "echo 'scale=2000; sqrt(2)' | $W/bc"
ok sqrt "$(sum /tmp/o.bb-sqrt)" "$(sum /tmp/o.wa-sqrt)"
# dc: 2^100000 printed
R=1
t bb-dc "echo '2 100000 ^ p' | $B dc"
R=${REPS:-3}
t wa-dc "echo '2 100000 ^ p' | $W/dc"
ok dc "$(sum /tmp/o.bb-dc)" "$(sum /tmp/o.wa-dc)"
ok dc-vs-bc "$(sum /tmp/o.wa-pow)" "$(sum /tmp/o.wa-dc)"
# pi to 2000 digits with the math library (busybox bc has no -l / a()): WebAssembly only
t wa-pi "echo 'scale=2000; 4*a(1)' | $W/bc -l"
v pi-head "$($B head -c 52 /tmp/o.wa-pi)"
echo "@@T done"
