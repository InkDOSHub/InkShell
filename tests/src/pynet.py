# Item 76: urllib in the WebAssembly python3 through the network helper (inksoc-net). Run by
# tests/linux-test.mjs with INK_NET=1 INK_NET_PY=1 (real network through the wisp tunnel).
import sys
import time
import urllib.request as u

print('py-path', [p for p in sys.path if 'inksoc' in p])


def t(name, url, **kw):
    t0 = time.time()
    try:
        r = u.urlopen(u.Request(url, headers={'User-Agent': 'curl/8'}, **kw), timeout=60)
        b = r.read()
        print('py', name, r.status, len(b), b[:20])
    except u.HTTPError as e:
        print('py', name, 'HTTPError', e.code)
    except u.URLError as e:
        print('py', name, 'URLError', e.reason)
    print('  %s %.1f s' % (name, time.time() - t0))


t('http', 'http://example.com/')
t('https', 'https://example.com/')
t('hub', 'https://hub.inkdos.workers.dev/')
t('post', 'https://example.com/', data=b'x=1')
t('refused', 'http://127.0.0.1:1/')
print('py-net-done')
