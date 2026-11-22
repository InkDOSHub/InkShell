# Small Python benchmark (pure Python + a few C modules). Prints "py NAME MS" lines.
import time
def t(name, f):
    a = time.perf_counter()
    try:
        f()
        print("py %-10s %9.1f" % (name, (time.perf_counter() - a) * 1000), flush=True)
    except Exception as e:
        print("py %-10s      skip (%s)" % (name, type(e).__name__), flush=True)
def loop():
    s = 0
    for i in range(3_000_000): s += i * i % 7
def calls():
    def fib(n): return n if n < 2 else fib(n - 1) + fib(n - 2)
    fib(25)
def dicts():
    d = {}
    for i in range(300_000): d["k%d" % i] = i
    for i in range(300_000): d["k%d" % i] += 1
def strings():
    s = "".join(str(i) for i in range(300_000))
    s.replace("1", "x").upper().split("x")
def sort():
    import random
    r = random.Random(1); a = [r.random() for _ in range(300_000)]; a.sort()
def js():
    import json
    o = [{"a": i, "b": str(i), "c": [i, i + 1]} for i in range(50_000)]
    json.loads(json.dumps(o))
def regex():
    import re
    txt = "abc123 def456 " * 50_000
    re.findall(r"[a-z]+\d+", txt)
def sha():
    import hashlib
    hashlib.sha256(b"x" * (32 << 20)).hexdigest()
def zl():
    import zlib
    zlib.decompress(zlib.compress(bytes(range(256)) * (64 << 10), 6))
def imports():
    import importlib
    for m in ["email", "http.client", "decimal", "asyncio", "ssl", "sqlite3"]:
        importlib.import_module(m)
total = time.perf_counter()
for n, f in [("loop", loop), ("calls", calls), ("dict", dicts), ("string", strings), ("sort", sort),
             ("json", js), ("regex", regex), ("sha256", sha), ("zlib", zl), ("imports", imports)]:
    t(n, f)
print("py %-10s %9.1f" % ("total", (time.perf_counter() - total) * 1000), flush=True)
