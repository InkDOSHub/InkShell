# Item 77a: GNU make (WebAssembly) running its recipes through the host channel /dev/inksoc.
# Run by tests/linux-test.mjs with INK_SPAWN=1 INK_WASI_THREADS=1 (recipes are x86 busybox sh/sed/cat children; the recursive make is WebAssembly).
M=/root/make.wasm
B=busybox
rm -rf /tmp/mk && mkdir -p /tmp/mk/sub && cd /tmp/mk || exit 1
printf 'hello\n' > a.in; printf 'world\n' > b.in
printf 'PREFIX = p-\nNAME = mk-name\n' > vars.mk
cat > Makefile <<'EOF'
include vars.mk
OUTS := $(patsubst %.in,%.out,$(sort $(wildcard *.in)))
NOW := $(shell echo shell-ok)
.PHONY: all clean fail rec
all: total.txt
	@echo all-done $(NOW) $(NAME)
%.out: %.in
	sed 's/^/$(PREFIX)/' $< > $@
total.txt: $(OUTS)
	cat $^ > $@
clean:
	rm -f *.out total.txt
fail:
	@echo before-fail
	false
	@echo never-here
rec:
	$(MAKE) -C sub
EOF
printf 'x:\n\t@echo in-sub $$(pwd)\n' > sub/Makefile
$M > log1 2>&1; echo r1=$?
$B cat log1
echo "n1=$($B grep -c '^sed ' log1)"
echo "total=$($B tr '\n' ' ' < total.txt)"
$M total.txt; echo r2=$?
$B sleep 1; $B touch b.in
$M > log3 2>&1; echo r3=$?
echo "n3=$($B grep -c '^sed ' log3) b3=$($B grep -c 'b.in > b.out' log3)"
$B sleep 1; $B touch a.in
$M -n > log4 2>&1; echo r4=$?
echo "n4=$($B grep -c '^sed ' log4) a4=$($B grep -c 'a.in > a.out' log4) stale=$([ a.out -ot a.in ] && echo 1)"
$M fail; echo rf=$?
$M -k fail all > log5 2>&1; echo rk=$?
echo "k5=$($B grep -c all-done log5) never=$($B grep -c never-here log5)"
cd /tmp && $M -C /tmp/mk/sub; echo rc=$?
cd /tmp/mk && $M rec; echo rr=$?
$M clean && $M -j2 > log6 2>&1; echo rj=$?
echo "j6=$($B grep -c '^sed ' log6) total6=$($B tr '\n' ' ' < total.txt)"
# 50 targets, each one child (sh -c with a redirection): the time is printed by linux-test.mjs
$B mkdir -p /tmp/mk50 && cd /tmp/mk50 && { printf 'T := $(addprefix t,$(addsuffix .o,1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50))\n.PHONY: all\nall: $(T)\n%%.o:\n\techo $@ > $@\n'; } > Makefile
echo "mk50-t0=$($B cut -d' ' -f1 /proc/uptime)"
$M -s; echo r50=$? n50=$($B ls /tmp/mk50/*.o | $B wc -l)
echo "mk50-t1=$($B cut -d' ' -f1 /proc/uptime)"
echo make-end
