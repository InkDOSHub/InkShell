/* Force-included (-include) for nano and ncurses on WASI: the signal interface wasi-libc hides (struct sigaction, sigaction,
   sigprocmask: tty.c; only signal()/raise() exist, SIGWINCH never arrives), SIGWINCH/SIGTSTP/SIGCONT numbers, termios.h. MIT, InkShell. */
#ifndef INK_NANO_H
#define INK_NANO_H
#include <signal.h>
#include <sys/types.h>
#define access ink_access
#ifndef SA_RESTART
struct sigaction { void (*sa_handler)(int); unsigned long sa_flags; sigset_t sa_mask; };
#define SA_RESTART 0x10000000
#define SA_NOCLDSTOP 1
#define SA_RESETHAND 0x80000000
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#define SA_SIGINFO 4
#endif
#ifndef SIGWINCH
#define SIGWINCH 28
#endif
#ifndef SIGTSTP
#define SIGTSTP 20
#endif
#ifndef SIGCONT
#define SIGCONT 18
#endif
#ifndef SIGSTOP
#define SIGSTOP 19
#endif
#ifndef SIGKILL
#define SIGKILL 9
#endif
#ifndef SIGPIPE
#define SIGPIPE 13
#endif
int sigaction(int, const struct sigaction *, struct sigaction *);
int sigemptyset(sigset_t *);
int sigfillset(sigset_t *);
int sigaddset(sigset_t *, int);
int sigdelset(sigset_t *, int);
int sigismember(const sigset_t *, int);
int sigprocmask(int, const sigset_t *, sigset_t *);
int kill(pid_t, int);
#ifndef P_tmpdir
#define P_tmpdir "/tmp"
#endif
int mkstemps(char *, int);
int ink_access(const char *, int);
int pipe(int[2]);
int dup(int);
int dup2(int, int);
int execl(const char *, const char *, ...);
struct passwd *getpwent(void);
void endpwent(void);
#endif
