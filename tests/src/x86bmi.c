// POPCNT, LZCNT, TZCNT, BMI1 (ANDN, BEXTR, BLSI, BLSMSK, BLSR) and BMI2 (BZHI, PDEP, PEXT,
// MULX, RORX, SARX, SHLX, SHRX) against a plain C model: 16/32/64-bit forms, register and
// memory operands, random values plus edges (0, ~0, single bits, low masks), the defined flags
// (CF/ZF/SF/OF, PF for POPCNT), flags kept by the BMI2 ops, and the CPUID bits; also
// SHL/SHR/SAR by CL (flags, count 0 keeps them) and BSF/BSR.
// Prints "x86bmi ok <n>".
// Built static: gcc -O2 -mbmi -mbmi2 -mpopcnt -mlzcnt -static -o tests/x86bmi tests/src/x86bmi.c
#include <cpuid.h>
#include <stdint.h>
#include <stdio.h>

#define CF 0x1ull
#define PF 0x4ull
#define ZF 0x40ull
#define SF 0x80ull
#define OF 0x800ull
#define ARITH (CF | PF | ZF | SF | OF)

static int fails, checks;
static void check(const char *what, uint64_t got, uint64_t want, uint64_t a, uint64_t b) {
  checks++;
  if (got != want) {
    fails++;
    if (fails < 30)
      printf("FAIL %s (%llx %llx): %llx != %llx\n", what, (unsigned long long)a, (unsigned long long)b,
             (unsigned long long)got, (unsigned long long)want);
  }
}

