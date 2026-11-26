// Item 51: browser twin of tests/bench-engine.mjs for the catalog's WebAssembly tools on a mounted /mnt
// (same engine, imports and run loop as browser-worker.js). The big files are never held whole: the kernel
// asks for pieces (linux_mount_fetch) and each piece is cut from a 1 MB block repeated up to the file size.
// Receives { files:[[name,url]], tools:[names], cmd, pool, mnt:[[path, kind]], mb }, posts
// { lines:[[ms,text]], compile:{name:[ms,ms,ms,bytes]}, mem, done, err, serve:{n,bytes,ms} }.
import { runWasi } from '/wasi.js';
import { swapStore } from '/tests/swap-store.mjs';
self.onmessage = async (ev) => {
  const { files, tools, cmd, pool, mnt, mb } = ev.data;
  const dec = new TextDecoder(), enc = new TextEncoder();
  const lines = [], compile = {}, srv = { n: 0, bytes: 0, ms: 0 };
  let mem, x, line = '', done = false, err = '';
  const t0 = performance.now();
  const emit = (s) => {
    line += s;
    for (let k; (k = line.indexOf('\n')) >= 0; line = line.slice(k + 1)) {
      const l = line.slice(0, k).replace(/\r/g, '');
      const t = +(performance.now() - t0).toFixed(1);
      lines.push([t, l]);
      // pieces served / bytes / ms spent cutting them, at every marker: the per-step share of the host's slice reads
      if (/^@@T (begin|end):/.test(l)) lines.push([t, `@@S ${l.slice(4)} ${srv.n} ${srv.bytes} ${srv.ms.toFixed(1)}`]);
      if (l === '@@T done') done = true;
    }
  };
  const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status); return new Uint8Array(await r.arrayBuffer()); };
  const gunzip = async (b) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  // the data files: a 1 MB block of whole lines (or bytes), repeated to ~mb MB
  const MB = 1048576, SIZE = mb * MB, blocks = new Map(), sizes = new Map();
  const mkBlock = (kind) => {
    if (kind === 'bin') { // half pseudo-random, half zeros (compresses about 2:1, like bench.sh)
      const b = new Uint8Array(MB); let s = 0x9e3779b9;
      for (let i = 0; i < MB / 2; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; b[i] = s & 255; }
      return b;
    }
    if (kind === 'text') { // unique prose-like text (no 1 MB repeat, so a dictionary coder cannot cheat): words of 2-10 random letters picked from a 20000-word vocabulary, 6-14 words per line
      let s = 0x2545f491;
      const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
      const voc = [];
      for (let i = 0; i < 20000; i++) { const w = new Uint8Array(2 + rnd() % 9); for (let k = 0; k < w.length; k++) w[k] = 97 + rnd() % 26; voc.push(w); }
      const out = new Uint8Array(SIZE); let o = 0;
      while (o < SIZE) {
        for (let n = 6 + rnd() % 9; n > 0 && o < SIZE; n--) { const w = voc[rnd() % 20000]; const k = Math.min(w.length, SIZE - o); out.set(w.subarray(0, k), o); o += k; if (o < SIZE) out[o++] = 32; }
        if (o < SIZE) out[o - 1] = 10;
      }
      out[SIZE - 1] = 10;
      return out;
    }
    const L = []; let n = 0;
    for (let i = 0; n < MB - 64; i++) { const l = kind === 'csv' ? `${i},word${i % 1000},${(i * 7) % 1000}\n` : `{"id":${i},"v":"word${i % 1000}","n":${i % 1000}}\n`; L.push(l); n += l.length; }
    return enc.encode(L.join(''));
  };
  for (const [p, kind] of mnt) {
    const b = mkBlock(kind);
    blocks.set(p, b); sizes.set(p, kind === 'bin' ? SIZE : Math.floor(SIZE / b.length) * b.length);
  }
  const cut = (p, off, len) => {
    const b = blocks.get(p), size = sizes.get(p);
    if (!b || off >= size) return new Uint8Array(0);
    const n = Math.min(len, size - off), o = new Uint8Array(n);
    for (let i = 0, k = off % b.length; i < n;) { const c = Math.min(n - i, b.length - k); o.set(b.subarray(k, k + c), i); i += c; k = 0; }
    return o;
  };
  try {
    // module compile time of each tool in this browser (3 reps), then its size
    for (const n of tools) {
      const bytes = await get('/out/tools/' + n); compile[n] = [];
      for (let i = 0; i < 3; i++) { const t = performance.now(); await WebAssembly.compile(bytes); compile[n].push(+(performance.now() - t).toFixed(1)); }
      compile[n].push(bytes.length);
    }
    const sw = swapStore(() => mem);
    const env = {
      host_console: (p, n) => emit(dec.decode(new Uint8Array(mem.buffer, p, n).slice(), { stream: true })),
      host_now_ms: () => performance.now(), host_epoch_ms: () => Date.now(),
      ...sw.imports,
      wine_call: () => 0,
      host_random: (p, n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); new Uint8Array(mem.buffer, p, n).set(b); },
      host_audio: () => {}, host_gl: () => 0, host_drive_read: () => 0, host_drive_write: () => 0,
      host_jit: (p, n) => {
        try {
          const m = new WebAssembly.Module(new Uint8Array(mem.buffer, p, n).slice());
          const i = new WebAssembly.Instance(m, { env: { memory: mem, rd: x.jit_rd, wr: x.jit_wr, step: x.jit_step, cond: x.jit_cond } });
          const tb = x.__indirect_function_table, k = tb.grow(1); tb.set(k, i.exports.f);
          return k;
        } catch (e) { return -1; }
      },
    };
    x = (await WebAssembly.instantiate(await get('/engine.wasm'), { env })).instance.exports;
    mem = x.memory;
    const put = (b) => { const p = x.buffer(b.length); new Uint8Array(mem.buffer, p, b.length).set(b); };
    const add = (name, data) => { const nm = enc.encode(name), d = new Uint8Array(data), b = new Uint8Array(nm.length + 1 + d.length); b.set(nm); b.set(d, nm.length + 1); put(b); x.add_file(); };
    x.init(pool, 8192);
    add('busybox', await get('/busybox'));
    add('rootfs.tar', await gunzip(await get('/alpine-rootfs.tar.gz')));
    add('zoverlay.tar', await get('/overlay.tar'));
    for (const [n, u] of files) add(n, await get(u));
    put(enc.encode('busybox\0' + cmd));
    if (x.start() !== 0) throw new Error('start: ' + dec.decode(new Uint8Array(mem.buffer, x.msg_ptr(), x.msg_len())));
    x.linux_winsize(30, 100);
    // the device folder /mnt/b (what the page's mountDir sends): path and size of each file
    put(enc.encode('/mnt/b\n' + mnt.map(([p]) => `F\t${p}\t${sizes.get(p)}`).join('\n'))); x.linux_mount();
    const serve = () => {
      const n = x.linux_mount_fetch();
      if (!n) return;
      const t = performance.now();
      for (const ln of dec.decode(new Uint8Array(mem.buffer, x.out_ptr(), n).slice()).split('\n')) {
        const [p, off, len] = ln.split('\t');
        if (!p) continue;
        const nm = enc.encode(p);
        if (len !== undefined) { // a piece of a big file
          const a = +off, d = cut(p, a, +len);
          const b = new Uint8Array(nm.length + 17 + d.length), v = new DataView(b.buffer);
          b.set(nm); v.setBigUint64(nm.length + 1, BigInt(a), true); v.setBigUint64(nm.length + 9, BigInt(+len), true); b.set(d, nm.length + 17);
          put(b); x.linux_mount_data(); srv.n++; srv.bytes += d.length;
        } else { const b = new Uint8Array(nm.length + 1); b.set(nm); put(b); x.linux_put_file(); }
      }
      srv.ms += performance.now() - t;
    };
    const t1 = performance.now();
    for (let idle = 0; !done && performance.now() - t1 < 1500000;) {
      const st = x.run(2000000);
      serve();
      if (x.wasi_next) for (let pid; (pid = x.wasi_next());) runWasi(x, pid, { serve });
      if (st === 1 || st === 2) break;
      if (st === 3) { const ms = x.stat(17); if (ms >= 30 && !(x.linux_timer_ms?.() >= 0) && ++idle > 200) break; await new Promise((r) => setTimeout(r, Math.min(ms, 30) || 2)); } else idle = 0;
    }
  } catch (e) { err = String((e && e.stack) || e); }
  if (line) emit('\n');
  postMessage({ lines, compile, mem: mem ? (mem.buffer.byteLength / 1048576) | 0 : 0, done, err, serve: srv });
};
