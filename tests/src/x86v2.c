// x86-64-v2 (SSE3, SSSE3, SSE4.1, SSE4.2, CMPXCHG16B, LAHF/SAHF) against plain C models
// written from the Intel SDM: every instruction with register and memory operands, random
// values plus edge values (0, -1, min/max of each width), every immediate of the imm ops,
// PCMPxSTRx in all 128 modes with implicit and explicit lengths, flags (PTEST, PCMPxSTRx, LAHF
// after a compare), narrow memory operands ending at an unmapped page (PMOVSX/ZX, ROUNDSS/SD,
// INSERTPS, PINSR/PEXTR, CRC32 must not read or write past their size), known CRC-32C value.
// Each test runs many times: first in the interpreter, then in JIT code.
// The models are scalar C built without SSE3/SSSE3/SSE4 and with -fno-tree-vectorize (they do not use the ops tested).
// Prints "x86v2 ok <n>" (or "x86v2 skip" when CPUID does not announce x86-64-v2).
// Built static: gcc -O2 -fno-tree-vectorize -mssse3 -msse4.1 -msse4.2 -mcx16 -static -o tests/x86v2 tests/src/x86v2.c
#include <cpuid.h>
#include <immintrin.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

typedef union {
  __m128i v;
  uint64_t q[2];
  int64_t sq[2];
  uint32_t w[4];
  int32_t sw[4];
  uint16_t h[8];
  int16_t sh[8];
  uint8_t b[16];
  int8_t sb[16];
  float f[4];
  double d[2];
} V;

static int fails, checks;
static void pv(const char *t, const V *v) { printf(" %s %016llx%016llx", t, (unsigned long long)v->q[1], (unsigned long long)v->q[0]); }
static void check(const char *what, int imm, V a, V b, V got, V want) {
  checks++;
  if (memcmp(got.b, want.b, 16)) {
    if (++fails < 40) {
      printf("FAIL %s imm %d:", what, imm);
      pv("a", &a); pv("b", &b); pv("got", &got); pv("want", &want);
      printf("\n");
    }
  }
}
static void check_u(const char *what, int imm, uint64_t got, uint64_t want) {
  checks++;
  if (got != want && ++fails < 40) printf("FAIL %s imm %d: got %llx want %llx\n", what, imm, (unsigned long long)got, (unsigned long long)want);
}

static uint64_t rs = 0x2545F4914F6CDD1Dull;
static uint32_t rnd(void) { rs ^= rs << 13; rs ^= rs >> 7; rs ^= rs << 17; return (uint32_t)(rs >> 16); }
static const uint8_t E8[] = {0, 1, 0x7F, 0x80, 0xFF, 0x81, 0xFE};
static const uint16_t E16[] = {0, 1, 0x7FFF, 0x8000, 0xFFFF, 0x8001, 0x00FF, 0xFF80, 0x0080, 0x007F};
static const uint32_t E32[] = {0, 1, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF, 0x80000001, 0x0000FFFF, 0xFFFF0000};
static V rv(void) {
  V v;
  for (int i = 0; i < 4; i++) v.w[i] = rnd();
  switch (rnd() % 5) {
  case 1: for (int i = 0; i < 16; i++) if (rnd() & 1) v.b[i] = E8[rnd() % 7]; break;
  case 2: for (int i = 0; i < 8; i++) if (rnd() & 1) v.h[i] = E16[rnd() % 10]; break;
  case 3: for (int i = 0; i < 4; i++) if (rnd() & 1) v.w[i] = E32[rnd() % 8]; break;
  case 4: for (int i = 0; i < 2; i++) if (rnd() & 1) v.q[i] = (uint64_t)E32[rnd() % 8] << 32 | E32[rnd() % 8]; break;
  }
  return v;
}
// finite floats/doubles (sums and products stay finite: no NaN sign questions)
static float rf(void) {
  int k = rnd() % 8;
  if (k == 0) return -0.0f;
  if (k == 1) return 0.0f;
  return (float)((int)(rnd() % 200001) - 100000) / (float)(1 << (rnd() % 12));
}
static V rvf(void) { V v; for (int i = 0; i < 4; i++) v.f[i] = rf(); return v; }
static V rvd(void) { V v; for (int i = 0; i < 2; i++) v.d[i] = (double)rf() * (1.0 + (double)rnd() / 4294967296.0); return v; }
// values for ROUND*: halves, specials (inf, NaNs, -0), large
static const uint32_t SF[] = {0x7F800000, 0xFF800000, 0x7FC00001, 0x7F800123, 0xFF812345, 0x80000000, 0, 0x4B000001, 0xCB7FFFFF, 0x3EFFFFFF, 0x00000001, 0x80000001};
static const uint64_t SD[] = {0x7FF0000000000000ull, 0xFFF0000000000000ull, 0x7FF8000000000001ull, 0x7FF0000000000123ull, 0x8000000000000000ull, 0,
                              0x4330000000000001ull, 0xC32FFFFFFFFFFFFFull, 0x3FDFFFFFFFFFFFFFull, 1, 0x8000000000000001ull};
static V rvr(void) {
  V v;
  for (int i = 0; i < 4; i++) {
    int k = rnd() % 4;
    v.f[i] = k == 0 ? (float)((int)(rnd() % 41) - 20) / 2.0f : k == 1 ? rf() : 0;
    if (k >= 2) v.w[i] = SF[rnd() % 12];
  }
  if (rnd() & 1) {
    for (int i = 0; i < 2; i++) {
      int k = rnd() % 4;
      v.d[i] = k == 0 ? (double)((int)(rnd() % 41) - 20) / 2.0 : k == 1 ? (double)rf() / 3.0 : 0;
      if (k >= 2) v.q[i] = SD[rnd() % 11];
    }
  }
  return v;
}

// ---- models (built without SSE3/SSSE3/SSE4: gcc would use PMINSD & co. for plain C) ----
#pragma GCC push_options
#pragma GCC target("no-sse3,no-ssse3,no-sse4.1,no-sse4.2")
static int16_t sat16(int32_t x) { return x > 32767 ? 32767 : x < -32768 ? -32768 : x; }
#define HP16(name, expr)                                                                        \
  static V name(V a, V b) {                                                                     \
    V r;                                                                                        \
    for (int i = 0; i < 8; i++) {                                                               \
      const V *s = i < 4 ? &a : &b;                                                             \
      int32_t x = s->sh[2 * (i & 3)], y = s->sh[2 * (i & 3) + 1];                               \
      r.h[i] = (uint16_t)(expr);                                                                \
    }                                                                                           \
    return r;                                                                                   \
  }