// ---- model: plain C, built without the instructions under test ----
#define MODEL __attribute__((noinline, target("no-bmi,no-bmi2,no-popcnt,no-lzcnt")))
MODEL static uint64_t msk(int n) { return n == 64 ? ~0ull : (1ull << n) - 1; }
MODEL static uint64_t sgn(int n) { return 1ull << (n - 1); }
MODEL static uint64_t m_popcnt(uint64_t x) { uint64_t c = 0; for (int i = 0; i < 64; i++) c += (x >> i) & 1; return c; }
MODEL static uint64_t m_lzcnt(uint64_t x, int n) { uint64_t c = 0; for (int i = n - 1; i >= 0 && !((x >> i) & 1); i--) c++; return c; }
MODEL static uint64_t m_tzcnt(uint64_t x, int n) { uint64_t c = 0; for (int i = 0; i < n && !((x >> i) & 1); i++) c++; return c; }
MODEL static uint64_t m_pdep(uint64_t s, uint64_t m, int n) {
  uint64_t r = 0; int k = 0;
  for (int i = 0; i < n; i++) if ((m >> i) & 1) { if ((s >> k) & 1) r |= 1ull << i; k++; }
  return r;
}
MODEL static uint64_t m_pext(uint64_t s, uint64_t m, int n) {
  uint64_t r = 0; int k = 0;
  for (int i = 0; i < n; i++) if ((m >> i) & 1) { if ((s >> i) & 1) r |= 1ull << k; k++; }
  return r;
}
MODEL static uint64_t m_bextr(uint64_t s, uint64_t c, int n) {
  unsigned st = c & 0xFF, ln = (c >> 8) & 0xFF;
  uint64_t r = 0;
  for (unsigned i = 0; i < ln && st + i < (unsigned)n; i++) r |= ((s >> (st + i)) & 1) << i;
  return r;
}
MODEL static uint64_t m_bzhi(uint64_t s, uint64_t c, int n) {
  unsigned k = c & 0xFF;
  uint64_t r = 0;
  for (unsigned i = 0; i < (unsigned)n && i < k; i++) r |= s & (1ull << i);
  return k >= (unsigned)n ? s : r;
}
MODEL static uint64_t m_blsi(uint64_t s, int n) { for (int i = 0; i < n; i++) if ((s >> i) & 1) return 1ull << i; return 0; }
MODEL static uint64_t m_blsmsk(uint64_t s, int n) { uint64_t r = 0; for (int i = 0; i < n; i++) { r |= 1ull << i; if ((s >> i) & 1) break; } return r; }
MODEL static uint64_t m_blsr(uint64_t s, int n) { return s & ~m_blsi(s, n); }
MODEL static uint64_t m_shl(uint64_t s, uint64_t c, int n) { c &= n - 1; for (uint64_t i = 0; i < c; i++) s <<= 1; return s & msk(n); }
MODEL static uint64_t m_shr(uint64_t s, uint64_t c, int n) { c &= n - 1; for (uint64_t i = 0; i < c; i++) s >>= 1; return s; }
MODEL static uint64_t m_sar(uint64_t s, uint64_t c, int n) {
  c &= n - 1;
  for (uint64_t i = 0; i < c; i++) s = (s >> 1) | (s & sgn(n));
  return s;
}
MODEL static uint64_t m_ror(uint64_t s, unsigned c, int n) {
  c &= n - 1;
  for (unsigned i = 0; i < c; i++) s = (s >> 1) | ((s & 1) << (n - 1));
  return s;
}
// 64x64 -> 128 by 32-bit halves
MODEL static void m_mul(uint64_t a, uint64_t b, int n, uint64_t *hi, uint64_t *lo) {
  if (n == 32) { uint64_t p = a * b; *hi = p >> 32; *lo = p & 0xFFFFFFFF; return; }
  uint64_t al = a & 0xFFFFFFFF, ah = a >> 32, bl = b & 0xFFFFFFFF, bh = b >> 32;
  uint64_t ll = al * bl, lh = al * bh, hl = ah * bl, hh = ah * bh;
  uint64_t mid = (ll >> 32) + (lh & 0xFFFFFFFF) + (hl & 0xFFFFFFFF);
  *lo = (ll & 0xFFFFFFFF) | (mid << 32);
  *hi = hh + (lh >> 32) + (hl >> 32) + (mid >> 32);
}
MODEL static uint64_t zs(uint64_t r, int n) { return (r == 0 ? ZF : 0) | (r & sgn(n) ? SF : 0); }
// SHL/SHR/SAR (op 0/1/2) of the n-bit x by k (1..n-1): result, defined flags in *fl, mask in *fm
MODEL static uint64_t m_shf(int op, uint64_t x, int k, int n, uint64_t *fl, uint64_t *fm) {
  uint64_t m = msk(n), r, cf, of;
  x &= m;
  if (op == 0) { r = (x << k) & m; cf = (x >> (n - k)) & 1; of = ((r >> (n - 1)) & 1) ^ cf; }
  else if (op == 1) { r = x >> k; cf = (x >> (k - 1)) & 1; of = (x >> (n - 1)) & 1; }
  else { int64_t v = n == 64 ? (int64_t)x : (int64_t)(int32_t)x; r = (uint64_t)(v >> k) & m; cf = (uint64_t)(v >> (k - 1)) & 1; of = 0; }
  *fm = CF | ZF | SF | (k == 1 ? OF : 0);
  *fl = (cf ? CF : 0) | zs(r, n) | (k == 1 && of ? OF : 0);
  return r;
}

// ---- the instructions ----
// flags in (fi) through popf, out (fo) through pushf; rsp moves past the red zone first
#define PRE "lea -128(%%rsp), %%rsp\n push %[fi]\n popfq\n "
#define POST "\n pushfq\n pop %[fo]\n lea 128(%%rsp), %%rsp"
#define OPS3(ins, pfx) asm volatile(PRE ins " %" pfx "[x], %" pfx "[y], %" pfx "[r]" POST \
  : [r] "=&r"(r), [fo] "=&r"(fo) : [x] "r"(x), [y] "r"(y), [fi] "r"(fi) : "cc", "memory")
#define OPS2(ins, pfx) asm volatile(PRE ins " %" pfx "[x], %" pfx "[r]" POST \
  : [r] "=&r"(r), [fo] "=&r"(fo) : [x] "r"(x), [fi] "r"(fi) : "cc", "memory")
