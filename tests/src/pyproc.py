# Item 78: processes from the WebAssembly python3 (host channel /dev/inksoc, /etc/inksoc/python/inksoc_proc.py).
# Run by tests/linux-test.mjs with INK_SPAWN=1 INK_WASI_THREADS=1 (WebAssembly programs in worker threads).
import os
import subprocess
import sys
import time


def t(name, f):
    t0 = time.time()
    try:
        r = f()
    except Exception as e:
        r = 'EXC %s: %s' % (type(e).__name__, e)
    print('pp', name, r, '(%.0f ms)' % ((time.time() - t0) * 1000))


print('pp-start', subprocess.Popen.__module__)


def diag():  # raw channel steps (which one fails)
    import inksoc_proc as ip
    a = ip.call_host({'op': 'spawn', 'argv': ['echo', 'diag'], 'stdout': 'pipe'})
    r = [a]
    for f in (lambda: os.fstat(a['stdout']).st_mode, lambda: os.read(a['stdout'], 100), lambda: os.close(a['stdout']),
              lambda: ip.call_host({'op': 'wait', 'pid': a['pid']})):
        try:
            r.append(f())
        except Exception as e:
            r.append('EXC %s' % e)
    return r


t('diag', diag)
t('system-shell', lambda: os.system('echo sys-x86 $((1+2))') >> 8)
t('system-codes', lambda: (os.system('true'), os.system('false') >> 8))
t('check_output', lambda: subprocess.check_output(['echo', 'hello', 'world']))
t('sort-input', lambda: subprocess.run(['sort'], input=b'b\na\nc\n', capture_output=True).stdout)
t('rc3', lambda: subprocess.run('exit 3', shell=True).returncode)


def cpe():
    try:
        subprocess.check_call(['false'])
    except subprocess.CalledProcessError as e:
        return 'cpe %d' % e.returncode


t('cpe', cpe)


def fnf():
    try:
        subprocess.run(['/nonexistent/prog'])
    except FileNotFoundError:
        return 'fnf-ok'


t('fnf', fnf)


def cat():
    p = subprocess.Popen(['cat'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    o, _ = p.communicate('via cat\n')
    return (p.returncode, o)


t('popen-cat', cat)
t('merged', lambda: subprocess.run(['sh', '-c', 'echo err >&2; echo out'], stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT).stdout)
t('cwd', lambda: subprocess.run(['pwd'], cwd='/tmp', capture_output=True, text=True).stdout.strip())
t('env', lambda: subprocess.run(['sh', '-c', 'echo $INKX'], env={'INKX': 'envok', 'PATH': '/bin:/usr/bin'},
                                capture_output=True, text=True).stdout.strip())
t('getoutput', lambda: subprocess.getstatusoutput('echo go; exit 2'))
t('os-popen', lambda: os.popen('echo popen-ok').read().strip())
# a program with a WebAssembly build runs as WebAssembly (its own thread), directly and in a shell pipe
if os.path.exists('/root/jq.wasm'):
    t('wasm-jq', lambda: subprocess.run(['/root/jq.wasm', '.a'], input=b'{"a":42}', capture_output=True).stdout)
    t('wasm-pipe', lambda: subprocess.getoutput('echo \'{"b":7}\' | /root/jq.wasm .b | /root/jq.wasm ". + 1"'))
t('wasm-python', lambda: subprocess.run(['/root/python.wasm', '-c',
                                         'import sys; print("child", sys.platform)'], capture_output=True,
                                        text=True).stdout.strip())


def kill():
    p = subprocess.Popen(['sleep', '5'])
    time.sleep(0.2)
    a = p.poll()
    p.kill()
    return (a, p.wait())


t('kill', kill)


def timeout():
    try:
        subprocess.run(['sleep', '3'], timeout=0.3)
    except subprocess.TimeoutExpired:
        return 'timeout-ok'


t('timeout', timeout)
print('pp-done')