HP16(m_phaddw, x + y)
HP16(m_phaddsw, sat16(x + y))
HP16(m_phsubw, x - y)
HP16(m_phsubsw, sat16(x - y))
static V m_phaddd(V a, V b) { V r = {{0}}; r.w[0] = a.w[0] + a.w[1]; r.w[1] = a.w[2] + a.w[3]; r.w[2] = b.w[0] + b.w[1]; r.w[3] = b.w[2] + b.w[3]; return r; }
static V m_phsubd(V a, V b) { V r = {{0}}; r.w[0] = a.w[0] - a.w[1]; r.w[1] = a.w[2] - a.w[3]; r.w[2] = b.w[0] - b.w[1]; r.w[3] = b.w[2] - b.w[3]; return r; }
static V m_pmaddubsw(V a, V b) { V r; for (int i = 0; i < 8; i++) r.sh[i] = sat16(a.b[2 * i] * b.sb[2 * i] + a.b[2 * i + 1] * b.sb[2 * i + 1]); return r; }
static V m_psignb(V a, V b) { V r; for (int i = 0; i < 16; i++) r.b[i] = b.sb[i] < 0 ? (uint8_t)-a.b[i] : b.b[i] ? a.b[i] : 0; return r; }
static V m_psignw(V a, V b) { V r; for (int i = 0; i < 8; i++) r.h[i] = b.sh[i] < 0 ? (uint16_t)-a.h[i] : b.h[i] ? a.h[i] : 0; return r; }
static V m_psignd(V a, V b) { V r; for (int i = 0; i < 4; i++) r.w[i] = b.sw[i] < 0 ? -a.w[i] : b.w[i] ? a.w[i] : 0; return r; }
static V m_pmulhrsw(V a, V b) { V r; for (int i = 0; i < 8; i++) r.h[i] = (uint16_t)((((int32_t)a.sh[i] * b.sh[i] >> 14) + 1) >> 1); return r; }
static V m_pabsb(V a, V b) { (void)a; V r; for (int i = 0; i < 16; i++) r.b[i] = b.sb[i] < 0 ? -b.sb[i] : b.sb[i]; return r; }
static V m_pabsw(V a, V b) { (void)a; V r; for (int i = 0; i < 8; i++) r.h[i] = b.sh[i] < 0 ? -(int32_t)b.sh[i] : b.sh[i]; return r; }
static V m_pabsd(V a, V b) { (void)a; V r; for (int i = 0; i < 4; i++) r.w[i] = b.sw[i] < 0 ? 0u - b.w[i] : b.w[i]; return r; }
#define MOVX(name, from, to, n, sx)                                                              \
  static V name(V a, V b) {                                                                     \
    (void)a; V r;                                                                               \
    for (int i = 0; i < n; i++) {                                                               \
      if (to == 8) r.q[i] = sx ? (uint64_t)(int64_t)((from *)b.b)[i] : (uint64_t)((from *)b.b)[i];      \
      if (to == 4) r.w[i] = sx ? (uint32_t)(int32_t)((from *)b.b)[i] : (uint32_t)((from *)b.b)[i];      \
      if (to == 2) r.h[i] = sx ? (uint16_t)(int16_t)((from *)b.b)[i] : (uint16_t)((from *)b.b)[i];      \
    }                                                                                           \
    return r;                                                                                   \
  }
MOVX(m_pmovsxbw, int8_t, 2, 8, 1)
MOVX(m_pmovsxbd, int8_t, 4, 4, 1)
MOVX(m_pmovsxbq, int8_t, 8, 2, 1)
MOVX(m_pmovsxwd, int16_t, 4, 4, 1)
MOVX(m_pmovsxwq, int16_t, 8, 2, 1)
MOVX(m_pmovsxdq, int32_t, 8, 2, 1)
MOVX(m_pmovzxbw, uint8_t, 2, 8, 0)
MOVX(m_pmovzxbd, uint8_t, 4, 4, 0)
MOVX(m_pmovzxbq, uint8_t, 8, 2, 0)
MOVX(m_pmovzxwd, uint16_t, 4, 4, 0)
MOVX(m_pmovzxwq, uint16_t, 8, 2, 0)
MOVX(m_pmovzxdq, uint32_t, 8, 2, 0)
static V m_pmuldq(V a, V b) { V r; r.sq[0] = (int64_t)a.sw[0] * b.sw[0]; r.sq[1] = (int64_t)a.sw[2] * b.sw[2]; return r; }
static V m_pcmpeqq(V a, V b) { V r; for (int i = 0; i < 2; i++) r.q[i] = a.q[i] == b.q[i] ? ~0ull : 0; return r; }
static V m_pcmpgtq(V a, V b) { V r; for (int i = 0; i < 2; i++) r.q[i] = a.sq[i] > b.sq[i] ? ~0ull : 0; return r; }
static V m_packusdw(V a, V b) {
  V r;
  for (int i = 0; i < 8; i++) { int32_t x = i < 4 ? a.sw[i] : b.sw[i - 4]; r.h[i] = x < 0 ? 0 : x > 65535 ? 65535 : x; }
  return r;
}
#define MM(name, f, n, T, op) static V name(V a, V b) { V r; for (int i = 0; i < n; i++) r.f[i] = a.f[i] op b.f[i] ? a.f[i] : b.f[i]; return r; }
MM(m_pminsb, sb, 16, int8_t, <)
MM(m_pminsd, sw, 4, int32_t, <)
MM(m_pminuw, h, 8, uint16_t, <)
MM(m_pminud, w, 4, uint32_t, <)
MM(m_pmaxsb, sb, 16, int8_t, >)
MM(m_pmaxsd, sw, 4, int32_t, >)
MM(m_pmaxuw, h, 8, uint16_t, >)
MM(m_pmaxud, w, 4, uint32_t, >)
static V m_pmulld(V a, V b) { V r; for (int i = 0; i < 4; i++) r.w[i] = a.w[i] * b.w[i]; return r; }
static V m_phminposuw(V a, V b) {
  (void)a; V r = {{0}}; int k = 0;
  for (int i = 1; i < 8; i++) if (b.h[i] < b.h[k]) k = i;
  r.h[0] = b.h[k]; r.h[1] = k;
  return r;
}
static V m_copy(V a, V b) { (void)a; return b; }
static V m_haddps(V a, V b) { V r; r.f[0] = a.f[0] + a.f[1]; r.f[1] = a.f[2] + a.f[3]; r.f[2] = b.f[0] + b.f[1]; r.f[3] = b.f[2] + b.f[3]; return r; }
static V m_hsubps(V a, V b) { V r; r.f[0] = a.f[0] - a.f[1]; r.f[1] = a.f[2] - a.f[3]; r.f[2] = b.f[0] - b.f[1]; r.f[3] = b.f[2] - b.f[3]; return r; }
static V m_haddpd(V a, V b) { V r; r.d[0] = a.d[0] + a.d[1]; r.d[1] = b.d[0] + b.d[1]; return r; }
static V m_hsubpd(V a, V b) { V r; r.d[0] = a.d[0] - a.d[1]; r.d[1] = b.d[0] - b.d[1]; return r; }
static V m_addsubps(V a, V b) { V r; for (int i = 0; i < 4; i++) r.f[i] = i & 1 ? a.f[i] + b.f[i] : a.f[i] - b.f[i]; return r; }
static V m_addsubpd(V a, V b) { V r; r.d[0] = a.d[0] - b.d[0]; r.d[1] = a.d[1] + b.d[1]; return r; }
static V m_movddup(V a, V b) { (void)a; V r; r.q[0] = r.q[1] = b.q[0]; return r; }
static V m_movshdup(V a, V b) { (void)a; V r; r.w[0] = r.w[1] = b.w[1]; r.w[2] = r.w[3] = b.w[3]; return r; }
static V m_movsldup(V a, V b) { (void)a; V r; r.w[0] = r.w[1] = b.w[0]; r.w[2] = r.w[3] = b.w[2]; return r; }