#define OPS2W(ins) asm volatile(PRE ins " %w[x], %w[r]" POST \
  : [r] "+&r"(r), [fo] "=&r"(fo) : [x] "r"(x), [fi] "r"(fi) : "cc", "memory")

static uint64_t rs = 0x9E3779B97F4A7C15ull;
static uint64_t rnd(void) { rs ^= rs << 13; rs ^= rs >> 7; rs ^= rs << 17; return rs; }
static uint64_t val(int i) {
  switch (i % 8) {
  case 0: return 0;
  case 1: return ~0ull;
  case 2: return 1ull << (rnd() & 63);
  case 3: return (1ull << (rnd() & 63)) - 1;
  case 4: return rnd() & rnd() & rnd();
  case 5: return 0xFFFFFFFFull ^ (rnd() & 0xFFFFFFFF00000000ull);
  case 6: return 0x8000000000000000ull | (rnd() & 0x80000000ull);
  default: return rnd();
  }
}
static uint64_t ctl(int i) {  // index/start+length controls, garbage above
  uint64_t g = rnd() & ~0xFFFFull;
  switch (i % 4) {
  case 0: return g | (rnd() % 72) | ((rnd() % 72) << 8);
  case 1: return g | (rnd() & 0xFFFF);
  case 2: return rnd() % 72;
  default: return rnd();
  }
}

