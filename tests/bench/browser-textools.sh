#!/bin/sh
# Item 67 (tests/bench/browser-textools.mjs): busybox x86 (JIT) vs WebAssembly sed (uutils), awk (one-true-awk), find (uutils findutils)
# and rg (ripgrep, the catalog's grep), same run, same files. "bb" = busybox applet (explicit "busybox X"), "wa" = the WebAssembly
# program by its full path in /usr/local/bin (the catalog links it there, before busybox in PATH).
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
pair() { # pair NAME BUSYBOX-COMMAND WASM-COMMAND
  t bb-$1 "$2"
  t wa-$1 "$3"
  a=$(busybox md5sum < /tmp/o.bb-$1 | busybox cut -c1-32); b=$(busybox md5sum < /tmp/o.wa-$1 | busybox cut -c1-32)
  [ "$a" = "$b" ] && echo "@@V same-$1 yes" || echo "@@V same-$1 NO"
}
C=/mnt/b/big.csv; U=/usr/local/bin
busybox mkdir -p /tmp/t && cd /tmp
# data (not timed): a tree of 4000 files (40 folders x 100), and a 10 MB csv cut from the mounted one
i=1; while [ $i -le 40 ]; do busybox mkdir /tmp/t/d$i; (cd /tmp/t/d$i && busybox seq 1 100 | busybox xargs busybox touch); i=$((i + 1)); done
busybox head -c 10485760 $C > /tmp/s10.csv
echo "@@V files $(busybox find /tmp/t -type f | busybox wc -l) s10 $(busybox wc -c < /tmp/s10.csv) which $(command -v sed awk find rg | busybox tr '\n' ' ')"
# start: the 1st rep of wa-start compiles the module in this browser (cold); the next ones are warm
t bb-start "echo a b c | busybox sed 's/b/X/'"
t wa-start "echo a b c | $U/sed 's/b/X/'"
t bb-loop 'i=0; while [ $i -lt 20 ]; do echo abc | busybox sed p; i=$((i + 1)); done'
t wa-loop "i=0; while [ \$i -lt 20 ]; do echo abc | $U/sed p; i=\$((i + 1)); done"
# grep: busybox grep vs ripgrep (-c = count only, same pattern syntax for these)
pair grep "busybox grep -c word77, $C" "$U/rg -c word77, $C"
pair grepre "busybox grep -c 'word[12][0-9]5,' $C" "$U/rg -c 'word[12][0-9]5,' $C"
# sed over the 64 MB file (filter: few lines out) and over 10 MB (rewrites every line)
pair sedn "busybox sed -n '/,word77,/p' $C" "$U/sed -n '/,word77,/p' $C"
pair seds "busybox sed 's/word/W/' /tmp/s10.csv" "$U/sed 's/word/W/' /tmp/s10.csv"
pair sedg "busybox sed 's/[0-9]\\+/#/g' /tmp/s10.csv" "$U/sed 's/[0-9]\\+/#/g' /tmp/s10.csv"
# awk
pair awkf "busybox awk -F, '\$3 > 990 {n++} END {print n}' $C" "$U/awk -F, '\$3 > 990 {n++} END {print n}' $C"
pair awks "busybox awk -F, '{s += \$3} END {print s}' $C" "$U/awk -F, '{s += \$3} END {print s}' $C"
pair awkc "busybox awk -F, '{c[\$2]++} END {for (k in c) n++; print n}' /tmp/s10.csv" "$U/awk -F, '{c[\$2]++} END {for (k in c) n++; print n}' /tmp/s10.csv"
# find over the tree (sorted: readdir order may differ)
pair findn "busybox find /tmp/t -type f -name '*7*' | busybox sort" "$U/find /tmp/t -type f -name '*7*' | busybox sort"
pair findc "busybox find /tmp/t | busybox wc -l" "$U/find /tmp/t | busybox wc -l"
echo "@@T done"
