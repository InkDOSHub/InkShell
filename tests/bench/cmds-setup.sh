#!/bin/sh
# Item 88: untimed data for tests/bench/cmds.tsv. Needs D (work dir) and BB ("busybox " in the VM, empty natively).
mkdir -p $D/many $D/x && cd $D
i=1; while [ $i -le 200 ]; do : > $D/many/f$i; i=$((i + 1)); done
${BB}awk 'BEGIN { for (i = 1; i <= 2000; i++) print "w" i ",word" (i % 50) "," (i * 7 % 100) }' > $D/words.txt
${BB}awk 'BEGIN { for (i = 1; i <= 100; i++) print "line" i " b" i " c" i }' > $D/l100.txt
${BB}tar cf $D/a.tar -C $D many
${BB}gzip -c $D/words.txt > $D/words.gz
: > $D/exe; echo ok
