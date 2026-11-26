# InkShell: network and processes for the WebAssembly python3 (catalog). PYTHONPATH (/etc/profile.d/inksoc.sh)
# puts this folder first, so site imports this file at start. It only adds an import hook: when http.client or
# urllib.request is imported, inksoc_net.py gives them connections through the terminal's network
# helper (http:// and https://; see inksoc_net.py); when subprocess is imported, inksoc_proc.py gives it
# processes through the host channel /dev/inksoc. os.system (and os.popen if missing) start the same way.
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
        try:
            import inksoc_net
            inksoc_net.patch(self._name, module)
        except Exception as e:  # never break the import itself
            sys.stderr.write('inksoc_net: %s\n' % e)

    def __getattr__(self, a):
        return getattr(self._ld, a)


class _InkNetHook:
    names = ('http.client', 'urllib.request', 'subprocess')

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


if sys.platform == 'wasi' and not any(isinstance(f, _InkNetHook) for f in sys.meta_path):
    sys.meta_path.insert(0, _InkNetHook())
    import os
    os.system = _system
    if not hasattr(os, 'popen'):
        os.popen = _popen
