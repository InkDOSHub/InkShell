#!/bin/sh
# Item 51 (tests/bench/browser-tools.mjs): the catalog's WebAssembly tools on /mnt (mounted by the host in
# pieces), REPS reps each. Markers "@@T begin:X.N" / "@@T end:X.N" (the host stamps each line), "@@RC X.N rc"
# per rep, "@@V X output" = last output (to check that the tool did the work).
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
R=${REPS:-3}
m() { echo "@@T $1"; }
t() { # t NAME CMD...: R timed reps, output to /tmp/o.NAME (last rep kept)
  n=$1; shift; i=1
  while [ $i -le $R ]; do
    m begin:$n.$i; "$@" > /tmp/o.$n 2>&1; rc=$?; m end:$n.$i
    echo "@@RC $n.$i $rc"; i=$((i + 1))
  done
  echo "@@V $n $(head -c 160 /tmp/o.$n | tr '\n' ' ')"
}
B=/mnt/b/big.bin; C=/mnt/b/big.csv; J=/mnt/b/big.jsonl
mkdir -p /tmp/u
# cold start: the first run of each tool compiles its module (--version, no big file)
for p in sha256sum zip unzip rg sqlite3 jq; do t v-$p $p --version; done
# the work, on the 64 MB files of /mnt
t sha256 sha256sum $B
t zip sh -c "rm -f /tmp/big.zip; zip -q -1 -j /tmp/big.zip $B"
echo "@@V zipsize $(stat -c %s /tmp/big.zip)"
t unzip sh -c "rm -f /tmp/u/big.bin; unzip -q -o /tmp/big.zip -d /tmp/u"
echo "@@V unzipsize $(stat -c %s /tmp/u/big.bin)"
rm -rf /tmp/u /tmp/big.zip
t rg rg -c --color never word777, $C
t jq jq -c 'select(.n==777)|.id' $J
t sqlite-ins sh -c "rm -f /tmp/t.db; sqlite3 /tmp/t.db \"create table t(a,b,c); with recursive s(i) as (select 1 union all select i+1 from s where i<300000) insert into t select i,'w'||(i%1000),i*7 from s; select count(*),sum(c) from t where b='w77';\""
rm -f /tmp/t.db
t sqlite-imp sqlite3 -csv :memory: "create table t(a,b,c);" ".import $C t" "select count(*),sum(c) from t where b='word777';"
echo "@@T done"
