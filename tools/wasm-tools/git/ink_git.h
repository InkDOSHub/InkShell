/* Force-included for git on WASI (item 75): what wasi-libc leaves out, and stat with permission bits.
 * The functions are in ink_git.c (built as compat/ink_git.o of git). MIT, InkShell. */
#ifndef INK_GIT_H
#define INK_GIT_H
#include <sys/types.h>
#include <sys/stat.h>
#include <compat.h>
int dup(int);
int dup2(int, int);
int pipe(int[2]);
int kill(pid_t, int);
int fchdir(int);
pid_t getpgid(pid_t);
pid_t tcgetpgrp(int);
int execl(const char *, const char *, ...);
int execlp(const char *, const char *, ...);
int execve(const char *, char *const[], char *const[]);
char *getpass(const char *);
char *mktemp(char *);
unsigned alarm(unsigned);
#define flockfile(f) ((void)(f)) /* one thread */
#define funlockfile(f) ((void)(f))
#define ITIMER_REAL 0
/* sockets: WASI preview1 cannot open one (git:// and ssh:// go through the x86 git) */
#include <sys/socket.h>
int socket(int, int, int);
int connect(int, const struct sockaddr *, socklen_t);
int setsockopt(int, int, int, const void *, socklen_t);
#ifndef SO_KEEPALIVE
#define SO_KEEPALIVE 9
#endif
/* signals: wasi-libc's emulation has signal() and raise() only; sigaction sets the handler with signal(), masks do nothing */
#include <signal.h>
#include <string.h>
struct sigaction { void (*sa_handler)(int); sigset_t sa_mask; int sa_flags; };
#define SA_RESTART 0x10000000
#ifndef SIG_BLOCK
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#endif
static inline int sigemptyset(sigset_t *s) { memset(s, 0, sizeof *s); return 0; }
static inline int sigfillset(sigset_t *s) { memset(s, 0xff, sizeof *s); return 0; }
static inline int sigaddset(sigset_t *s, int n) { (void)s; (void)n; return 0; }
static inline int sigdelset(sigset_t *s, int n) { (void)s; (void)n; return 0; }
static inline int sigismember(const sigset_t *s, int n) { (void)s; (void)n; return 0; }
static inline int sigprocmask(int h, const sigset_t *s, sigset_t *o) { (void)h; (void)s; if (o) memset(o, 0, sizeof *o); return 0; }
static inline int sigaction(int n, const struct sigaction *a, struct sigaction *o)
{
	void (*old)(int) = a ? signal(n, a->sa_handler) : SIG_DFL;
	if (o) { memset(o, 0, sizeof *o); o->sa_handler = old; }
	return 0;
}
/* WASI stat has no permission bits: give files 0644 and folders 0755 (git copies a file's mode to its lock file) */
int ink_stat(const char *, struct stat *);
int ink_lstat(const char *, struct stat *);
int ink_fstat(int, struct stat *);
#define stat(p, s) ink_stat(p, s)
#define lstat(p, s) ink_lstat(p, s)
#define fstat(f, s) ink_fstat(f, s)
struct child_process;
int ink_start_command(struct child_process *);
#endif