// imm ops
static V m_pblendw(V a, V b, int imm) { V r; for (int k = 0; k < 8; k++) r.h[k] = imm >> k & 1 ? b.h[k] : a.h[k]; return r; }
static V m_blendps(V a, V b, int imm) { V r; for (int k = 0; k < 4; k++) r.w[k] = imm >> k & 1 ? b.w[k] : a.w[k]; return r; }
static V m_blendpd(V a, V b, int imm) { V r; for (int k = 0; k < 2; k++) r.q[k] = imm >> k & 1 ? b.q[k] : a.q[k]; return r; }
static V m_palignr(V a, V b, int n) {
  uint8_t t[32]; V r;
  for (int i = 0; i < 16; i++) t[i] = b.b[i], t[16 + i] = a.b[i];
  for (int i = 0; i < 16; i++) r.b[i] = i + n < 32 ? t[i + n] : 0;
  return r;
}
// rounding without the libm functions (gcc would turn them into ROUNDSS/SD)
typedef union { double d; uint64_t u; } DU;
typedef union { float f; uint32_t u; } FU;
static double rnd_d(double x, int imm) {
  DU c = {x}; uint64_t u = c.u;
  if ((u >> 52 & 0x7FF) == 0x7FF) { if (u & 0xFFFFFFFFFFFFFull) c.u |= 1ull << 51; return c.d; }
  if ((u >> 52 & 0x7FF) >= 1075) return x;  // |x| >= 2^52: already an integer
  int mode = imm & 4 ? 0 : imm & 3;
  double t = (double)(int64_t)x, r;
  double fl = t > x ? t - 1 : t, ce = t < x ? t + 1 : t;
  if (mode == 1) r = fl;
  else if (mode == 2) r = ce;
  else if (mode == 3) r = t;
  else { double d = x - fl; r = d < 0.5 ? fl : d > 0.5 ? ce : ((int64_t)fl & 1) ? ce : fl; }
  if (r == 0) { DU z = {.u = u & 1ull << 63}; r = z.d; }
  return r;
}
static float rnd_f(float x, int imm) {
  FU c = {x}; uint32_t u = c.u;
  if ((u >> 23 & 0xFF) == 0xFF) { if (u & 0x7FFFFF) c.u |= 1u << 22; return c.f; }
  if ((u >> 23 & 0xFF) >= 150) return x;
  float r = (float)rnd_d((double)x, imm);  // exact: |x| < 2^23
  if (r == 0) { FU z = {.u = u & 1u << 31}; r = z.f; }
  return r;
}
static V m_roundps(V a, V b, int imm) { (void)a; V r; for (int i = 0; i < 4; i++) r.f[i] = rnd_f(b.f[i], imm); return r; }
static V m_roundpd(V a, V b, int imm) { (void)a; V r; for (int i = 0; i < 2; i++) r.d[i] = rnd_d(b.d[i], imm); return r; }
static V m_roundss(V a, V b, int imm) { V r = a; r.f[0] = rnd_f(b.f[0], imm); return r; }
static V m_roundsd(V a, V b, int imm) { V r = a; r.d[0] = rnd_d(b.d[0], imm); return r; }
static V m_insertps(V a, V b, int imm) {
  V r = a;
  r.w[imm >> 4 & 3] = b.w[imm >> 6 & 3];
  for (int k = 0; k < 4; k++) if (imm >> k & 1) r.w[k] = 0;
  return r;
}
static V m_dpps(V a, V b, int imm) {
  float p[4]; V r;
  for (int i = 0; i < 4; i++) p[i] = imm >> (4 + i) & 1 ? a.f[i] * b.f[i] : 0.0f;
  float t1 = p[0] + p[1], t2 = p[2] + p[3], t = t1 + t2;
  for (int i = 0; i < 4; i++) r.f[i] = imm >> i & 1 ? t : 0.0f;
  return r;
}
static V m_dppd(V a, V b, int imm) {
  double p[2]; V r;
  for (int i = 0; i < 2; i++) p[i] = imm >> (4 + i) & 1 ? a.d[i] * b.d[i] : 0.0;
  double t = p[0] + p[1];
  for (int i = 0; i < 2; i++) r.d[i] = imm >> i & 1 ? t : 0.0;
  return r;
}
static V m_mpsadbw(V a, V b, int imm) {
  V r; int o1 = (imm >> 2 & 1) * 4, o2 = (imm & 3) * 4;
  for (int i = 0; i < 8; i++) {
    int s = 0;
    for (int k = 0; k < 4; k++) s += abs((int)a.b[o1 + i + k] - (int)b.b[o2 + k]);
    r.h[i] = s;
  }
  return r;
}
static V m_pblendvb(V a, V b, V m) { V r; for (int i = 0; i < 16; i++) r.b[i] = m.b[i] & 0x80 ? b.b[i] : a.b[i]; return r; }
static V m_blendvps(V a, V b, V m) { V r; for (int i = 0; i < 4; i++) r.w[i] = m.w[i] >> 31 ? b.w[i] : a.w[i]; return r; }
static V m_blendvpd(V a, V b, V m) { V r; for (int i = 0; i < 2; i++) r.q[i] = m.q[i] >> 63 ? b.q[i] : a.q[i]; return r; }

