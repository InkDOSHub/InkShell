// Calls and returns under the JIT: every result is computed two ways (recursive and plain loop)
// and compared, so the program checks itself. Prints "x86calls ok <n>" or the failing checks.
// Built static: gcc -O2 -static -pthread -o tests/x86calls tests/src/x86calls.c
#include <pthread.h>
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

#define NI __attribute__((noinline))
static int fails, checks;
static void check(const char *what, uint64_t got, uint64_t want) {
  checks++;
  if (got != want && ++fails <= 30) { printf("FAIL %s: %llu != %llu\n", what, (unsigned long long)got, (unsigned long long)want); }
}

// 1 recursion: fib, deep linear recursion, Ackermann
NI static uint64_t fib(int n) { return n < 2 ? (uint64_t)n : fib(n - 1) + fib(n - 2); }
static uint64_t fib_loop(int n) { uint64_t a = 0, b = 1; while (n--) { uint64_t t = a + b; a = b; b = t; } return a; }
NI static uint64_t deep(volatile int n, uint64_t x) { if (n == 0) return x; uint64_t r = deep(n - 1, x * 31 + n); return r ^ (uint64_t)n; }
static uint64_t deep_loop(int n, uint64_t x) {
  uint64_t xs = x; for (int k = n; k > 0; k--) xs = xs * 31 + k;
  for (int k = 1; k <= n; k++) xs ^= (uint64_t)k;
  return xs;
}
NI static uint64_t ack(uint64_t m, uint64_t n) { return m == 0 ? n + 1 : n == 0 ? ack(m - 1, 1) : ack(m - 1, ack(m, n - 1)); }

// 2 mutual recursion
NI static int is_odd(unsigned n);
NI static int is_even(unsigned n) { return n == 0 ? 1 : is_odd(n - 1); }
NI static int is_odd(unsigned n) { return n == 0 ? 0 : is_even(n - 1); }
NI static uint64_t hof(int n);
NI static uint64_t hom(int n);
NI static uint64_t hof(int n) { if ((unsigned)n > 40) return 1000; return n == 0 ? 1 : (uint64_t)n - hom((int)hof(n - 1)); } // Hofstadter F/M
NI static uint64_t hom(int n) { if ((unsigned)n > 40) return 1000; return n == 0 ? 0 : (uint64_t)n - hof((int)hom(n - 1)); }

// 3 function pointers: a table, qsort callbacks, a callback calling back
typedef uint64_t (*op_t)(uint64_t, uint64_t);
NI static uint64_t op_add(uint64_t a, uint64_t b) { return a + b; }
NI static uint64_t op_xor(uint64_t a, uint64_t b) { return a ^ (b * 7); }
NI static uint64_t op_mul(uint64_t a, uint64_t b) { return a * (b | 1); }
NI static uint64_t op_rot(uint64_t a, uint64_t b) { return (a << 13 | a >> 51) + b; }
static op_t ops[4] = { op_add, op_xor, op_mul, op_rot };
static volatile op_t vops[4] = { op_add, op_xor, op_mul, op_rot };
static int cmp_u32(const void *a, const void *b) { uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b; return x < y ? -1 : x > y; }
NI static uint64_t apply_n(op_t f, uint64_t a, int n) { for (int i = 0; i < n; i++) a = f(a, (uint64_t)i); return a; }
NI static uint64_t rec_ptr(op_t const *t, int n, uint64_t a) { return n == 0 ? a : t[n & 3](rec_ptr(t, n - 1, a), (uint64_t)n); }

// 4 tail calls (gcc -O2 turns these into jumps) and a switch through a jump table
NI static uint64_t tail_sum(uint64_t n, uint64_t acc) { if (n == 0) return acc; return tail_sum(n - 1, acc + n * n); }
NI static uint64_t tail_b(uint64_t n, uint64_t acc);
NI static uint64_t tail_a(uint64_t n, uint64_t acc) { if (n == 0) return acc; return tail_b(n - 1, acc * 3 + 1); }
NI static uint64_t tail_b(uint64_t n, uint64_t acc) { if (n == 0) return acc; return tail_a(n - 1, acc ^ (acc >> 3)); }
NI static uint64_t sw(uint64_t x, int k) {
  switch (k & 7) {
  case 0: return x + 1; case 1: return x * 3; case 2: return x ^ 0x55; case 3: return x - 7;
  case 4: return x << 1; case 5: return x >> 1; case 6: return ~x; default: return x * x;
  }
}

