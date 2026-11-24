// WASI pwrite / pread (tests/linux-test.mjs): wasi-libc's pwrite() calls fd_pwrite, pread() fd_pread;
// the file offset stays where it was. Built in CI with wasi-sdk: clang -O2 -o tests/wasipwrite.wasm tests/src/wasipwrite.c
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(void) {
  int fd = open("/tmp/wasi-pw.txt", O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) { printf("wasipwrite open failed\n"); return 1; }
  char b[32] = "";
  int ok = write(fd, "0123456789", 10) == 10 && lseek(fd, 3, SEEK_SET) == 3
    && pwrite(fd, "AB", 2, 6) == 2 && lseek(fd, 0, SEEK_CUR) == 3
    && pread(fd, b, 10, 0) == 10 && memcmp(b, "012345AB89", 10) == 0 && lseek(fd, 0, SEEK_CUR) == 3;
  close(fd);
  printf(ok ? "wasipwrite ok %s\n" : "wasipwrite FAIL %s\n", b);
  return !ok;
}