// PCMPxSTRx: IntRes2 from the SDM's aggregation and polarity
static int el(V v, int i, int imm) {
  switch (imm & 3) {
  case 0: return v.b[i];
  case 1: return v.h[i];
  case 2: return v.sb[i];
  default: return v.sh[i];
  }
}
static unsigned m_pcmpstr(V a, V b, int la, int lb, int imm) {
  int n = imm & 1 ? 8 : 16;
  unsigned r = 0;
  for (int j = 0; j < n; j++) {
    int t = 0;
    switch (imm >> 2 & 3) {
    case 0:  // equal any
      for (int i = 0; i < n; i++) if (i < la && j < lb && el(a, i, imm) == el(b, j, imm)) t = 1;
      break;
    case 1:  // ranges
      for (int i = 0; i + 1 < n; i += 2)
        if (i + 1 < la && j < lb && el(b, j, imm) >= el(a, i, imm) && el(b, j, imm) <= el(a, i + 1, imm)) t = 1;
      break;
    case 2:  // equal each
      t = (j < la && j < lb) ? el(a, j, imm) == el(b, j, imm) : (j >= la && j >= lb);
      break;
    default:  // equal ordered
      t = 1;
      for (int i = 0; i < n - j; i++) {
        int k = j + i, bt;
        if (i >= la) bt = 1;
        else if (k >= lb) bt = 0;
        else bt = el(a, i, imm) == el(b, k, imm);
        t &= bt;
      }
    }
    r |= (unsigned)t << j;
  }
  switch (imm >> 4 & 3) {
  case 1: r = ~r & ((1u << n) - 1); break;
  case 3: r ^= (1u << lb) - 1; break;
  }
  return r;
}
static int ilen(V v, int imm) {
  int n = imm & 1 ? 8 : 16;
  for (int i = 0; i < n; i++) if ((imm & 1 ? v.h[i] : v.b[i]) == 0) return i;
  return n;
}
static int elen(int64_t v, int imm, int w) {
  int n = imm & 1 ? 8 : 16;
  if (!w) v = (int32_t)v;
  uint64_t u = v < 0 ? 0 - (uint64_t)v : (uint64_t)v;
  return u > (uint64_t)n ? n : (int)u;
}
// flags as z | c<<1 | s<<2 | o<<3 | p<<4
static unsigned m_strflags(unsigned r2, int la, int lb, int imm) {
  int n = imm & 1 ? 8 : 16;
  return (lb < n) | (r2 != 0) << 1 | (la < n) << 2 | (r2 & 1) << 3;
}
static unsigned m_stri(unsigned r2, int imm) {
  int n = imm & 1 ? 8 : 16;
  if (!r2) return n;
  if (imm & 0x40) return 31 - __builtin_clz(r2);
  return __builtin_ctz(r2);
}
static V m_strm(unsigned r2, int imm) {
  V r = {{0}};
  if (!(imm & 0x40)) { r.w[0] = r2; return r; }
  int n = imm & 1 ? 8 : 16;
  for (int i = 0; i < n; i++)
    if (r2 >> i & 1) { if (n == 8) r.h[i] = 0xFFFF; else r.b[i] = 0xFF; }
  return r;
}
static uint32_t m_crc(uint32_t c, uint64_t v, int bytes) {
  for (int i = 0; i < bytes; i++) {
    c ^= (uint8_t)(v >> (8 * i));
    for (int k = 0; k < 8; k++) c = c & 1 ? (c >> 1) ^ 0x82F63B78u : c >> 1;
  }
  return c;
}

#pragma GCC pop_options

// ---- instructions ----
#define OP2(nm, ins)                                                                              \
  static V nm##_r(V a, V b) { __asm__(ins " %1, %0" : "+x"(a.v) : "x"(b.v)); return a; }        \
  static V nm##_m(V a, V b) { __asm__(ins " %1, %0" : "+x"(a.v) : "m"(b)); return a; }
OP2(phaddw, "phaddw") OP2(phaddd, "phaddd") OP2(phaddsw, "phaddsw") OP2(pmaddubsw, "pmaddubsw")
OP2(phsubw, "phsubw") OP2(phsubd, "phsubd") OP2(phsubsw, "phsubsw")
OP2(psignb, "psignb") OP2(psignw, "psignw") OP2(psignd, "psignd") OP2(pmulhrsw, "pmulhrsw")
OP2(pabsb, "pabsb") OP2(pabsw, "pabsw") OP2(pabsd, "pabsd")
OP2(pmovsxbw, "pmovsxbw") OP2(pmovsxbd, "pmovsxbd") OP2(pmovsxbq, "pmovsxbq") OP2(pmovsxwd, "pmovsxwd") OP2(pmovsxwq, "pmovsxwq") OP2(pmovsxdq, "pmovsxdq")
OP2(pmovzxbw, "pmovzxbw") OP2(pmovzxbd, "pmovzxbd") OP2(pmovzxbq, "pmovzxbq") OP2(pmovzxwd, "pmovzxwd") OP2(pmovzxwq, "pmovzxwq") OP2(pmovzxdq, "pmovzxdq")
OP2(pmuldq, "pmuldq") OP2(pcmpeqq, "pcmpeqq") OP2(packusdw, "packusdw") OP2(pcmpgtq, "pcmpgtq")
OP2(pminsb, "pminsb") OP2(pminsd, "pminsd") OP2(pminuw, "pminuw") OP2(pminud, "pminud")
OP2(pmaxsb, "pmaxsb") OP2(pmaxsd, "pmaxsd") OP2(pmaxuw, "pmaxuw") OP2(pmaxud, "pmaxud")
OP2(pmulld, "pmulld") OP2(phminposuw, "phminposuw")
OP2(haddps, "haddps") OP2(hsubps, "hsubps") OP2(haddpd, "haddpd") OP2(hsubpd, "hsubpd") OP2(addsubps, "addsubps") OP2(addsubpd, "addsubpd")
OP2(movddup, "movddup") OP2(movshdup, "movshdup") OP2(movsldup, "movsldup")
static V movntdqa_m(V a, V b) { __asm__("movntdqa %1, %0" : "=x"(a.v) : "m"(b)); return a; }
static V lddqu_m(V a, V b) { __asm__("lddqu %1, %0" : "=x"(a.v) : "m"(b)); return a; }

typedef V (*F2)(V, V);
struct op2 { const char *name; F2 r, m, model; int fl; };  // fl: 0 integers, 1 floats, 2 doubles
#define E2(nm, f) {#nm, nm##_r, nm##_m, m_##nm, f}
static const struct op2 ops2[] = {
  E2(phaddw, 0), E2(phaddd, 0), E2(phaddsw, 0), E2(pmaddubsw, 0), E2(phsubw, 0), E2(phsubd, 0), E2(phsubsw, 0),
  E2(psignb, 0), E2(psignw, 0), E2(psignd, 0), E2(pmulhrsw, 0), E2(pabsb, 0), E2(pabsw, 0), E2(pabsd, 0),
  E2(pmovsxbw, 0), E2(pmovsxbd, 0), E2(pmovsxbq, 0), E2(pmovsxwd, 0), E2(pmovsxwq, 0), E2(pmovsxdq, 0),
  E2(pmovzxbw, 0), E2(pmovzxbd, 0), E2(pmovzxbq, 0), E2(pmovzxwd, 0), E2(pmovzxwq, 0), E2(pmovzxdq, 0),
  E2(pmuldq, 0), E2(pcmpeqq, 0), E2(packusdw, 0), E2(pcmpgtq, 0),
  E2(pminsb, 0), E2(pminsd, 0), E2(pminuw, 0), E2(pminud, 0), E2(pmaxsb, 0), E2(pmaxsd, 0), E2(pmaxuw, 0), E2(pmaxud, 0),
  E2(pmulld, 0), E2(phminposuw, 0),
  E2(haddps, 1), E2(hsubps, 1), E2(haddpd, 2), E2(hsubpd, 2), E2(addsubps, 1), E2(addsubpd, 2),
  E2(movddup, 0), E2(movshdup, 0), E2(movsldup, 0),
  {"movntdqa", movntdqa_m, movntdqa_m, m_copy, 0}, {"lddqu", lddqu_m, lddqu_m, m_copy, 0},
};

