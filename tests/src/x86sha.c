// SHA extensions (SHA256RNDS2/MSG1/MSG2, SHA1RNDS4/NEXTE/MSG1/MSG2) and the SSSE3/SSE4.1 ops
// their code uses (PSHUFB, PALIGNR, PBLENDW) against a plain C model written from the Intel SDM:
// random values, register and memory operands, every SHA1RNDS4 function and several
// PALIGNR/PBLENDW immediates; then whole SHA-256 and SHA-1 through the instructions against a
// scalar C implementation: FIPS 180 "abc" and 1 MB of pseudo-random data.
// "x86sha bench N": MB/s of SHA-256 and SHA-1 over N MB, instructions vs scalar C.
// Prints "x86sha ok <n>" (or "x86sha skip" when CPUID does not announce SHA).
// Built static: gcc -O2 -static -o tests/x86sha tests/src/x86sha.c
#include <cpuid.h>
#include <emmintrin.h>
#include <immintrin.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef union { __m128i v; uint32_t w[4]; uint16_t h[8]; uint8_t b[16]; } V;

static int fails, checks;
static void check(const char *what, const V *got, const V *want, const V *a, const V *b, int imm) {
  checks++;
  if (memcmp(got->b, want->b, 16)) {
    fails++;
    if (fails < 30)
      printf("FAIL %s imm %d: a %08x%08x%08x%08x b %08x%08x%08x%08x got %08x%08x%08x%08x want %08x%08x%08x%08x\n", what, imm,
             a->w[3], a->w[2], a->w[1], a->w[0], b->w[3], b->w[2], b->w[1], b->w[0], got->w[3], got->w[2], got->w[1], got->w[0],
             want->w[3], want->w[2], want->w[1], want->w[0]);
  }
}

static uint64_t rs = 0x9E3779B97F4A7C15ull;
static uint32_t rnd(void) { rs ^= rs << 13; rs ^= rs >> 7; rs ^= rs << 17; return (uint32_t)(rs >> 16); }
static V rv(void) { V v; for (int i = 0; i < 4; i++) v.w[i] = rnd(); return v; }

// ---- model ----
static uint32_t ror(uint32_t x, int n) { return x >> n | x << (32 - n); }
static uint32_t rol(uint32_t x, int n) { return x << n | x >> (32 - n); }
static uint32_t s0(uint32_t x) { return ror(x, 7) ^ ror(x, 18) ^ x >> 3; }
static uint32_t s1(uint32_t x) { return ror(x, 17) ^ ror(x, 19) ^ x >> 10; }
static uint32_t S0(uint32_t x) { return ror(x, 2) ^ ror(x, 13) ^ ror(x, 22); }
static uint32_t S1(uint32_t x) { return ror(x, 6) ^ ror(x, 11) ^ ror(x, 25); }

