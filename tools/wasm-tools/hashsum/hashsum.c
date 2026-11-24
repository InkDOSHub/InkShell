/* hashsum: md5sum, sha1sum, sha224sum, sha256sum, sha384sum, sha512sum, b2sum in one WASI program
   (the name it is run by picks the hash). Output and -c checking in the format of GNU coreutils.
   Written for InkShell from the published specifications (RFC 1321, FIPS 180-4, RFC 7693): no code
   copied from other projects; same license as InkShell (MIT). Files are read 1 MB at a time: the
   memory used does not grow with the file size. */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

typedef struct ctx ctx;
typedef struct algo {
  const char *prog, *tag; /* program name, --tag name */
  int dlen, blk, lazy;    /* digest bytes, block bytes, lazy = keep the last full block for final (BLAKE2b) */
  void (*init)(ctx *);
  void (*blocks)(ctx *, const uint8_t *, size_t);
  void (*final)(ctx *, uint8_t *);
} algo;
struct ctx {
  const algo *a;
  int outlen; /* BLAKE2b digest bytes */
  uint64_t len; /* bytes compressed so far */
  union { uint32_t w[8]; uint64_t q[8]; } h;
  uint8_t buf[128];
  size_t n;
};

#define ROL32(x, n) (((x) << (n)) | ((x) >> (32 - (n))))
#define ROR32(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define ROR64(x, n) (((x) >> (n)) | ((x) << (64 - (n))))
static uint32_t le32(const uint8_t *p) { return p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static uint32_t be32(const uint8_t *p) { return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3]; }
static uint64_t le64(const uint8_t *p) { return le32(p) | (uint64_t)le32(p + 4) << 32; }
static uint64_t be64(const uint8_t *p) { return (uint64_t)be32(p) << 32 | be32(p + 4); }

/* Merkle-Damgard padding: 0x80, zeros, bit length (64 bits; 128 bits for 128-byte blocks) */
static void md_pad(ctx *c, int be) {
  size_t B = c->a->blk, L = B == 128 ? 16 : 8;
  uint64_t bits = (c->len + c->n) * 8;
  c->buf[c->n++] = 0x80;
  if (c->n > B - L) { memset(c->buf + c->n, 0, B - c->n); c->a->blocks(c, c->buf, 1); c->n = 0; }
  memset(c->buf + c->n, 0, B - c->n);
  for (int i = 0; i < 8; i++) {
    if (be) c->buf[B - 1 - i] = (uint8_t)(bits >> (8 * i));
    else c->buf[B - 8 + i] = (uint8_t)(bits >> (8 * i));
  }
  c->a->blocks(c, c->buf, 1);
  c->n = 0;
}
static void out32(const ctx *c, uint8_t *o, int be) {
  for (int i = 0; i < c->a->dlen; i++) { uint32_t w = c->h.w[i / 4]; o[i] = (uint8_t)(be ? w >> (24 - 8 * (i % 4)) : w >> (8 * (i % 4))); }
}

/* ---- MD5 (RFC 1321) ---- */
static const uint32_t KMD5[64] = {
  0xd76aa478u, 0xe8c7b756u, 0x242070dbu, 0xc1bdceeeu, 0xf57c0fafu, 0x4787c62au, 0xa8304613u, 0xfd469501u,
  0x698098d8u, 0x8b44f7afu, 0xffff5bb1u, 0x895cd7beu, 0x6b901122u, 0xfd987193u, 0xa679438eu, 0x49b40821u,
  0xf61e2562u, 0xc040b340u, 0x265e5a51u, 0xe9b6c7aau, 0xd62f105du, 0x02441453u, 0xd8a1e681u, 0xe7d3fbc8u,
  0x21e1cde6u, 0xc33707d6u, 0xf4d50d87u, 0x455a14edu, 0xa9e3e905u, 0xfcefa3f8u, 0x676f02d9u, 0x8d2a4c8au,
  0xfffa3942u, 0x8771f681u, 0x6d9d6122u, 0xfde5380cu, 0xa4beea44u, 0x4bdecfa9u, 0xf6bb4b60u, 0xbebfbc70u,
  0x289b7ec6u, 0xeaa127fau, 0xd4ef3085u, 0x04881d05u, 0xd9d4d039u, 0xe6db99e5u, 0x1fa27cf8u, 0xc4ac5665u,
  0xf4292244u, 0x432aff97u, 0xab9423a7u, 0xfc93a039u, 0x655b59c3u, 0x8f0ccc92u, 0xffeff47du, 0x85845dd1u,
  0x6fa87e4fu, 0xfe2ce6e0u, 0xa3014314u, 0x4e0811a1u, 0xf7537e82u, 0xbd3af235u, 0x2ad7d2bbu, 0xeb86d391u};
