#!/bin/sh
# Item 88 (tests/bench/browser-cmds.mjs): everyday commands in the VM with every small catalog WASM tool installed.
# Per row of /root/cmds.tsv (name TAB programs TAB command): "@@V which-NAME" = what each program resolves to,
# then R timed reps of "sh -c COMMAND": "@@T begin:NAME.N" / "@@T end:NAME.N" (the host stamps each line), "@@RC NAME.N rc".
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export D=/tmp/cb BB="busybox "
R=${REPS:-2}
m() { echo "@@T $1"; }
busybox mkdir -p $D
sh /root/cmds-setup.sh > /dev/null 2>&1
cd $D
echo "@@V setup files $(busybox ls $D/many | busybox wc -l) words $(busybox wc -l < $D/words.txt)"
while IFS='	' read -r n p c; do
  w=''; for x in $p; do w="$w $x=$(command -v $x 2>/dev/null || echo none)"; done
  echo "@@V which-$n$w"
  i=1
  while [ $i -le $R ]; do
    m begin:$n.$i; sh -c "$c" > /tmp/o.$n 2>&1 < /dev/null; rc=$?; m end:$n.$i
    echo "@@RC $n.$i $rc"; [ $rc = 0 ] || echo "@@V out-$n $(busybox head -c 300 /tmp/o.$n | busybox tr '\n\r' '  ')"; i=$((i + 1))
  done
done < /root/cmds.tsv
echo "@@T done"
