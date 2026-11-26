"""InkShell: http:// and https:// for the WebAssembly python3 (WASI has no sockets and this build no ssl).

The terminal runs a small network helper as root (/usr/local/sbin/inksoc-net: busybox nc listening on
127.0.0.1:9417). Its connections are the x86 Linux side, which has the network (the page's wisp
tunnel: no CORS) and TLS (Alpine's ssl_client, with certificate checks, as wget and apk use).
A WebAssembly program reaches it by opening "/dev/tcp/127.0.0.1/9417" (wasi.js turns that open into a
TCP socket) and sends one line "tcp|tls HOST PORT CONNECT_SECONDS"; the answer is "OK" and then the raw
stream (TLS already removed for "tls"), or an error line. http.client then speaks HTTP over it, so
urllib.request.urlopen works as usual: GET, POST, headers, status, redirects, HTTPError for 4xx/5xx;
no helper or no network gives URLError. sitecustomize.py calls patch() when http.client and
urllib.request are imported. Proxies (http_proxy...) are not used for https. Other programs can use
the same helper (one line, then the stream).
"""
import io
import os
import socket
import sys

PORT = 9417
IDLE = 300  # seconds a read may wait when urlopen has no timeout (no endless hang when the link dies)


def _secs(t):
    return None if t is None or t is socket._GLOBAL_DEFAULT_TIMEOUT else float(t)


class _Raw(io.RawIOBase):
    def __init__(self, sock):
        self._s = sock

    def readable(self):
        return True

    def readinto(self, b):
        d = self._s._read(len(b))
        n = len(d)
        b[:n] = d
        return n

    def close(self):
        if not self.closed:
            super().close()
            self._s._decref()


class InkSocket:
    """A connected stream to the helper, with what http.client uses of a socket."""

    def __init__(self, fd, timeout):
        self._fd, self._timeout, self._refs, self._closed = fd, timeout, 0, False

    def fileno(self):
        return self._fd

    def settimeout(self, t):
        self._timeout = t

    def gettimeout(self):
        return self._timeout

    def setsockopt(self, *a):
        pass

    def shutdown(self, how):
        pass

    def _read(self, n):
        if self._fd < 0:
            raise OSError(9, 'closed connection')
        return os.read(self._fd, n)  # TimeoutError (socket.timeout) after the idle timeout

    recv = _read

    def recv_into(self, b, n=0):
        d = self._read(n or len(b))
        b[:len(d)] = d
        return len(d)

    def send(self, data):
        if self._fd < 0:
            raise OSError(9, 'closed connection')
        return os.write(self._fd, data)

    def sendall(self, data):
        mv = memoryview(data).cast('B')
        while mv:
            mv = mv[self.send(mv):]

    def makefile(self, mode='r', buffering=None, **kw):
        self._refs += 1
        f = io.BufferedReader(_Raw(self), buffering if buffering and buffering > 0 else io.DEFAULT_BUFFER_SIZE)
        return f if 'b' in mode else io.TextIOWrapper(f, kw.get('encoding'), kw.get('errors'), kw.get('newline'))

    def _decref(self):
        self._refs -= 1
        if self._closed and self._refs <= 0:
            self._real_close()

    def close(self):
        self._closed = True
        if self._refs <= 0:
            self._real_close()

    def _real_close(self):
        if self._fd >= 0:
            fd, self._fd = self._fd, -1
            try:
                os.close(fd)
            except OSError:
                pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def connect(mode, host, port, timeout=None):
    """A stream to HOST:PORT through the helper; mode 'tcp' (plain) or 'tls' (decrypted stream)."""
    host, port, t = str(host), int(port), _secs(timeout)
    if not host or any(c in host for c in ' \t\r\n') or not 0 < port < 65536:
        raise OSError(22, 'bad address %r port %r' % (host, port))
    idle = max(1, int((t or IDLE) * 1000))
    try:
        fd = os.open('/dev/tcp/127.0.0.1/%d?t=%d' % (PORT, idle), os.O_RDWR)
    except OSError as e:
        raise ConnectionRefusedError(e.errno, 'InkShell network helper not reachable (inksoc-net, 127.0.0.1:%d): %s' % (PORT, e.strerror or e))
    s = InkSocket(fd, t)
    try:
        s.sendall(('%s %s %d %d\n' % (mode, host, port, max(1, int(t)) if t else 30)).encode())
        line = b''
        while not line.endswith(b'\n') and len(line) < 2048:
            c = s._read(1)
            if not c:
                break
            line += c
    except BaseException:
        s.close()
        raise
    line = line.decode('utf-8', 'replace').strip()
    if line != 'OK':
        s.close()
        raise ConnectionError('cannot connect to %s port %d: %s' % (host, port, line or 'no answer (no network?)'))
    return s


def patch(name, mod):
    if name == 'http.client':
        _patch_http(mod)
    elif name == 'urllib.request':
        _patch_urllib(mod)


def _patch_http(hc):
    def connect_plain(self):
        sys.audit('http.client.connect', self, self.host, self.port)
        self.sock = connect('tcp', self.host, self.port, self.timeout)
        if self._tunnel_host:
            self._tunnel()

    hc.HTTPConnection.connect = connect_plain
    if getattr(hc, 'HTTPSConnection', None) is None or not getattr(hc.HTTPSConnection, '_inksoc', False):
        class HTTPSConnection(hc.HTTPConnection):
            """HTTPS through the helper (TLS in x86 Linux: Alpine's ssl_client, certificates checked)."""
            default_port = hc.HTTPS_PORT
            _inksoc = True

            def __init__(self, host, port=None, *a, context=None, check_hostname=None, **kw):
                kw.pop('key_file', None)
                kw.pop('cert_file', None)
                super().__init__(host, port, *a, **kw)

            def connect(self):
                sys.audit('http.client.connect', self, self.host, self.port)
                if self._tunnel_host:  # no proxy for https: straight to the server
                    h, p = self._tunnel_host, self._tunnel_port or self.default_port
                else:
                    h, p = self.host, self.port
                self.sock = connect('tls', h, p, self.timeout)

        hc.HTTPSConnection = HTTPSConnection
        if 'HTTPSConnection' not in hc.__all__:
            hc.__all__.append('HTTPSConnection')


def _patch_urllib(ur):
    import http.client as hc
    if not getattr(hc.HTTPSConnection, '_inksoc', False):
        _patch_http(hc)

    class HTTPSHandler(ur.AbstractHTTPHandler):
        def __init__(self, debuglevel=None, context=None, check_hostname=None):
            ur.AbstractHTTPHandler.__init__(self, debuglevel if debuglevel is not None else 0)

        def https_open(self, req):
            try:
                return self.do_open(hc.HTTPSConnection, req)
            except (hc.RemoteDisconnected, ConnectionResetError, BrokenPipeError) as e:
                # TLS failed (certificate, protocol) or the server closed before answering
                raise ur.URLError('connection closed before an answer (TLS refused?): %s' % e)

        https_request = ur.AbstractHTTPHandler.do_request_

    ur.HTTPSHandler = HTTPSHandler
    if 'HTTPSHandler' not in ur.__all__:
        ur.__all__.append('HTTPSHandler')
