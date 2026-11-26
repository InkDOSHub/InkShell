"""InkShell: pip for the WebAssembly python3 (catalog: apk add python3 brings py3-pip, the pip wheel).

pip speaks HTTP through its own copy of requests/urllib3, over real sockets and ssl, which this
python3 does not have (WASI). sitecustomize.py calls patch() when these pip modules are imported:
- pip._internal.network.session: every http:// and https:// adapter of pip's session becomes
  InkAdapter, which sends the request with http.client, whose connections go through the terminal's
  network helper (inksoc_net.py, item 76: TLS in x86 Linux by Alpine's ssl_client, certificates
  checked). The answer is wrapped in urllib3's own HTTPResponse, so pip streams, decodes and hashes
  it as usual (redirects, auth, headers: requests does them). No HTTP cache, no proxy.
- pip._internal.commands.install: without --user/--target/--prefix/--root, pip installs for the
  user (~/.local/lib/python3.12/site-packages): the standard library of this python3 is inside the
  program, not a folder pip could write to.
- no warnings about the missing ssl module (search_scope, truststore), no progress bars (rich
  draws them from a thread; WASI has none), no "new pip version" check.
Only wheels of pure Python packages install (py3-none-any): there are no compilers here, so a
package with C code (numpy, Pillow...) or one that only has a source archive will not.
"""
import os
import sys


def patch(name, mod):
    f = _PATCHES.get(name)
    if f:
        f(mod)


def _pip(mod):
    os.environ.setdefault('PIP_DISABLE_PIP_VERSION_CHECK', '1')
    os.environ.setdefault('PIP_DEFAULT_TIMEOUT', '60')  # the helper's TLS and the tunnel are slower than a socket
    import socket  # urllib3 reads these at import (as class defaults); the WASI socket module may miss some
    for k, v in (('AF_UNSPEC', 0), ('AF_INET6', 10), ('IPPROTO_TCP', 6), ('TCP_NODELAY', 1), ('SOL_SOCKET', 1),
                 ('SO_KEEPALIVE', 9), ('SHUT_RD', 0)):
        if not hasattr(socket, k):
            setattr(socket, k, v)


def _no_tls_warning(mod):  # pip._internal.models.search_scope: https works (the helper does TLS)
    mod.has_tls = lambda: True


def _no_truststore(mod):  # pip._internal.cli.index_command
    mod._create_truststore_ssl_context = lambda: None


def _no_bars(mod):  # pip._internal.cli.progress_bars: rich's live bars start a thread
    for n in ('get_download_progress_renderer', 'get_install_progress_renderer'):
        f = getattr(mod, n, None)
        if f:
            def g(*a, _f=f, **kw):
                if kw.get('bar_type') == 'on':
                    kw['bar_type'] = 'off'
                return _f(*a, **kw)
            setattr(mod, n, g)


def _user_install(mod):  # pip._internal.commands.install
    f = mod.decide_user_install

    def decide_user_install(use_user_site, prefix_path=None, target_dir=None, root_path=None, isolated_mode=False):
        if use_user_site is None and not (prefix_path or target_dir or root_path) and sys.prefix == sys.base_prefix:
            use_user_site = True
        return f(use_user_site, prefix_path, target_dir, root_path, isolated_mode)

    mod.decide_user_install = decide_user_install


def _session(mod):
    import http.client as hc
    from urllib.parse import urlsplit
    from pip._vendor.requests import exceptions as rex
    from pip._vendor.requests.adapters import BaseAdapter, HTTPAdapter
    from pip._vendor.urllib3._collections import HTTPHeaderDict
    from pip._vendor.urllib3.response import HTTPResponse

    class InkAdapter(BaseAdapter):
        """http:// and https:// through the network helper (one connection per request)."""

        def send(self, request, stream=False, timeout=None, verify=True, cert=None, proxies=None):
            u = urlsplit(request.url)
            if isinstance(timeout, tuple):
                timeout = max([t for t in timeout if t is not None], default=None)
            kw = {} if timeout is None else {'timeout': timeout}
            conn = (hc.HTTPSConnection if u.scheme == 'https' else hc.HTTPConnection)(u.hostname, u.port, **kw)
            headers = dict(request.headers)
            headers['Connection'] = 'close'  # the server closes: the stream ends with the answer
            try:
                conn.request(request.method, request.path_url or '/', body=request.body, headers=headers)
                r = conn.getresponse()
            except TimeoutError as e:
                conn.close()
                raise rex.ReadTimeout(e, request=request)
            except (OSError, hc.HTTPException) as e:
                conn.close()
                raise rex.ConnectionError(e, request=request)
            r._ink_conn = conn  # a keep-alive answer: the connection stays open until the answer is read
            raw = HTTPResponse(body=r, headers=HTTPHeaderDict(list(r.msg.items())), status=r.status,
                               version=r.version, version_string='HTTP/1.0' if r.version == 10 else 'HTTP/1.1',
                               reason=r.reason, preload_content=False, decode_content=False,
                               original_response=r, request_method=request.method, request_url=request.url)
            return HTTPAdapter.build_response(self, request, raw)

        def close(self):
            pass

    init = mod.PipSession.__init__

    def __init__(self, *a, **kw):
        init(self, *a, **kw)
        ink = InkAdapter()
        for k, v in list(self.adapters.items()):
            if not isinstance(v, mod.LocalFSAdapter):
                self.adapters[k] = ink
        self._trusted_host_adapter = ink  # add_trusted_host mounts this one

    mod.PipSession.__init__ = __init__
    mod.InkAdapter = InkAdapter


_PATCHES = {
    'pip': _pip,
    'pip._internal.models.search_scope': _no_tls_warning,
    'pip._internal.cli.index_command': _no_truststore,
    'pip._internal.cli.progress_bars': _no_bars,
    'pip._internal.commands.install': _user_install,
    'pip._internal.network.session': _session,
}
NAMES = tuple(_PATCHES)