static const uint8_t SMD5[16] = {7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21};
static void md5_init(ctx *c) { c->h.w[0] = 0x67452301u; c->h.w[1] = 0xefcdab89u; c->h.w[2] = 0x98badcfeu; c->h.w[3] = 0x10325476u; }
static void md5_blocks(ctx *c, const uint8_t *p, size_t nb) {
  uint32_t *h = c->h.w;
  for (; nb--; p += 64, c->len += 64) {
    uint32_t m[16], a = h[0], b = h[1], cc = h[2], d = h[3];
    for (int i = 0; i < 16; i++) m[i] = le32(p + 4 * i);
    for (int i = 0; i < 64; i++) {
      uint32_t f; int g;
      switch (i >> 4) {
      case 0: f = d ^ (b & (cc ^ d)); g = i; break;
      case 1: f = cc ^ (d & (b ^ cc)); g = (5 * i + 1) & 15; break;
      case 2: f = b ^ cc ^ d; g = (3 * i + 5) & 15; break;
      default: f = cc ^ (b | ~d); g = (7 * i) & 15; break;
      }
      f += a + KMD5[i] + m[g];
      a = d; d = cc; cc = b;
      b += ROL32(f, SMD5[(i >> 4) * 4 + (i & 3)]);
    }
    h[0] += a; h[1] += b; h[2] += cc; h[3] += d;
  }
}
static void md5_final(ctx *c, uint8_t *o) { md_pad(c, 0); out32(c, o, 0); }

/* ---- SHA-1 (FIPS 180-4) ---- */
static void sha1_init(ctx *c) {
  static const uint32_t iv[5] = {0x67452301u, 0xefcdab89u, 0x98badcfeu, 0x10325476u, 0xc3d2e1f0u};
  memcpy(c->h.w, iv, sizeof iv);
}
static void sha1_blocks(ctx *c, const uint8_t *p, size_t nb) {
  uint32_t *h = c->h.w;
  for (; nb--; p += 64, c->len += 64) {
    uint32_t w[80], a = h[0], b = h[1], cc = h[2], d = h[3], e = h[4];
    for (int i = 0; i < 16; i++) w[i] = be32(p + 4 * i);
    for (int i = 16; i < 80; i++) w[i] = ROL32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    for (int i = 0; i < 80; i++) {
      uint32_t f, k;
      if (i < 20) { f = d ^ (b & (cc ^ d)); k = 0x5a827999u; }
      else if (i < 40) { f = b ^ cc ^ d; k = 0x6ed9eba1u; }
      else if (i < 60) { f = (b & cc) | (d & (b | cc)); k = 0x8f1bbcdcu; }
      else { f = b ^ cc ^ d; k = 0xca62c1d6u; }
      uint32_t t = ROL32(a, 5) + f + e + k + w[i];
      e = d; d = cc; cc = ROL32(b, 30); b = a; a = t;
    }
    h[0] += a; h[1] += b; h[2] += cc; h[3] += d; h[4] += e;
  }
}
static void sha1_final(ctx *c, uint8_t *o) { md_pad(c, 1); out32(c, o, 1); }

/* ---- SHA-224 / SHA-256 (FIPS 180-4) ---- */
static const uint32_t K256[64] = {
  0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
  0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
  0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
  0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
  0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
  0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
  0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
  0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};