#define K1(K, I, n) case n: K(I, n); break;
#define K4(K, I, n) K1(K, I, n) K1(K, I, n + 1) K1(K, I, n + 2) K1(K, I, n + 3)
#define K16(K, I, n) K4(K, I, n) K4(K, I, n + 4) K4(K, I, n + 8) K4(K, I, n + 12)
#define K64(K, I, n) K16(K, I, n) K16(K, I, n + 16) K16(K, I, n + 32) K16(K, I, n + 48)
#define K128(K, I, n) K64(K, I, n) K64(K, I, n + 64)
#define K256(K, I) K128(K, I, 0) K128(K, I, 128)
#define IR(I, n) __asm__(I " %2, %1, %0" : "+x"(a.v) : "x"(b.v), "i"(n))
#define IM(I, n) __asm__(I " %2, %1, %0" : "+x"(a.v) : "m"(b), "i"(n))
#define IMF(I, n) __asm__(I " %2, %1, %0" : "+x"(a.v) : "m"(b.w[0]), "i"(n))
#define IMD(I, n) __asm__(I " %2, %1, %0" : "+x"(a.v) : "m"(b.q[0]), "i"(n))
#define OPI(nm, ins, MK)                                                                          \
  static V nm##_r(V a, V b, int imm) { switch (imm) { K256(IR, ins) } return a; }                \
  static V nm##_m(V a, V b, int imm) { switch (imm) { K256(MK, ins) } return a; }
OPI(palignr, "palignr", IM) OPI(pblendw, "pblendw", IM) OPI(blendps, "blendps", IM) OPI(blendpd, "blendpd", IM)
OPI(roundps, "roundps", IM) OPI(roundpd, "roundpd", IM) OPI(roundss, "roundss", IMF) OPI(roundsd, "roundsd", IMD)
OPI(insertps, "insertps", IMF) OPI(dpps, "dpps", IM) OPI(dppd, "dppd", IM) OPI(mpsadbw, "mpsadbw", IM)
typedef V (*FI)(V, V, int);
struct opi { const char *name; FI r, m, model; int fl, imax; };
#define EI(nm, f, mx) {#nm, nm##_r, nm##_m, m_##nm, f, mx}
static const struct opi opsi[] = {
  EI(palignr, 0, 256), EI(pblendw, 0, 256), EI(blendps, 0, 16), EI(blendpd, 0, 4), EI(roundps, 3, 16), EI(roundpd, 3, 16),
  EI(roundss, 3, 16), EI(roundsd, 3, 16), EI(insertps, 0, 256), EI(dpps, 1, 256), EI(dppd, 2, 256), EI(mpsadbw, 0, 8),
};

#define OPV(nm, ins)                                                                                              \
  static V nm##_r(V a, V b, V m) { __asm__(ins " %2, %1, %0" : "+x"(a.v) : "x"(b.v), "Yz"(m.v)); return a; }    \
  static V nm##_m(V a, V b, V m) { __asm__(ins " %2, %1, %0" : "+x"(a.v) : "m"(b), "Yz"(m.v)); return a; }
OPV(pblendvb, "pblendvb") OPV(blendvps, "blendvps") OPV(blendvpd, "blendvpd")
typedef V (*FV)(V, V, V);
static const struct { const char *name; FV r, m, model; } opsv[] = {
  {"pblendvb", pblendvb_r, pblendvb_m, m_pblendvb}, {"blendvps", blendvps_r, blendvps_m, m_blendvps}, {"blendvpd", blendvpd_r, blendvpd_m, m_blendvpd}};

#define FLAGS "\n\tsetz %[z]\n\tsetc %[c]\n\tsets %[s]\n\tseto %[o]\n\tsetp %[p]"
#define FOUT [z] "=q"(z), [c] "=q"(c), [s] "=q"(s), [o] "=q"(o), [p] "=q"(p)
#define FPACK (z | c << 1 | s << 2 | o << 3 | p << 4)
// PTEST after an add that sets OF and SF (PTEST clears them)
static unsigned ptest_r(V a, V b) {
  uint8_t z, c, s, o, p;
  __asm__("movb $0x7f, %%al\n\taddb $1, %%al\n\tptest %[b], %[a]" FLAGS : FOUT : [a] "x"(a.v), [b] "x"(b.v) : "eax", "cc");
  return FPACK;
}
static unsigned ptest_m(V a, V b) {
  uint8_t z, c, s, o, p;
  __asm__("movb $0x7f, %%al\n\taddb $1, %%al\n\tptest %[b], %[a]" FLAGS : FOUT : [a] "x"(a.v), [b] "m"(b) : "eax", "cc");
  return FPACK;
}

// PCMPxSTRx: index or mask, flags
struct sr { unsigned idx, fl; V m; };
#define SI_R(I, n) __asm__(I " %[i], %[b], %[a]" FLAGS : "=c"(r.idx), FOUT : [a] "x"(a.v), [b] "x"(b.v), [i] "i"(n), "a"(la), "d"(lb) : "cc")
#define SI_M(I, n) __asm__(I " %[i], %[b], %[a]" FLAGS : "=c"(r.idx), FOUT : [a] "x"(a.v), [b] "m"(b), [i] "i"(n), "a"(la), "d"(lb) : "cc")
#define SM_R(I, n) __asm__(I " %[i], %[b], %[a]" FLAGS : "=Yz"(r.m.v), FOUT : [a] "x"(a.v), [b] "x"(b.v), [i] "i"(n), "a"(la), "d"(lb) : "cc")
#define SM_M(I, n) __asm__(I " %[i], %[b], %[a]" FLAGS : "=Yz"(r.m.v), FOUT : [a] "x"(a.v), [b] "m"(b), [i] "i"(n), "a"(la), "d"(lb) : "cc")
#define OPS(nm, ins, KR, KM)                                                                           \
  static struct sr nm##_r(V a, V b, int64_t la, int64_t lb, int imm) {                                 \
    struct sr r = {0}; uint8_t z, c, s, o, p;                                                          \
    switch (imm) { K128(KR, ins, 0) }                                                                  \
    r.fl = FPACK; return r;                                                                            \
  }                                                                                                    \
  static struct sr nm##_m(V a, V b, int64_t la, int64_t lb, int imm) {                                 \
    struct sr r = {0}; uint8_t z, c, s, o, p;                                                          \
    switch (imm) { K128(KM, ins, 0) }                                                                  \
    r.fl = FPACK; return r;                                                                            \
  }
OPS(pcmpestri, "pcmpestri", SI_R, SI_M) OPS(pcmpistri, "pcmpistri", SI_R, SI_M)
OPS(pcmpestrm, "pcmpestrm", SM_R, SM_M) OPS(pcmpistrm, "pcmpistrm", SM_R, SM_M)
// PCMPESTRI with REX.W (64-bit lengths in rax/rdx): xmm1, xmm2, imm 0x0C (equal ordered)
static unsigned estri_w(V a, V b, int64_t la, int64_t lb) {
  register __m128i x1 __asm__("xmm1") = a.v;
  register __m128i x2 __asm__("xmm2") = b.v;
  unsigned idx;
  __asm__(".byte 0x66, 0x48, 0x0f, 0x3a, 0x61, 0xca, 0x0c" : "=c"(idx) : "x"(x1), "x"(x2), "a"(la), "d"(lb) : "cc");
  return idx;
}

