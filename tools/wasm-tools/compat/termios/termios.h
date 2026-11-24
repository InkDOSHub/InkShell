/* WASI has no terminal control: termios types and constants (musl values), tcgetattr/tcsetattr fail with ENOTTY.
   Only for Info-ZIP zip/unzip (ttyio.c: password and "more" prompts); tools/wasm-tools/build.sh adds this folder for them. */
#ifndef COMPAT_TERMIOS_H
#define COMPAT_TERMIOS_H
#include <errno.h>
typedef unsigned char cc_t;
typedef unsigned int speed_t, tcflag_t;
#define NCCS 32
struct termios { tcflag_t c_iflag, c_oflag, c_cflag, c_lflag; cc_t c_line, c_cc[NCCS]; speed_t __c_ispeed, __c_ospeed; };
#define VINTR 0
#define VQUIT 1
#define VERASE 2
#define VKILL 3
#define VEOF 4
#define VTIME 5
#define VMIN 6
#define ISIG 0000001
#define ICANON 0000002
#define ECHO 0000010
#define ECHOE 0000020
#define ECHOK 0000040
#define ECHONL 0000100
#define ICRNL 0000400
#define OPOST 0000001
#define TCSANOW 0
#define TCSADRAIN 1
#define TCSAFLUSH 2
static inline int tcgetattr(int fd, struct termios *t) { (void)fd; (void)t; errno = ENOTTY; return -1; }
static inline int tcsetattr(int fd, int a, const struct termios *t) { (void)fd; (void)a; (void)t; errno = ENOTTY; return -1; }
#endif
