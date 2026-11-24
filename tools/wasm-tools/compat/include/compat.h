/* Force-included (-include compat.h): prototypes WASI libc leaves out. Stubs in compat.c fail with ENOSYS. */
#ifndef COMPAT_H
#define COMPAT_H
#include <stdio.h>
#include <sys/types.h>
#ifdef __cplusplus
extern "C" {
#endif
FILE *popen(const char *, const char *);
int pclose(FILE *);
pid_t fork(void);
int execvp(const char *, char *const[]);
pid_t getppid(void);
mode_t umask(mode_t);
int chown(const char *, uid_t, gid_t);
int lchown(const char *, uid_t, gid_t);
int fchown(int, uid_t, gid_t);
#ifndef TIOCGWINSZ /* terminal size: ioctl fails, programs keep their default width */
#define TIOCGWINSZ 0x5413
struct winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; };
#endif
#ifdef COMPAT_CHMOD_OK /* WASI cannot set permission bits: chmod/fchmod succeed when the file exists (7-Zip extract) */
#define chmod(p, m) compat_chmod(p, m)
#define fchmod(f, m) compat_fchmod(f, m)
int compat_chmod(const char *, mode_t);
int compat_fchmod(int, mode_t);
#endif
#define tzset() ((void)0) /* no time zones: UTC */
#ifdef __cplusplus
}
#endif
#endif