static void sha256_init(ctx *c) {
  static const uint32_t iv[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au, 0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
  memcpy(c->h.w, iv, sizeof iv);
}
static void sha224_init(ctx *c) {
  static const uint32_t iv[8] = {0xc1059ed8u, 0x367cd507u, 0x3070dd17u, 0xf70e5939u, 0xffc00b31u, 0x68581511u, 0x64f98fa7u, 0xbefa4fa4u};
  memcpy(c->h.w, iv, sizeof iv);
}
#define CH(e, f, g) ((g) ^ ((e) & ((f) ^ (g))))
#define MAJ(a, b, c) (((a) & (b)) | ((c) & ((a) | (b))))
#define S0_256(a) (ROR32(a, 2) ^ ROR32(a, 13) ^ ROR32(a, 22))
#define S1_256(e) (ROR32(e, 6) ^ ROR32(e, 11) ^ ROR32(e, 25))
#define s0_256(w) (ROR32(w, 7) ^ ROR32(w, 18) ^ ((w) >> 3))
#define s1_256(w) (ROR32(w, 17) ^ ROR32(w, 19) ^ ((w) >> 10))
/* one round in place: d becomes the new e, h the new a; the next round names the variables one step on */
#define R256(a, b, c, d, e, f, g, h, i) t = h + S1_256(e) + CH(e, f, g) + K256[i] + w[i]; d += t; h = t + S0_256(a) + MAJ(a, b, c);
static void sha256_blocks(ctx *c, const uint8_t *p, size_t nb) {
  uint32_t *H = c->h.w;
  for (; nb--; p += 64, c->len += 64) {
    uint32_t w[64], t, a = H[0], b = H[1], cc = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (int i = 0; i < 16; i++) w[i] = be32(p + 4 * i);
    for (int i = 16; i < 64; i++) w[i] = w[i - 16] + s0_256(w[i - 15]) + w[i - 7] + s1_256(w[i - 2]);
    for (int i = 0; i < 64; i += 8) {
      R256(a, b, cc, d, e, f, g, h, i) R256(h, a, b, cc, d, e, f, g, i + 1)
      R256(g, h, a, b, cc, d, e, f, i + 2) R256(f, g, h, a, b, cc, d, e, i + 3)
      R256(e, f, g, h, a, b, cc, d, i + 4) R256(d, e, f, g, h, a, b, cc, i + 5)
      R256(cc, d, e, f, g, h, a, b, i + 6) R256(b, cc, d, e, f, g, h, a, i + 7)
    }
    H[0] += a; H[1] += b; H[2] += cc; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
}
static void sha256_final(ctx *c, uint8_t *o) { md_pad(c, 1); out32(c, o, 1); }

/* ---- SHA-384 / SHA-512 (FIPS 180-4) ---- */
static const uint64_t K512[80] = {
  0x428a2f98d728ae22ULL, 0x7137449123ef65cdULL, 0xb5c0fbcfec4d3b2fULL, 0xe9b5dba58189dbbcULL,
  0x3956c25bf348b538ULL, 0x59f111f1b605d019ULL, 0x923f82a4af194f9bULL, 0xab1c5ed5da6d8118ULL,
  0xd807aa98a3030242ULL, 0x12835b0145706fbeULL, 0x243185be4ee4b28cULL, 0x550c7dc3d5ffb4e2ULL,
  0x72be5d74f27b896fULL, 0x80deb1fe3b1696b1ULL, 0x9bdc06a725c71235ULL, 0xc19bf174cf692694ULL,
  0xe49b69c19ef14ad2ULL, 0xefbe4786384f25e3ULL, 0x0fc19dc68b8cd5b5ULL, 0x240ca1cc77ac9c65ULL,
  0x2de92c6f592b0275ULL, 0x4a7484aa6ea6e483ULL, 0x5cb0a9dcbd41fbd4ULL, 0x76f988da831153b5ULL,
  0x983e5152ee66dfabULL, 0xa831c66d2db43210ULL, 0xb00327c898fb213fULL, 0xbf597fc7beef0ee4ULL,
  0xc6e00bf33da88fc2ULL, 0xd5a79147930aa725ULL, 0x06ca6351e003826fULL, 0x142929670a0e6e70ULL,
  0x27b70a8546d22ffcULL, 0x2e1b21385c26c926ULL, 0x4d2c6dfc5ac42aedULL, 0x53380d139d95b3dfULL,
  0x650a73548baf63deULL, 0x766a0abb3c77b2a8ULL, 0x81c2c92e47edaee6ULL, 0x92722c851482353bULL,
  0xa2bfe8a14cf10364ULL, 0xa81a664bbc423001ULL, 0xc24b8b70d0f89791ULL, 0xc76c51a30654be30ULL,
  0xd192e819d6ef5218ULL, 0xd69906245565a910ULL, 0xf40e35855771202aULL, 0x106aa07032bbd1b8ULL,
  0x19a4c116b8d2d0c8ULL, 0x1e376c085141ab53ULL, 0x2748774cdf8eeb99ULL, 0x34b0bcb5e19b48a8ULL,
  0x391c0cb3c5c95a63ULL, 0x4ed8aa4ae3418acbULL, 0x5b9cca4f7763e373ULL, 0x682e6ff3d6b2b8a3ULL,
  0x748f82ee5defb2fcULL, 0x78a5636f43172f60ULL, 0x84c87814a1f0ab72ULL, 0x8cc702081a6439ecULL,
  0x90befffa23631e28ULL, 0xa4506cebde82bde9ULL, 0xbef9a3f7b2c67915ULL, 0xc67178f2e372532bULL,
  0xca273eceea26619cULL, 0xd186b8c721c0c207ULL, 0xeada7dd6cde0eb1eULL, 0xf57d4f7fee6ed178ULL,
  0x06f067aa72176fbaULL, 0x0a637dc5a2c898a6ULL, 0x113f9804bef90daeULL, 0x1b710b35131c471bULL,
  0x28db77f523047d84ULL, 0x32caab7b40c72493ULL, 0x3c9ebe0a15c9bebcULL, 0x431d67c49c100d4cULL,
  0x4cc5d4becb3e42b6ULL, 0x597f299cfc657e2aULL, 0x5fcb6fab3ad6faecULL, 0x6c44198c4a475817ULL};
static const uint64_t IV512[8] = {0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL, 0x3c6ef372fe94f82bULL, 0xa54ff53a5f1d36f1ULL,
  0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL, 0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL};
static void sha512_init(ctx *c) { memcpy(c->h.q, IV512, sizeof IV512); }
static void sha384_init(ctx *c) {
  static const uint64_t iv[8] = {0xcbbb9d5dc1059ed8ULL, 0x629a292a367cd507ULL, 0x9159015a3070dd17ULL, 0x152fecd8f70e5939ULL,
    0x67332667ffc00b31ULL, 0x8eb44a8768581511ULL, 0xdb0c2e0d64f98fa7ULL, 0x47b5481dbefa4fa4ULL};
  memcpy(c->h.q, iv, sizeof iv);
}
#define S0_512(a) (ROR64(a, 28) ^ ROR64(a, 34) ^ ROR64(a, 39))
#define S1_512(e) (ROR64(e, 14) ^ ROR64(e, 18) ^ ROR64(e, 41))
#define s0_512(w) (ROR64(w, 1) ^ ROR64(w, 8) ^ ((w) >> 7))
#define s1_512(w) (ROR64(w, 19) ^ ROR64(w, 61) ^ ((w) >> 6))
#define R512(a, b, c, d, e, f, g, h, i) t = h + S1_512(e) + CH(e, f, g) + K512[i] + w[i]; d += t; h = t + S0_512(a) + MAJ(a, b, c);
static void sha512_blocks(ctx *c, const uint8_t *p, size_t nb) {
  uint64_t *H = c->h.q;
  for (; nb--; p += 128, c->len += 128) {
    uint64_t w[80], t, a = H[0], b = H[1], cc = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (int i = 0; i < 16; i++) w[i] = be64(p + 8 * i);
    for (int i = 16; i < 80; i++) w[i] = w[i - 16] + s0_512(w[i - 15]) + w[i - 7] + s1_512(w[i - 2]);
    for (int i = 0; i < 80; i += 8) {
      R512(a, b, cc, d, e, f, g, h, i) R512(h, a, b, cc, d, e, f, g, i + 1)
      R512(g, h, a, b, cc, d, e, f, i + 2) R512(f, g, h, a, b, cc, d, e, i + 3)
      R512(e, f, g, h, a, b, cc, d, i + 4) R512(d, e, f, g, h, a, b, cc, i + 5)
      R512(cc, d, e, f, g, h, a, b, i + 6) R512(b, cc, d, e, f, g, h, a, i + 7)
    }
    H[0] += a; H[1] += b; H[2] += cc; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
}
static void sha512_final(ctx *c, uint8_t *o) {
  md_pad(c, 1);
  for (int i = 0; i < c->a->dlen; i++) o[i] = (uint8_t)(c->h.q[i / 8] >> (56 - 8 * (i % 8)));
}

/* ---- BLAKE2b (RFC 7693), no key ---- */
static const uint8_t SIGMA[12][16] = {
  {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}, {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
  {11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4}, {7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
  {9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13}, {2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
  {12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11}, {13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
  {6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5}, {10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
  {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}, {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3}};
#define G2(a, b, c, d, x, y) \
  a += b + x; d = ROR64(d ^ a, 32); c += d; b = ROR64(b ^ c, 24); \
  a += b + y; d = ROR64(d ^ a, 16); c += d; b = ROR64(b ^ c, 63);
static void b2_compress(ctx *c, const uint8_t *p, uint64_t t, int last) {
  uint64_t m[16], v[16], *h = c->h.q;
  for (int i = 0; i < 16; i++) m[i] = le64(p + 8 * i);
  for (int i = 0; i < 8; i++) { v[i] = h[i]; v[i + 8] = IV512[i]; }
  v[12] ^= t;
  if (last) v[14] = ~v[14];
  for (int r = 0; r < 12; r++) {
    const uint8_t *s = SIGMA[r];
    G2(v[0], v[4], v[8], v[12], m[s[0]], m[s[1]])
    G2(v[1], v[5], v[9], v[13], m[s[2]], m[s[3]])
    G2(v[2], v[6], v[10], v[14], m[s[4]], m[s[5]])
    G2(v[3], v[7], v[11], v[15], m[s[6]], m[s[7]])
    G2(v[0], v[5], v[10], v[15], m[s[8]], m[s[9]])
    G2(v[1], v[6], v[11], v[12], m[s[10]], m[s[11]])
    G2(v[2], v[7], v[8], v[13], m[s[12]], m[s[13]])
    G2(v[3], v[4], v[9], v[14], m[s[14]], m[s[15]])
  }
  for (int i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}
static void b2_init(ctx *c) {
  memcpy(c->h.q, IV512, sizeof IV512);
  c->h.q[0] ^= 0x01010000u ^ (uint64_t)c->outlen;
}
static void b2_blocks(ctx *c, const uint8_t *p, size_t nb) {
  for (; nb--; p += 128) { c->len += 128; b2_compress(c, p, c->len, 0); }
}
static void b2_final(ctx *c, uint8_t *o) {
  memset(c->buf + c->n, 0, 128 - c->n);
  c->len += c->n;
  b2_compress(c, c->buf, c->len, 1);
  for (int i = 0; i < c->outlen; i++) o[i] = (uint8_t)(c->h.q[i / 8] >> (8 * (i % 8)));
}

static const algo ALGOS[] = {
  {"md5sum", "MD5", 16, 64, 0, md5_init, md5_blocks, md5_final},
  {"sha1sum", "SHA1", 20, 64, 0, sha1_init, sha1_blocks, sha1_final},
  {"sha224sum", "SHA224", 28, 64, 0, sha224_init, sha256_blocks, sha256_final},
  {"sha256sum", "SHA256", 32, 64, 0, sha256_init, sha256_blocks, sha256_final},
  {"sha384sum", "SHA384", 48, 128, 0, sha384_init, sha512_blocks, sha512_final},
  {"sha512sum", "SHA512", 64, 128, 0, sha512_init, sha512_blocks, sha512_final},
  {"b2sum", "BLAKE2b", 64, 128, 1, b2_init, b2_blocks, b2_final},
};

static void update(ctx *c, const uint8_t *p, size_t n) {
  size_t B = c->a->blk;
  if (c->n) {
    size_t k = B - c->n;
    if (k > n) k = n;
    memcpy(c->buf + c->n, p, k); c->n += k; p += k; n -= k;
    if (c->n < B || (c->a->lazy && !n)) return;
    c->a->blocks(c, c->buf, 1); c->n = 0;
  }
  size_t nb = n / B;
  if (c->a->lazy && nb && nb * B == n) nb--; /* BLAKE2b: the last block is compressed by final */
  if (nb) { c->a->blocks(c, p, nb); p += nb * B; n -= nb * B; }
  memcpy(c->buf, p, n); c->n = n;
}

static const char *prog = "sha256sum";
static const algo *A;
static int outbytes; /* digest bytes printed (b2sum -l) */
static uint8_t *iobuf;
#define IOSZ (1 << 20)

/* digest of a file ("-" = stdin) into out; -1 with errno on failure */
static int hash_file(const char *name, uint8_t *out) {
  int fd = strcmp(name, "-") ? open(name, O_RDONLY) : 0;
  if (fd < 0) return -1;
  ctx c; memset(&c, 0, sizeof c);
  c.a = A; c.outlen = outbytes; A->init(&c);
  for (;;) {
    ssize_t r = read(fd, iobuf, IOSZ);
    if (r < 0) { if (errno == EINTR) continue; int e = errno; if (fd) close(fd); errno = e; return -1; }
    if (r == 0) break;
    update(&c, iobuf, (size_t)r);
  }
  if (fd) close(fd);
  A->final(&c, out);
  return 0;
}

static void errfile(const char *name) { fflush(stdout); fprintf(stderr, "%s: %s: %s\n", prog, name, strerror(errno)); }

/* file names with a backslash or a line break are printed escaped, the line then starts with a backslash */
static int needs_escape(const char *s) { return strpbrk(s, "\\\n\r") != NULL; }
static void put_name(const char *s, int esc) {
  for (; *s; s++) {
    if (esc && *s == '\\') fputs("\\\\", stdout);
    else if (esc && *s == '\n') fputs("\\n", stdout);
    else if (esc && *s == '\r') fputs("\\r", stdout);
    else putchar(*s);
  }
}
static void put_hex(const uint8_t *d, int n) {
  static const char hx[] = "0123456789abcdef";
  for (int i = 0; i < n; i++) { putchar(hx[d[i] >> 4]); putchar(hx[d[i] & 15]); }
}

static int o_binary, o_tag, o_zero, o_quiet, o_status, o_strict, o_warn, o_ignore_missing;

static void tagname(void) {
  fputs(A->tag, stdout);
  if (A->lazy && outbytes != 64) printf("-%d", outbytes * 8);
}

static int print_one(const char *name) {
  uint8_t d[64];
  if (hash_file(name, d) < 0) { errfile(name); return 1; }
  int esc = !o_zero && needs_escape(name);
  if (esc) putchar('\\');
  if (o_tag) { tagname(); fputs(" (", stdout); put_name(name, esc); fputs(") = ", stdout); put_hex(d, outbytes); }
  else { put_hex(d, outbytes); putchar(' '); putchar(o_binary ? '*' : ' '); put_name(name, esc); }
  putchar(o_zero ? '\0' : '\n');
  return 0;
}

static int hexval(int ch) {
  if (ch >= '0' && ch <= '9') return ch - '0';
  if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
  if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
  return -1;
}
static void unescape(char *s) {
  char *o = s;
  for (; *s; s++) {
    if (*s == '\\' && s[1]) { s++; *o++ = *s == 'n' ? '\n' : *s == 'r' ? '\r' : *s; }
    else *o++ = *s;
  }
  *o = 0;
}

/* one line of a checksum list: hex digest and file name (both point into line); 0 if not well formed */
static int parse_line(char *line, char **hex, int *hexlen, char **name) {
  int esc = 0;
  while (*line == ' ' || *line == '\t') line++;
  if (*line == '\\') { esc = 1; line++; }
  size_t tl = strlen(A->tag);
  if (!strncmp(line, A->tag, tl) && (line[tl] == ' ' || line[tl] == '-' || line[tl] == '(')) { /* ALGO (NAME) = HEX */
    char *p = line + tl;
    int bits = 0;
    if (*p == '-') {
      if (!A->lazy) return 0;
      bits = (int)strtol(p + 1, &p, 10);
      if (bits <= 0 || bits > 512 || bits % 8) return 0;
    }
    if (*p == ' ') p++;
    if (*p != '(') return 0;
    char *nm = p + 1, *e = strstr(nm, ") = ");
    if (!e) return 0;
    char *q;
    while ((q = strstr(e + 1, ") = "))) e = q; /* the last ") = ": the name may contain one */
    *e = 0;
    char *hx = e + 4;
    int n = 0;
    while (hexval((unsigned char)hx[n]) >= 0) n++;
    if (hx[n] || !n || n % 2) return 0;
    if (A->lazy ? (bits ? n != bits / 4 : n != 128) : n != A->dlen * 2) return 0;
    if (esc) unescape(nm);
    *hex = hx; *hexlen = n; *name = nm;
    return 1;
  }
  int n = 0;
  while (hexval((unsigned char)line[n]) >= 0) n++;
  if (!n || n % 2 || line[n] != ' ') return 0;
  if (A->lazy ? n > 128 : n != A->dlen * 2) return 0;
  char *nm = line + n + 1;
  if (*nm == ' ' || *nm == '*') nm++;
  if (!*nm) return 0;
  line[n] = 0;
  if (esc) unescape(nm);
  *hex = line; *hexlen = n; *name = nm;
  return 1;
}

static int check_list(const char *list) {
  FILE *f = strcmp(list, "-") ? fopen(list, "r") : stdin;
  if (!f) { errfile(list); return 1; }
  char *line = NULL; size_t cap = 0; ssize_t len;
  long lineno = 0, bad_fmt = 0, bad_read = 0, bad_sum = 0, good = 0, matched = 0;
  const char *shown = strcmp(list, "-") ? list : "standard input";
  while ((len = getline(&line, &cap, f)) >= 0) {
    lineno++;
    while (len && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = 0;
    char *hx, *nm; int hl;
    if (line[0] == '#' || !parse_line(line, &hx, &hl, &nm)) {
      if (line[0] == '#') continue;
      bad_fmt++;
      if (o_warn) { fflush(stdout); fprintf(stderr, "%s: %s: %ld: improperly formatted %s checksum line\n", prog, shown, lineno, A->tag); }
      continue;
    }
    good++;
    int keep = outbytes;
    if (A->lazy) outbytes = hl / 2;
    uint8_t d[64];
    int r = hash_file(nm, d);
    outbytes = keep;
    int esc = needs_escape(nm);
    if (r < 0) {
      if (errno == ENOENT && o_ignore_missing) continue;
      bad_read++;
      if (!o_status) {
        errfile(nm);
        if (esc) putchar('\\');
        put_name(nm, esc); fputs(": FAILED open or read\n", stdout);
      }
      continue;
    }
    matched++;
    int ok = 1;
    for (int i = 0; i < hl / 2; i++) if (((hexval((unsigned char)hx[2 * i]) << 4) | hexval((unsigned char)hx[2 * i + 1])) != d[i]) { ok = 0; break; }
    if (!ok) bad_sum++;
    if (!o_status && (!ok || !o_quiet)) {
      if (esc) putchar('\\');
      put_name(nm, esc); fputs(ok ? ": OK\n" : ": FAILED\n", stdout);
    }
  }
  free(line);
  if (f != stdin) fclose(f);
  fflush(stdout);
  if (!good) { fprintf(stderr, "%s: %s: no properly formatted checksum lines found\n", prog, shown); return 1; }
  if (!matched && o_ignore_missing && !o_status) fprintf(stderr, "%s: %s: no file was verified\n", prog, shown);
  if (!o_status) {
    if (bad_fmt) fprintf(stderr, "%s: WARNING: %ld line%s improperly formatted\n", prog, bad_fmt, bad_fmt == 1 ? " is" : "s are");
    if (bad_read) fprintf(stderr, "%s: WARNING: %ld listed file%s could not be read\n", prog, bad_read, bad_read == 1 ? "" : "s");
    if (bad_sum) fprintf(stderr, "%s: WARNING: %ld computed checksum%s did NOT match\n", prog, bad_sum, bad_sum == 1 ? "" : "s");
  }
  return bad_read || bad_sum || (o_strict && bad_fmt) || (!matched && o_ignore_missing) ? 1 : 0;
}

static void usage(int rc) {
  FILE *o = rc ? stderr : stdout;
  if (rc) { fprintf(o, "Try '%s --help' for more information.\n", prog); exit(rc); }
  fprintf(o, "Usage: %s [OPTION]... [FILE]...\nPrint or check %s checksums (WebAssembly build, InkShell).\n"
    "With no FILE, or when FILE is -, read standard input.\n\n"
    "  -b, --binary         read in binary mode (marks the name with *)\n"
    "  -c, --check          read checksums from the FILEs and check them\n", prog, A->tag);
  if (A->lazy) fprintf(o, "  -l, --length=BITS    digest length in bits (multiple of 8, at most 512)\n");
  fprintf(o, "      --tag            create a BSD-style checksum\n"
    "  -t, --text           read in text mode (default)\n"
    "  -z, --zero           end each output line with NUL, not newline\n\n"
    "The following options are useful only when verifying checksums:\n"
    "      --ignore-missing don't fail or report status for missing files\n"
    "      --quiet          don't print OK for each successfully verified file\n"
    "      --status         don't output anything, status code shows success\n"
    "      --strict         exit non-zero for improperly formatted checksum lines\n"
    "  -w, --warn           warn about improperly formatted checksum lines\n\n"
    "      --help           display this help and exit\n"
    "      --version        output version information and exit\n");
  exit(0);
}

static int set_length(const char *s) {
  char *e; long v = strtol(s, &e, 10);
  if (*e || v < 0 || v > 512 || v % 8) { fprintf(stderr, "%s: invalid length: '%s'\n", prog, s); return 1; }
  outbytes = v ? (int)(v / 8) : 64;
  return 0;
}

int main(int argc, char **argv) {
  if (argc > 0 && argv[0]) { const char *b = strrchr(argv[0], '/'); prog = b ? b + 1 : argv[0]; }
  A = &ALGOS[3];
  for (size_t i = 0; i < sizeof ALGOS / sizeof *ALGOS; i++) if (!strcmp(prog, ALGOS[i].prog)) A = &ALGOS[i];
  outbytes = A->dlen;
  int check = 0, nfiles = 0;
  char **files = calloc((size_t)argc + 1, sizeof *files);
  int opts = 1;
  for (int i = 1; i < argc; i++) {
    char *s = argv[i];
    if (!opts || s[0] != '-' || !s[1]) { files[nfiles++] = s; continue; }
    if (!strcmp(s, "--")) { opts = 0; continue; }
    if (s[1] == '-') {
      char *v = strchr(s, '=');
      size_t kl = v ? (size_t)(v - s) : strlen(s);
#define IS(x) (kl == strlen(x) && !strncmp(s, x, kl))
      if (IS("--binary")) o_binary = 1;
      else if (IS("--text")) o_binary = 0;
      else if (IS("--check")) check = 1;
      else if (IS("--tag")) o_tag = 1;
      else if (IS("--untagged")) o_tag = 0;
      else if (IS("--zero")) o_zero = 1;
      else if (IS("--quiet")) o_quiet = 1;
      else if (IS("--status")) o_status = 1;
      else if (IS("--strict")) o_strict = 1;
      else if (IS("--warn")) o_warn = 1;
      else if (IS("--ignore-missing")) o_ignore_missing = 1;
      else if (IS("--help")) usage(0);
      else if (IS("--version")) { printf("%s (InkShell hashsum, WebAssembly) 1.0\n", prog); return 0; }
      else if (A->lazy && IS("--length")) {
        const char *val = v ? v + 1 : (i + 1 < argc ? argv[++i] : NULL);
        if (!val) { fprintf(stderr, "%s: option '--length' requires an argument\n", prog); usage(1); }
        if (set_length(val)) return 1;
      } else { fprintf(stderr, "%s: unrecognized option '%s'\n", prog, s); usage(1); }
      continue;
    }
    for (char *p = s + 1; *p; p++) {
      switch (*p) {
      case 'b': o_binary = 1; break;
      case 't': o_binary = 0; break;
      case 'c': check = 1; break;
      case 'z': o_zero = 1; break;
      case 'w': o_warn = 1; break;
      case 's': o_status = 1; break; /* busybox: -s = --status */
      case 'l':
        if (A->lazy) {
          const char *val = p[1] ? p + 1 : (i + 1 < argc ? argv[++i] : NULL);
          if (!val) { fprintf(stderr, "%s: option requires an argument -- 'l'\n", prog); usage(1); }
          if (set_length(val)) return 1;
          p += strlen(p) - 1;
          break;
        }
        /* fall through */
      default: fprintf(stderr, "%s: invalid option -- '%c'\n", prog, *p); usage(1);
      }
    }
  }
  if (check && o_tag) { fprintf(stderr, "%s: the --tag option is meaningless when verifying checksums\n", prog); usage(1); }
  iobuf = malloc(IOSZ);
  if (!iobuf) { fprintf(stderr, "%s: out of memory\n", prog); return 1; }
  if (!nfiles) files[nfiles++] = "-";
  int rc = 0;
  for (int i = 0; i < nfiles; i++) rc |= check ? check_list(files[i]) : print_one(files[i]);
  fflush(stdout);
  return rc;
}
