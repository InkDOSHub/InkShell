/* Terminal glue for Vim on WASI (MIT, InkShell): termios and the window size through the host's "inkshell" imports
   (wasi.js: TCGETS / TCSETS / TIOCGWINSZ on the kernel terminal), plus the few calls WASI lacks. */
#include <errno.h>
#include <string.h>
#include <stdlib.h>
#include <termios.h>
#include <sys/types.h>
#include <unistd.h>
#include "ink_vim.h"
#define IMP(n) __attribute__((import_module("inkshell"), import_name(n)))
IMP("tty_get") int ink_tty_get(int fd, void *kernel_termios36);
IMP("tty_set") int ink_tty_set(int fd, int action, const void *kernel_termios36);
IMP("tty_size") int ink_tty_size(int fd, void *winsize8);

int tcgetattr(int fd, struct termios *t) {
  unsigned char b[36]; int e = ink_tty_get(fd, b);
  if (e) { errno = e; return -1; }
  memset(t, 0, sizeof *t);
  memcpy(&t->c_iflag, b, 16); t->c_line = b[16]; memcpy(t->c_cc, b + 17, 19);
  t->__c_ispeed = t->__c_ospeed = B38400;
  return 0;
}
int tcsetattr(int fd, int action, const struct termios *t) {
  unsigned char b[36];
  memcpy(b, &t->c_iflag, 16); b[16] = t->c_line; memcpy(b + 17, t->c_cc, 19);
  int e = ink_tty_set(fd, action, b);
  if (e) { errno = e; return -1; }
  return 0;
}
speed_t cfgetospeed(const struct termios *t) { (void)t; return B38400; }
speed_t cfgetispeed(const struct termios *t) { (void)t; return B38400; }
int tcflush(int fd, int q) { (void)fd; (void)q; return 0; }

/* Called first thing in main(): no runtime files here (no defaults.vim), so the defaults come from VIMINIT, which Vim
   uses only when the person has no vimrc of their own. */
void ink_defaults(void) {
  setenv("VIMINIT", "set nocompatible backspace=indent,eol,start ruler showcmd incsearch ttimeout ttimeoutlen=50 display=truncate "
         "nrformats-=octal noswapfile nobackup nowritebackup viminfo= mouse=", 0);
  setenv("TERM", "xterm", 0);
}

/* term.c leaves it out without a termcap library; Vim never resizes the page's terminal */
void term_set_winsize(int height, int width) { (void)height; (void)width; }

/* no processes, pipes or signals to others: Vim's :!cmd, filters and stdin copies report failure */
int dup(int fd) { (void)fd; errno = ENOSYS; return -1; }
int pipe(int p[2]) { (void)p; errno = ENOSYS; return -1; }
int kill(pid_t pid, int sig) { (void)pid; (void)sig; errno = ENOSYS; return -1; }

/* Vim calls ioctl(fd, TIOCGWINSZ, &ws) (built with -Dioctl=ink_ioctl): the kernel's window size, set by the page's terminal */
int ink_ioctl(int fd, int req, ...) {
  __builtin_va_list ap; __builtin_va_start(ap, req); void *arg = __builtin_va_arg(ap, void *); __builtin_va_end(ap);
  if (req == 0x5413 && arg) { int e = ink_tty_size(fd, arg); if (e) { errno = e; return -1; } return 0; }
  errno = ENOTTY; return -1;
}
