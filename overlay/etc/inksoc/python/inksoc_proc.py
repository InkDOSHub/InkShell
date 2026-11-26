"""InkShell: processes for the WebAssembly python3 (WASI has none): subprocess, os.system, os.popen.

The program's host (wasi.js) has a request/response channel: opening "/dev/inksoc" gives a descriptor
where each written JSON line is one request and one JSON line comes back (ops: spawn, wait, kill; see
wasi.js ctlCall). "spawn" forks the program's own Linux process and runs argv in the child: a program
with a WebAssembly build (the catalog's tools in /usr/local/bin, this python3...) runs as WebAssembly in
its own Worker, anything else as x86 Linux. Pipes are real Linux pipes, so pipes between WebAssembly
programs stay WebAssembly. A shell command (shell=True, os.system) without shell syntax is split here and
started directly (no x86 /bin/sh in between); with shell syntax it goes to /bin/sh -c.
sitecustomize.py installs os.system (and os.popen when missing) and patches subprocess when imported.
Limits: no preexec_fn, user/group, pass_fds (other descriptors are not inherited), start_new_session;
communicate() reads stdout then stderr (Linux pipes here never fill up, so this cannot deadlock).
"""
import errno
import io
import json
import os
import signal
import sys
import time

PIPE, STDOUT, DEVNULL = -1, -2, -3
_SHELL_CHARS = set('|&;<>()$`\\"\'*?[]#~=%{}!\n')
_ch = None


class SubprocessError(Exception):
    pass


class CalledProcessError(SubprocessError):
    def __init__(self, returncode, cmd, output=None, stderr=None):
        self.returncode, self.cmd, self.output, self.stderr = returncode, cmd, output, stderr

    def __str__(self):
        if self.returncode and self.returncode < 0:
            return "Command '%s' died with signal %d." % (self.cmd, -self.returncode)
        return "Command '%s' returned non-zero exit status %d." % (self.cmd, self.returncode)

    @property
    def stdout(self):
        return self.output

    @stdout.setter
    def stdout(self, v):
        self.output = v


class TimeoutExpired(SubprocessError):
    def __init__(self, cmd, timeout, output=None, stderr=None):
        self.cmd, self.timeout, self.output, self.stderr = cmd, timeout, output, stderr

    def __str__(self):
        return "Command '%s' timed out after %s seconds" % (self.cmd, self.timeout)

    @property
    def stdout(self):
        return self.output

    @stdout.setter
    def stdout(self, v):
        self.output = v


class CompletedProcess:
    def __init__(self, args, returncode, stdout=None, stderr=None):
        self.args, self.returncode, self.stdout, self.stderr = args, returncode, stdout, stderr

    def __repr__(self):
        a = ['args={!r}'.format(self.args), 'returncode={!r}'.format(self.returncode)]
        if self.stdout is not None:
            a.append('stdout={!r}'.format(self.stdout))
        if self.stderr is not None:
            a.append('stderr={!r}'.format(self.stderr))
        return 'CompletedProcess({})'.format(', '.join(a))

    def check_returncode(self):
        if self.returncode:
            raise CalledProcessError(self.returncode, self.args, self.stdout, self.stderr)


def call_host(req):
    """One request on the host channel ("/dev/inksoc"): a dict in, the answer dict out (OSError on error)."""
    global _ch
    if _ch is None:
        try:
            _ch = os.open('/dev/inksoc', os.O_RDWR)
        except OSError as e:
            raise OSError(errno.ENOSYS, 'no process channel (/dev/inksoc): %s' % e) from None
    os.write(_ch, (json.dumps(req) + '\n').encode())
    buf = b''
    while not buf.endswith(b'\n'):
        d = os.read(_ch, 65536)
        if not d:
            raise OSError(errno.EIO, 'process channel closed')
        buf += d
    a = json.loads(buf)
    if 'error' in a:  # WASI errno numbers are this python's errno numbers (FileNotFoundError...)
        raise OSError(a['error'], a.get('msg', ''))
    return a


def _rc(status):
    return (status >> 8) & 0xff if status & 0x7f == 0 else -(status & 0x7f)