// strings over a small alphabet (so the compares match), zeros for the implicit lengths
static V rstr(void) {
  static const uint8_t al[] = {'a', 'b', 'c', 'a', 'b', 0x80, 0xFF, 1, 'z', 0};
  V v;
  for (int i = 0; i < 16; i++) v.b[i] = al[rnd() % (rnd() & 1 ? 3 : 10)];
  if (rnd() % 3 == 0) v.b[rnd() % 16] = 0;
  if (rnd() % 4 == 0) for (int i = 0; i < 16; i++) if (!v.b[i]) v.b[i] = 'a';
  return v;
}
static int64_t rlen(void) {
  static const int64_t L[] = {0, 1, 7, 8, 9, 15, 16, 17, 100, -1, -8, -16, -17, 0x7FFFFFFF, -0x7FFFFFFF - 1, 0xFFFFFFF0ll, 0x100000003ll, -0x100000000ll};
  return rnd() & 1 ? (int64_t)(rnd() % 21) - 2 : L[rnd() % 18];
}

// PEXTR / PINSR / EXTRACTPS: register (upper bits of the 64-bit register checked) and memory
#define PX_R(I, n) __asm__(I " %2, %1, %k0" : "+r"(g) : "x"(a.v), "i"(n))
#define PX_RQ(I, n) __asm__(I " %2, %1, %0" : "+r"(g) : "x"(a.v), "i"(n))
#define PX_M(I, n) __asm__(I " %2, %1, %0" : "+m"(*mem) : "x"(a.v), "i"(n))
#define PI_R(I, n) __asm__(I " %2, %k1, %0" : "+x"(a.v) : "r"(g), "i"(n))
#define PI_RQ(I, n) __asm__(I " %2, %1, %0" : "+x"(a.v) : "r"(g), "i"(n))
#define PI_M(I, n) __asm__(I " %2, %1, %0" : "+x"(a.v) : "m"(*mem), "i"(n))
#define PXF(nm, ins, T, KR, KM, N)                                                                    \
  static uint64_t nm##_r(V a, int imm) { uint64_t g = ~0ull; switch (imm) { N(KR, ins, 0) } return g; } \
  static void nm##_m(V a, int imm, T *mem) { switch (imm) { N(KM, ins, 0) } }
#define PIF(nm, ins, T, KR, KM, N)                                                                    \
  static V nm##_r(V a, uint64_t g, int imm) { switch (imm) { N(KR, ins, 0) } return a; }            \
  static V nm##_m(V a, T *mem, int imm) { switch (imm) { N(KM, ins, 0) } return a; }
PXF(pextrb, "pextrb", uint8_t, PX_R, PX_M, K16) PXF(pextrw, "pextrw", uint16_t, PX_R, PX_M, K4)
PXF(pextrd, "pextrd", uint32_t, PX_R, PX_M, K4) PXF(pextrq, "pextrq", uint64_t, PX_RQ, PX_M, K4)
PXF(extractps, "extractps", uint32_t, PX_R, PX_M, K4)
PIF(pinsrb, "pinsrb", uint8_t, PI_R, PI_M, K16) PIF(pinsrd, "pinsrd", uint32_t, PI_R, PI_M, K4) PIF(pinsrq, "pinsrq", uint64_t, PI_RQ, PI_M, K4)
// PEXTRW r32, xmm, imm in its SSE4.1 encoding (66 0F 3A 15; the assembler picks 0F C5): eax, xmm1
#define PXW(I, n) __asm__(".byte 0x66, 0x0f, 0x3a, 0x15, 0xc8, %c2" : "+a"(g) : "x"(x1), "i"(n))
static uint64_t pextrw3a_r(V a, int imm) {
  register __m128i x1 __asm__("xmm1") = a.v;
  uint64_t g = ~0ull;
  switch (imm) { K4(PXW, "", 0) }
  return g;
}

