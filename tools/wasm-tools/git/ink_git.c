/* git on WASI (item 75): child processes through the host channel /dev/inksoc (compat_spawn: pager, editor, hooks,
 * "git maintenance", git-remote-*), stat with permission bits, stubs for what WASI lacks. MIT, InkShell.
 * Copied into git's compat/ folder by tools/wasm-tools/build.sh (b_git) and linked into git. */
#include "git-compat-util.h"
#include "run-command.h"
#include "exec-cmd.h"
#include "strvec.h"
#include "strbuf.h"
#include "abspath.h"
#include "trace.h"
#undef stat
#undef lstat
#undef fstat

static int perms(int r, struct stat *st)
{
	if (r == 0 && !(st->st_mode & 0777))
		st->st_mode |= S_ISDIR(st->st_mode) ? 0755 : S_ISLNK(st->st_mode) ? 0777 : 0644;
	return r;
}
int ink_stat(const char *p, struct stat *st) { return perms(stat(p, st), st); }
int ink_lstat(const char *p, struct stat *st) { return perms(lstat(p, st), st); }
int ink_fstat(int f, struct stat *st) { return perms(fstat(f, st), st); }

int dup(int f) { (void)f; errno = ENOSYS; return -1; }
int dup2(int f, int g) { (void)f; (void)g; errno = ENOSYS; return -1; }
int pipe(int p[2]) { (void)p; errno = ENOSYS; return -1; } /* pipes come from the host with the child (compat_spawn) */
int kill(pid_t p, int s) { (void)p; (void)s; errno = ENOSYS; return -1; }
int fchdir(int f) { (void)f; errno = ENOSYS; return -1; }
int execl(const char *p, const char *a, ...) { (void)p; (void)a; errno = ENOSYS; return -1; } /* no exec: start_command spawns */
int execlp(const char *p, const char *a, ...) { (void)p; (void)a; errno = ENOSYS; return -1; }
int execve(const char *p, char *const a[], char *const e[]) { (void)p; (void)a; (void)e; errno = ENOSYS; return -1; }
char *getpass(const char *p) { (void)p; errno = ENOTTY; return NULL; } /* no prompts: credentials come from config/helpers */
unsigned alarm(unsigned s) { (void)s; return 0; }
char *mktemp(char *t) /* a free name (compat mkdtemp): mkstemp makes the file, which goes again */
{
	int fd = mkstemp(t);
	if (fd < 0)
		*t = 0;
	else {
		close(fd);
		unlink(t);
	}
	return t;
}
int socket(int d, int t, int p) { (void)d; (void)t; (void)p; errno = ENOSYS; return -1; }
int connect(int f, const struct sockaddr *a, socklen_t l) { (void)f; (void)a; (void)l; errno = ENOSYS; return -1; }
int setsockopt(int f, int l, int n, const void *v, socklen_t s) { (void)f; (void)l; (void)n; (void)v; (void)s; errno = ENOSYS; return -1; }
pid_t getpgid(pid_t p) { (void)p; return 1; }
pid_t tcgetpgrp(int f) { (void)f; return 1; } /* progress meter: always in the foreground */

/* environ with git's changes ("K=V" sets, "K" removes) */
static char **child_env(const char *const *delta)
{
	extern char **environ;
	struct strvec v = STRVEC_INIT;
	for (char **e = environ; e && *e; e++) {
		size_t n = strcspn(*e, "=");
		int drop = 0;
		for (const char *const *d = delta; d && *d && !drop; d++)
			drop = !strncmp(*d, *e, n) && ((*d)[n] == '=' || !(*d)[n]);
		if (!drop)
			strvec_push(&v, *e);
	}
	for (const char *const *d = delta; d && *d; d++)
		if (strchr(*d, '='))
			strvec_push(&v, *d);
	return (char **)strvec_detach(&v);
}

/* start_command for WASI: the host starts the child (WebAssembly or x86 Linux) and makes the pipes git asks for */
int ink_start_command(struct child_process *cmd)
{
	struct strvec argv = STRVEC_INIT;
	struct strbuf dir = STRBUF_INIT;
	int io[3], need_in, need_out, need_err, e;
	char **env;

	if (cmd->git_cmd) {
		prepare_git_cmd(&argv, cmd->args.v);
	} else if (cmd->use_shell && strcspn(cmd->args.v[0], "|&;<>()$`\\\"' \t\n*?[#~=%") != strlen(cmd->args.v[0])) {
		strvec_push(&argv, SHELL_PATH);
		strvec_push(&argv, "-c");
		if (cmd->args.v[1])
			strvec_pushf(&argv, "%s \"$@\"", cmd->args.v[0]);
		else
			strvec_push(&argv, cmd->args.v[0]);
		strvec_pushv(&argv, cmd->args.v);
	} else {
		strvec_pushv(&argv, cmd->args.v);
	}

	need_in = !cmd->no_stdin && cmd->in < 0;
	need_out = !cmd->no_stdout && !cmd->stdout_to_stderr && cmd->out < 0;
	need_err = !cmd->no_stderr && cmd->err < 0;
	io[0] = cmd->no_stdin ? COMPAT_NULL : need_in ? COMPAT_PIPE : cmd->in > 0 ? cmd->in : COMPAT_INHERIT;
	io[2] = cmd->no_stderr ? COMPAT_NULL : need_err ? COMPAT_PIPE : cmd->err > 2 ? cmd->err : COMPAT_INHERIT;
	if (cmd->no_stdout)
		io[1] = COMPAT_NULL;
	else if (cmd->stdout_to_stderr)
		io[1] = io[2] == COMPAT_INHERIT ? 2 : io[2] == COMPAT_PIPE ? 2 : io[2];
	else
		io[1] = need_out ? COMPAT_PIPE : cmd->out > 1 ? cmd->out : COMPAT_INHERIT;

	if (cmd->dir) {
		if (!is_absolute_path(cmd->dir) && !strbuf_getcwd(&dir))
			strbuf_addch(&dir, '/');
		strbuf_addstr(&dir, cmd->dir);
	}
	env = child_env(cmd->env.v);
	trace_argv_printf(argv.v, "trace: start_command:");
	fflush(NULL);
	cmd->pid = compat_spawn((char *const *)argv.v, env, cmd->dir ? dir.buf : NULL, io);
	e = errno;
	if (cmd->pid < 0 && (!cmd->silent_exec_failure || e != ENOENT))
		error_errno("cannot run %s", argv.v[0]);
	for (char **p = env; *p; p++)
		free(*p);
	free(env);
	strbuf_release(&dir);
	strvec_clear(&argv);

	/* descriptors git handed over belong to the child now */
	if (!need_in && cmd->in > 0)
		close(cmd->in);
	if (!need_out && cmd->out > 1)
		close(cmd->out);
	if (!need_err && cmd->err > 2)
		close(cmd->err);
	if (cmd->pid < 0) {
		for (int i = 0; i < 3; i++)
			if ((i == 0 ? need_in : i == 1 ? need_out : need_err) && io[i] >= 0)
				close(io[i]);
		child_process_clear(cmd);
		errno = e;
		return -1;
	}
	if (need_in)
		cmd->in = io[0];
	if (need_out)
		cmd->out = io[1];
	if (need_err)
		cmd->err = io[2];
	return 0;
}