static V m_pshufb(V a, V b) { V r; for (int i = 0; i < 16; i++) r.b[i] = b.b[i] & 0x80 ? 0 : a.b[b.b[i] & 15]; return r; }
static V m_palignr(V a, V b, int n) {
  uint8_t t[32]; V r;
  memcpy(t, b.b, 16); memcpy(t + 16, a.b, 16);
  for (int i = 0; i < 16; i++) r.b[i] = i + n < 32 ? t[i + n] : 0;
  return r;
}
static V m_pblendw(V a, V b, int imm) { V r; for (int k = 0; k < 8; k++) r.h[k] = imm >> k & 1 ? b.h[k] : a.h[k]; return r; }
static V m_rnds2(V d, V s, V k) {
  uint32_t A = s.w[3], B = s.w[2], C = d.w[3], D = d.w[2], E = s.w[1], F = s.w[0], G = d.w[1], H = d.w[0];
  for (int i = 0; i < 2; i++) {
    uint32_t ch = (E & F) ^ (~E & G), maj = (A & B) ^ (A & C) ^ (B & C);
    uint32_t t = ch + S1(E) + k.w[i] + H;
    uint32_t a2 = t + maj + S0(A), e2 = t + D;
    H = G; G = F; F = E; E = e2; D = C; C = B; B = A; A = a2;
  }
  V r; r.w[3] = A; r.w[2] = B; r.w[1] = E; r.w[0] = F; return r;
}
static V m_msg1(V d, V s) {
  V r; r.w[3] = d.w[3] + s0(s.w[0]); r.w[2] = d.w[2] + s0(d.w[3]); r.w[1] = d.w[1] + s0(d.w[2]); r.w[0] = d.w[0] + s0(d.w[1]); return r;
}
static V m_msg2(V d, V s) {
  uint32_t w16 = d.w[0] + s1(s.w[2]), w17 = d.w[1] + s1(s.w[3]), w18 = d.w[2] + s1(w16), w19 = d.w[3] + s1(w17);
  V r; r.w[0] = w16; r.w[1] = w17; r.w[2] = w18; r.w[3] = w19; return r;
}
static uint32_t f1(int i, uint32_t b, uint32_t c, uint32_t d) {
  return i == 0 ? (b & c) ^ (~b & d) : i == 2 ? (b & c) ^ (b & d) ^ (c & d) : b ^ c ^ d;
}
static const uint32_t K1[4] = {0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xCA62C1D6};
static V m_rnds4(V d, V s, int f) {
  uint32_t A = d.w[3], B = d.w[2], C = d.w[1], D = d.w[0], E = 0;
  for (int i = 0; i < 4; i++) {
    uint32_t t = f1(f, B, C, D) + rol(A, 5) + s.w[3 - i] + E + K1[f];
    E = D; D = C; C = rol(B, 30); B = A; A = t;
  }
  V r; r.w[3] = A; r.w[2] = B; r.w[1] = C; r.w[0] = D; return r;
}
static V m_nexte(V d, V s) { V r = s; r.w[3] += rol(d.w[3], 30); return r; }
static V m_s1msg1(V d, V s) { V r; r.w[3] = d.w[1] ^ d.w[3]; r.w[2] = d.w[0] ^ d.w[2]; r.w[1] = s.w[3] ^ d.w[1]; r.w[0] = s.w[2] ^ d.w[0]; return r; }
static V m_s1msg2(V d, V s) {
  V r; r.w[3] = rol(d.w[3] ^ s.w[2], 1); r.w[2] = rol(d.w[2] ^ s.w[1], 1); r.w[1] = rol(d.w[1] ^ s.w[0], 1); r.w[0] = rol(d.w[0] ^ r.w[3], 1); return r;
}