def _argv(args, shell, executable=None):
    if isinstance(args, (str, bytes, os.PathLike)):
        args = [os.fsdecode(args)]
    else:
        args = [os.fsdecode(a) for a in args]
    if shell:
        cmd = args[0] if args else ''
        if len(args) == 1 and cmd.strip() and not (set(cmd) & _SHELL_CHARS):
            return cmd.split(), None  # plain words: started directly (a WebAssembly build stays WebAssembly)
        return [executable or '/bin/sh', '-c'] + args, None
    return args, executable


def _io(v, name):
    if v is None:
        return 'inherit'
    if v == PIPE:
        return 'pipe'
    if v == DEVNULL:
        return 'null'
    if v == STDOUT and name == 'stderr':
        return 'stdout'
    if isinstance(v, int):
        return v
    return v.fileno()


class Popen:
    def __init__(self, args, bufsize=-1, executable=None, stdin=None, stdout=None, stderr=None,
                 preexec_fn=None, close_fds=True, shell=False, cwd=None, env=None, universal_newlines=None,
                 startupinfo=None, creationflags=0, restore_signals=True, start_new_session=False,
                 pass_fds=(), *, encoding=None, errors=None, text=None, **kw):
        self.args, self.returncode = args, None
        self.stdin = self.stdout = self.stderr = None
        self.text_mode = bool(text or universal_newlines or encoding or errors)
        self._enc, self._err = encoding, errors
        argv, path = _argv(args, shell, executable)
        req = {'op': 'spawn', 'argv': argv, 'stdin': _io(stdin, 'stdin'), 'stdout': _io(stdout, 'stdout'),
               'stderr': _io(stderr, 'stderr')}
        if path:
            req['path'] = os.fsdecode(path)
        if cwd is not None:
            req['cwd'] = os.fsdecode(cwd)
        else:
            try:
                here = os.getcwd()
                if here != '/':
                    req['cwd'] = here
            except OSError:
                pass
        e = os.environ if env is None else env
        req['env'] = ['%s=%s' % (os.fsdecode(k), os.fsdecode(v)) for k, v in e.items()]
        for f in (sys.stdout, sys.stderr):
            try:
                f.flush()
            except Exception:
                pass
        a = call_host(req)
        self.pid = a['pid']
        buf = -1 if bufsize in (None, 1) or self.text_mode else bufsize
        if 'stdin' in a:
            self.stdin = io.open(a['stdin'], 'wb', buf)
            if self.text_mode:
                self.stdin = io.TextIOWrapper(self.stdin, encoding=encoding, errors=errors,
                                              write_through=True, line_buffering=(bufsize == 1))
        for k in ('stdout', 'stderr'):
            if k in a:
                f = io.open(a[k], 'rb', buf)
                if self.text_mode:
                    f = io.TextIOWrapper(f, encoding=encoding, errors=errors)
                setattr(self, k, f)

    def __repr__(self):
        return '<Popen: returncode: {} args: {!r}>'.format(self.returncode, self.args)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        for f in (self.stdout, self.stderr):
            if f:
                f.close()
        try:
            if self.stdin:
                self.stdin.close()
        finally:
            self.wait()

    def poll(self):
        if self.returncode is None:
            a = call_host({'op': 'wait', 'pid': self.pid, 'nohang': True})
            if a['pid']:
                self.returncode = _rc(a['status'])
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is not None:
            return self.returncode
        if timeout is None:
            self.returncode = _rc(call_host({'op': 'wait', 'pid': self.pid})['status'])
            return self.returncode
        end = time.monotonic() + timeout
        while self.poll() is None:
            if time.monotonic() >= end:
                raise TimeoutExpired(self.args, timeout)
            time.sleep(0.005)
        return self.returncode

    def communicate(self, input=None, timeout=None):
        if self.stdin:
            try:
                if input:
                    self.stdin.write(input)
                self.stdin.close()
            except BrokenPipeError:
                pass
        out = self.stdout.read() if self.stdout else None
        err = self.stderr.read() if self.stderr else None
        for f in (self.stdout, self.stderr):
            if f:
                f.close()
        self.wait(timeout)
        return out, err

    def send_signal(self, sig):
        if self.returncode is None:
            try:
                call_host({'op': 'kill', 'pid': self.pid, 'sig': int(sig)})
            except ProcessLookupError:
                pass

    def terminate(self):
        self.send_signal(getattr(signal, 'SIGTERM', 15))

    def kill(self):
        self.send_signal(getattr(signal, 'SIGKILL', 9))


