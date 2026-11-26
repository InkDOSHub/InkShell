/* nano/ncurses on WASI: tcgetattr/tcsetattr, the TIOCGWINSZ ioctl, and the signal calls nano uses (sigaction, sigprocmask, ...).
   WASI has no ioctl: the host (wasi.js, import module "inksoc") does TCGETS / TCSETS / TIOCGWINSZ on the Linux terminal.
   Signals: only what wasi-libc emulates (signal/raise); SIGWINCH never arrives (nano asks for the size when it redraws). InkShell's own code, MIT. */
#include <errno.h>
#include <stdarg.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <string.h>
#include <time.h>
#include <stdlib.h>
#include "termios.h"
#include "ink_nano.h"

#define IMP(n) __attribute__((__import_module__("inksoc"), __import_name__(n)))
IMP("tty_get") int ink_tty_get(int fd, void *termios36);   /* 0 = ok */
IMP("tty_set") int ink_tty_set(int fd, const void *termios36);
IMP("tty_size") int ink_tty_size(int fd, unsigned short *rows_cols); /* 0 = ok */

/* the terminal database is only the built-in xterm-256color entry (ncurses --with-fallbacks): the browser terminal is an xterm */
__attribute__((constructor)) static void ink_term(void) { setenv("TERM", "xterm-256color", 1); }

int tcgetattr(int fd, struct termios *t) { if (ink_tty_get(fd, t)) { errno = ENOTTY; return -1; } return 0; }
int tcsetattr(int fd, int a, const struct termios *t) { (void)a; if (ink_tty_set(fd, t)) { errno = ENOTTY; return -1; } return 0; }
int tcflush(int fd, int q) { struct termios t; (void)q; return tcgetattr(fd, &t); }
int tcdrain(int fd) { struct termios t; return tcgetattr(fd, &t); }
speed_t cfgetospeed(const struct termios *t) { return t->c_cflag & CBAUD; }
speed_t cfgetispeed(const struct termios *t) { return t->c_cflag & CBAUD; }
int ioctl(int fd, int req, ...) {
  va_list ap; va_start(ap, req);
  if (req == TIOCGWINSZ) {
    struct winsize *w = va_arg(ap, struct winsize *); unsigned short rc[4] = { 0, 0, 0, 0 };
    va_end(ap);
    if (ink_tty_size(fd, rc)) { errno = ENOTTY; return -1; }
    w->ws_row = rc[0]; w->ws_col = rc[1]; w->ws_xpixel = rc[2]; w->ws_ypixel = rc[3]; return 0;
  }
  va_end(ap); errno = ENOTTY; return -1;
}

int sigaction(int sig, const struct sigaction *a, struct sigaction *old) {
  void (*prev)(int) = SIG_DFL;
  if (sig == SIGKILL || sig == SIGSTOP) { errno = EINVAL; return -1; }
  if (a) { prev = signal(sig, a->sa_handler); if (prev == SIG_ERR) { errno = EINVAL; return -1; } }
  if (old) { old->sa_handler = prev; old->sa_flags = 0; old->sa_mask = 0; }
  return 0;
}
int sigemptyset(sigset_t *s) { *s = 0; return 0; }
int sigfillset(sigset_t *s) { *s = 0xff; return 0; }
int sigaddset(sigset_t *s, int n) { *s |= 1u << (n & 7); return 0; }
int sigdelset(sigset_t *s, int n) { *s &= ~(1u << (n & 7)); return 0; }
int sigismember(const sigset_t *s, int n) { return (*s >> (n & 7)) & 1; }
int sigprocmask(int how, const sigset_t *s, sigset_t *old) { (void)how; (void)s; if (old) *old = 0; return 0; }
struct passwd *getpwent(void) { return NULL; } /* nano's ~user completion: no user database */
void endpwent(void) {}
int mkstemps(char *t, int suf) { /* ...XXXXXX<suffix>: created with O_EXCL (WASI libc has none) */
  static const char a[] = "abcdefghijklmnopqrstuvwxyz0123456789"; static unsigned long n;
  size_t l = strlen(t); char *x;
  if ((int)l < 6 + suf || strncmp(t + l - suf - 6, "XXXXXX", 6)) { errno = EINVAL; return -1; }
  x = t + l - suf - 6;
  for (int tries = 0; tries < 100; tries++) {
    unsigned long v = (unsigned long)time(NULL) * 2654435761UL + ++n * 40503UL + (unsigned long)tries * 7919UL;
    for (int i = 0; i < 6; i++) { x[i] = a[v % 36]; v = v / 36 + (unsigned long)i * 131; }
    int fd = open(t, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd >= 0 || errno != EEXIST) return fd;
  }
  return -1;
}
int kill(pid_t p, int sig) { (void)p; (void)sig; errno = ENOSYS; return -1; } /* Ctrl-Z (SIGTSTP to itself): no job control */
