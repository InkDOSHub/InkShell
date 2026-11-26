/* Stubs for POSIX calls WASI preview1 does not have (no users; processes through the host channel, see below). tools/wasm-tools/build.sh links them. */
#include <errno.h>
#include <fcntl.h>
#include <time.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <sys/sysinfo.h>
#include <sys/stat.h>
#include <sys/types.h>
#include "compat.h"
#include "pwd.h"
#include "sys/wait.h"
#include "grp.h"
/* Processes (item 78): WASI has none, so the host (wasi.js ctlCall) gives a channel: open "/dev/inksoc", write one
 * JSON request line, read one JSON answer line. {"op":"spawn","argv":[..],"cwd":..,"env":[..],"stdout":"pipe"} ->
 * {"pid":N,"stdout":FD}; {"op":"wait","pid":N,"nohang":true} -> {"pid":N,"status":S}; errors {"error":WASI errno}.
 * A program with a WebAssembly build runs as WebAssembly (its own Worker); others as x86 Linux. system() and
 * popen() start a command without shell syntax directly (split on blanks), else through /bin/sh -c. */
extern char **environ;
static int ink_ch = -1;
typedef struct { char *b; size_t n, cap; int bad; } ink_buf;
static void ink_put(ink_buf *o, const char *s, size_t n)
{
  if (o->bad) return;
  if (o->n + n + 1 > o->cap) {
    size_t c = (o->cap ? o->cap * 2 : 1024); while (c < o->n + n + 1) c *= 2;
    char *b = realloc(o->b, c); if (!b) { o->bad = 1; return; }
    o->b = b; o->cap = c;
  }
  memcpy(o->b + o->n, s, n); o->n += n; o->b[o->n] = 0;
}
static void ink_puts(ink_buf *o, const char *s) { ink_put(o, s, strlen(s)); }
static void ink_str(ink_buf *o, const char *s) /* a JSON string */
{
  ink_puts(o, "\"");
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s; char e[8];
    if (c == '"' || c == '\\') { e[0] = '\\'; e[1] = (char)c; ink_put(o, e, 2); }
    else if (c < 0x20) { snprintf(e, sizeof e, "\\u%04x", c); ink_puts(o, e); }
    else ink_put(o, (const char *)&c, 1);
  }
  ink_puts(o, "\"");
}
static long ink_num(const char *a, const char *k, long def) /* "k":N in an answer */
{
  char key[32]; snprintf(key, sizeof key, "\"%s\":", k);
  const char *p = strstr(a, key);
  return p ? strtol(p + strlen(key), NULL, 10) : def;
}
static int ink_ask(ink_buf *q, char *ans, size_t cap) /* 0, or -1 with errno */
{
  if (q->bad) { errno = ENOMEM; return -1; }
  if (ink_ch < 0 && (ink_ch = open("/dev/inksoc", O_RDWR)) < 0) { errno = ENOSYS; return -1; }
  ink_puts(q, "\n");
  for (size_t o = 0; o < q->n;) { ssize_t w = write(ink_ch, q->b + o, q->n - o); if (w <= 0) return -1; o += (size_t)w; }
  size_t n = 0;
  while (n + 1 < cap && (n == 0 || ans[n - 1] != '\n')) { ssize_t r = read(ink_ch, ans + n, cap - 1 - n); if (r <= 0) { errno = EIO; return -1; } n += (size_t)r; }
  ans[n] = 0;
  long e = ink_num(ans, "error", 0);
  if (e) { errno = (int)e; return -1; }
  return 0;
}
static int ink_plain(const char *c) /* no shell syntax: the words can be started directly */
{
  int words = 0;
  for (const char *p = c; *p; p++) {
    if (strchr("|&;<>()$`\\\"'*?[]#~=%{}!\n", *p)) return 0;
    if (*p != ' ' && *p != '\t' && (p == c || p[-1] == ' ' || p[-1] == '\t')) words++;
  }
  return words > 0;
}
/* starts `cmd`; io: 0 = inherit, 'r' = its stdout is a pipe, 'w' = its stdin is a pipe (*fd = this side) */
static pid_t ink_spawn(const char *cmd, int io, int *fd)
{
  ink_buf q = {0}; char ans[512], cwd[1024];
  ink_puts(&q, "{\"op\":\"spawn\",\"argv\":[");
  if (ink_plain(cmd)) {
    int first = 1; const char *p = cmd;
    while (*p) {
      while (*p == ' ' || *p == '\t') p++;
      if (!*p) break;
      size_t n = strcspn(p, " \t"); char *w = strndup(p, n);
      if (!w) { q.bad = 1; break; }
      if (!first) ink_puts(&q, ",");
      ink_str(&q, w); free(w); first = 0; p += n;
    }
  } else { ink_puts(&q, "\"/bin/sh\",\"-c\","); ink_str(&q, cmd); }
  ink_puts(&q, "]");
  if (getcwd(cwd, sizeof cwd) && strcmp(cwd, "/")) { ink_puts(&q, ",\"cwd\":"); ink_str(&q, cwd); }
  if (environ) { ink_puts(&q, ",\"env\":["); for (char **e = environ; *e; e++) { if (e != environ) ink_puts(&q, ","); ink_str(&q, *e); } ink_puts(&q, "]"); }
  if (io == 'r') ink_puts(&q, ",\"stdout\":\"pipe\"");
  if (io == 'w') ink_puts(&q, ",\"stdin\":\"pipe\"");
  ink_puts(&q, "}");
  fflush(NULL);
  int r = ink_ask(&q, ans, sizeof ans);
  free(q.b);
  if (r < 0) return -1;
  if (fd) *fd = (int)ink_num(ans, io == 'r' ? "stdout" : "stdin", -1);
  return (pid_t)ink_num(ans, "pid", -1);
}
pid_t waitpid(pid_t p, int *s, int o)
{
  ink_buf q = {0}; char ans[256], t[64];
  snprintf(t, sizeof t, "{\"op\":\"wait\",\"pid\":%d%s}", (int)p, (o & WNOHANG) ? ",\"nohang\":true" : "");
  ink_puts(&q, t);
  int r = ink_ask(&q, ans, sizeof ans);
  free(q.b);
  if (r < 0) return -1;
  if (s) *s = (int)ink_num(ans, "status", 0);
  return (pid_t)ink_num(ans, "pid", -1);
}
pid_t wait(int *s) { return waitpid(-1, s, 0); }
pid_t fork(void) { errno = ENOSYS; return -1; } /* a WebAssembly program cannot copy itself: use system/popen */
int execvp(const char *f, char *const a[]) { (void)f; (void)a; errno = ENOSYS; return -1; }
int system(const char *c)
{
  if (!c) return 1; /* a shell is there */
  int se = errno; /* Lua's os.execute reads errno after a nonzero status */
  pid_t p = ink_spawn(c, 0, NULL);
  if (p < 0) { errno = se; return 127 << 8; } /* as sh says for a command it cannot start */
  int st = 0;
  while (waitpid(p, &st, 0) < 0) if (errno != EINTR) return -1;
  errno = se;
  return st;
}
static struct ink_pop { FILE *f; pid_t pid; struct ink_pop *next; } *ink_pops;
FILE *popen(const char *c, const char *m)
{
  if (!c || !m || (m[0] != 'r' && m[0] != 'w')) { errno = EINVAL; return NULL; }
  struct ink_pop *e = malloc(sizeof *e);
  if (!e) return NULL;
  int fd = -1; pid_t p = ink_spawn(c, m[0], &fd);
  if (p < 0 || fd < 0) { free(e); return NULL; }
  e->f = fdopen(fd, m[0] == 'r' ? "r" : "w");
  if (!e->f) { close(fd); waitpid(p, NULL, 0); free(e); return NULL; }
  e->pid = p; e->next = ink_pops; ink_pops = e;
  return e->f;
}
int pclose(FILE *f)
{
  struct ink_pop **pp = &ink_pops;
  while (*pp && (*pp)->f != f) pp = &(*pp)->next;
  if (!*pp) { errno = ECHILD; return -1; }
  struct ink_pop *e = *pp; *pp = e->next;
  pid_t p = e->pid; free(e);
  fclose(f);
  int st = 0, se = errno;
  while (waitpid(p, &st, 0) < 0) if (errno != EINTR) return -1;
  errno = se;
  return st;
}
struct passwd *getpwuid(uid_t u) { (void)u; return NULL; }
struct passwd *getpwnam(const char *n) { (void)n; return NULL; }
int getpwnam_r(const char *n, struct passwd *p, char *b, size_t l, struct passwd **r) { (void)n; (void)p; (void)b; (void)l; *r = NULL; return 0; }
int getpwuid_r(uid_t u, struct passwd *p, char *b, size_t l, struct passwd **r) { (void)u; (void)p; (void)b; (void)l; *r = NULL; return 0; }
uid_t getuid(void) { return 0; }
uid_t geteuid(void) { return 0; }
gid_t getgid(void) { return 0; }
gid_t getegid(void) { return 0; }
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
