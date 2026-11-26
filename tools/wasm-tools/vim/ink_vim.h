/* force-included for Vim on WASI: the ioctl hook of ink_term.c and prototypes for what wasi-libc leaves out (they fail with ENOSYS) */
#ifndef INK_VIM_H
#define INK_VIM_H
#include <sys/types.h>
#define ioctl ink_ioctl
int dup(int);
int pipe(int[2]);
int kill(pid_t, int);
void ink_defaults(void);
#endif
