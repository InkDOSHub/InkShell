#!/bin/sh
# Item 78 (one small comparison, 1 browser, 1 size, 1 rep; tests/bench/procs-bench.mjs): processes started from
# the WebAssembly python3 and find (host channel /dev/inksoc) vs the same from x86 python3 and busybox find.
# Markers "@@T begin:X" / "@@T end:X"; the host stamps each line.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin PYTHONPATH=/etc/inksoc/python
m() { echo "@@T $1"; }
seq 1 20000 | busybox awk '{ print ($1 * 7919) % 20011 }' > /tmp/s.txt
mkdir -p /tmp/fe && i=0 && while [ $i -lt 200 ]; do : > /tmp/fe/f$i; i=$((i + 1)); done
P='import subprocess; r = subprocess.run(["sort", "/tmp/s.txt"], capture_output=True); print("sorted", len(r.stdout.splitlines()), r.returncode, subprocess.Popen.__module__)'
for v in x86:/usr/bin/python3 wasm:/usr/local/bin/python3; do
  n=${v%%:*} py=${v#*:}
  m begin:py-pass-$n; $py -c pass; m end:py-pass-$n
  m begin:py-sort-$n; $py -c "$P"; m end:py-sort-$n
done
m begin:find-busybox; busybox find /tmp/fe -type f -exec true {} \; ; echo "rc $?"; m end:find-busybox
m begin:find-wasm; /root/find.wasm /tmp/fe -type f -exec true {} \; ; echo "rc $?"; m end:find-wasm
echo "@@T done"
