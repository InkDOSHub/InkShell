// AES-NI (AESENC, AESENCLAST, AESDEC, AESDECLAST, AESIMC, AESKEYGENASSIST) and PCLMULQDQ
// against plain C models written from FIPS-197 / the Intel SDM (byte-wise, no tables shared
// with the engine): register and memory operands, random and edge values, every immediate of
// AESKEYGENASSIST and PCLMULQDQ, plus the FIPS-197 C.1 AES-128 vector (key expansion with
// AESKEYGENASSIST, encrypt, decrypt with AESIMC keys) and a known GHASH-style product.
// Each test runs many times: first in the interpreter, then in JIT code.
// Prints "x86aes ok <n>" (or "x86aes skip" when CPUID does not announce AES and PCLMULQDQ).
// Built static: gcc -O2 -fno-tree-vectorize -maes -mpclmul -static -o tests/x86aes tests/src/x86aes.c
#include <cpuid.h>
#include <immintrin.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef union {
  __m128i v;
  uint64_t q[2];
  uint32_t w[4];
  uint8_t b[16];
} V;

static int fails, checks;
static void pv(const char *t, const V *v) { printf(" %s %016llx%016llx", t, (unsigned long long)v->q[1], (unsigned long long)v->q[0]); }
static void check(const char *what, int imm, V a, V b, V got, V want) {
  checks++;
  if (memcmp(got.b, want.b, 16) && ++fails < 40) {
    printf("FAIL %s imm %d:", what, imm);
    pv("a", &a); pv("b", &b); pv("got", &got); pv("want", &want);
    printf("\n");
  }
}

static uint64_t rs = 0x2545F4914F6CDD1Dull;
static uint32_t rnd(void) { rs ^= rs << 13; rs ^= rs >> 7; rs ^= rs << 17; return (uint32_t)(rs >> 16); }
static V rv(void) {
  V v;
  for (int i = 0; i < 4; i++) v.w[i] = rnd();
  switch (rnd() % 6) {
  case 1: memset(&v, 0, 16); break;
  case 2: memset(&v, 0xFF, 16); break;
  case 3: for (int i = 0; i < 16; i++) if (rnd() & 1) v.b[i] = (uint8_t[]){0, 1, 0x80, 0xFF, 0x63, 0x52}[rnd() % 6]; break;
  }
  return v;
}

// ---- models (FIPS-197, byte at a time) ----
static uint8_t xt(uint8_t x) { return (uint8_t)(x << 1) ^ (x & 0x80 ? 0x1B : 0); }
static uint8_t gm(uint8_t a, uint8_t b) {
  uint8_t p = 0;
  for (; b; b >>= 1, a = xt(a)) if (b & 1) p ^= a;
  return p;
}
static uint8_t S[256], SI[256];
static void init_sbox(void) {
  for (int x = 0; x < 256; x++) {
    uint8_t inv = 0;
    for (int y = 1; y < 256 && x; y++) if (gm((uint8_t)x, (uint8_t)y) == 1) { inv = (uint8_t)y; break; }
    uint8_t s = 0x63;
    for (int i = 0; i < 8; i++) {
      int bit = (inv >> i ^ inv >> ((i + 4) & 7) ^ inv >> ((i + 5) & 7) ^ inv >> ((i + 6) & 7) ^ inv >> ((i + 7) & 7)) & 1;
      s ^= (uint8_t)(bit << i);
    }
    S[x] = s;
    SI[s] = (uint8_t)x;
  }
}
// state[r][c] = byte 4c + r
static V shift_rows(V a, int inv) {
  V o;
  for (int c = 0; c < 4; c++)
    for (int r = 0; r < 4; r++) o.b[4 * c + r] = a.b[4 * ((c + (inv ? 4 - r : r)) & 3) + r];
  return o;
}
static V sub_bytes(V a, int inv) { for (int i = 0; i < 16; i++) a.b[i] = inv ? SI[a.b[i]] : S[a.b[i]]; return a; }
static V mix(V a, int inv) {
  static const uint8_t M[2][4] = {{2, 3, 1, 1}, {14, 11, 13, 9}};
  V o;
  for (int c = 0; c < 4; c++)
    for (int r = 0; r < 4; r++) {
      uint8_t v = 0;
      for (int k = 0; k < 4; k++) v ^= gm(M[inv][(k - r + 4) & 3], a.b[4 * c + k]);
      o.b[4 * c + r] = v;
    }
  return o;
}
static V vxor(V a, V b) { a.q[0] ^= b.q[0]; a.q[1] ^= b.q[1]; return a; }
static V m_aesenc(V a, V k) { return vxor(mix(sub_bytes(shift_rows(a, 0), 0), 0), k); }
static V m_aesenclast(V a, V k) { return vxor(sub_bytes(shift_rows(a, 0), 0), k); }
static V m_aesdec(V a, V k) { return vxor(mix(sub_bytes(shift_rows(a, 1), 1), 1), k); }
static V m_aesdeclast(V a, V k) { return vxor(sub_bytes(shift_rows(a, 1), 1), k); }
static V m_aesimc(V a, V k) { (void)a; return mix(k, 1); }
static uint32_t subw(uint32_t x) { return S[x & 255] | S[x >> 8 & 255] << 8 | S[x >> 16 & 255] << 16 | (uint32_t)S[x >> 24] << 24; }
static uint32_t rotw(uint32_t x) { return x >> 8 | x << 24; }
static V m_keygen(V a, V s, int imm) {
  (void)a;
  V o;
  o.w[0] = subw(s.w[1]);
  o.w[1] = rotw(subw(s.w[1])) ^ (uint32_t)imm;
  o.w[2] = subw(s.w[3]);
  o.w[3] = rotw(subw(s.w[3])) ^ (uint32_t)imm;
  return o;
}
static V m_clmul(V a, V s, int imm) {
  uint64_t x = a.q[imm & 1], y = s.q[imm >> 4 & 1];
  V o = {0};
  for (int i = 0; i < 64; i++)
    if (y >> i & 1) {
      o.q[0] ^= x << i;
      if (i) o.q[1] ^= x >> (64 - i);
    }
  return o;
}

