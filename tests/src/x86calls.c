// Calls microbench (item 43): where the time of cpubench's recursive fib goes, built up step by step
// (empty loop, + call/ret of an empty function, + push/pop pair, + mov store/load at [rsp]), plus
// the stack accesses without a call and the same store/load on a heap cell (TLB path, not RSP).
// Same asm natively and on the engine; ns per iteration of each variant. Measurement only.
// usage: x86calls [M iterations, default 20]   prints "x86calls NAME ns/iter result"
// Built static: gcc -O2 -static -o x86calls tests/src/x86calls.c
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e9 + t.tv_nsec; }
static long n;
static void show(const char *name, double t0, long r) { printf("x86calls %-12s %6.2f ns/iter %ld\n", name, (now() - t0) / n, r); }

// every loop leaves 128 bytes below rsp untouched (the compiler's red zone) and jumps over its function
#define ENTER "sub $128, %%rsp\n\t"
#define LEAVE "add $128, %%rsp\n\t"

int main(int argc, char **argv) {
  n = (argc > 1 ? atol(argv[1]) : 20) * 1000000L;
  long i, m = n, k = 0, cell = 0;
  double t;
  // 1 empty loop: add, cmp, jne
  t = now(); i = 0;
  __asm__ volatile(ENTER "1: add $1, %0\n\tcmp %1, %0\n\tjne 1b\n\t" LEAVE : "+r"(i) : "r"(m) : "memory");
  show("loop", t, i);
  // 2 + call/ret of an empty function
  t = now(); i = 0;
  __asm__ volatile(ENTER "jmp 2f\n9: ret\n2: call 9b\n\tadd $1, %0\n\tcmp %1, %0\n\tjne 2b\n\t" LEAVE : "+r"(i) : "r"(m) : "memory");
  show("call", t, i);
  // 3 + push/pop pair inside the function
  t = now(); i = 0;
  __asm__ volatile(ENTER "jmp 2f\n9: push %%rbx\n\tpop %%rbx\n\tret\n2: call 9b\n\tadd $1, %0\n\tcmp %1, %0\n\tjne 2b\n\t" LEAVE : "+r"(i) : "r"(m) : "memory");
  show("call+push", t, i);
  // 4 + mov store/load at [rsp] inside the function
  t = now(); i = 0; k = 0;
  __asm__ volatile(ENTER "jmp 2f\n9: push %%rbx\n\tsub $16, %%rsp\n\tmov %0, (%%rsp)\n\tmov (%%rsp), %%rbx\n\tadd %%rbx, %1\n\tadd $16, %%rsp\n\tpop %%rbx\n\tret\n"
                   "2: call 9b\n\tadd $1, %0\n\tcmp %2, %0\n\tjne 2b\n\t" LEAVE : "+r"(i), "+r"(k) : "r"(m) : "rbx", "memory");
  show("call+mov", t, k);
  // 5 stack accesses without a call: push/pop pair in the loop
  t = now(); i = 0;
  __asm__ volatile(ENTER "1: push %0\n\tpop %0\n\tadd $1, %0\n\tcmp %1, %0\n\tjne 1b\n\t" LEAVE : "+r"(i) : "r"(m) : "memory");
  show("push/pop", t, i);
  // 6 mov store/load at [rsp+8] in the loop
  t = now(); i = 0; k = 0;
  __asm__ volatile(ENTER "1: mov %0, 8(%%rsp)\n\tmov 8(%%rsp), %%rax\n\tadd %%rax, %1\n\tadd $1, %0\n\tcmp %2, %0\n\tjne 1b\n\t" LEAVE
                   : "+r"(i), "+r"(k) : "r"(m) : "rax", "memory");
  show("mov[rsp]", t, k);
  // 7 the same store/load on a heap cell (base register is not RSP: the full TLB path)
  t = now(); i = 0; k = 0;
  {
    long *p = &cell;
    __asm__ volatile("1: mov %0, (%3)\n\tmov (%3), %%rax\n\tadd %%rax, %1\n\tadd $1, %0\n\tcmp %2, %0\n\tjne 1b"
                     : "+r"(i), "+r"(k) : "r"(m), "r"(p) : "rax", "memory");
  }
  show("mov[heap]", t, k);
  return 0;
}
