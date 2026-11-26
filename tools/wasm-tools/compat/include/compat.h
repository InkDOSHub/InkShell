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
uid_t getuid(void); /* one user: root (uid 0, gid 0) */
uid_t geteuid(void);
gid_t getgid(void);
gid_t getegid(void);
int mkstemp(char *);
#define COMPAT_INHERIT (-1) /* compat_spawn io[]: what the child's stdin/stdout/stderr is (or a descriptor) */
#define COMPAT_NULL (-2)
#define COMPAT_PIPE (-3)
pid_t compat_spawn(char *const argv[], char *const env[], const char *cwd, int io[3]); /* compat.c: WASI libc declares it only in some modes and has none */
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
