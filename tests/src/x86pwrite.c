// pwrite64 / preadv / pwritev / preadv2 / pwritev2 (tests/linux-test.mjs): a write at a position
// leaves the file offset alone; big files (in blocks); 2 iovecs; pipe = ESPIPE; unknown RWF_ flag.
// Built static in CI (Alpine gcc): gcc -O2 -static -o tests/x86pwrite tests/src/x86pwrite.c
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <unistd.h>
static int fails;
#define CHECK(c) do { if (!(c)) { printf("FAIL line %d: %s (errno %d)\n", __LINE__, #c, errno); fails++; } } while (0)
int main(int argc, char **argv) {
  const char *p = argc > 1 ? argv[1] : "/tmp/pw.bin";
  int fd = open(p, O_RDWR | O_CREAT | O_TRUNC, 0644); CHECK(fd >= 0);
  char buf[64];
  CHECK(write(fd, "0123456789abcdef", 16) == 16);
  CHECK(lseek(fd, 4, SEEK_SET) == 4);
  CHECK(pwrite(fd, "XY", 2, 8) == 2);                       // middle of the file
  CHECK(lseek(fd, 0, SEEK_CUR) == 4);                       // offset unchanged
  memset(buf, 0, sizeof buf); CHECK(pread(fd, buf, 16, 0) == 16);
  CHECK(memcmp(buf, "01234567XYabcdef", 16) == 0);
  CHECK(read(fd, buf, 2) == 2 && memcmp(buf, "45", 2) == 0); // reads go on from 4
  CHECK(pwrite(fd, "END", 3, 20) == 3);                      // past the end: a hole of zeros
  CHECK(pread(fd, buf, 7, 16) == 7 && memcmp(buf, "\0\0\0\0END", 7) == 0);
  CHECK(lseek(fd, 0, SEEK_CUR) == 6);
  // a big file (> 1 MB, in blocks): pwrite at several places, pread back, offset still where it was
  size_t big = 3u << 20; char *b = malloc(big); for (size_t i = 0; i < big; i++) b[i] = (char)(i * 7 + 1);
  CHECK(pwrite(fd, b, big, 0) == (ssize_t)big);
  CHECK(pwrite(fd, "MID!", 4, 1500000) == 4);
  CHECK(pwrite(fd, "TAIL", 4, big - 2) == 4);
  CHECK(lseek(fd, 0, SEEK_CUR) == 6);
  CHECK(pread(fd, buf, 8, 1499998) == 8 && buf[0] == b[1499998] && buf[1] == b[1499999] && memcmp(buf + 2, "MID!", 4) == 0 && buf[6] == b[1500004]);
  CHECK(pread(fd, buf, 8, big - 4) == 6 && buf[0] == b[big - 4] && memcmp(buf + 2, "TAIL", 4) == 0);
  CHECK(lseek(fd, 0, SEEK_END) == (off_t)big + 2);
  CHECK(lseek(fd, 100, SEEK_SET) == 100);
  // pwritev / preadv: 2 iovecs
  struct iovec w[2] = { { "hello ", 6 }, { "world", 5 } };
  CHECK(pwritev(fd, w, 2, 2000000) == 11);
  CHECK(lseek(fd, 0, SEEK_CUR) == 100);
  char r1[4], r2[7]; struct iovec r[2] = { { r1, 4 }, { r2, 7 } };
  CHECK(preadv(fd, r, 2, 2000000) == 11 && memcmp(r1, "hell", 4) == 0 && memcmp(r2, "o world", 7) == 0);
  CHECK(lseek(fd, 0, SEEK_CUR) == 100);
  // preadv2 / pwritev2: flags 0 and RWF_SYNC, offset -1 = the file offset (which then moves)
  struct iovec w2 = { "v2", 2 };
  CHECK(syscall(SYS_pwritev2, fd, &w2, 1, 3000000L, 0L, 4L) == 2);
  CHECK(lseek(fd, 0, SEEK_CUR) == 100);
  struct iovec r3 = { buf, 2 }; memset(buf, 0, 4);
  CHECK(syscall(SYS_preadv2, fd, &r3, 1, 3000000L, 0L, 0L) == 2 && memcmp(buf, "v2", 2) == 0);
  CHECK(syscall(SYS_preadv2, fd, &r3, 1, -1L, -1L, 0L) == 2 && buf[0] == b[100] && buf[1] == b[101]);
  CHECK(lseek(fd, 0, SEEK_CUR) == 102);
  errno = 0; CHECK(syscall(SYS_preadv2, fd, &r3, 1, 0L, 0L, 0x1000L) == -1 && errno == EOPNOTSUPP);
  errno = 0; CHECK(pwrite(fd, "x", 1, -5) == -1 && errno == EINVAL);
  close(fd);
  // a pipe: no position
  int pp[2]; CHECK(pipe(pp) == 0);
  errno = 0; CHECK(pwrite(pp[1], "x", 1, 0) == -1 && errno == ESPIPE);
  errno = 0; CHECK(pread(pp[0], buf, 1, 0) == -1 && errno == ESPIPE);
  errno = 0; CHECK(pwritev(pp[1], w, 2, 0) == -1 && errno == ESPIPE);
  errno = 0; CHECK(pwrite(99, "x", 1, 0) == -1 && errno == EBADF);
  unlink(p);
  if (!fails) printf("x86pwrite ok %d\n", 26);
  return fails != 0;
}