def run(*popenargs, input=None, capture_output=False, timeout=None, check=False, **kw):
    if input is not None:
        kw['stdin'] = PIPE
    if capture_output:
        kw['stdout'] = kw['stderr'] = PIPE
    with Popen(*popenargs, **kw) as p:
        try:
            out, err = p.communicate(input, timeout=timeout)
        except TimeoutExpired as e:
            p.kill()
            p.wait()
            raise TimeoutExpired(p.args, timeout, e.output, e.stderr) from None
        except BaseException:
            p.kill()
            raise
        rc = p.poll()
    if check and rc:
        raise CalledProcessError(rc, p.args, out, err)
    return CompletedProcess(p.args, rc, out, err)


def call(*popenargs, timeout=None, **kw):
    with Popen(*popenargs, **kw) as p:
        try:
            return p.wait(timeout=timeout)
        except BaseException:
            p.kill()
            raise


def check_call(*popenargs, **kw):
    rc = call(*popenargs, **kw)
    if rc:
        raise CalledProcessError(rc, kw.get('args', popenargs[0] if popenargs else None))
    return 0


def check_output(*popenargs, timeout=None, **kw):
    if 'input' in kw and kw['input'] is None:
        kw['input'] = '' if kw.get('text') or kw.get('universal_newlines') or kw.get('encoding') else b''
    return run(*popenargs, stdout=PIPE, timeout=timeout, check=True, **kw).stdout


def getstatusoutput(cmd, *, encoding=None, errors=None):
    try:
        data, rc = check_output(cmd, shell=True, text=True, stderr=STDOUT, encoding=encoding, errors=errors), 0
    except CalledProcessError as e:
        data, rc = e.output, e.returncode
    if data[-1:] == '\n':
        data = data[:-1]
    return rc, data


def getoutput(cmd, *, encoding=None, errors=None):
    return getstatusoutput(cmd, encoding=encoding, errors=errors)[1]


def system(command):
    """os.system: the raw wait status (exit code << 8), as on Linux."""
    if command is None:
        return 1
    try:
        p = Popen(command, shell=True)
    except OSError as e:
        sys.stderr.write('sh: %s\n' % e)
        return 127 << 8
    st = call_host({'op': 'wait', 'pid': p.pid})['status']
    p.returncode = _rc(st)
    return st


def popen(cmd, mode='r', buffering=-1):
    """os.popen (only installed when this python has none)."""
    if mode not in ('r', 'w'):
        raise ValueError('invalid mode %r' % mode)
    if mode == 'r':
        p = Popen(cmd, shell=True, stdout=PIPE, text=True, bufsize=buffering)
        return _Wrap(p.stdout, p)
    p = Popen(cmd, shell=True, stdin=PIPE, text=True, bufsize=buffering)
    return _Wrap(p.stdin, p)


class _Wrap:
    def __init__(self, stream, proc):
        self._stream, self._proc = stream, proc

    def close(self):
        self._stream.close()
        rc = self._proc.wait()
        return None if rc == 0 else (rc << 8 if rc > 0 else -rc)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    def __getattr__(self, name):
        return getattr(self._stream, name)

    def __iter__(self):
        return iter(self._stream)


_NAMES = ('Popen', 'run', 'call', 'check_call', 'check_output', 'getoutput', 'getstatusoutput',
          'CompletedProcess', 'PIPE', 'STDOUT', 'DEVNULL')
_ERRORS = ('SubprocessError', 'CalledProcessError', 'TimeoutExpired')


def patch(name, mod):
    """subprocess imported (sitecustomize.py): its process functions become these. The module's own
    exception classes are kept (when it loaded) so `except subprocess.CalledProcessError` matches."""
    if name != 'subprocess':
        return
    g = globals()
    for n in _ERRORS:
        if isinstance(getattr(mod, n, None), type):
            g[n] = getattr(mod, n)
        else:
            setattr(mod, n, g[n])
    for n in _NAMES:
        setattr(mod, n, g[n])
    if not hasattr(mod, 'list2cmdline'):
        mod.list2cmdline = lambda seq: ' '.join(seq)
    mod._inksoc = True
