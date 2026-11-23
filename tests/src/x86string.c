// REP MOVS / REP STOS (byte, word, dword, qword) against a plain element-by-element model:
// many sizes, alignments, overlaps both ways, DF=1, page crossings, long counts, libc
// memcpy/memmove/memset, and a fault at an unmapped page. Prints "x86string ok <n>".
// Built static: gcc -O2 -fno-tree-loop-distribute-patterns -static -o tests/x86string tests/src/x86string.c
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

static int fails, checks;
static void check(const char *what, uint64_t got, uint64_t want, long a, long b, long c) {
  checks++;
  if (got != want) {
    fails++;
    if (fails < 20) printf("FAIL %s (%ld %ld %ld): %llx != %llx\n", what, a, b, c, (unsigned long long)got, (unsigned long long)want);
  }
}
static uint64_t sum(const volatile uint8_t *p, long n) {
  uint64_t h = 1469598103934665603ull;
  for (long i = 0; i < n; i++) h = (h ^ p[i]) * 1099511628211ull;
  return h;
}

// the instructions; returns the final rcx, rsi, rdi through r[]
static void movs(int sz, int back, void *d, const void *s, uint64_t n, uint64_t r[3]) {
  uint64_t c = n; void *dd = d; const void *ss = s;
  if (back) __asm__ volatile("std" ::: "memory");
  switch (sz) {
  case 1: __asm__ volatile("rep movsb" : "+c"(c), "+S"(ss), "+D"(dd) :: "memory"); break;
  case 2: __asm__ volatile("rep movsw" : "+c"(c), "+S"(ss), "+D"(dd) :: "memory"); break;
  case 4: __asm__ volatile("rep movsl" : "+c"(c), "+S"(ss), "+D"(dd) :: "memory"); break;
  default: __asm__ volatile("rep movsq" : "+c"(c), "+S"(ss), "+D"(dd) :: "memory"); break;
  }
  if (back) __asm__ volatile("cld" ::: "memory");
  r[0] = c; r[1] = (uint64_t)ss; r[2] = (uint64_t)dd;
}
static void stos(int sz, int back, void *d, uint64_t v, uint64_t n, uint64_t r[3]) {
  uint64_t c = n; void *dd = d;
  if (back) __asm__ volatile("std" ::: "memory");
  switch (sz) {
  case 1: __asm__ volatile("rep stosb" : "+c"(c), "+D"(dd) : "a"(v) : "memory"); break;
  case 2: __asm__ volatile("rep stosw" : "+c"(c), "+D"(dd) : "a"(v) : "memory"); break;
  case 4: __asm__ volatile("rep stosl" : "+c"(c), "+D"(dd) : "a"(v) : "memory"); break;
  default: __asm__ volatile("rep stosq" : "+c"(c), "+D"(dd) : "a"(v) : "memory"); break;
  }
  if (back) __asm__ volatile("cld" ::: "memory");
  r[0] = c; r[2] = (uint64_t)dd;
}
// the model: one element at a time, read whole before it is written
static void movs_ref(int sz, int back, volatile uint8_t *d, const volatile uint8_t *s, uint64_t n) {
  for (uint64_t i = 0; i < n; i++) {
    uint8_t t[8];
    for (int j = 0; j < sz; j++) t[j] = s[j];
    for (int j = 0; j < sz; j++) d[j] = t[j];
    if (back) { d -= sz; s -= sz; } else { d += sz; s += sz; }
  }
}
static void stos_ref(int sz, int back, volatile uint8_t *d, uint64_t v, uint64_t n) {
  for (uint64_t i = 0; i < n; i++) {
    for (int j = 0; j < sz; j++) d[j] = (uint8_t)(v >> (8 * j));
    if (back) d -= sz; else d += sz;
  }
}

#define AREA (3 * 4096) // three pages
static uint8_t *A, *B; // same contents; A gets the instruction, B the model
static uint32_t rs = 12345;
static uint32_t rnd(void) { rs ^= rs << 13; rs ^= rs >> 17; rs ^= rs << 5; return rs; }
static void reset(void) { volatile uint32_t *a = (uint32_t *)A, *b = (uint32_t *)B; for (long i = 0; i < AREA / 4; i++) a[i] = b[i] = rnd(); }

// the run of n elements of sz bytes starting at offset a lies inside the area
static int fits(long a, uint64_t n, int sz, int back) {
  long span = (long)(n * sz);
  return back ? (a - span + sz >= 0 && a + sz <= AREA) : (a >= 0 && a + span <= AREA && a + sz <= AREA);
}
static void one_movs(int sz, int back, long doff, long soff, uint64_t n) {
  reset();
  uint64_t r[3];
  // DF=1: the addresses are those of the last (highest) element
  movs(sz, back, A + doff, A + soff, n, r);
  movs_ref(sz, back, B + doff, B + soff, n);
  long dn = back ? -(long)(n * sz) : (long)(n * sz);
  check("movs data", sum(A, AREA), sum(B, AREA), sz * 10 + back, doff - soff, (long)n);
  check("movs rcx", r[0], 0, sz, doff, (long)n);
  check("movs rsi", r[1], (uint64_t)(A + soff + dn), sz, soff, (long)n);
  check("movs rdi", r[2], (uint64_t)(A + doff + dn), sz, doff, (long)n);
}
static void one_stos(int sz, int back, long doff, uint64_t n) {
  reset();
  uint64_t r[3], v = 0x8877665544332211ull ^ rnd();
  stos(sz, back, A + doff, v, n, r);
  stos_ref(sz, back, B + doff, v, n);
  long dn = back ? -(long)(n * sz) : (long)(n * sz);
  check("stos data", sum(A, AREA), sum(B, AREA), sz * 10 + back, doff, (long)n);
  check("stos rcx", r[0], 0, sz, doff, (long)n);
  check("stos rdi", r[2], (uint64_t)(A + doff + dn), sz, doff, (long)n);
}

