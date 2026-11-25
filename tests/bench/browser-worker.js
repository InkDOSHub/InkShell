// Browser twin of tests/bench-engine.mjs (CI: WebKit vs Chromium, item 47). Runs in a module Worker:
// the engine and the WASI programs run in this thread, as in node. Receives { files:[[name,url]], cmd, pool },
// posts { lines:[[ms,text]], jit:{n,ms,bytes}, mem, done, err }.
import { runWasi } from '/wasi.js';
import { swapStore } from '/tests/swap-store.mjs';
self.onmessage = async (ev) => {
  const { files, cmd, pool } = ev.data;
  const dec = new TextDecoder(), enc = new TextEncoder();
  const lines = [], jit = { n: 0, ms: 0, bytes: 0, err: '' };
  let mem, x, line = '', done = false, err = '';
  const t0 = performance.now();
  const emit = (s) => {
    line += s;
    for (let k; (k = line.indexOf('\n')) >= 0; line = line.slice(k + 1)) {
      const l = line.slice(0, k).replace(/\r/g, '');
      lines.push([+(performance.now() - t0).toFixed(1), l]);
      if (l === '@@T done') done = true;
    }
  };
  const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status); return new Uint8Array(await r.arrayBuffer()); };
  const gunzip = async (b) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  try {
    const sw = swapStore(() => mem);
    const env = {
      host_console: (p, n) => emit(dec.decode(new Uint8Array(mem.buffer, p, n).slice(), { stream: true })),
      host_now_ms: () => performance.now(), host_epoch_ms: () => Date.now(),
      ...sw.imports,
      wine_call: () => 0,
      host_random: (p, n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); new Uint8Array(mem.buffer, p, n).set(b); },
      host_audio: () => {}, host_gl: () => 0, host_drive_read: () => 0, host_drive_write: () => 0,
      host_jit: (p, n) => {
        const t = performance.now();
        try {
          const m = new WebAssembly.Module(new Uint8Array(mem.buffer, p, n).slice());
          const i = new WebAssembly.Instance(m, { env: { memory: mem, rd: x.jit_rd, wr: x.jit_wr, step: x.jit_step, cond: x.jit_cond } });
          const tb = x.__indirect_function_table, k = tb.grow(1); tb.set(k, i.exports.f);
          jit.n++; jit.bytes += n; jit.ms += performance.now() - t; return k;
        } catch (e) { if (!jit.err) jit.err = e.message; return -1; }
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
    const t1 = performance.now();
    for (let idle = 0; !done && performance.now() - t1 < 600000;) {
      const st = x.run(2000000);
      if (x.wasi_next) for (let pid; (pid = x.wasi_next());) runWasi(x, pid);
      if (st === 1 || st === 2) break;
      if (st === 3) { const ms = x.stat(17); if (ms >= 30 && !(x.linux_timer_ms?.() >= 0) && ++idle > 200) break; await new Promise((r) => setTimeout(r, Math.min(ms, 30) || 2)); } else idle = 0;
    }
  } catch (e) { err = String((e && e.stack) || e); }
  if (line) emit('\n');
  postMessage({ lines, jit, mem: mem ? (mem.buffer.byteLength / 1048576) | 0 : 0, done, err });
};