// ---- the instructions (register and memory forms) ----
#define OP2(name, ins, model)                                                                              \
  static void t_##name(V a, V b) {                                                                       \
    V r = a, m = a, w = model(a, b);                                                                     \
    __asm__ volatile(ins " %1, %0" : "+x"(r.v) : "x"(b.v));                                              \
    check(#name, &r, &w, &a, &b, -1);                                                                   \
    __asm__ volatile(ins " %1, %0" : "+x"(m.v) : "m"(b.v));                                              \
    check(#name " mem", &m, &w, &a, &b, -1);                                                            \
  }
OP2(pshufb, "pshufb", m_pshufb)
OP2(sha256msg1, "sha256msg1", m_msg1)
OP2(sha256msg2, "sha256msg2", m_msg2)
OP2(sha1nexte, "sha1nexte", m_nexte)
OP2(sha1msg1, "sha1msg1", m_s1msg1)
OP2(sha1msg2, "sha1msg2", m_s1msg2)

static void t_rnds2(V a, V b, V k) {
  V r = a, m = a, w = m_rnds2(a, b, k);
  __asm__ volatile("sha256rnds2 %2, %1, %0" : "+x"(r.v) : "x"(b.v), "Yz"(k.v));
  check("sha256rnds2", &r, &w, &a, &b, -1);
  __asm__ volatile("sha256rnds2 %2, %1, %0" : "+x"(m.v) : "m"(b.v), "Yz"(k.v));
  check("sha256rnds2 mem", &m, &w, &a, &b, -1);
}
#define OPI(name, ins, model, imm)                                                                         \
  do {                                                                                                   \
    V r = a, m = a, w = model(a, b, imm);                                                                \
    __asm__ volatile(ins " %2, %1, %0" : "+x"(r.v) : "x"(b.v), "i"(imm));                                \
    check(#name, &r, &w, &a, &b, imm);                                                                  \
    __asm__ volatile(ins " %2, %1, %0" : "+x"(m.v) : "m"(b.v), "i"(imm));                                \
    check(#name " mem", &m, &w, &a, &b, imm);                                                           \
  } while (0)
static void t_imm(V a, V b) {
  OPI(palignr, "palignr", m_palignr, 0); OPI(palignr, "palignr", m_palignr, 4); OPI(palignr, "palignr", m_palignr, 8);
  OPI(palignr, "palignr", m_palignr, 15); OPI(palignr, "palignr", m_palignr, 16); OPI(palignr, "palignr", m_palignr, 20);
  OPI(palignr, "palignr", m_palignr, 33);
  OPI(pblendw, "pblendw", m_pblendw, 0x00); OPI(pblendw, "pblendw", m_pblendw, 0xF0); OPI(pblendw, "pblendw", m_pblendw, 0x5A);
  OPI(pblendw, "pblendw", m_pblendw, 0xFF);
  OPI(sha1rnds4, "sha1rnds4", m_rnds4, 0); OPI(sha1rnds4, "sha1rnds4", m_rnds4, 1);
  OPI(sha1rnds4, "sha1rnds4", m_rnds4, 2); OPI(sha1rnds4, "sha1rnds4", m_rnds4, 3);
}

// ---- whole hashes ----
static const uint32_t K256[64] = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
static uint32_t be32(const uint8_t *p) { return (uint32_t)p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3]; }

static void sha256_c(uint32_t st[8], const uint8_t *p, size_t n) {
  for (; n--; p += 64) {
    uint32_t w[64], v[8];
    for (int i = 0; i < 16; i++) w[i] = be32(p + 4 * i);
    for (int i = 16; i < 64; i++) w[i] = s1(w[i - 2]) + w[i - 7] + s0(w[i - 15]) + w[i - 16];
    memcpy(v, st, 32);
    for (int i = 0; i < 64; i++) {
      uint32_t t1 = v[7] + S1(v[4]) + ((v[4] & v[5]) ^ (~v[4] & v[6])) + K256[i] + w[i];
      uint32_t t2 = S0(v[0]) + ((v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]));
      memmove(v + 1, v, 28); v[4] += t1; v[0] = t1 + t2;
    }
    for (int i = 0; i < 8; i++) st[i] += v[i];
  }
}
static void sha1_c(uint32_t st[5], const uint8_t *p, size_t n) {
  for (; n--; p += 64) {
    uint32_t w[80], a = st[0], b = st[1], c = st[2], d = st[3], e = st[4];
    for (int i = 0; i < 16; i++) w[i] = be32(p + 4 * i);
    for (int i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    for (int i = 0; i < 80; i++) {
      uint32_t t = rol(a, 5) + f1(i / 20, b, c, d) + e + K1[i / 20] + w[i];
      e = d; d = c; c = rol(b, 30); b = a; a = t;
    }
    st[0] += a; st[1] += b; st[2] += c; st[3] += d; st[4] += e;
  }
}

#define SHA __attribute__((target("sha,ssse3,sse4.1")))
static const uint8_t BSWAP32[16] = {3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12};
static const uint8_t BSWAP128[16] = {15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0};

SHA static void sha256_ni(uint32_t st[8], const uint8_t *p, size_t n) {
  const __m128i mask = _mm_loadu_si128((const __m128i *)BSWAP32);
  __m128i t = _mm_shuffle_epi32(_mm_loadu_si128((const __m128i *)st), 0xB1);      // B A D C
  __m128i cdgh = _mm_shuffle_epi32(_mm_loadu_si128((const __m128i *)(st + 4)), 0x1B); // H G F E
  __m128i abef = _mm_alignr_epi8(t, cdgh, 8);                                        // F E B A
  cdgh = _mm_blend_epi16(cdgh, t, 0xF0);                                             // H G D C
  for (; n--; p += 64) {
    __m128i sa = abef, sc = cdgh, m[16];
    for (int i = 0; i < 4; i++) m[i] = _mm_shuffle_epi8(_mm_loadu_si128((const __m128i *)(p + 16 * i)), mask);
    for (int g = 0; g < 16; g++) {
      if (g >= 4)
        m[g] = _mm_sha256msg2_epu32(_mm_add_epi32(_mm_sha256msg1_epu32(m[g - 4], m[g - 3]), _mm_alignr_epi8(m[g - 1], m[g - 2], 4)), m[g - 1]);
      __m128i wk = _mm_add_epi32(m[g], _mm_loadu_si128((const __m128i *)(K256 + 4 * g)));
      cdgh = _mm_sha256rnds2_epu32(cdgh, abef, wk);
      wk = _mm_shuffle_epi32(wk, 0x0E);
      abef = _mm_sha256rnds2_epu32(abef, cdgh, wk);
    }
    abef = _mm_add_epi32(abef, sa);
    cdgh = _mm_add_epi32(cdgh, sc);
  }
  t = _mm_shuffle_epi32(abef, 0x1B);          // A B E F
  cdgh = _mm_shuffle_epi32(cdgh, 0xB1);       // G H C D
  _mm_storeu_si128((__m128i *)st, _mm_blend_epi16(t, cdgh, 0xF0));        // A B C D
  _mm_storeu_si128((__m128i *)(st + 4), _mm_alignr_epi8(cdgh, t, 8));     // E F G H
}

#define R4(f) abcd = _mm_sha1rnds4_epu32(abcd, we, f)
SHA static void sha1_ni(uint32_t st[5], const uint8_t *p, size_t n) {
  const __m128i mask = _mm_loadu_si128((const __m128i *)BSWAP128);
  uint32_t e4[4];  // through memory (volatile): no PINSRD/PEXTRD from the compiler
  volatile uint32_t *ve = e4;
  ve[0] = ve[1] = ve[2] = 0; ve[3] = st[4];
  __m128i abcd = _mm_shuffle_epi32(_mm_loadu_si128((const __m128i *)st), 0x1B), e0 = _mm_loadu_si128((const __m128i *)e4);
  for (; n--; p += 64) {
    __m128i sa = abcd, se = e0, m[20], prev = abcd, we;
    for (int i = 0; i < 4; i++) m[i] = _mm_shuffle_epi8(_mm_loadu_si128((const __m128i *)(p + 16 * i)), mask);
    for (int g = 4; g < 20; g++) m[g] = _mm_sha1msg2_epu32(_mm_xor_si128(_mm_sha1msg1_epu32(m[g - 4], m[g - 3]), m[g - 2]), m[g - 1]);
    for (int g = 0; g < 20; g++) {
      we = g == 0 ? _mm_add_epi32(e0, m[0]) : _mm_sha1nexte_epu32(prev, m[g]);
      prev = abcd;
      switch (g / 5) {
        case 0: R4(0); break;
        case 1: R4(1); break;
        case 2: R4(2); break;
        default: R4(3); break;
      }
    }
    e0 = _mm_sha1nexte_epu32(prev, se);
    abcd = _mm_add_epi32(abcd, sa);
  }
  _mm_storeu_si128((__m128i *)st, _mm_shuffle_epi32(abcd, 0x1B));
  _mm_storeu_si128((__m128i *)e4, e0);
  st[4] = ve[3];
}

// padded message: n bytes of `d` + 0x80 + zeros + 64-bit bit length (big-endian)
static uint8_t *pad(const uint8_t *d, size_t n, size_t *blocks) {
  size_t nb = (n + 9 + 63) / 64;
  uint8_t *p = calloc(nb, 64);
  memcpy(p, d, n); p[n] = 0x80;
  for (int i = 0; i < 8; i++) p[nb * 64 - 1 - i] = (uint8_t)((uint64_t)n * 8 >> (8 * i));
  *blocks = nb;
  return p;
}
static const uint32_t IV256[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
static const uint32_t IV1[5] = {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0};
static void hashes(const char *what, const uint8_t *d, size_t n, const uint32_t *want256, const uint32_t *want1) {
  size_t nb; uint8_t *p = pad(d, n, &nb);
  uint32_t a[8], b[8], c[5], e[5];
  memcpy(a, IV256, 32); memcpy(b, IV256, 32); memcpy(c, IV1, 20); memcpy(e, IV1, 20);
  sha256_c(a, p, nb); sha256_ni(b, p, nb); sha1_c(c, p, nb); sha1_ni(e, p, nb);
  free(p);
  checks += 2;
  if (memcmp(a, b, 32) || (want256 && memcmp(a, want256, 32))) { fails++; printf("FAIL sha256 %s: %08x %08x c %08x\n", what, b[0], b[7], a[0]); }
  if (memcmp(c, e, 20) || (want1 && memcmp(c, want1, 20))) { fails++; printf("FAIL sha1 %s: %08x %08x c %08x\n", what, e[0], e[4], c[0]); }
}

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
static void bench(int mb) {
  size_t nb = (size_t)mb << 14;  // 64-byte blocks
  uint8_t *p = malloc(1 << 20);
  for (int i = 0; i < 1 << 20; i++) p[i] = (uint8_t)rnd();
  uint32_t st[8];
  const char *names[4] = {"sha256 instr", "sha256 C", "sha1 instr", "sha1 C"};
  for (int k = 0; k < 4; k++) {
    memcpy(st, k < 2 ? IV256 : IV1, k < 2 ? 32 : 20);
    double t0 = now();
    for (size_t done = 0; done < nb; done += 1 << 14) {
      if (k == 0) sha256_ni(st, p, 1 << 14);
      else if (k == 1) sha256_c(st, p, 1 << 14);
      else if (k == 2) sha1_ni(st, p, 1 << 14);
      else sha1_c(st, p, 1 << 14);
    }
    double s = now() - t0;
    printf("x86sha bench %s: %d MB in %.2f s = %.1f MB/s (%08x)\n", names[k], mb, s, mb / s, st[0]);
  }
  free(p);
}

int main(int argc, char **argv) {
  unsigned a, b, c, d;
  __cpuid(0, a, b, c, d);
  if (a < 7) { printf("x86sha skip (max leaf %u)\n", a); return 0; }
  __cpuid_count(7, 0, a, b, c, d);
  if (!(b >> 29 & 1)) { printf("x86sha skip (no SHA in CPUID)\n"); return 0; }
  if (argc > 2 && !strcmp(argv[1], "bench")) { bench(atoi(argv[2])); return 0; }
  for (int i = 0; i < 3000; i++) {  // interpreter first, then the JIT
    V x = rv(), y = rv(), k = rv();
    if (i & 1) for (int j = 0; j < 16; j++) y.b[j] &= 0x8F;  // pshufb: in-range indexes too
    t_pshufb(x, y); t_sha256msg1(x, y); t_sha256msg2(x, y); t_sha1nexte(x, y); t_sha1msg1(x, y); t_sha1msg2(x, y);
    t_rnds2(x, y, k); t_imm(x, y);
  }
  static const uint32_t abc256[8] = {0xba7816bf, 0x8f01cfea, 0x414140de, 0x5dae2223, 0xb00361a3, 0x96177a9c, 0xb410ff61, 0xf20015ad};
  static const uint32_t abc1[5] = {0xa9993e36, 0x4706816a, 0xba3e2571, 0x7850c26c, 0x9cd0d89d};
  hashes("abc", (const uint8_t *)"abc", 3, abc256, abc1);
  uint8_t *big = malloc(1 << 20);
  for (int i = 0; i < 1 << 20; i++) big[i] = (uint8_t)rnd();
  hashes("1 MB", big, 1 << 20, 0, 0);
  hashes("1 MB - 7", big, (1 << 20) - 7, 0, 0);
  free(big);
  if (fails) { printf("x86sha FAIL %d of %d\n", fails, checks); return 1; }
  printf("x86sha ok %d\n", checks);
  return 0;
}
