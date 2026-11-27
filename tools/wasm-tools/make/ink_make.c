
/* InkShell (tools/wasm-tools/make/ink_make.c, appended to src/job.c by b_make in tools/wasm-tools/build.sh;
 * GPL-3.0-or-later like GNU make): WASI has no fork/exec/pipe, so make's children start through the host channel
 * /dev/inksoc (compat_spawn and waitpid of tools/wasm-tools/compat, item 78). A child that is a WebAssembly program
 * runs as one, anything else (busybox sh, x86 programs) as x86 Linux. Hooks (sed lines in b_make): child_execute_job,
 * exec_command (make re-running itself after it remade an included makefile: spawn, wait, exit with its status) and
 * $(shell ...) (its stdout pipe is made by the host). */
#ifdef __wasi__
#define INK_SHELL_MARK (-100) /* child.output.out of $(shell ...): "a pipe the host makes" */
int ink_shell_fd = -1;
int
ink_shell_pipe (int *p)
{
  p[0] = -1;
  p[1] = INK_SHELL_MARK;
  return 0;
}
static int
ink_io (int fd, int std)
{
  if (fd == INK_SHELL_MARK)
    return COMPAT_PIPE;
  return fd < 0 || fd == std ? COMPAT_INHERIT : fd;
}
pid_t
ink_child_execute_job (struct childbase *child, int good_stdin, char **argv)
{
  int io[3] = { good_stdin ? COMPAT_INHERIT : COMPAT_NULL, COMPAT_INHERIT, COMPAT_INHERIT };
  int shell = child->output.syncout && child->output.out == INK_SHELL_MARK;
  pid_t pid;
  if (child->output.syncout)
    {
      io[1] = ink_io (child->output.out, FD_STDOUT);
      io[2] = ink_io (child->output.err, FD_STDERR);
    }
  pid = compat_spawn (argv, child->environment, NULL, io);
  if (pid < 0)
    OSS (error, NILF, "%s: %s", argv[0], strerror (errno));
  else if (shell)
    ink_shell_fd = io[1];
  return pid;
}
void
ink_exec_command (char **argv, char **envp)
{
  int io[3] = { COMPAT_INHERIT, COMPAT_INHERIT, COMPAT_INHERIT }, st = 0;
  pid_t pid = compat_spawn (argv, envp, NULL, io);
  if (pid < 0)
    {
      OSS (error, NILF, "%s: %s", argv[0], strerror (errno));
      _exit (127);
    }
  while (waitpid (pid, &st, 0) < 0)
    if (errno != EINTR)
      _exit (127);
  _exit (WIFEXITED (st) ? WEXITSTATUS (st) : 128 + (st & 0x7f));
}
int
pipe (int p[2])
{
  (void) p;
  errno = ENOSYS;
  return -1;
}
#endif
#ifdef __wasi__
/* kill: no signals between WebAssembly processes; make kills itself (fatal_error_signal) only to exit with the signal */
int
kill (pid_t p, int sig)
{
  if (p == getpid ())
    _exit (128 + sig);
  return 0;
}
/* getlogin: glob's ~ without a name (one user) */
char *
getlogin (void)
{
  char *u = getenv ("USER");
  return u && *u ? u : (char *) "root";
}
#endif