static void one(int i) {
  uint64_t v = val(i), w = val(i / 3 + 5), c = (i & 1) ? val(i / 2 + 3) : ctl(i), r, fo;
  uint64_t fi = 0x2 | (rnd() & 0x8D5);
  uint64_t x = v, y = w, x32 = x & 0xFFFFFFFF, y32 = y & 0xFFFFFFFF;
#define SET(a, b) (x = (a), y = (b), x32 = x & 0xFFFFFFFF, y32 = y & 0xFFFFFFFF)
#define FL(what, mask, want) check(what " flags", fo & (mask), (want), x, y)
#define KEEP(what) check(what " flags kept", fo & ARITH, fi & ARITH, x, y)
  // ANDN dst = ~vvvv & rm: AT&T "andn rm, vvvv, dst"
  OPS3("andn", "q"); check("andn64", r, ~y & x, x, y); FL("andn64", CF | ZF | SF | OF, zs(~y & x, 64));
  OPS3("andn", "k"); check("andn32", r, ~y32 & x32, x, y); FL("andn32", CF | ZF | SF | OF, zs(~y32 & x32, 32));
  // BEXTR dst = rm, ctl vvvv: "bextr vvvv, rm, dst" (x = control / index / count, y = source)
  SET(c, v);
  OPS3("bextr", "q"); check("bextr64", r, m_bextr(y, x, 64), x, y); FL("bextr64", CF | ZF | OF, zs(m_bextr(y, x, 64), 64) & ZF);
  OPS3("bextr", "k"); check("bextr32", r, m_bextr(y32, x32, 32), x, y); FL("bextr32", CF | ZF | OF, zs(m_bextr(y32, x32, 32), 32) & ZF);
  // BZHI "bzhi vvvv(index), rm, dst"
  OPS3("bzhi", "q"); check("bzhi64", r, m_bzhi(y, x, 64), x, y);
  FL("bzhi64", CF | ZF | SF | OF, zs(m_bzhi(y, x, 64), 64) | ((x & 0xFF) >= 64 ? CF : 0));
  OPS3("bzhi", "k"); check("bzhi32", r, m_bzhi(y32, x32, 32), x, y);
  FL("bzhi32", CF | ZF | SF | OF, zs(m_bzhi(y32, x32, 32), 32) | ((x & 0xFF) >= 32 ? CF : 0));
  // PDEP / PEXT "pdep rm(mask), vvvv(src), dst"
  SET(w, v);
  OPS3("pdep", "q"); check("pdep64", r, m_pdep(y, x, 64), x, y); KEEP("pdep64");
  OPS3("pdep", "k"); check("pdep32", r, m_pdep(y32, x32, 32), x, y); KEEP("pdep32");
  OPS3("pext", "q"); check("pext64", r, m_pext(y, x, 64), x, y); KEEP("pext64");
  OPS3("pext", "k"); check("pext32", r, m_pext(y32, x32, 32), x, y); KEEP("pext32");
  // SHLX / SARX / SHRX "shlx vvvv(count), rm, dst"
  SET(c, v);
  OPS3("shlx", "q"); check("shlx64", r, m_shl(y, x, 64), x, y); KEEP("shlx64");
  OPS3("shlx", "k"); check("shlx32", r, m_shl(y32, x, 32), x, y); KEEP("shlx32");
  OPS3("shrx", "q"); check("shrx64", r, m_shr(y, x, 64), x, y); KEEP("shrx64");
  OPS3("shrx", "k"); check("shrx32", r, m_shr(y32, x, 32), x, y); KEEP("shrx32");
  OPS3("sarx", "q"); check("sarx64", r, m_sar(y, x, 64), x, y); KEEP("sarx64");
  OPS3("sarx", "k"); check("sarx32", r, m_sar(y32, x, 32), x, y); KEEP("sarx32");
  // BLSI / BLSMSK / BLSR "blsi rm, vvvv"
  SET(v, w);
  OPS2("blsi", "q"); check("blsi64", r, m_blsi(x, 64), x, 0);
  FL("blsi64", CF | ZF | SF | OF, zs(m_blsi(x, 64), 64) | (x ? CF : 0));
  OPS2("blsi", "k"); check("blsi32", r, m_blsi(x32, 32), x, 0);
  FL("blsi32", CF | ZF | SF | OF, zs(m_blsi(x32, 32), 32) | (x32 ? CF : 0));
  OPS2("blsmsk", "q"); check("blsmsk64", r, m_blsmsk(x, 64), x, 0);
  FL("blsmsk64", CF | ZF | SF | OF, (zs(m_blsmsk(x, 64), 64) & SF) | (x ? 0 : CF));
  OPS2("blsmsk", "k"); check("blsmsk32", r, m_blsmsk(x32, 32), x, 0);
  FL("blsmsk32", CF | ZF | SF | OF, (zs(m_blsmsk(x32, 32), 32) & SF) | (x32 ? 0 : CF));
  OPS2("blsr", "q"); check("blsr64", r, m_blsr(x, 64), x, 0);
  FL("blsr64", CF | ZF | SF | OF, zs(m_blsr(x, 64), 64) | (x ? 0 : CF));
  OPS2("blsr", "k"); check("blsr32", r, m_blsr(x32, 32), x, 0);
  FL("blsr32", CF | ZF | SF | OF, zs(m_blsr(x32, 32), 32) | (x32 ? 0 : CF));
  // POPCNT / LZCNT / TZCNT
  OPS2("popcnt", "q"); check("popcnt64", r, m_popcnt(x), x, 0); FL("popcnt64", ARITH, x ? 0 : ZF);
  OPS2("popcnt", "k"); check("popcnt32", r, m_popcnt(x32), x, 0); FL("popcnt32", ARITH, x32 ? 0 : ZF);
  OPS2("lzcnt", "q"); check("lzcnt64", r, m_lzcnt(x, 64), x, 0);
  FL("lzcnt64", CF | ZF, (x ? 0 : CF) | (m_lzcnt(x, 64) ? 0 : ZF));
  OPS2("lzcnt", "k"); check("lzcnt32", r, m_lzcnt(x32, 32), x, 0);
  FL("lzcnt32", CF | ZF, (x32 ? 0 : CF) | (m_lzcnt(x32, 32) ? 0 : ZF));
  OPS2("tzcnt", "q"); check("tzcnt64", r, m_tzcnt(x, 64), x, 0);
  FL("tzcnt64", CF | ZF, (x ? 0 : CF) | (m_tzcnt(x, 64) ? 0 : ZF));
  OPS2("tzcnt", "k"); check("tzcnt32", r, m_tzcnt(x32, 32), x, 0);
  FL("tzcnt32", CF | ZF, (x32 ? 0 : CF) | (m_tzcnt(x32, 32) ? 0 : ZF));
  {
    uint64_t x16 = x & 0xFFFF, up = y & ~0xFFFFull;
    r = y; OPS2W("popcnt"); check("popcnt16", r, up | m_popcnt(x16), x, y); FL("popcnt16", ARITH, x16 ? 0 : ZF);
    r = y; OPS2W("lzcnt"); check("lzcnt16", r, up | m_lzcnt(x16, 16), x, y);
    FL("lzcnt16", CF | ZF, (x16 ? 0 : CF) | (m_lzcnt(x16, 16) ? 0 : ZF));
    r = y; OPS2W("tzcnt"); check("tzcnt16", r, up | m_tzcnt(x16, 16), x, y);
    FL("tzcnt16", CF | ZF, (x16 ? 0 : CF) | (m_tzcnt(x16, 16) ? 0 : ZF));
  }
  // MULX "mulx rm, lo(vvvv), hi" with rdx implicit
  {
    uint64_t hi, lo, wh, wl;
    asm volatile("mulx %[x], %[lo], %[hi]" : [hi] "=&r"(hi), [lo] "=&r"(lo) : [x] "r"(x), "d"(y));
    m_mul(y, x, 64, &wh, &wl); check("mulx64 hi", hi, wh, x, y); check("mulx64 lo", lo, wl, x, y);
    asm volatile("mulx %k[x], %k[lo], %k[hi]" : [hi] "=&r"(hi), [lo] "=&r"(lo) : [x] "r"(x), "d"(y));
    m_mul(y32, x32, 32, &wh, &wl); check("mulx32 hi", hi, wh, x, y); check("mulx32 lo", lo, wl, x, y);
    asm volatile("mulx %%rcx, %%rax, %%rax" : "=a"(hi) : "c"(x), "d"(y));
    m_mul(y, x, 64, &wh, &wl); check("mulx same reg", hi, wh, x, y);
  }
  // RORX "rorx $imm, rm, dst"
#define RORX(k) \
  asm volatile("rorx %[n], %q[x], %q[r]" : [r] "=r"(r) : [x] "r"(x), [n] "i"(k)); check("rorx64 " #k, r, m_ror(x, k, 64), x, k); \
  asm volatile("rorx %[n], %k[x], %k[r]" : [r] "=r"(r) : [x] "r"(x), [n] "i"(k)); check("rorx32 " #k, r, m_ror(x32, k, 32), x, k);
  RORX(0) RORX(1) RORX(7) RORX(31) RORX(32) RORX(33) RORX(63)
  // shifts by CL with the flags read right after (pushf): a zero count keeps them
  {
    uint64_t cl = rnd() & 0xFF, fl, fm, want;
    if (i % 5 == 0) cl &= ~63ull;
#define SHC(ins, reg, n, op, in) do { int k = (int)(cl & (n == 64 ? 63 : 31)); r = (in); \
    asm volatile(PRE ins " %%cl, %" reg "[r]" POST : [r] "+&r"(r), [fo] "=&r"(fo) : "c"(cl), [fi] "r"(fi) : "cc", "memory"); \
    if (k == 0) { check(ins " cl=0", r, (in), x, cl); KEEP(ins " cl=0"); } \
    else { want = m_shf(op, (in), k, n, &fl, &fm); check(ins " cl", r, want, x, cl); check(ins " cl flags", fo & fm, fl, x, cl); } } while (0)
    SHC("shlq", "", 64, 0, x); SHC("shrq", "", 64, 1, x); SHC("sarq", "", 64, 2, x);
    SHC("shll", "k", 32, 0, x32); SHC("shrl", "k", 32, 1, x32); SHC("sarl", "k", 32, 2, x32);
#undef SHC
    // BSF/BSR: a zero source keeps the destination
    r = y; asm volatile(PRE "bsfq %[x], %[r]" POST : [r] "+&r"(r), [fo] "=&r"(fo) : [x] "r"(x), [fi] "r"(fi) : "cc", "memory");
    check("bsf64", r, x ? m_tzcnt(x, 64) : y, x, y); FL("bsf64", ZF, x ? 0 : ZF);
    r = y; asm volatile(PRE "bsrq %[x], %[r]" POST : [r] "+&r"(r), [fo] "=&r"(fo) : [x] "r"(x), [fi] "r"(fi) : "cc", "memory");
    check("bsr64", r, x ? 63 - m_lzcnt(x, 64) : y, x, y); FL("bsr64", ZF, x ? 0 : ZF);
    if (x32) { asm volatile("bsfl %k[x], %k[r]" : [r] "=r"(r) : [x] "r"(x32) : "cc"); check("bsf32", r, m_tzcnt(x32, 32), x, 0); }
  }
  // memory operands (and rip of the next instruction past an immediate)
  SET(v, c);
  {
    static volatile uint64_t mem;
    mem = x;
    asm volatile("andn %[m], %[y], %[r]" : [r] "=r"(r) : [m] "m"(mem), [y] "r"(y) : "cc"); check("andn mem", r, ~y & x, x, y);
    asm volatile("bextr %[y], %[m], %[r]" : [r] "=r"(r) : [m] "m"(mem), [y] "r"(y) : "cc"); check("bextr mem", r, m_bextr(x, y, 64), x, y);
    asm volatile("bzhi %[y], %[m], %[r]" : [r] "=r"(r) : [m] "m"(mem), [y] "r"(y) : "cc"); check("bzhi mem", r, m_bzhi(x, y, 64), x, y);
    asm volatile("pdep %[m], %[y], %[r]" : [r] "=r"(r) : [m] "m"(mem), [y] "r"(y)); check("pdep mem", r, m_pdep(y, x, 64), x, y);
    asm volatile("pext %[m], %[y], %[r]" : [r] "=r"(r) : [m] "m"(mem), [y] "r"(y)); check("pext mem", r, m_pext(y, x, 64), x, y);
    asm volatile("sarx %[y], %[m], %[r]" : [r] "=r"(r) : [m] "m"(mem), [y] "r"(y)); check("sarx mem", r, m_sar(x, y, 64), x, y);
    asm volatile("blsr %[m], %[r]" : [r] "=r"(r) : [m] "m"(mem) : "cc"); check("blsr mem", r, m_blsr(x, 64), x, 0);
    asm volatile("tzcnt %[m], %[r]" : [r] "=r"(r) : [m] "m"(mem) : "cc"); check("tzcnt mem", r, m_tzcnt(x, 64), x, 0);
    asm volatile("rorxq $13, %[m], %[r]" : [r] "=r"(r) : [m] "m"(mem)); check("rorx mem", r, m_ror(x, 13, 64), x, 13);
    uint64_t hi, lo, wh, wl;
    asm volatile("mulxq %[m], %[lo], %[hi]" : [hi] "=&r"(hi), [lo] "=&r"(lo) : [m] "m"(mem), "d"(y));
    m_mul(y, x, 64, &wh, &wl); check("mulx mem hi", hi, wh, x, y); check("mulx mem lo", lo, wl, x, y);
  }
}

int main(void) {
  unsigned a, b, c, d;
  __cpuid(0, a, b, c, d); check("cpuid max leaf >= 7", a >= 7, 1, a, 0);
  __cpuid(1, a, b, c, d); check("cpuid popcnt", (c >> 23) & 1, 1, c, 0);
  __cpuid_count(7, 0, a, b, c, d); check("cpuid bmi1", (b >> 3) & 1, 1, b, 0); check("cpuid bmi2", (b >> 8) & 1, 1, b, 0);
  __cpuid(0x80000001, a, b, c, d); check("cpuid abm/lzcnt", (c >> 5) & 1, 1, c, 0);
  for (int i = 0; i < 20000; i++) one(i);  // hot enough for the JIT
  if (fails) { printf("x86bmi FAIL %d of %d\n", fails, checks); return 1; }
  printf("x86bmi ok %d\n", checks);
  return 0;
}
