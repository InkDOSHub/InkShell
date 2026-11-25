// JIT warm-up vs steady state for calls (item 46): cpubench's recursive fib(32) run REPS times in
// one process (run 0 = what the "calls" bench measures, later runs = steady state), then one long
// fib(LONG) (~0.5-1 s natively). Same fib as tests/src/cpubench.c. Measurement only.
// usage: x86fib [REPS, default 20] [LONG, default 42]
//   prints "x86fib start", "x86fib run K MS ms" per run, "x86fib long N MS ms", "x86fib end SUM"
// Built static: gcc -O2 -static -o x86fib tests/src/x86fib.c
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
int main(int argc, char **argv) {
  int reps = argc > 1 ? atoi(argv[1]) : 20, big = argc > 2 ? atoi(argv[2]) : 42;
  volatile int n = 32;
  long sum = 0;
  double t;
  printf("x86fib start\n"); fflush(stdout);
  for (int r = 0; r < reps; r++) {
    t = now(); sum += fib(n); t = now() - t;
    printf("x86fib run %d %.2f ms\n", r, t); fflush(stdout);
  }
  n = big;
  t = now(); sum += fib(n); t = now() - t;
  printf("x86fib long %d %.1f ms\n", big, t);
  printf("x86fib end %ld\n", sum);
  return 0;
}
