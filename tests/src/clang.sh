# Item 77: clang (WebAssembly, apk add clang) compiles C to WASI programs that run here; GNU make (77a) drives it.
# Run by tests/linux-test.mjs with INK_CLANG=1 INK_WASI_THREADS=1, after apk add clang (as root).
M=/root/make.wasm
B=busybox
rm -rf /tmp/cc && mkdir -p /tmp/cc && cd /tmp/cc || exit 1
clang --version | $B head -n 1
printf '#include <stdio.h>\nint main(int argc, char **argv) { printf("hello from clang argc=%%d\\n", argc); return 7; }\n' > hello.c
echo "cc-t0=$($B cut -d' ' -f1 /proc/uptime)"
clang hello.c -o hello; echo c1=$?
echo "cc-t1=$($B cut -d' ' -f1 /proc/uptime)"
clang -### hello.c -o hello 2>&1 | $B tail -n 2 | $B cut -c1-90 | $B sed "s/^/plan: /"
./hello a b; echo h1=$?
echo "mode=$($B stat -c %A hello) magic=$($B head -c 4 hello | $B od -An -tx1 | $B tr -d ' ')"
# a compile error: clang's message and a failing exit status
printf 'int main(void) { return nope; }\n' > bad.c
clang bad.c -o bad 2> err.txt; echo cb=$? ue=$($B grep -c 'undeclared identifier' err.txt)
# two files and a header, built by make with its built-in %.o: %.c rule (CC = cc); the program reads a relative path
printf 'int add(int a, int b);\n' > calc.h
printf '#include "calc.h"\nint add(int a, int b) { return a + b; }\n' > calc.c
printf '#include <stdio.h>\n#include <stdlib.h>\n#include "calc.h"\nint main(int argc, char **argv) {\n  char line[64] = "";\n  FILE *f = fopen("data.txt", "r");\n  if (f) { fgets(line, sizeof line, f); fclose(f); }\n  printf("sum=%%d data=%%s", add(atoi(argv[1]), atoi(argv[2])), line);\n  return 0;\n}\n' > main.c
printf 'from-data\n' > data.txt
printf 'CFLAGS = -O2\nprog: main.o calc.o\n\t$(CC) $(CFLAGS) -o $@ main.o calc.o\nmain.o calc.o: calc.h\n' > Makefile
$M; echo m1=$?
./prog 6 7; echo p1=$?
$M; echo m2=$?
# -c, then ar (llvm-ar: symbol index for wasm-ld) and a link against the archive
clang -c calc.c -o c2.o && ar rcs libcalc.a c2.o && clang main.c -L. -lcalc -o prog2; echo l1=$?
./prog2 1 2; echo p2=$?
# C++ (libc++), information only
printf '#include <iostream>\n#include <vector>\nint main() { std::vector<int> v{1, 2, 3}; int s = 0; for (int x : v) s += x; std::cout << "cpp sum " << s << std::endl; }\n' > hi.cpp
clang++ -O1 hi.cpp -o hicpp; echo cx=$?
./hicpp; echo hx=$?
echo clang-end
