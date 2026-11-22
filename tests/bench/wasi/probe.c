// WASI probe for phase 2 (kernel runs WASI programs): touches the calls a terminal tool needs.
// Built with wasi-sdk: clang -O2 -o probe.wasm probe.c. Prints "ok NAME" / "FAIL NAME".
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <errno.h>
#include <time.h>
#include <sys/stat.h>
#include <sys/random.h>
static int fails;
static void ck(int ok, const char *n) { printf("%s %s\n", ok ? "ok" : "FAIL", n); if (!ok) { fails++; printf("  errno %d %s\n", errno, strerror(errno)); } }
int main(int argc, char **argv) {
  ck(argc >= 2 && !strcmp(argv[1], "arg1"), "args");
  ck(getenv("PROBE") && !strcmp(getenv("PROBE"), "yes"), "environ");
  struct timespec ts; ck(!clock_gettime(CLOCK_MONOTONIC, &ts) && !clock_gettime(CLOCK_REALTIME, &ts) && ts.tv_sec > 1700000000, "clock");
  unsigned char r[16] = {0}; getentropy(r, sizeof r); int nz = 0; for (int i = 0; i < 16; i++) nz |= r[i]; ck(nz, "random");
  ck(!mkdir("/w/d", 0755) || errno == EEXIST, "mkdir");
  int fd = open("/w/d/f.bin", O_CREAT | O_RDWR | O_TRUNC, 0644); ck(fd >= 0, "open-create");
  static char big[1 << 20]; memset(big, 'a', sizeof big);
  ck(write(fd, big, sizeof big) == sizeof big, "write-1MB");
  ck(lseek(fd, 4096, SEEK_SET) == 4096 && write(fd, "XY", 2) == 2, "seek-write");
  char b2[2]; ck(pread(fd, b2, 2, 4096) == 2 && b2[0] == 'X', "pread");
  ck(!ftruncate(fd, 8192), "ftruncate");
  struct stat s; ck(!fstat(fd, &s) && s.st_size == 8192, "fstat");
  ck(!fsync(fd) && !close(fd), "fsync-close");
  ck(!rename("/w/d/f.bin", "/w/d/g.bin"), "rename");
  ck(!stat("/w/d/g.bin", &s) && S_ISREG(s.st_mode), "stat");
  DIR *d = opendir("/w/d"); int seen = 0; struct dirent *e; while (d && (e = readdir(d))) seen |= !strcmp(e->d_name, "g.bin"); if (d) closedir(d); ck(seen, "readdir");
  ck(!symlink("g.bin", "/w/d/l") || errno == ENOTSUP, "symlink");
  ck(!unlink("/w/d/g.bin"), "unlink"); unlink("/w/d/l"); ck(!rmdir("/w/d"), "rmdir");
  ck(open("/etc/passwd", O_RDONLY) < 0, "sandbox (no access outside preopen)");
  char line[64]; ck(fgets(line, sizeof line, stdin) && !strncmp(line, "hello", 5), "stdin");
  fprintf(stderr, "stderr ok\n");
  printf("probe %s (%d fails)\n", fails ? "FAIL" : "PASS", fails);
  return fails ? 1 : 0;
}