// ---- the instructions ----
#define OP2(nm, ins)                                                                              \
  static V nm##_r(V a, V b) { __asm__(ins " %1, %0" : "+x"(a.v) : "x"(b.v)); return a; }        \
  static V nm##_m(V a, V b) { __asm__(ins " %1, %0" : "+x"(a.v) : "m"(b)); return a; }
OP2(aesenc, "aesenc") OP2(aesenclast, "aesenclast") OP2(aesdec, "aesdec") OP2(aesdeclast, "aesdeclast")
static V aesimc_r(V a, V b) { __asm__("aesimc %1, %0" : "=x"(a.v) : "x"(b.v)); return a; }
static V aesimc_m(V a, V b) { __asm__("aesimc %1, %0" : "=x"(a.v) : "m"(b)); return a; }
static const struct { const char *n; V (*r)(V, V), (*m)(V, V), (*model)(V, V); } OPS[] = {
    {"aesenc", aesenc_r, aesenc_m, m_aesenc},         {"aesenclast", aesenclast_r, aesenclast_m, m_aesenclast},
    {"aesdec", aesdec_r, aesdec_m, m_aesdec},         {"aesdeclast", aesdeclast_r, aesdeclast_m, m_aesdeclast},
    {"aesimc", aesimc_r, aesimc_m, m_aesimc},
};
static void t_ops2(void) {
  for (unsigned k = 0; k < sizeof OPS / sizeof *OPS; k++) {
    V a = rv(), b = rv(), w = OPS[k].model(a, b);
    check(OPS[k].n, 0, a, b, OPS[k].r(a, b), w);
    check(OPS[k].n, 1, a, b, OPS[k].m(a, b), w);
  }
}

#define K1(K, I, n) case n: K(I, n); break;
#define K4(K, I, n) K1(K, I, n) K1(K, I, n + 1) K1(K, I, n + 2) K1(K, I, n + 3)
#define K16(K, I, n) K4(K, I, n) K4(K, I, n + 4) K4(K, I, n + 8) K4(K, I, n + 12)
#define K64(K, I, n) K16(K, I, n) K16(K, I, n + 16) K16(K, I, n + 32) K16(K, I, n + 48)
#define K256(K, I) K64(K, I, 0) K64(K, I, 64) K64(K, I, 128) K64(K, I, 192)
#define KG_R(I, n) __asm__(I " %2, %1, %0" : "=x"(r.v) : "x"(b.v), "i"(n))
#define KG_M(I, n) __asm__(I " %2, %1, %0" : "=x"(r.v) : "m"(b), "i"(n))
#define CL_R(I, n) __asm__(I " %2, %1, %0" : "+x"(r.v) : "x"(b.v), "i"(n))
#define CL_M(I, n) __asm__(I " %2, %1, %0" : "+x"(r.v) : "m"(b), "i"(n))
static V keygen(V b, int imm, int mem) {
  V r = {0};
  if (mem) switch (imm) { K256(KG_M, "aeskeygenassist") }
  else switch (imm) { K256(KG_R, "aeskeygenassist") }
  return r;
}
static V clmul(V a, V b, int imm, int mem) {
  V r = a;
  if (mem) switch (imm) { K256(CL_M, "pclmulqdq") }
  else switch (imm) { K256(CL_R, "pclmulqdq") }
  return r;
}
static void t_imm(int imm) {
  V a = rv(), b = rv();
  check("aeskeygenassist", imm, a, b, keygen(b, imm, 0), m_keygen(a, b, imm));
  check("aeskeygenassist m", imm, a, b, keygen(b, imm, 1), m_keygen(a, b, imm));
  check("pclmulqdq", imm, a, b, clmul(a, b, imm, 0), m_clmul(a, b, imm));
  check("pclmulqdq m", imm, a, b, clmul(a, b, imm, 1), m_clmul(a, b, imm));
}

