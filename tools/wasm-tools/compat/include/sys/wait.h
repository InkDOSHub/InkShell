/* WASI has no processes: wait status macros only (tools/wasm-tools/compat). */
#ifndef COMPAT_SYS_WAIT_H
#define COMPAT_SYS_WAIT_H
#include <sys/types.h>
#define WNOHANG 1
#define WEXITSTATUS(s) (((s) & 0xff00) >> 8)
#define WTERMSIG(s) ((s) & 0x7f)
#define WIFEXITED(s) (!WTERMSIG(s))
#define WIFSIGNALED(s) (WTERMSIG(s) != 0)
#ifdef __cplusplus
extern "C" {
#endif
pid_t waitpid(pid_t, int *, int);
pid_t wait(int *);
#ifdef __cplusplus
}
#endif
#endif
