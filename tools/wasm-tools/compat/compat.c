/* Stubs for POSIX calls WASI preview1 does not have (no processes, no users). tools/wasm-tools/build.sh links them. */
#include <errno.h>
#include <fcntl.h>
#include <time.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/sysinfo.h>
#include <sys/stat.h>
#include <sys/types.h>
#include "compat.h"
#include "pwd.h"
#include "sys/wait.h"
#include "grp.h"
pid_t waitpid(pid_t p, int *s, int o) { (void)p; (void)s; (void)o; errno = ECHILD; return -1; }
pid_t wait(int *s) { (void)s; errno = ECHILD; return -1; }
pid_t fork(void) { errno = ENOSYS; return -1; }
int execvp(const char *f, char *const a[]) { (void)f; (void)a; errno = ENOSYS; return -1; }
int system(const char *c) { (void)c; errno = ENOSYS; return c ? -1 : 0; }
FILE *popen(const char *c, const char *m) { (void)c; (void)m; errno = ENOSYS; return NULL; }
int pclose(FILE *f) { (void)f; errno = ECHILD; return -1; }
struct passwd *getpwuid(uid_t u) { (void)u; return NULL; }
struct passwd *getpwnam(const char *n) { (void)n; return NULL; }
int getpwnam_r(const char *n, struct passwd *p, char *b, size_t l, struct passwd **r) { (void)n; (void)p; (void)b; (void)l; *r = NULL; return 0; }
int getpwuid_r(uid_t u, struct passwd *p, char *b, size_t l, struct passwd **r) { (void)u; (void)p; (void)b; (void)l; *r = NULL; return 0; }
pid_t getppid(void) { return 1; }
mode_t umask(mode_t m) { (void)m; return 022; }
int chown(const char *p, uid_t u, gid_t g) { (void)p; (void)u; (void)g; return 0; } /* one user: owners are not kept */
int lchown(const char *p, uid_t u, gid_t g) { (void)p; (void)u; (void)g; return 0; }
int fchown(int f, uid_t u, gid_t g) { (void)f; (void)u; (void)g; return 0; }
struct group *getgrgid(gid_t g) { (void)g; return NULL; }
struct group *getgrnam(const char *n) { (void)n; return NULL; }
int sysinfo(struct sysinfo *i) { memset(i, 0, sizeof *i); i->totalram = i->freeram = 1u << 30; i->mem_unit = 1; return 0; } /* 1 GB: what a wasm32 program can use comfortably */
int compat_chmod(const char *p, mode_t m) { struct stat st; int r = chmod(p, m); return r && errno == ENOSYS ? stat(p, &st) : r; }
int compat_fchmod(int f, mode_t m) { struct stat st; int r = fchmod(f, m); return r && errno == ENOSYS ? fstat(f, &st) : r; }
int mkstemp(char *t) /* WASI libc declares mkstemp but has none (zip): XXXXXX from the clock and a counter, created with O_EXCL */
{
  static unsigned c;
  size_t n = strlen(t);
  if (n < 6 || strcmp(t + n - 6, "XXXXXX")) { errno = EINVAL; return -1; }
  for (int i = 0; i < 100; i++) {
    struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
    unsigned v = (unsigned)ts.tv_nsec ^ (++c * 2654435761u);
    for (int k = 0; k < 6; k++, v /= 36) t[n - 6 + k] = "0123456789abcdefghijklmnopqrstuvwxyz"[v % 36];
    int fd = open(t, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd >= 0 || errno != EEXIST) return fd;
  }
  errno = EEXIST; return -1;
}
