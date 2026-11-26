/* less on WASI: a termcap library for an xterm-style terminal (what the browser terminal is), and tcgetattr/tcsetattr.
   No terminfo database: the capabilities are fixed. WASI has no ioctl: the host (wasi.js, import module "inksoc") does
   TCGETS / TCSETS / TIOCGWINSZ on the Linux terminal. InkShell's own code, MIT. */
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "termios.h"
#include "termcap.h"

#define IMP(n) __attribute__((__import_module__("inksoc"), __import_name__(n)))
IMP("tty_get") int ink_tty_get(int fd, void *termios36);   /* 0 = ok */
IMP("tty_set") int ink_tty_set(int fd, const void *termios36);
IMP("tty_size") int ink_tty_size(int fd, unsigned short *rows_cols); /* 0 = ok */

int tcgetattr(int fd, struct termios *t) { if (ink_tty_get(fd, t)) { errno = ENOTTY; return -1; } return 0; }
int tcsetattr(int fd, int a, const struct termios *t) { (void)a; if (ink_tty_set(fd, t)) { errno = ENOTTY; return -1; } return 0; }
speed_t cfgetospeed(const struct termios *t) { return t->c_cflag & CBAUD; }

static const struct { const char *id, *val; } caps[] = {
  { "cm", "\033[%i%d;%dH" }, { "ho", "\033[H" }, { "cl", "\033[H\033[2J" }, { "ce", "\033[K" }, { "cd", "\033[J" },
  { "ti", "\033[?1049h" }, { "te", "\033[?1049l" },
  { "so", "\033[7m" }, { "se", "\033[27m" }, { "us", "\033[4m" }, { "ue", "\033[24m" },
  { "md", "\033[1m" }, { "me", "\033[0m" }, { "mr", "\033[7m" }, { "mb", "\033[5m" },
  { "bl", "\007" }, { "al", "\033[L" }, { "dl", "\033[M" }, { "sr", "\033M" },
  { "ku", "\033[A" }, { "kd", "\033[B" }, { "kr", "\033[C" }, { "kl", "\033[D" },
  { "kh", "\033[H" }, { "@7", "\033[F" }, { "kP", "\033[5~" }, { "kN", "\033[6~" }, { "kD", "\033[3~" }, { "kI", "\033[2~" },
};

int tgetent(char *buf, const char *name) { (void)buf; (void)name; return 1; }
int tgetflag(const char *id) { return !strcmp(id, "am") || !strcmp(id, "xn") || !strcmp(id, "bs"); }
int tgetnum(const char *id) {
  unsigned short wh[4] = { 0, 0, 0, 0 };
  int v;
  if (strcmp(id, "li") && strcmp(id, "co")) return -1;
  if (ink_tty_size(2, wh) && ink_tty_size(1, wh) && ink_tty_size(0, wh)) return -1;
  v = id[0] == 'l' ? wh[0] : wh[1];
  return v > 0 ? v : -1;
}
char *tgetstr(const char *id, char **area) {
  (void)area;
  for (unsigned i = 0; i < sizeof caps / sizeof *caps; i++) if (!strcmp(id, caps[i].id)) return (char *)caps[i].val;
  return NULL;
}
char *tgoto(const char *cap, int col, int row) { /* cm: %i (1-based) %d, the first %d is the row */
  static char out[32]; char *o = out; int a[2] = { row, col }, n = 0, inc = 0;
  for (; *cap && o < out + 24; cap++) {
    if (*cap != '%') { *o++ = *cap; continue; }
    cap++;
    if (*cap == 'i') inc = 1;
    else if (*cap == 'd' && n < 2) o += sprintf(o, "%d", a[n++] + inc);
    else if (*cap == '%') *o++ = '%';
  }
  *o = 0; return out;
}
int tputs(const char *s, int n, int (*f)(int)) { (void)n; if (s) while (*s) f((unsigned char)*s++); return 0; }

int pclose(FILE *f) { (void)f; errno = ENOSYS; return -1; } /* edit.c calls it for LESSOPEN pipes, which cannot exist here (no processes) */