// FIPS-197 C.1: key 000102..0f, plaintext 00112233..ff -> 69c4e0d86a7b0430d8cdb78070b4c55a
#define EXPAND(i, rc)                                                                  \
  t = _mm_aeskeygenassist_si128(k[i - 1], rc);                                         \
  t = _mm_shuffle_epi32(t, 0xFF);                                                      \
  u = k[i - 1];                                                                        \
  u = _mm_xor_si128(u, _mm_slli_si128(u, 4));                                          \
  u = _mm_xor_si128(u, _mm_slli_si128(u, 8));                                          \
  k[i] = _mm_xor_si128(u, t);
static void t_fips(void) {
  static const uint8_t key[16] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15};
  static const uint8_t pt[16] = {0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff};
  static const uint8_t ct[16] = {0x69, 0xc4, 0xe0, 0xd8, 0x6a, 0x7b, 0x04, 0x30, 0xd8, 0xcd, 0xb7, 0x80, 0x70, 0xb4, 0xc5, 0x5a};
  __m128i k[11], t, u;
  k[0] = _mm_loadu_si128((const __m128i *)key);
  EXPAND(1, 0x01) EXPAND(2, 0x02) EXPAND(3, 0x04) EXPAND(4, 0x08) EXPAND(5, 0x10)
  EXPAND(6, 0x20) EXPAND(7, 0x40) EXPAND(8, 0x80) EXPAND(9, 0x1b) EXPAND(10, 0x36)
  V x, want, got, z = {0};
  x.v = _mm_xor_si128(_mm_loadu_si128((const __m128i *)pt), k[0]);
  for (int i = 1; i < 10; i++) x.v = _mm_aesenc_si128(x.v, k[i]);
  got.v = _mm_aesenclast_si128(x.v, k[10]);
  memcpy(want.b, ct, 16);
  check("fips-197 encrypt", 0, z, z, got, want);
  x.v = _mm_xor_si128(got.v, k[10]);
  for (int i = 9; i > 0; i--) x.v = _mm_aesdec_si128(x.v, _mm_aesimc_si128(k[i]));
  got.v = _mm_aesdeclast_si128(x.v, k[0]);
  memcpy(want.b, pt, 16);
  check("fips-197 decrypt", 0, z, z, got, want);
  // x^63 * x^63 = x^126; (x+1)^2 = x^2+1
  V a = {.q = {1ull << 63, 3}}, b = {.q = {1ull << 63, 3}};
  got.v = _mm_clmulepi64_si128(a.v, b.v, 0x00); want.q[0] = 0; want.q[1] = 1ull << 62;
  check("pclmulqdq x^126", 0, a, b, got, want);
  got.v = _mm_clmulepi64_si128(a.v, b.v, 0x11); want.q[0] = 5; want.q[1] = 0;
  check("pclmulqdq (x+1)^2", 0x11, a, b, got, want);
}

int main(void) {
  unsigned a, b, c, d;
  __cpuid(1, a, b, c, d);
  if ((c & (1u << 25 | 1u << 1)) != (1u << 25 | 1u << 1)) { printf("x86aes skip (leaf 1 ecx %08x)\n", c); return 0; }
  init_sbox();
  if (S[0] != 0x63 || S[0x53] != 0xED) { printf("x86aes FAIL model s-box\n"); return 1; }
  // every immediate once (interpreter), then many times (JIT)
  for (int imm = 0; imm < 256; imm++) t_imm(imm);
  for (int i = 0; i < 2000; i++) {
    t_ops2();
    t_fips();
    t_imm((int[]){0x00, 0x01, 0x10, 0x11, 0x36, 0x1b, 0x80, 0xFF}[i & 7]);
  }
  if (fails) { printf("x86aes FAIL %d of %d\n", fails, checks); return 1; }
  printf("x86aes ok %d\n", checks);
  return 0;
}