// 5 setjmp/longjmp out of deep recursion (the shadow of the return addresses is wrong after it)
static jmp_buf jb;
NI static int dive(int n, int at) { if (n == at) longjmp(jb, n + 1); return dive(n + 1, at) + 1; }

// 6 a return address changed by hand: ret goes somewhere no call came from
#if defined(__x86_64__)
uint64_t swap_ret_target(void);
__asm__(".text\n.globl swap_ret_target\nswap_ret_target:\n"
        "  lea 1f(%rip), %rax\n  push %rax\n  mov $1, %eax\n  ret\n"   // returns to 1:, no call came from there
        "  mov $99, %eax\n  ret\n"
        "1:\n  add $41, %eax\n  ret\n");                                     // ... which returns to the caller
uint64_t ret_imm(uint64_t a);
__asm__(".text\n.globl ret_imm\nret_imm:\n  pop %rcx\n  push %rdi\n  push %rdi\n  push %rcx\n"
        "  lea 3(%rdi), %rax\n  ret $16\n");                                 // ret imm16 drops two pushed words
#endif

// 7 signals: a handler running in the middle of deep recursion, and siglongjmp out of one
static volatile int ticks;
static sigjmp_buf sjb;
static volatile int jump_out;
static void on_alarm(int s) { (void)s; ticks++; if (jump_out && ticks >= 3) siglongjmp(sjb, 1); }
NI static uint64_t spin(int n) { return n == 0 ? 0 : spin(n - 1) + (uint64_t)(n & 3); }

// 8 threads: recursion and pointer calls on two threads at once
static void *thr(void *a) {
  int id = (int)(intptr_t)a; uint64_t s = 0;
  for (int r = 0; r < 40; r++) s += fib(18 + id) + rec_ptr(ops, 200, (uint64_t)r);
  return (void *)(uintptr_t)s;
}

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  fputs("[fib] ", stderr);
  for (int n = 0; n < 26; n++) check("fib", fib(n), fib_loop(n));
  for (int r = 0; r < 20; r++) check("deep", deep(20000 + r, (uint64_t)r), deep_loop(20000 + r, (uint64_t)r));
  check("ack", ack(2, 300), 603);
  check("ack3", ack(3, 6), 509);

  fputs("[mutual] ", stderr);
  int e = 0; for (unsigned n = 0; n < 3000; n++) e += is_even(n) != !(n & 1) || is_odd(n) != (int)(n & 1);
  check("even/odd", (uint64_t)e, 0);
  uint64_t F[40], M[40]; F[0] = 1; M[0] = 0;
  for (int n = 1; n < 40; n++) { M[n] = (uint64_t)n - F[M[n - 1]]; F[n] = (uint64_t)n - M[F[n - 1]]; } // M[n] first: F[n-1] can be n
  e = 0; for (int n = 0; n < 40; n++) e += hof(n) != F[n] || hom(n) != M[n];
  check("hofstadter", (uint64_t)e, 0);

  fputs("[fptr] ", stderr);
  uint64_t a1 = 1, a2 = 1;
  for (int i = 0; i < 100000; i++) { a1 = ops[i & 3](a1, (uint64_t)i); a2 = vops[i & 3](a2, (uint64_t)i); }
  uint64_t a3 = 1;
  for (int i = 0; i < 100000; i++) {
    uint64_t b = (uint64_t)i;
    switch (i & 3) { case 0: a3 = a3 + b; break; case 1: a3 = a3 ^ (b * 7); break; case 2: a3 = a3 * (b | 1); break; default: a3 = (a3 << 13 | a3 >> 51) + b; }
  }
  check("fptr table", a1, a3);
  check("fptr volatile", a2, a3);
  uint64_t p1 = 5, p2 = 5; for (int i = 0; i < 4; i++) { p1 = apply_n(ops[i], p1, 5000); for (int k = 0; k < 5000; k++) p2 = ops[i](p2, (uint64_t)k); }
  check("fptr arg", p1, p2);
  uint64_t r1 = rec_ptr(ops, 3000, 9), r2 = 9; for (int n = 1; n <= 3000; n++) r2 = ops[n & 3](r2, (uint64_t)n);
  check("fptr recursive", r1, r2);
  uint32_t *v = malloc(50000 * 4); uint32_t s = 2463534242u; uint64_t sum0 = 0;
  for (int i = 0; i < 50000; i++) { s ^= s << 13; s ^= s >> 17; s ^= s << 5; v[i] = s; sum0 += s; }
  qsort(v, 50000, 4, cmp_u32);
  uint64_t sum1 = 0; int bad = 0; for (int i = 0; i < 50000; i++) { sum1 += v[i]; bad += i && v[i - 1] > v[i]; }
  check("qsort order", (uint64_t)bad, 0); check("qsort sum", sum1, sum0);

  fputs("[tail] ", stderr);
  uint64_t t1 = 0; for (uint64_t k = 1; k <= 100000; k++) t1 += k * k;
  check("tail self", tail_sum(100000, 0), t1);
  uint64_t ta = 7; for (uint64_t n = 100001; n > 0; n--) ta = (n & 1) ? ta * 3 + 1 : ta ^ (ta >> 3);
  check("tail mutual", tail_a(100001, 7), ta);
  uint64_t w1 = 3, w2 = 3;
  for (int k = 0; k < 200000; k++) { w1 = sw(w1, k); uint64_t x = w2; switch (k & 7) { case 0: x = x + 1; break; case 1: x = x * 3; break; case 2: x = x ^ 0x55; break; case 3: x = x - 7; break; case 4: x = x << 1; break; case 5: x = x >> 1; break; case 6: x = ~x; break; default: x = x * x; } w2 = x; }
  check("switch", w1, w2);

  fputs("[longjmp] ", stderr);
  uint64_t lj = 0;
  for (int r = 0; r < 300; r++) { volatile int at = 50 + r * 7; int got = setjmp(jb); if (got == 0) dive(0, at); else lj += (uint64_t)got; }
  uint64_t lj2 = 0; for (int r = 0; r < 300; r++) lj2 += (uint64_t)(50 + r * 7 + 1);
  check("longjmp", lj, lj2);
  check("after longjmp", fib(20), 6765);

