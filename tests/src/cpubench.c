// CPU benchmark for comparing x86-64 emulators (InkShell engine, Blink) with native.
// Built static with musl: musl-gcc -O2 -static -march=x86-64 -o cpubench tests/src/cpubench.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
static int cmp(const void *a, const void *b) { uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b; return x < y ? -1 : x > y; }
int main(void) {
  double t, total = 0; volatile uint64_t sink = 0;
  // 1 integer ALU: xorshift + mixing
  t = now(); uint64_t s = 88172645463325252ull, acc = 0;
  for (long i = 0; i < 60000000; i++) { s ^= s << 13; s ^= s >> 7; s ^= s << 17; acc += s * 0x9E3779B97F4A7C15ull >> 3; }
  sink += acc; t = now() - t; total += t; printf("int    %8.1f ms\n", t);
  // 2 calls: recursive fib
  t = now(); sink += fib(32); t = now() - t; total += t; printf("calls  %8.1f ms\n", t);
  // 3 memory: qsort 2M ints
  uint32_t *a = malloc(2000000 * 4); for (int i = 0; i < 2000000; i++) { s ^= s << 13; s ^= s >> 7; s ^= s << 17; a[i] = (uint32_t)s; }
  t = now(); qsort(a, 2000000, 4, cmp); t = now() - t; total += t; sink += a[1000]; printf("sort   %8.1f ms\n", t);
  // 4 strings: memcpy/memchr/strlen over 64 MB
  char *b = malloc(1 << 20), *c = malloc(1 << 20); memset(b, 'x', (1 << 20) - 1); b[(1 << 20) - 1] = 0;
  t = now(); for (int i = 0; i < 64; i++) { memcpy(c, b, 1 << 20); sink += strlen(c) + (memchr(c, 'y', 1 << 20) != 0); } t = now() - t; total += t; printf("string %8.1f ms\n", t);
  // 5 floating point
  t = now(); double x = 0; for (long i = 1; i < 30000000; i++) x += 1.0 / ((double)i * i); t = now() - t; total += t; sink += (uint64_t)(x * 1e6); printf("float  %8.1f ms\n", t);
  printf("total  %8.1f ms  (%llu)\n", total, (unsigned long long)(sink & 0xFFFF));
  return 0;
}
