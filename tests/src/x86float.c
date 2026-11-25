// Float microbench (item 42): where the time of cpubench's float loop (x += 1.0 / ((double)i * i),
// 9 instructions per iteration) goes, by adding its instructions one at a time, plus the same
// loop on x87 and loop-carried add chains (xmm, x87, general register). Same asm natively and
// on the engine; ns per iteration of each variant. Measurement only.
// usage: x86float [M iterations, default 30]   prints "x86float NAME ns/iter result"
// Built static: gcc -O2 -static -o x86float tests/src/x86float.c
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e9 + t.tv_nsec; }
static long n;
static void show(const char *name, double t0, double r) { printf("x86float %-10s %6.2f ns/iter %.6g\n", name, (now() - t0) / n, r); }

int main(int argc, char **argv) {
  n = (argc > 1 ? atol(argv[1]) : 30) * 1000000L;
  double one = 1.0, x;
  long i, m = n + 1, k;
  double t;
  // general register loop only: add, cmp, jne
  t = now(); i = 1;
  __asm__ volatile("1: add $1, %0\n\tcmp %1, %0\n\tjne 1b" : "+r"(i) : "r"(m));
  show("int", t, (double)i);
  // + pxor, cvtsi2sd
  t = now(); i = 1;
  __asm__ volatile("1: pxor %%xmm0, %%xmm0\n\tcvtsi2sd %0, %%xmm0\n\tadd $1, %0\n\tcmp %1, %0\n\tjne 1b" : "+r"(i) : "r"(m) : "xmm0");
  show("cvt", t, (double)i);
  // + mulsd
  t = now(); i = 1;
  __asm__ volatile("1: pxor %%xmm0, %%xmm0\n\tcvtsi2sd %0, %%xmm0\n\tadd $1, %0\n\tmulsd %%xmm0, %%xmm0\n\tcmp %1, %0\n\tjne 1b" : "+r"(i) : "r"(m) : "xmm0");
  show("cvt+mul", t, (double)i);
  // + movapd, divsd
  t = now(); i = 1;
  __asm__ volatile("movsd %2, %%xmm3\n1: pxor %%xmm0, %%xmm0\n\tmovapd %%xmm3, %%xmm2\n\tcvtsi2sd %0, %%xmm0\n\tadd $1, %0\n\tmulsd %%xmm0, %%xmm0\n\tdivsd %%xmm0, %%xmm2\n\tcmp %1, %0\n\tjne 1b"
                   : "+r"(i) : "r"(m), "m"(one) : "xmm0", "xmm2", "xmm3");
  show("+div", t, (double)i);
  // + addsd: the whole cpubench loop (sum of 1/i^2 -> pi^2/6)
  t = now(); i = 1; x = 0;
  __asm__ volatile("movsd %3, %%xmm3\n1: pxor %%xmm0, %%xmm0\n\tmovapd %%xmm3, %%xmm2\n\tcvtsi2sd %0, %%xmm0\n\tadd $1, %0\n\tmulsd %%xmm0, %%xmm0\n\tdivsd %%xmm0, %%xmm2\n\taddsd %%xmm2, %1\n\tcmp %2, %0\n\tjne 1b"
                   : "+r"(i), "+x"(x) : "r"(m), "m"(one) : "xmm0", "xmm2", "xmm3");
  show("full", t, x);
  // the same loop on x87: fild, fmul, fld1, fdiv, fstp, faddp (sum in st0)
  t = now(); i = 1; x = 0;
  {
    long cell;
    __asm__ volatile("fldz\n1: mov %0, %2\n\tfildll %2\n\tfmul %%st(0), %%st\n\tfld1\n\tfdiv %%st(1), %%st\n\tfstp %%st(1)\n\tfaddp\n\tadd $1, %0\n\tcmp %3, %0\n\tjne 1b\n\tfstpl %1"
                     : "+r"(i), "=m"(x), "=m"(cell) : "r"(m) : "st", "st(1)", "st(2)");
  }
  show("x87 full", t, x);
  // loop-carried add chains: xmm (addsd), x87 (fadd), general register (add)
  t = now(); i = 1; x = 0;
  __asm__ volatile("movsd %3, %%xmm2\n1: addsd %%xmm2, %1\n\tadd $1, %0\n\tcmp %2, %0\n\tjne 1b" : "+r"(i), "+x"(x) : "r"(m), "m"(one) : "xmm2");
  show("addsd", t, x);
  t = now(); i = 1; x = 0;
  __asm__ volatile("fldz\n\tfld1\n1: fadd %%st, %%st(1)\n\tadd $1, %0\n\tcmp %2, %0\n\tjne 1b\n\tfstp %%st(0)\n\tfstpl %1" : "+r"(i), "=m"(x) : "r"(m) : "st", "st(1)");
  show("x87 fadd", t, x);
  t = now(); i = 1; k = 0;
  __asm__ volatile("1: add %3, %1\n\tadd $1, %0\n\tcmp %2, %0\n\tjne 1b" : "+r"(i), "+r"(k) : "r"(m), "r"(3L));
  show("int add", t, (double)k);
  return 0;
}
