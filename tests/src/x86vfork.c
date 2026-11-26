// Item 64: vfork semantics busybox wget's https path counts on (spawn_https_helper_openssl):
// socketpair(AF_UNIX) + vfork; the child moves the pair to 0/1, tries execvp("openssl"), sets a
// flag in the (shared) memory and _exits; the parent, which waited, sees the flag and falls back.
// Also: a child that runs execve lets the parent go on; the pair carries data both ways and
// shutdown(SHUT_WR) gives the other end EOF. Prints "x86vfork ok N" (N checks) or the failure.
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

static int n;
#define CHECK(c, what) do { if (!(c)) { printf("x86vfork FAIL %s (errno %d)\n", what, errno); return 1; } n++; } while (0)

static volatile int child_failed, order;

int main(void) {
    int sp[2], st;
    // 1. exec fails in the child: its write to memory reaches the parent, and the parent ran after it
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sp) == 0, "socketpair");
    pid_t pid = vfork();
    if (pid == 0) {
        close(sp[0]);
        dup2(sp[1], 0); close(sp[1]); dup2(0, 1);
        char *argv[] = { "no-such-program-x86vfork", NULL };
        execvp(argv[0], argv);
        order = 1;
        child_failed = 1;
        _exit(1);
    }
    CHECK(pid > 0, "vfork");
    CHECK(order == 1, "parent waited for the child");
    CHECK(child_failed == 1, "child's write seen by the parent (shared memory)");
    close(sp[1]);
    CHECK(waitpid(pid, &st, 0) == pid && WIFEXITED(st) && WEXITSTATUS(st) == 1, "waitpid status 1");
    close(sp[0]);
    // 2. exec works: the parent goes on, and talks to the program through the pair
    CHECK(socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sp) == 0, "socketpair cloexec");
    child_failed = 0;
    pid = vfork();
    if (pid == 0) {
        dup2(sp[1], 0); dup2(sp[1], 1); // dup2 clears CLOEXEC on 0 and 1
        char *argv[] = { "tr", "a-z", "A-Z", NULL };
        execvp(argv[0], argv);
        child_failed = 1;
        _exit(127);
    }
    CHECK(pid > 0 && child_failed == 0, "vfork + execvp tr");
    close(sp[1]);
    CHECK(write(sp[0], "hello\n", 6) == 6, "write to the pair");
    CHECK(shutdown(sp[0], SHUT_WR) == 0, "shutdown SHUT_WR");
    char b[64]; int k = 0, r;
    while ((r = read(sp[0], b + k, sizeof b - 1 - k)) > 0) k += r;
    b[k] = 0;
    CHECK(r == 0 && strcmp(b, "HELLO\n") == 0, "answer through the pair, then EOF");
    CHECK(waitpid(pid, &st, 0) == pid && WIFEXITED(st) && WEXITSTATUS(st) == 0, "tr exit 0");
    close(sp[0]);
    printf("x86vfork ok %d\n", n);
    return 0;
}