#if defined(__x86_64__)
  fputs("[asm] ", stderr);
  uint64_t sr = 0; for (int r = 0; r < 1000; r++) sr += swap_ret_target();
  check("changed return address", sr, 42000);
  uint64_t ri = 0; for (uint64_t r = 0; r < 1000; r++) ri += ret_imm(r);
  check("ret imm16", ri, 1000 * 3 + 999 * 1000 / 2);
#endif

  fputs("[signals] ", stderr);
  struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_handler = on_alarm; sigaction(SIGALRM, &sa, 0);
  struct itimerval it = { { 0, 2000 }, { 0, 2000 } }; setitimer(ITIMER_REAL, &it, 0);
  uint64_t sp1 = 0; for (int r = 0; r < 1000000 && ticks < 3; r++) sp1 += spin(5000) - spin(4999);
  int got_tick = ticks > 0;
  jump_out = 1;
  int out = 0;
  if (sigsetjmp(sjb, 1) == 0) { for (;;) spin(20000); } else out = 1;
  it.it_value.tv_usec = it.it_interval.tv_usec = 0; setitimer(ITIMER_REAL, &it, 0);
  check("signal during recursion", (uint64_t)got_tick, 1);
  check("siglongjmp out of recursion", (uint64_t)out, 1);
  check("recursion after signals", spin(1000), 1500);
  (void)sp1;

  fputs("[threads] ", stderr);
  pthread_t th[2]; void *res[2];
  for (int k = 0; k < 2; k++) pthread_create(&th[k], 0, thr, (void *)(intptr_t)k);
  for (int k = 0; k < 2; k++) pthread_join(th[k], &res[k]);
  for (int k = 0; k < 2; k++) { uint64_t w = 0; for (int r = 0; r < 40; r++) { uint64_t x = (uint64_t)r; for (int n = 1; n <= 200; n++) x = ops[n & 3](x, (uint64_t)n); w += fib_loop(18 + k) + x; } check("threads", (uint64_t)(uintptr_t)res[k], w); }

  if (fails) printf("x86calls FAILED %d of %d\n", fails, checks);
  else printf("x86calls ok %d\n", checks);
  return fails != 0;
}