static uint8_t *page;  // two pages, the second one unmapped: narrow operands end at the first's end
static int gate(void) {
  long ps = sysconf(_SC_PAGESIZE);
  page = mmap(0, 2 * ps, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (page == MAP_FAILED || munmap(page + ps, ps)) return 0;
  page += ps;  // one past the end of the readable page
  return 1;
}

static V rin(int fl) { return fl == 1 ? rvf() : fl == 2 ? rvd() : fl == 3 ? rvr() : rv(); }

static void t_ops2(void) {
  for (unsigned k = 0; k < sizeof ops2 / sizeof *ops2; k++) {
    const struct op2 *o = &ops2[k];
    V a = rin(o->fl), b = rin(o->fl), w = o->model(a, b);
    check(o->name, -1, a, b, o->r(a, b), w);
    check(o->name, -2, a, b, o->m(a, b), w);
  }
}
static void t_opsi(int imm_fixed) {
  for (unsigned k = 0; k < sizeof opsi / sizeof *opsi; k++) {
    const struct opi *o = &opsi[k];
    int imm = imm_fixed >= 0 ? imm_fixed % o->imax : (int)(rnd() % o->imax);
    V a = rin(o->fl), b = rin(o->fl);
    V w = o->model(a, b, imm);
    check(o->name, imm, a, b, o->r(a, b, imm), w);
    // a memory source of ROUNDSS/SD and INSERTPS is one element (INSERTPS: count_s is ignored)
    V bm = b;
    if (o->r == insertps_r) bm.w[imm >> 6 & 3] = b.w[0];
    check(o->name, imm + 1000, a, b, o->m(a, b, imm), o->model(a, bm, imm));
  }
}
static void t_blendv(void) {
  for (int k = 0; k < 3; k++) {
    V a = rv(), b = rv(), m = rv(), w = opsv[k].model(a, b, m);
    check(opsv[k].name, -1, a, b, opsv[k].r(a, b, m), w);
    check(opsv[k].name, -2, a, b, opsv[k].m(a, b, m), w);
  }
}
static void t_ptest(void) {
  V a = rv(), b = rv();
  if (rnd() % 3 == 0) for (int i = 0; i < 2; i++) b.q[i] &= ~a.q[i];
  if (rnd() % 3 == 0) for (int i = 0; i < 2; i++) b.q[i] &= a.q[i];
  if (rnd() % 5 == 0) b.q[0] = b.q[1] = 0;
  int z = !((a.q[0] & b.q[0]) | (a.q[1] & b.q[1])), c = !((~a.q[0] & b.q[0]) | (~a.q[1] & b.q[1]));
  check_u("ptest", -1, ptest_r(a, b), z | c << 1);
  check_u("ptest", -2, ptest_m(a, b), z | c << 1);
}
static void t_str(int imm) {
  V a = rstr(), b = rstr();
  if (rnd() & 1) {  // b holds a copy of a part of a (substring search)
    int at = rnd() % 16, from = rnd() % 16, len = rnd() % 6;
    for (int i = 0; i < len && at + i < 16 && from + i < 16; i++) b.b[at + i] = a.b[from + i];
  }
  int64_t la = rlen(), lb = rlen();
  // explicit lengths
  int ea = elen(la, imm, 0), eb = elen(lb, imm, 0);
  unsigned r2 = m_pcmpstr(a, b, ea, eb, imm), fl = m_strflags(r2, ea, eb, imm);
  struct sr g = pcmpestri_r(a, b, la, lb, imm);
  check_u("pcmpestri", imm, g.idx, m_stri(r2, imm)); check_u("pcmpestri flags", imm, g.fl, fl);
  g = pcmpestri_m(a, b, la, lb, imm);
  check_u("pcmpestri m", imm, g.idx, m_stri(r2, imm)); check_u("pcmpestri m flags", imm, g.fl, fl);
  g = pcmpestrm_r(a, b, la, lb, imm);
  check("pcmpestrm", imm, a, b, g.m, m_strm(r2, imm)); check_u("pcmpestrm flags", imm, g.fl, fl);
  g = pcmpestrm_m(a, b, la, lb, imm);
  check("pcmpestrm m", imm, a, b, g.m, m_strm(r2, imm)); check_u("pcmpestrm m flags", imm, g.fl, fl);
  // implicit lengths
  ea = ilen(a, imm), eb = ilen(b, imm);
  r2 = m_pcmpstr(a, b, ea, eb, imm), fl = m_strflags(r2, ea, eb, imm);
  g = pcmpistri_r(a, b, la, lb, imm);
  check_u("pcmpistri", imm, g.idx, m_stri(r2, imm)); check_u("pcmpistri flags", imm, g.fl, fl);
  g = pcmpistri_m(a, b, la, lb, imm);
  check_u("pcmpistri m", imm, g.idx, m_stri(r2, imm)); check_u("pcmpistri m flags", imm, g.fl, fl);
  g = pcmpistrm_r(a, b, la, lb, imm);
  check("pcmpistrm", imm, a, b, g.m, m_strm(r2, imm)); check_u("pcmpistrm flags", imm, g.fl, fl);
  g = pcmpistrm_m(a, b, la, lb, imm);
  check("pcmpistrm m", imm, a, b, g.m, m_strm(r2, imm)); check_u("pcmpistrm m flags", imm, g.fl, fl);
  // 64-bit lengths
  ea = elen(la, 0x0C, 1), eb = elen(lb, 0x0C, 1);
  check_u("pcmpestri rex.w", 0x0C, estri_w(a, b, la, lb), m_stri(m_pcmpstr(a, b, ea, eb, 0x0C), 0x0C));
}
static void t_extr_ins(void) {
  V a = rv();
  uint64_t mem = ((uint64_t)rnd() << 32) | rnd(), g = ((uint64_t)rnd() << 32) | rnd();
  int i16 = rnd() % 16, i8 = rnd() % 8, i4 = rnd() % 4, i2 = rnd() % 2;
  check_u("pextrb", i16, pextrb_r(a, i16), a.b[i16]);
  check_u("pextrw", i8 & 3, pextrw_r(a, i8 & 3), a.h[i8 & 3]);
  check_u("pextrw 3a15", i4, pextrw3a_r(a, i4), a.h[i4]);
  check_u("pextrd", i4, pextrd_r(a, i4), a.w[i4]);
  check_u("pextrq", i2, pextrq_r(a, i2), a.q[i2]);
  check_u("extractps", i4, extractps_r(a, i4), a.w[i4]);
  uint64_t m = mem; pextrb_m(a, i16, (uint8_t *)&m); check_u("pextrb m", i16, m, (mem & ~0xFFull) | a.b[i16]);
  m = mem; pextrw_m(a, i8 & 3, (uint16_t *)&m); check_u("pextrw m", i8 & 3, m, (mem & ~0xFFFFull) | a.h[i8 & 3]);
  m = mem; pextrd_m(a, i4, (uint32_t *)&m); check_u("pextrd m", i4, m, (mem & ~0xFFFFFFFFull) | a.w[i4]);
  m = mem; pextrq_m(a, i2, &m); check_u("pextrq m", i2, m, a.q[i2]);
  m = mem; extractps_m(a, i4, (uint32_t *)&m); check_u("extractps m", i4, m, (mem & ~0xFFFFFFFFull) | a.w[i4]);
  V w = a; w.b[i16] = (uint8_t)g;
  check("pinsrb", i16, a, a, pinsrb_r(a, g, i16), w);
  check("pinsrb m", i16, a, a, pinsrb_m(a, (uint8_t *)&g, i16), w);
  w = a; w.w[i4] = (uint32_t)g;
  check("pinsrd", i4, a, a, pinsrd_r(a, g, i4), w);
  check("pinsrd m", i4, a, a, pinsrd_m(a, (uint32_t *)&g, i4), w);
  w = a; w.q[i2] = g;
  check("pinsrq", i2, a, a, pinsrq_r(a, g, i2), w);
  check("pinsrq m", i2, a, a, pinsrq_m(a, &g, i2), w);
}
static void t_crc(void) {
  uint64_t v = ((uint64_t)rnd() << 32) | rnd(), c = ((uint64_t)rnd() << 32) | rnd(), r;
  uint32_t c32 = (uint32_t)c;
  uint8_t v8 = (uint8_t)v; uint16_t v16 = (uint16_t)v; uint32_t v32 = (uint32_t)v;
  r = c; __asm__("crc32b %1, %k0" : "+r"(r) : "q"(v8)); check_u("crc32b", 0, r, m_crc(c32, v, 1));
  r = c; __asm__("crc32b %1, %q0" : "+r"(r) : "q"(v8)); check_u("crc32b r64", 0, r, m_crc(c32, v, 1));
  r = c; __asm__("crc32w %1, %k0" : "+r"(r) : "r"(v16)); check_u("crc32w", 0, r, m_crc(c32, v, 2));
  r = c; __asm__("crc32l %1, %k0" : "+r"(r) : "r"(v32)); check_u("crc32l", 0, r, m_crc(c32, v, 4));
  r = c; __asm__("crc32q %1, %q0" : "+r"(r) : "r"(v)); check_u("crc32q", 0, r, m_crc(c32, v, 8));
  r = c; __asm__("crc32b %1, %k0" : "+r"(r) : "m"(v8)); check_u("crc32b m", 0, r, m_crc(c32, v, 1));
  r = c; __asm__("crc32w %1, %k0" : "+r"(r) : "m"(v16)); check_u("crc32w m", 0, r, m_crc(c32, v, 2));
  r = c; __asm__("crc32l %1, %k0" : "+r"(r) : "m"(v32)); check_u("crc32l m", 0, r, m_crc(c32, v, 4));
  r = c; __asm__("crc32q %1, %q0" : "+r"(r) : "m"(v)); check_u("crc32q m", 0, r, m_crc(c32, v, 8));
}
static void t_cx16(void) {
  static __attribute__((aligned(16))) uint64_t m[2];
  uint64_t lo = ((uint64_t)rnd() << 32) | rnd(), hi = ((uint64_t)rnd() << 32) | rnd(), nlo = rnd(), nhi = ~(uint64_t)rnd();
  int eq = rnd() & 1;
  m[0] = lo; m[1] = eq ? hi : hi ^ 1;
  uint64_t a = lo, d = hi; uint8_t z;
  __asm__ volatile("lock cmpxchg16b %[m]\n\tsetz %[z]" : [m] "+m"(m), "+a"(a), "+d"(d), [z] "=q"(z) : "b"(nlo), "c"(nhi) : "cc", "memory");
  check_u("cmpxchg16b zf", eq, z, eq);
  check_u("cmpxchg16b lo", eq, m[0], eq ? nlo : lo);
  check_u("cmpxchg16b hi", eq, m[1], eq ? nhi : hi ^ 1);
  check_u("cmpxchg16b rax", eq, a, lo);
  check_u("cmpxchg16b rdx", eq, d, eq ? hi : hi ^ 1);
}
// LAHF/SAHF (AF, bit 4, is not compared: the emulator does not keep it)
static void t_lahf(void) {
  uint64_t v = (uint64_t)(rnd() & 0xFF) << 8, in = v >> 8;
  __asm__("sahf\n\tlahf" : "+a"(v) : : "cc");
  check_u("sahf/lahf", (int)in, v >> 8 & 0xEF, (in & 0xC5) | 2);
  uint32_t x = rnd(), y = rnd() & 3 ? rnd() : x;
  uint64_t f = 0;
  __asm__("cmpl %2, %1\n\tlahf" : "+a"(f) : "r"(x), "r"(y) : "cc");
  uint32_t d = x - y;
  unsigned want = (x < y) | 2 | (__builtin_parity(d & 0xFF) ? 0 : 4) | (d == 0) << 6 | (d >> 31) << 7;
  check_u("cmp/lahf", 0, f >> 8 & 0xEF, want);
}
// narrow memory operands that end at the unmapped page: a wider access would fault
#define NARROW_LD(ins, n, model)                                                                   \
  {                                                                                                \
    uint8_t *p = page - n; for (int i = 0; i < n; i++) p[i] = b.b[i];                              \
    V r = a; __asm__(ins " %1, %0" : "+x"(r.v) : "m"(*(const uint8_t(*)[n])p));                   \
    check(ins " narrow", n, a, b, r, model);                                                       \
  }
#define NARROW_LDI(ins, n, imm, model)                                                             \
  {                                                                                                \
    uint8_t *p = page - n; for (int i = 0; i < n; i++) p[i] = b.b[i];                              \
    V r = a; __asm__(ins " %2, %1, %0" : "+x"(r.v) : "m"(*(const uint8_t(*)[n])p), "i"(imm));     \
    check(ins " narrow", n, a, b, r, model);                                                       \
  }
static void t_narrow(void) {
  V a = rv(), b = rv(), bf = rvr();
  NARROW_LD("pmovsxbw", 8, m_pmovsxbw(a, b)) NARROW_LD("pmovsxbd", 4, m_pmovsxbd(a, b)) NARROW_LD("pmovsxbq", 2, m_pmovsxbq(a, b))
  NARROW_LD("pmovsxwd", 8, m_pmovsxwd(a, b)) NARROW_LD("pmovsxwq", 4, m_pmovsxwq(a, b)) NARROW_LD("pmovsxdq", 8, m_pmovsxdq(a, b))
  NARROW_LD("pmovzxbw", 8, m_pmovzxbw(a, b)) NARROW_LD("pmovzxbd", 4, m_pmovzxbd(a, b)) NARROW_LD("pmovzxbq", 2, m_pmovzxbq(a, b))
  NARROW_LD("pmovzxwd", 8, m_pmovzxwd(a, b)) NARROW_LD("pmovzxwq", 4, m_pmovzxwq(a, b)) NARROW_LD("pmovzxdq", 8, m_pmovzxdq(a, b))
  b = bf;
  NARROW_LDI("roundss", 4, 9, m_roundss(a, b, 9)) NARROW_LDI("roundsd", 8, 10, m_roundsd(a, b, 10))
  NARROW_LDI("insertps", 4, 0xE6, m_insertps(a, b, 0x26))
  uint8_t *p = page - 8;
  memcpy(p, &b.q[0], 8);
  V w = a; w.q[1] = b.q[0];
  check("pinsrq narrow", 8, a, b, pinsrq_m(a, (uint64_t *)p, 1), w);
  w = a; w.b[15] = p[7];
  check("pinsrb narrow", 1, a, b, pinsrb_m(a, p + 7, 15), w);
  pextrb_m(a, 3, p + 7); check_u("pextrb narrow", 3, p[7], a.b[3]);
  pextrw_m(a, 2, (uint16_t *)(p + 6)); check_u("pextrw narrow", 2, *(uint16_t *)(p + 6), a.h[2]);
  extractps_m(a, 1, (uint32_t *)(p + 4)); check_u("extractps narrow", 1, *(uint32_t *)(p + 4), a.w[1]);
  uint64_t r = 0;
  __asm__("crc32b %1, %k0" : "+r"(r) : "m"(p[7])); check_u("crc32b narrow", 0, r, m_crc(0, p[7], 1));
}
// CRC-32C ("Castagnoli") of "123456789" is e3069283 (initial and final value ~0)
static void t_crc_known(void) {
  const char *s = "123456789";
  uint32_t c = ~0u;
  for (int i = 0; i < 9; i++) c = _mm_crc32_u8(c, (uint8_t)s[i]);
  check_u("crc32c 123456789", 0, ~c, 0xE3069283u);
  uint64_t c64 = ~0u;
  c64 = _mm_crc32_u64(c64, 0x3837363534333231ull);
  c = _mm_crc32_u8((uint32_t)c64, '9');
  check_u("crc32c 123456789 (u64)", 0, ~c, 0xE3069283u);
}

int main(void) {
  unsigned a, b, c, d;
  __cpuid(1, a, b, c, d);
  const unsigned want = 1u << 0 | 1u << 9 | 1u << 13 | 1u << 19 | 1u << 20 | 1u << 23;
  if ((c & want) != want) { printf("x86v2 skip (leaf 1 ecx %08x)\n", c); return 0; }
  __cpuid(0x80000000, a, b, c, d);
  if (a < 0x80000001) { printf("x86v2 skip (no leaf 0x80000001)\n"); return 0; }
  __cpuid(0x80000001, a, b, c, d);
  if (!(c & 1)) { printf("x86v2 skip (no LAHF/SAHF in 64-bit mode)\n"); return 0; }
  if (!gate()) { printf("x86v2 FAIL mmap\n"); return 1; }
  t_crc_known();
  // every immediate once (interpreter), then a few immediates many times (JIT)
  for (int imm = 0; imm < 256; imm++) t_opsi(imm);
  for (int imm = 0; imm < 128; imm++) t_str(imm);
  for (int i = 0; i < 1000; i++) {
    t_ops2(); t_blendv(); t_ptest(); t_extr_ins(); t_crc(); t_cx16(); t_lahf(); t_narrow();
    t_opsi(-1);
    t_opsi((int[]){0, 0x0F, 0x1B, 0x55, 0xF1, 0xFF, 0x3D, 0x09}[i & 7]);
    t_str((int[]){0x00, 0x0C, 0x04, 0x08, 0x1A, 0x3A, 0x44, 0x71, 0x0D, 0x19}[i % 10]);
    if (i % 4 == 0) t_str(rnd() % 128);
  }
  if (fails) { printf("x86v2 FAIL %d of %d\n", fails, checks); return 1; }
  printf("x86v2 ok %d\n", checks);
  return 0;
}
