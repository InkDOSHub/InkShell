// Item 58: the same CPU workloads for our x86-64 engine and for v86 (32-bit x86), built twice from this file.
// x86-64: gcc -O2 -static (musl, alpine x86_64). i386: gcc -O2 -static -march=pentium4 -msse2 -mfpmath=sse (musl, i386/alpine;
// SSE2 floats because v86's x87 FPU is soft-float and would measure the FPU, not the CPU core).
// 32-bit integer arithmetic only, so both builds do the same work. The host stamps the "@@T" lines (no guest clock).
// As PID 1 (v86 initramfs /init) it opens /dev/ttyS0 for the output and then sleeps forever.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/sysmacros.h>
static int fd = 1;
static void mark(const char *k, const char *n) { char b[96]; int l = snprintf(b, sizeof b, "@@T %s:%s\n", k, n); if (write(fd, b, l) < 0) {} }
static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
static int cmp(const void *a, const void *b) { uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b; return x < y ? -1 : x > y; }
int main(void) {
  if (getpid() == 1) {
    mkdir("/dev", 0755); mount("devtmpfs", "/dev", "devtmpfs", 0, 0);
    int f = open("/dev/ttyS0", O_WRONLY | O_NOCTTY);
    if (f < 0) { mknod("/dev/ttyS0", S_IFCHR | 0600, makedev(4, 64)); f = open("/dev/ttyS0", O_WRONLY | O_NOCTTY); }
    if (f >= 0) fd = f;
  }
  mark("boot", "init");
  volatile uint32_t sink = 0; char b[48];
  mark("begin", "int");
  { uint32_t x = 2463534242u, acc = 0; for (long i = 0; i < 40000000; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; acc += (x * 2654435761u) >> 3; } sink += acc; }
  mark("end", "int");
  mark("begin", "calls"); sink += fib(32); mark("end", "calls");
  uint32_t *a = malloc(1000000 * 4); uint32_t s = 12345;
  for (int i = 0; i < 1000000; i++) { s = s * 1664525u + 1013904223u; a[i] = s; }
  mark("begin", "sort"); qsort(a, 1000000, 4, cmp); mark("end", "sort"); sink += a[500000];
  char *p = malloc(1 << 20), *q = malloc(1 << 20); memset(p, 'x', (1 << 20) - 1); p[(1 << 20) - 1] = 0;
  mark("begin", "string");
  for (int i = 0; i < 32; i++) { memcpy(q, p, 1 << 20); sink += strlen(q) + (memchr(q, 'y', 1 << 20) != 0); }
  mark("end", "string");
  mark("begin", "float");
  { double x = 0; for (long i = 1; i < 15000000; i++) x += 1.0 / ((double)i * i); sink += (uint32_t)(x * 1e6); }
  mark("end", "float");
  snprintf(b, sizeof b, "%u", (unsigned)sink); mark("sum", b);
  if (write(fd, "@@T done\n", 9) < 0) {}
  if (getpid() == 1) for (;;) pause();
  return 0;
}