int main(void) {
  A = aligned_alloc(4096, AREA); B = aligned_alloc(4096, AREA);
  static const uint64_t ns[] = { 0, 1, 2, 7, 8, 31, 64, 255, 1000, 2047 };
  static const long offs[] = { 0, 3, 8, 4093, 4096, 4097, 8190 };
  static const long gaps[] = { 0, 1, 3, 8, 9, 4095, 4100 };
  for (int sz = 1; sz <= 8; sz *= 2)
    for (int back = 0; back < 2; back++)
      for (unsigned k = 0; k < sizeof ns / sizeof *ns; k++)
        for (unsigned a = 0; a < sizeof offs / sizeof *offs; a++) {
          uint64_t n = ns[k];
          long s0 = offs[a] + (back ? (long)(n * sz) : 0); // DF=1: rsi/rdi point at the last element
          if (!fits(s0, n, sz, back)) continue;
          one_stos(sz, back, s0, n);
          long far = fits(s0 + AREA / 2, n, sz, back) ? s0 + AREA / 2 : s0 - AREA / 2; // no overlap
          if (fits(far, n, sz, back) && (long)(n * sz) <= AREA / 2) one_movs(sz, back, far, s0, n);
          for (unsigned g = 0; g < sizeof gaps / sizeof *gaps; g++) {
            if (fits(s0 + gaps[g], n, sz, back)) one_movs(sz, back, s0 + gaps[g], s0, n);
            if (gaps[g] && fits(s0 - gaps[g], n, sz, back)) one_movs(sz, back, s0 - gaps[g], s0, n);
          }
        }

  // long counts: 6 MB copy and fill, and 40 MB (more than one pause of the engine's bulk loop)
  long big = 6 << 20;
  uint8_t *x = malloc(big), *y = malloc(big);
  for (long i = 0; i < big; i++) x[i] = (uint8_t)rnd();
  uint64_t r[3];
  movs(8, 0, y, x, big / 8, r);
  check("big movsq", sum(y, big), sum(x, big), 0, 0, big);
  movs(1, 0, y + 1, x + 3, big - 8, r);
  check("big movsb unaligned", sum(y + 1, big - 8), sum(x + 3, big - 8), 0, 0, big);
  check("big movsb rcx", r[0], 0, 0, 0, 0);
  stos(4, 0, y, 0xA5A5A5A5u, big / 4, r);
  uint64_t bad = 0; for (long i = 0; i < big; i++) bad += y[i] != 0xA5;
  check("big stosd", bad, 0, 0, 0, big);
  long huge = 40 << 20; uint8_t *h = malloc(huge);
  stos(1, 0, h, 0x3C, huge, r);
  bad = 0; for (long i = 0; i < huge; i += 4093) bad += h[i] != 0x3C;
  check("40 MB stosb", bad + (h[huge - 1] != 0x3C), 0, 0, 0, huge);
  movs(8, 1, h + huge - 8, h + huge - 8 - (1 << 20), (huge - (1 << 20)) / 8, r); // backwards, overlapping
  check("40 MB movsq back rcx", r[0], 0, 0, 0, 0);
  check("40 MB movsq back rdi", r[2], (uint64_t)(h + huge - 8 - (huge - (1 << 20))), 0, 0, 0);

  // libc (musl uses rep movsq / rep stosq for big sizes)
  for (int k = 0; k < 150; k++) {
    long n = (long)(rnd() % 70000), so = (long)(rnd() % 64), dof = (long)(rnd() % 64);
    memset(y, 0x11, n + 200);
    memcpy(y + dof, x + so, n);
    check("memcpy", sum(y + dof, n), sum(x + so, n), n, so, dof);
    check("memcpy edge", y[dof + n], 0x11, n, so, dof);
    int c = (int)(rnd() & 255); memset(y + dof, c, n);
    bad = 0; for (long i = 0; i < n; i++) bad += y[dof + i] != (uint8_t)c;
    check("memset", bad + (y[dof + n] != 0x11), 0, n, c, dof);
    memcpy(y, x, n + 100);
    long mv = (long)(rnd() % 100) - 50;
    if (mv >= 0) { memmove(y + mv, y, n); check("memmove up", sum(y + mv, n), sum(x, n), n, mv, 0); }
    else { memmove(y, y - mv, n); check("memmove down", sum(y, n), sum(x - mv, n), n, mv, 0); }
  }

  // a fault in the middle: the child stops with SIGSEGV
  uint8_t *m = mmap(0, 2 * 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  munmap(m + 4096, 4096);
  pid_t pid = fork();
  if (pid == 0) { stos(1, 0, m + 100, 7, 8000, r); _exit(0); }
  int st = 0; waitpid(pid, &st, 0);
  check("fault ends the child", WIFSIGNALED(st) && WTERMSIG(st) == SIGSEGV, 1, st, 0, 0);

  if (fails) printf("x86string FAILED %d of %d\n", fails, checks);
  else printf("x86string ok %d\n", checks);
  return fails != 0;
}
