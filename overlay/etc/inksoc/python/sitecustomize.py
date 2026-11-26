# InkShell: network and processes for the WebAssembly python3 (catalog). PYTHONPATH (/etc/profile.d/inksoc.sh)
# puts this folder first, so site imports this file at start. It only adds an import hook: when http.client or
# urllib.request is imported, inksoc_net.py gives them connections through the terminal's network
# helper (http:// and https://; see inksoc_net.py); when subprocess is imported, inksoc_proc.py gives it
# processes through the host channel /dev/inksoc. os.system (and os.popen if missing) start the same way.
# pip (item 83): the pip wheel of the catalog (py3-pip, /var/lib/inksoc-python) goes on sys.path, so
# "python3 -m pip" works, and inksoc_pip.py patches some pip modules when they are imported (HTTP
# through the helper, install for the user). The user's site-packages (~/.local, PYTHONUSERBASE)
# is turned on: CPython for WASI has no home folder by default. os.umask exists (pip calls it).
# Nothing else is imported here, so start stays fast.
# Not under /usr: the VMware python3 has its own /usr (standard library inside), which hides the real one.
import sys


class _InkNetLoader:
    def __init__(self, loader, name):
        self._ld, self._name = loader, name

    def create_module(self, spec):
        f = getattr(self._ld, 'create_module', None)
        return f(spec) if f else None

    def exec_module(self, module):
        if self._name == 'subprocess':
            try:
                self._ld.exec_module(module)
            except Exception:  # a WASI build may miss select/_posixsubprocess: inksoc_proc gives it all
                pass
            import inksoc_proc
            inksoc_proc.patch(self._name, module)
            return
        self._ld.exec_module(module)
        if self._name.startswith('pip'):
            import inksoc_pip
            inksoc_pip.patch(self._name, module)
            return
        try:
            import inksoc_net
            inksoc_net.patch(self._name, module)
        except Exception as e:  # never break the import itself
            sys.stderr.write('inksoc_net: %s\n' % e)

    def __getattr__(self, a):
        return getattr(self._ld, a)


class _InkNetHook:
    names = ('http.client', 'urllib.request', 'subprocess', 'pip', 'pip._internal.models.search_scope',
             'pip._internal.cli.index_command', 'pip._internal.cli.progress_bars',
             'pip._internal.commands.install', 'pip._internal.network.session')  # = inksoc_pip.NAMES

    def find_spec(self, name, path=None, target=None):
        if name not in self.names:
            return None
        for f in sys.meta_path:
            if f is self or not hasattr(f, 'find_spec'):
                continue
            spec = f.find_spec(name, path, target)
            if spec is not None:
                break
        else:
            return None
        if spec.loader is not None and hasattr(spec.loader, 'exec_module'):
            spec.loader = _InkNetLoader(spec.loader, name)
        return spec


def _system(command):
    import inksoc_proc
    return inksoc_proc.system(command)


def _popen(cmd, mode='r', buffering=-1):
    import inksoc_proc
    return inksoc_proc.popen(cmd, mode, buffering)


_umask = [0o022]


def _os_umask(mask):  # WASI has no permission mask: remember the value, as a real umask would
    old, _umask[0] = _umask[0], mask & 0o777
    return old


PIP_DIR = '/var/lib/inksoc-python'  # the catalog's py3-pip puts pip-VERSION-py3-none-any.whl here


def _user_site():
    import os
    import site
    if sys.flags.no_user_site or os.environ.get('PYTHONNOUSERSITE'):
        return
    if not os.environ.get('PYTHONUSERBASE'):
        home = os.environ.get('HOME')
        if not home:
            return
        os.environ['PYTHONUSERBASE'] = os.path.join(home, '.local')
        if 'sysconfig' in sys.modules:  # its user schemes are only defined when a user base exists
            import importlib
            importlib.reload(sys.modules['sysconfig'])
    site.USER_BASE = site.USER_SITE = None
    site.ENABLE_USER_SITE = True
    p = site.getusersitepackages()
    if p and p not in sys.path and os.path.isdir(p):
        site.addsitedir(p)


def _pip_wheel():
    import os
    try:
        w = sorted(f for f in os.listdir(PIP_DIR) if f.startswith('pip-') and f.endswith('.whl'))
    except OSError:
        return
    if w and os.path.join(PIP_DIR, w[-1]) not in sys.path:
        sys.path.append(os.path.join(PIP_DIR, w[-1]))  # after the user's site: an upgraded pip there wins


if sys.platform == 'wasi' and not any(isinstance(f, _InkNetHook) for f in sys.meta_path):
    sys.meta_path.insert(0, _InkNetHook())
    import os
    os.system = _system
    if not hasattr(os, 'popen'):
        os.popen = _popen
    if not hasattr(os, 'umask'):
        os.umask = _os_umask
    try:
        _user_site()
        _pip_wheel()
    except Exception as e:  # never break the start of python3
        sys.stderr.write('sitecustomize: %s\n' % e)
