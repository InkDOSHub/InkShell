#!/bin/sh
# Light subset for the browser bench (item 47, tests/bench/browser.mjs): sh browser.sh cpu | py
# Markers "@@T begin:X" / "@@T end:X"; the host stamps each line. python3 is whatever the run packs
# (x86 in /usr/bin, or the catalog's WebAssembly build in /usr/local/bin).
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
m() { echo "@@T $1"; }
for s in "$@"; do
  case $s in
    cpu) m begin:cpu; /root/cpubench; m end:cpu ;;
    py)
      m begin:py-start-1; python3 -c pass; m end:py-start-1
      m begin:py-start-2; python3 -c pass; m end:py-start-2
      m begin:py-loop; python3 -c 'print(sum(i * i for i in range(1000000)))'; m end:py-loop ;;
  esac
done
echo "@@T done"
