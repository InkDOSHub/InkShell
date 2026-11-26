#!/bin/sh
# Item 71 (tests/bench/browser-diffutils.mjs): busybox x86 (JIT) diff/cmp vs the WebAssembly uutils diffutils, same run, same files.
# "bb" = busybox applet (explicit "busybox X"), "wa" = the WebAssembly program by its full path in /usr/local/bin (the catalog links it there,
# before busybox in PATH). Markers "@@T begin:X.N" / "@@T end:X.N" (the host stamps each line), "@@RC X.N rc" per rep, "@@V name text" = check.
# Output is compared byte for byte after the timestamps of the "---"/"+++" headers are cut (they differ by tool).
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
R=${REPS:-3}
m() { echo "@@T $1"; }
v() { echo "@@V $1 $2"; }
t() { # t NAME COMMAND: R timed reps of "sh -c COMMAND", output to /tmp/o.NAME (the last rep's output stays)
  n=$1; c=$2; i=1
  while [ $i -le $R ]; do
    m begin:$n.$i; sh -c "$c" > /tmp/o.$n 2>&1; rc=$?; m end:$n.$i
    echo "@@RC $n.$i $rc"; i=$((i + 1))
  done
}
W=/usr/local/bin; T=/mnt/b/big.txt; B=busybox
norm() { $B sed 's/^\(---\|+++\) \([^\t]*\)\t.*/\1 \2/' "$1"; }
same() { # same NAME: identical output of bb-NAME and wa-NAME (headers without timestamps)?
  if [ "$(norm /tmp/o.bb-$1 | $B md5sum)" = "$(norm /tmp/o.wa-$1 | $B md5sum)" ]; then v same-$1 yes
  else v same-$1 "NO bb $($B wc -l < /tmp/o.bb-$1) lines wa $($B wc -l < /tmp/o.wa-$1) lines; first diff: $($B diff /tmp/o.bb-$1 /tmp/o.wa-$1 | $B head -6 | $B tr '\n' '|')"; fi
}
$B mkdir -p /tmp/t && cd /tmp
v setup "which $(for c in diff cmp; do command -v $c; done | $B tr '\n' ' ')"
# data (not timed): a.txt = the first 10 MB of the 64 MB text; b.txt = a.txt with 1 line changed, 1 deleted, 1 added (3 places)
$B head -c 10485760 $T > /tmp/a.txt
$B sed -e '1000c\changed line one' -e '50000d' -e '90000a\added line after 90000' /tmp/a.txt > /tmp/b.txt
v setup-files "a $($B wc -c < /tmp/a.txt) b $($B wc -c < /tmp/b.txt) lines $($B wc -l < /tmp/a.txt)"
# start (tiny files): the 1st rep of wa-start compiles the module in this browser (cold)
echo x > /tmp/s1; echo y > /tmp/s2
t bb-start "$B diff /tmp/s1 /tmp/s2"
t wa-start "$W/diff /tmp/s1 /tmp/s2"
# diff, diff -u of the two 10 MB files (2 reps: busybox is slow)
R=2
t bb-d "$B diff /tmp/a.txt /tmp/b.txt"
t wa-d "$W/diff /tmp/a.txt /tmp/b.txt"
same d
t bb-u "$B diff -u /tmp/a.txt /tmp/b.txt"
t wa-u "$W/diff -u /tmp/a.txt /tmp/b.txt"
same u
R=${REPS:-3}
# the unified diff of the WebAssembly diff applies to a.txt with busybox patch and gives b.txt (valid even when it differs from busybox's)
$B cp /tmp/a.txt /tmp/p.txt; $B patch /tmp/p.txt /tmp/o.wa-u > /dev/null 2>&1
[ "$($B md5sum < /tmp/p.txt)" = "$($B md5sum < /tmp/b.txt)" ] && v patch-wa yes || v patch-wa NO
# equal files: exit 0, no output
t bb-eq "$B diff /tmp/a.txt /tmp/a.txt"
t wa-eq "$W/diff /tmp/a.txt /tmp/a.txt"
# diff -r of two trees of 2000 files (40 folders x 50 files, 3 KB of text each); the 2nd tree has 5 files changed, 1 removed, 1 only there
L=$($B head -c 3000 $T)
i=1; while [ $i -le 40 ]; do d=/tmp/t/a/d$i; $B mkdir -p $d; j=1; while [ $j -le 50 ]; do printf '%s %s\n' "$i-$j" "$L" > $d/f$j; j=$((j + 1)); done; i=$((i + 1)); done
$B cp -r /tmp/t/a /tmp/t/b
for k in 3 11 17 25 38; do echo "changed $k" >> /tmp/t/b/d$k/f7; done
$B rm /tmp/t/b/d5/f9; echo new > /tmp/t/b/d6/only-b
v setup-tree "files $($B find /tmp/t/a -type f | $B wc -l)"
t bb-r "cd /tmp/t && $B diff -r a b"
t wa-r "cd /tmp/t && $W/diff -r a b"
same r
t bb-ru "cd /tmp/t && $B diff -ru a b"
t wa-ru "cd /tmp/t && $W/diff -ru a b"
same ru
t bb-rq "cd /tmp/t && $B diff -rq a b"
t wa-rq "cd /tmp/t && $W/diff -rq a b"
same rq
# cmp of 64 MB: identical copies (full scan, exit 0) and one byte changed near the end (exit 1)
$B cp $T /tmp/c1; $B cp $T /tmp/c2; $B cp $T /tmp/c3; printf 'Z' | $B dd of=/tmp/c3 bs=1 seek=60000000 conv=notrunc 2> /dev/null
v setup-cmp "c1 $($B wc -c < /tmp/c1)"
R=2
t bb-cmpeq "$B cmp /tmp/c1 /tmp/c2"
t wa-cmpeq "$W/cmp /tmp/c1 /tmp/c2"
same cmpeq
t bb-cmpne "$B cmp /tmp/c1 /tmp/c3"
t wa-cmpne "$W/cmp /tmp/c1 /tmp/c3"
v cmpne-out "bb $($B head -1 /tmp/o.bb-cmpne) | wa $($B head -1 /tmp/o.wa-cmpne)"
R=${REPS:-3}
# a missing file: exit status of each
$B diff /tmp/a.txt /tmp/nofile > /dev/null 2>&1; e1=$?; $W/diff /tmp/a.txt /tmp/nofile > /dev/null 2>&1; e2=$?; v rc-missing "bb $e1 wa $e2"
echo "@@T done"
