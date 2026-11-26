// Linux test for the Alpine terminal's engine (node 18+, no network needed).
// usage: node tests/linux-test.mjs [engine.wasm]   (run from apps/alpine)
// Boots Alpine like the page does, creates a user, and checks sudo, files, fork/exec, apk,
// /proc, and the swap (small real RAM, so pages of several processes go out and come back).
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { runWasi, cwdStats, cwdSlot } from '../wasi.js';
import { swapStore } from './swap-store.mjs';
import { report as enosysReport } from './enosys.mjs';
const wasmPath = process.argv[2] || 'engine.wasm';
const POOL = 24; // MB of real RAM: small on purpose
const dec = new TextDecoder(), enc = new TextEncoder();
let mem, x, out = '', jitErr = 0;
const sw = swapStore(() => mem), swap = sw.chunks; // 64 KB chunks of swap slots
const env = {
  host_console: (p, n) => { out += dec.decode(new Uint8Array(mem.buffer, p, n).slice(), { stream: true }); },
  host_now_ms: () => performance.now(), host_epoch_ms: () => Date.now(),
  ...sw.imports,
  wine_call: () => 0,
    host_random: (p, n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); new Uint8Array(mem.buffer, p, n).set(b); },
    host_audio: () => {}, host_gl: () => 0, host_drive_read: () => 0, host_drive_write: () => 0,
  host_jit: (p, n) => {
    try {
      const m = new WebAssembly.Module(new Uint8Array(mem.buffer, p, n).slice());
      const i = new WebAssembly.Instance(m, { env: { memory: mem, rd: x.jit_rd, wr: x.jit_wr, step: x.jit_step, cond: x.jit_cond } });
      const t = x.__indirect_function_table, k = t.grow(1); t.set(k, i.exports.f); return k;
    } catch (e) { if (!jitErr) { jitErr = 1; console.error('host_jit: ' + e.message); } return -1; }
  },
};
x = (await WebAssembly.instantiate(fs.readFileSync(wasmPath), { env })).instance.exports;
mem = x.memory;
x.set_jit_hot?.(40); // item 52: default HOT is 500; the test keeps 40 so short loops still go through the JIT
const put = (b) => { const p = x.buffer(b.length); new Uint8Array(mem.buffer, p, b.length).set(b); };
const add = (name, data) => { const nm = enc.encode(name), d = new Uint8Array(data), b = new Uint8Array(nm.length + 1 + d.length); b.set(nm); b.set(d, nm.length + 1); put(b); x.add_file(); };
x.init(POOL, 8192);
add('busybox', fs.readFileSync('busybox'));
add('rootfs.tar', zlib.gunzipSync(fs.readFileSync('alpine-rootfs.tar.gz')));
add('zoverlay.tar', fs.readFileSync('overlay.tar'));
add('stage1', fs.readFileSync(new URL('./stage1', import.meta.url))); // tests/src/stage1.c, built static
add('x86string', fs.readFileSync(new URL('./x86string', import.meta.url))); // tests/src/x86string.c, built static in CI (Alpine)
add('x86bmi', fs.readFileSync(new URL('./x86bmi', import.meta.url))); // tests/src/x86bmi.c, built static in CI (Alpine)
add('x86pwrite', fs.readFileSync(new URL('./x86pwrite', import.meta.url))); // tests/src/x86pwrite.c, built static in CI (Alpine)
add('x86vfork', fs.readFileSync(new URL('./x86vfork', import.meta.url))); // tests/src/x86vfork.c, built static in CI (Alpine)
add('x86sha', fs.readFileSync(new URL('./x86sha', import.meta.url))); // tests/src/x86sha.c, built static in CI (Alpine)
add('x86ssl', fs.readFileSync(new URL('./x86ssl', import.meta.url))); // tests/src/x86ssl.c, built in CI (Alpine), uses the rootfs libcrypto
add('x86v2', fs.readFileSync(new URL('./x86v2', import.meta.url))); // tests/src/x86v2.c, built static in CI (Alpine)
add('x86aes', fs.readFileSync(new URL('./x86aes', import.meta.url))); // tests/src/x86aes.c, built static in CI (Alpine)
// WebAssembly programs (kernel with wasi_next; the published engine.wasm may be older)
const wasiHello = new URL('./wasihello.wasm', import.meta.url); // tests/src/wasihello.c, built in CI (wasi-sdk)
const hasWasi = !!x.wasi_next;
if (hasWasi) add('hello.wasm', fs.readFileSync(wasiHello));
const wasiPw = new URL('./wasipwrite.wasm', import.meta.url); // tests/src/wasipwrite.c, built in CI (wasi-sdk; test job only)
const hasWasiPw = hasWasi && fs.existsSync(wasiPw);
if (hasWasiPw) add('pw.wasm', fs.readFileSync(wasiPw));
// CPython for WASI from the catalog (test.yml downloads it to tests/python.wasm, sha256 checked)
const pyWasm = new URL('./python.wasm', import.meta.url);
const hasPy = hasWasi && fs.existsSync(pyWasm);
const pyBytes = hasPy ? fs.readFileSync(pyWasm) : null;
if (hasPy) add('python.wasm', pyBytes);
if (hasPy) add('pynet.py', fs.readFileSync(new URL('./src/pynet.py', import.meta.url))); // item 76 (INK_NET_PY)
if (hasPy) add('pyproc.py', fs.readFileSync(new URL('./src/pyproc.py', import.meta.url))); // item 78 (INK_SPAWN)
// tools from the catalog (test.yml downloads them to tests/NAME.wasm, sha256 checked): [catalog name, file, programs]
const tools = [['7zip', '7zz', '7zz,7z'], ['qpdf', 'qpdf', 'qpdf'], ['imagemagick', 'magick', 'magick,convert,identify'], ['ffmpeg', 'ffmpeg', 'ffmpeg'], ['ffprobe', 'ffprobe', 'ffprobe'],
  ['sqlite', 'sqlite3', 'sqlite3'], ['jq', 'jq', 'jq'], ['lua5.4', 'lua', 'lua5.4,lua'], ['zip', 'zip', 'zip'], ['unzip', 'unzip', 'unzip'], ['ripgrep', 'rg', 'rg'],
  ['hashtools', 'hashsum', 'sha256sum,sha1sum,sha224sum,sha384sum,sha512sum,md5sum,b2sum'], ['quickjs', 'qjs', 'qjs'],
  ['sed', 'sed', 'sed'], ['findutils', 'find', 'find'], ['onetrue-awk', 'awk', 'awk'],
  ['tar', 'bsdtar', 'tar,bsdtar'], ['gzip', 'gzip', 'gzip,gunzip,zcat'], ['xz', 'xz', 'xz,unxz,xzcat,lzma,unlzma,lzcat'],
  ['bzip2', 'bzip2', 'bzip2,bunzip2,bzcat'], ['zstd', 'zstd', 'zstd,unzstd,zstdcat'],
  ['bc', 'bc', 'bc,dc'], ['file', 'file', 'file']]
  .map(([name, file, progs]) => ({ name, file, progs, url: new URL(`./${file}.wasm`, import.meta.url) })).filter((t) => hasWasi && fs.existsSync(t.url));
for (const t of tools) { t.bytes = fs.readFileSync(t.url); add(`${t.file}.wasm`, t.bytes); }
const hasTool = (name) => tools.some((t) => t.name === name);
// uutils coreutils (item 56): the catalog's `coreutils` (test.yml downloads it to tests/coreutils.wasm, sha256 checked); the links come from the catalog line
const cuUrl = new URL('./coreutils.wasm', import.meta.url);
const cu = hasWasi && fs.existsSync(cuUrl) ? { bytes: fs.readFileSync(cuUrl) } : null;
if (cu) { add('coreutils.wasm', cu.bytes); cu.files = fs.readFileSync('overlay/etc/inksoc/wasm-catalog', 'utf8').split('\n').find((l) => l.startsWith('coreutils\t')).split('\t')[5];
  add('cucat.txt', Buffer.from(`coreutils\tfile:///root/coreutils.wasm\t${crypto.createHash('sha256').update(cu.bytes).digest('hex')}\t${cu.bytes.length}\tMIT\t${cu.files}\tcoreutils\n`)); } // the line is too long for the terminal: a file
// hashtools: an 8 MB file whose digests node computes (and "abc"), to compare with the WebAssembly md5sum, sha*sum, b2sum
const HASHES = [['md5', 'md5'], ['sha1', 'sha1'], ['sha224', 'sha224'], ['sha256', 'sha256'], ['sha384', 'sha384'], ['sha512', 'sha512'], ['b2', 'blake2b512']];
const h8 = hasTool('hashtools') ? Buffer.alloc(8 << 20, 0).map((_, i) => (i * 131 + (i >> 9)) & 255) : null;
if (h8) add('h8.bin', h8);
const dig = (alg, b) => crypto.createHash(alg).update(b).digest('hex');
if (hasTool('qpdf')) { // a one-page PDF with a correct cross-reference table
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>', '<< /Length 27 >>\nstream\n0 0 1 rg 50 50 100 100 re f\nendstream'];
  let pdf = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  add('t.pdf', enc.encode(pdf));
}
if (hasTool('unzip')) { // CVE-2019-13232: a zip whose two central directory entries share one local entry (overlap, a zip bomb's trick)
  const crc = (b) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const data = enc.encode('bomb\n'), name = enc.encode('a.txt'), z = [];
  const u16 = (v) => z.push(v & 255, v >>> 8 & 255), u32 = (v) => { u16(v & 0xffff); u16(v >>> 16); }, str = (b) => z.push(...b);
  u32(0x04034b50); u16(10); u16(0); u16(0); u16(0); u16(0x21); u32(crc(data)); u32(data.length); u32(data.length); u16(name.length); u16(0); str(name); str(data);
  const cd = z.length;
  for (let i = 0; i < 2; i++) { u32(0x02014b50); u16(0x031e); u16(10); u16(0); u16(0); u16(0); u16(0x21); u32(crc(data)); u32(data.length); u32(data.length); u16(name.length); u16(0); u16(0); u16(0); u16(0); u32(0o100644 * 65536); u32(0); str(name); }
  const cdLen = z.length - cd;
  u32(0x06054b50); u16(0); u16(0); u16(2); u16(2); u32(cdLen); u32(cd); u16(0);
  add('bomb.zip', new Uint8Array(z));
}
// Module cache (wasi.js, key = the kernel's file version + size + path): two programs of the same size (> 1 MB),
// the 2nd written over the 1st in place; the smaller one gets a custom section ("p") as padding
const padWasm = (b, len) => { const o = new Uint8Array(len), c = len - b.length - 6; o.set(b); let i = b.length; o[i++] = 0; for (let k = 0, v = c; k < 5; k++, v >>>= 7) o[i++] = v & 0x7f | (k < 4 ? 0x80 : 0); o[i++] = 1; o[i++] = 0x70; return o; };
const cacheA = tools.find((t) => t.name === 'sqlite'), cacheB = tools.find((t) => t.name === 'jq');
const cacheLen = cacheA && cacheB ? Math.max(cacheA.bytes.length, cacheB.bytes.length, 1100000) + 64 : 0;
if (cacheLen) { add('cache-a.wasm', padWasm(cacheA.bytes, cacheLen)); add('cache-b.wasm', padWasm(cacheB.bytes, cacheLen)); }
put(enc.encode('busybox\0sh /etc/inksoc/start'));
if (x.start() !== 0) { console.log('FAIL start:', dec.decode(new Uint8Array(mem.buffer, x.msg_ptr(), x.msg_len()))); process.exit(1); }
x.linux_winsize(30, 100);
const send = (t) => { const b = enc.encode(t); put(b); x.linux_stdin(b.length); };
// item 76/78: WebAssembly programs in worker threads (tests/wasi-thread.mjs), like the page's wasi-worker.js:
// the engine (and the WebSocket) keep running while a program waits; a program's children run too.
// Used by the INK_NET block and, with INK_WASI_THREADS=1, by settle() instead of runWasi.
const threads = new Map();
function serveThreads() {
  if (!hasWasi) return;
  for (let pid; (pid = x.wasi_next());) {
    const k = x.wasi_info(pid), info = new Uint8Array(mem.buffer, x.out_ptr(), k).slice();
    const m = x.wasi_module(pid), bytes = new Uint8Array(mem.buffer, x.out_ptr(), m).slice();
    const size = x.wasi_buf_size(), sab = new SharedArrayBuffer(256 + Math.max(size, 65536) + 8192);
    const t = { ctl: new Int32Array(sab, 0, 16), F: new Float64Array(sab, 64, 12), data: new Uint8Array(sab, 256), busy: false, to: pid };
    t.w = new Worker(new URL('./wasi-thread.mjs', import.meta.url), { workerData: { sab, info, bytes, base: x.wasi_base(), size, pid, spawn: !!x.wasi_spawn } });
    t.w.on('error', (e) => console.log('  [wasi thread: ' + e.message + ']')); t.w.on('exit', () => threads.delete(pid));
    threads.set(pid, t);
  }
  for (const [, t] of threads) {
    const gone = () => { t.busy = false; Atomics.store(t.ctl, 0, 3); Atomics.notify(t.ctl, 0); };
    if (!t.busy && Atomics.load(t.ctl, 0) === 1) {
      const F = t.F, n = F[8], p = x.buffer(n); new Uint8Array(mem.buffer, p, n).set(t.data.subarray(0, n));
      t.to = F[11];
      if (x.wasi_call(t.to, F[0], F[1], F[2], F[3], F[4], F[5], F[6], F[7]) !== 0) { gone(); continue; }
      t.busy = true;
    }
    if (!t.busy) continue;
    const n = x.wasi_take(t.to);
    if (n === -1) continue;
    if (n === -2) { gone(); continue; }
    t.busy = false; t.F[9] = x.wasi_ret(); t.F[10] = n;
    if (n > 0) t.data.set(new Uint8Array(mem.buffer, x.out_ptr(), n));
    Atomics.store(t.ctl, 0, 2); Atomics.notify(t.ctl, 0);
  }
}
const WASI_MAX = 300000; // ms, one WebAssembly program in settle()
// run until the program waits for the terminal again (or ends)
async function settle(maxMs = 120000) {
  const t0 = Date.now();
  for (let idle = 0; Date.now() - t0 < maxMs;) {
    const st = x.run(2000000);
    serveMount();
    if (process.env.INK_WASI_THREADS) serveThreads();
    else if (hasWasi) for (let pid; (pid = x.wasi_next());) { // serveMount: a WASI read of a big /mnt file waits on its pieces
      const end = Date.now() + WASI_MAX; // watchdog: fail fast instead of eating the job's 30 min
      runWasi(x, pid, { serve: () => { serveMount(); if (Date.now() > end) { console.log(`FAIL WebAssembly program ran over ${WASI_MAX / 1000} s (hung?)\n---- output ----\n${out.slice(-600)}`); process.exit(1); } } });
    }
    if (st === 1 || st === 2) return st;
    // waiting: a timer due soon (sleep, a timeout) is not idle; only waiting for the terminal is
    if (st === 3 && threads.size) { await new Promise((r) => setTimeout(r, 0)); idle = 0; continue; } // a program's thread is working
    if (st === 3) { const ms = x.stat(17); if (ms >= 30 && !(x.linux_timer_ms?.() >= 0) && ++idle > 20) return 3; await new Promise((r) => setTimeout(r, Math.min(ms, 30) || 2)); } else idle = 0;
  }
  return 0;
}
// a device folder mounted at /mnt/t (the page's part: files are sent when a program opens them)
const devFiles = new Map([['/mnt/t/a.txt', 'hello-dev\n'], ['/mnt/t/sub/b.txt', 'B']]);
const devBig = new Map(), devServed = new Map(); let devPiece = 0; // big device files: served in pieces
function serveMount() {
  const n = x.linux_mount_fetch();
  if (!n) return;
  for (const ln of dec.decode(new Uint8Array(mem.buffer, x.out_ptr(), n).slice()).split('\n')) {
    const [p, off, len] = ln.split('\t');
    if (len !== undefined) { // a piece of a big file (the page answers with File.slice)
      const src = devBig.get(p) || Buffer.alloc(0), a = +off, d = src.subarray(a, a + +len);
      devServed.set(p, (devServed.get(p) || 0) + d.length); devPiece = Math.max(devPiece, d.length);
      const nm = enc.encode(p), b = new Uint8Array(nm.length + 17 + d.length), v = new DataView(b.buffer);
      b.set(nm); v.setBigUint64(nm.length + 1, BigInt(a), true); v.setBigUint64(nm.length + 9, BigInt(+len), true); b.set(d, nm.length + 17);
      put(b); x.linux_mount_data(); continue;
    }
    const nm = enc.encode(p), d = enc.encode(devFiles.get(p) || ''), b = new Uint8Array(nm.length + 1 + d.length);
    b.set(nm); b.set(d, nm.length + 1); put(b); x.linux_put_file();
  }
}
// A second engine that boots from a saved tar fed in 4 MB pieces (linux_load_begin/linux_load_chunk,
// as the page reads alpine-fs.tar from OPFS) and runs `script` as root. Its own memory and swap.
async function bootSaved(tar, script) {
  let m2, x2, o2 = '';
  const s2 = swapStore(() => m2);
  const env2 = {
    ...env, ...s2.imports,
    host_console: (p, n) => { o2 += dec.decode(new Uint8Array(m2.buffer, p, n).slice(), { stream: true }); },
    host_random: (p, n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); new Uint8Array(m2.buffer, p, n).set(b); },
    host_jit: (p, n) => {
      try {
        const m = new WebAssembly.Module(new Uint8Array(m2.buffer, p, n).slice());
        const i = new WebAssembly.Instance(m, { env: { memory: m2, rd: x2.jit_rd, wr: x2.jit_wr, step: x2.jit_step, cond: x2.jit_cond } });
        const t = x2.__indirect_function_table, k = t.grow(1); t.set(k, i.exports.f); return k;
      } catch (e) { if (!jitErr) { jitErr = 1; console.error('host_jit: ' + e.message); } return -1; }
    },
  };
  x2 = (await WebAssembly.instantiate(fs.readFileSync(wasmPath), { env: env2 })).instance.exports;
  m2 = x2.memory;
  const put2 = (b) => { const p = x2.buffer(b.length); new Uint8Array(m2.buffer, p, b.length).set(b); };
  const add2 = (name, data) => { const nm = enc.encode(name), d = new Uint8Array(data), b = new Uint8Array(nm.length + 1 + d.length); b.set(nm); b.set(d, nm.length + 1); put2(b); x2.add_file(); };
  x2.init(POOL, 8192);
  add2('busybox', fs.readFileSync('busybox'));
  const h0 = x2.heap_used(); let peak = h0;
  x2.linux_load_begin();
  for (let a = 0; a < tar.length; a += 4 << 20) { put2(tar.subarray(a, a + (4 << 20))); x2.linux_load_chunk(); peak = Math.max(peak, x2.heap_used()); }
  add2('zoverlay.tar', fs.readFileSync('overlay.tar'));
  add2('chk.sh', enc.encode(script));
  put2(enc.encode('busybox\0sh /root/chk.sh'));
  if (x2.start() !== 0) return { out: 'start failed: ' + dec.decode(new Uint8Array(m2.buffer, x2.msg_ptr(), x2.msg_len())), grow: 0 };
  for (const t1 = Date.now(); Date.now() - t1 < 180000;) {
    const st = x2.run(2000000);
    if (st === 1 || st === 2) break;
    if (st === 3) await new Promise((r) => setTimeout(r, 2));
  }
  return { out: o2, grow: (peak - h0) / 1048576 };
}
const results = [];
async function step(input, expect, name) {
  const before = out.length;
  send(input);
  const st = await settle();
  const got = out.slice(before);
  const ok = expect.test(got);
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '\n---- output ----\n' + got.slice(-600) + '\n----------------'));
  if (st === 2) { console.log('engine stopped:', dec.decode(new Uint8Array(mem.buffer, x.msg_ptr(), x.msg_len()))); process.exit(1); }
}
const t0 = Date.now();
await settle();
results.push(/New UNIX username/.test(out)); console.log((results[0] ? 'PASS' : 'FAIL') + ' first start asks for a user');
await step('tester\n', /New password/, 'user name accepted');
await step('pw1\n', /Retype/, 'password asked twice');
await step('pw1\n', /tester@inksoc/, 'shell as the new user');
if (process.env.INK_NET) { // item 62: real network through the wisp tunnels, like worker.js (INK_NET=1; only the wisp-net workflow sets it)
  const TUN = ['wss://wisp.mercurywork.shop/v86/', 'wss://hub.inkdos.workers.dev/net/wisp/'];
  let wsUrl = null, ws = null, wsq = [], opened = false; const got = new Set();
  const packet = (t, id, body) => { const b = Buffer.alloc(5 + body.length); b[0] = t; b.writeUInt32LE(id, 1); Buffer.from(body).copy(b, 5); return b; };
  const wsSend = (b) => { if (ws && ws.readyState === 1) ws.send(b); else wsq.push(b); };
  const netIn = (id, kind, d) => { put(d || new Uint8Array(0)); x.linux_net_in(id, kind); };
  const openWs = () => {
    wsUrl = wsUrl || TUN[0]; opened = false;
    const sock = ws = new WebSocket(wsUrl); ws.binaryType = 'arraybuffer';
    ws.onopen = () => { opened = true; console.log('  [net: tunnel open ' + wsUrl + ']'); for (const b of wsq) ws.send(b); wsq = []; };
    ws.onmessage = (ev) => {
      const b = new Uint8Array(ev.data); if (b.length < 5) return;
      const id = new DataView(b.buffer).getUint32(1, true);
      if (b[0] === 2) { got.add(id); netIn(id, 1, b.subarray(5)); }
      else if (b[0] === 4) { console.log('  [net: stream ' + id + ' closed by the tunnel, reason ' + b[5] + ', got data: ' + got.has(id) + ']'); netIn(id, got.has(id) || b[5] === 2 ? 2 : 3); }
    };
    const lost = () => { if (ws !== sock) return; ws = null; console.log('  [net: tunnel lost, opened=' + opened + ']'); if (!opened && wsUrl !== TUN[1]) { wsUrl = TUN[1]; openWs(); return; } wsq = []; };
    ws.onclose = lost; ws.onerror = lost;
  };
  const pump = () => {
    const n = x.linux_net_poll(); if (!n) return;
    const b = new Uint8Array(mem.buffer, x.out_ptr(), n).slice(), v = new DataView(b.buffer);
    for (let o = 0; o < n;) {
      const op = b[o], id = v.getUint32(o + 1, true), len = v.getUint32(o + 5, true), d = b.subarray(o + 9, o + 9 + len); o += 9 + len;
      if (op === 1) {
        if (!ws) openWs();
        const sd = dec.decode(d), k = sd.lastIndexOf(':'), host = enc.encode(sd.slice(0, k)), body = new Uint8Array(3 + host.length);
        body[0] = 1; new DataView(body.buffer).setUint16(1, +sd.slice(k + 1), true); body.set(host, 3); wsSend(packet(1, id, body));
      } else if (op === 2) wsSend(packet(2, id, d));
      else if (op === 3) { got.delete(id); wsSend(packet(4, id, new Uint8Array([2]))); }
    }
  };
  const until = async (re, maxMs, mark) => {
    const t1 = Date.now(), from = out.length;
    for (let tick = 0; Date.now() - t1 < maxMs;) {
      const st = x.run(2000000); pump(); serveThreads();
      if (re.test(out.slice(from))) return out.slice(from);
      if (st === 2) { console.log('engine stopped'); process.exit(1); }
      if (st === 3) await new Promise((r) => setTimeout(r, threads.size ? 0 : 5)); else if (++tick % 50 === 0) await new Promise((r) => setTimeout(r, 0));
      if (mark && Date.now() - t1 > mark.at) { mark.at += 30000; console.log('  ... ' + ((Date.now() - t1) / 1000 | 0) + ' s'); }
    }
    return null;
  };
  if (process.env.INK_NET_PY) { // item 76: urllib http/https in the WebAssembly python3 (network helper inksoc-net)
    if (!hasPy) { console.log('FAIL INK_NET_PY: no tests/python.wasm'); process.exit(1); }
    const t1 = Date.now(); send('/root/python.wasm /root/pynet.py; echo done-$?\n');
    const got1 = await until(/done-\d/, 240000, { at: 30000 }) || out.slice(-1500);
    const checks = [[/py-path \['\/etc\/inksoc\/python'\]/, 'PYTHONPATH from /etc/profile.d has the helper folder'],
      [/py http 200 \d+ b'<!doctype html/i, 'urlopen http:// (example.com) 200 + body'],
      [/py https 200 \d+ b'<!doctype html/i, 'urlopen https:// (example.com, TLS by ssl_client) 200 + body'],
      [/py hub (\d{3}|HTTPError \d{3})/, 'urlopen https://hub.inkdos.workers.dev/ answers (status or HTTPError)'],
      [/py post (\d{3}|HTTPError \d{3})/, 'urlopen POST https:// answers'],
      [/py refused URLError/, 'no server: clean URLError, no hang'],
      [/py-net-done[\s\S]*done-0/, 'python3 ends normally']];
    let ok = true;
    for (const [re, name] of checks) { const k = re.test(got1); ok = ok && k; console.log((k ? 'PASS ' : 'FAIL ') + 'python3 urllib: ' + name); }
    console.log('python3 urllib in ' + ((Date.now() - t1) / 1000).toFixed(1) + ' s\n' + got1.slice(-1500));
    process.exit(ok ? 0 : 1);
  }
  const all = [];
  for (const [name, cmd, ms, want] of [['plain http (example.com, no TLS)', 'wget -O /dev/null http://example.com/ 2>&1 | tr "\\r" "\\n" | tail -n 3', 60000],
      ['https (example.com, ssl_client)', 'wget -O /dev/null https://example.com/ 2>&1 | tr "\\r" "\\n" | tail -n 3', 60000],
      ['apk fetch over https (apk uses ssl_client too)', 'cd /tmp && apk fetch --no-cache --repository https://dl-cdn.alpinelinux.org/alpine/v3.21/main --allow-untrusted busybox-extras 2>&1 | tail -n 3; ls -l /tmp/*.apk | head -2; cd ~ && true', 120000],
      // item 64: busybox wget https (openssl helper missing -> ssl_client) + sha256 of the file
      ['hashtools (small, InkShell release, sha256)', 'wget -O /tmp/h.wasm https://github.com/InkDOSHub/InkShell/releases/download/wasm-tools-7/hashsum.wasm 2>&1 | tr "\\r" "\\n" | tail -n 3; sha256sum /tmp/h.wasm', 120000, /06b833ca3ad90fb715b30f4f7787ad02d25b40792b1075cbb6de7bd196cb65b1/],
      ['python3 (26 MB, vmware release)', 'wget -O /dev/null "$(grep ^python3 /etc/inksoc/wasm-catalog | cut -f2)" 2>&1 | tr "\\r" "\\n" | tail -n 3', 600000]]) {
    const t1 = Date.now(); send(cmd + '; echo done-$?\n');
    const got1 = await until(/done-\d/, ms, { at: 30000 });
    const ok = !!got1 && /saved|\.apk/.test(got1) && (!want || want.test(got1));
    all.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + 'wget through wisp: ' + name + ' in ' + ((Date.now() - t1) / 1000).toFixed(1) + ' s\n' + (got1 || out.slice(-300)).slice(-500));
  }
  process.exit(all.every(Boolean) ? 0 : 1);
}
if (process.env.INK_SPAWN) { // item 78: processes from WebAssembly programs (host channel /dev/inksoc); with INK_WASI_THREADS=1
  if (!hasPy) { console.log('FAIL INK_SPAWN: no tests/python.wasm'); process.exit(1); }
  const t1 = Date.now(), from = out.length;
  send('/root/python.wasm /root/pyproc.py; echo done-$?\n');
  while (!/done-\d/.test(out.slice(from)) && Date.now() - t1 < 240000) await settle(5000);
  const got1 = out.slice(from);
  const hasJq = hasTool('jq');
  const checks = [[/pp-start inksoc_proc/, 'subprocess.Popen is the bridge'],
    [/sys-x86 3[\s\S]*pp system-shell 0/, 'os.system with shell syntax (x86 sh -c)'], [/pp system-codes \(0, 1\)/, 'os.system true/false statuses'],
    [/pp check_output b'hello world\\n'/, 'check_output'], [/pp sort-input b'a\\nb\\nc\\n'/, 'run(input=, capture_output=)'],
    [/pp rc3 3 /, 'shell=True return code'], [/pp cpe cpe 1 /, 'CalledProcessError'], [/pp fnf fnf-ok/, 'FileNotFoundError'],
    [/pp popen-cat \(0, 'via cat\\n'\)/, 'Popen pipes, text, communicate'], [/pp merged b'err\\nout\\n'/, 'stderr=STDOUT'],
    [/pp cwd \/tmp /, 'cwd='], [/pp env envok /, 'env='], [/pp getoutput \(2, 'go'\)/, 'getstatusoutput'], [/pp os-popen popen-ok/, 'os.popen'],
    ...(hasJq ? [[/pp wasm-jq b'42\\n'/, 'WebAssembly child (jq) with pipes'], [/pp wasm-pipe 8 /, 'pipe of WebAssembly programs in sh']] : []),
    [/pp wasm-python child wasi/, 'WebAssembly child (python3)'], [/pp kill \(None, -9\)/, 'poll + kill'], [/pp timeout timeout-ok/, 'TimeoutExpired'],
    [/pp-done[\s\S]*done-0/, 'python3 ends normally']];
  let ok = true;
  for (const [re, name] of checks) { const k = re.test(got1); ok = ok && k; console.log((k ? 'PASS ' : 'FAIL ') + 'python3 processes: ' + name); }
  console.log('python3 processes in ' + ((Date.now() - t1) / 1000).toFixed(1) + ' s\n' + got1.slice(-3000));
  process.exit(ok ? 0 : 1);
}
await step('id -un; echo $HOME\n', /tester\s+\/home\/tester/, 'id and home');
await step('sudo id -u\n', /Password/, 'sudo asks the password');
await step('pw1\n', /^\s*0\s*$/m, 'sudo runs as root');
await step('echo hello > f.txt && cat f.txt\n', /hello/, 'files');
await step('sh -c "for i in 1 2 3 4 5; do /bin/true; done; echo forked-ok"\n', /forked-ok/, 'fork and exec');
await step('apk info | wc -l\n', /^\s*1[0-9]\s*$/m, 'apk (dynamic program, shared libraries)');
await step('free -m | grep Mem\n', /Mem:\s+8192/, '/proc and sysinfo: programs see 8 GB');
await step('awk \'BEGIN{for(i=0;i<400000;i++)a[i]="item number " i; print length(a)}\'\n', /400000/, 'a program using more than the real RAM');
results.push(swap.size > 0); console.log((swap.size > 0 ? 'PASS' : 'FAIL') + ' pages went to swap (' + swap.size + ' chunks)');
await step('sh -c \'awk "BEGIN{for(i=0;i<200000;i++)a[i]=i; print 1}" & awk "BEGIN{for(i=0;i<200000;i++)b[i]=i; print 2}"; wait\' | sort | tr "\\n" " "; echo\n', /1 2/, 'two processes swapping at once');
await step('/root/x86string\n', /x86string ok \d+/, 'rep movs/stos: sizes, alignments, overlaps, DF=1, long counts, memcpy/memset, fault');
await step('/root/x86bmi\n', /x86bmi ok \d+/, 'POPCNT/LZCNT/TZCNT, BMI1, BMI2 (VEX): values, flags, memory operands, CPUID bits');
// the published engine.wasm may predate SHA in CPUID (then the program says skip)
await step('/root/x86sha\n', wasmPath === 'engine.wasm' ? /x86sha (ok \d+|skip)/ : /x86sha ok \d+/, 'SHA extensions, PSHUFB/PALIGNR/PBLENDW: model, memory operands, SHA-256/SHA-1 of abc and 1 MB');
// the published engine.wasm may predate x86-64-v2 in CPUID (then the program says skip)
await step('/root/x86v2\n', wasmPath === 'engine.wasm' ? /x86v2 (ok \d+|skip)/ : /x86v2 ok \d+/, 'x86-64-v2: SSE3/SSSE3/SSE4.1/SSE4.2 (PCMPxSTRx, CRC32), CMPXCHG16B, LAHF/SAHF: model, memory operands, flags, CPUID bits');
// the published engine.wasm may predate AES-NI in CPUID (then the program says skip)
await step('/root/x86aes\n', wasmPath === 'engine.wasm' ? /x86aes (ok \d+|skip)/ : /x86aes ok \d+/, 'AES-NI (AESENC/DEC/LAST, AESIMC, AESKEYGENASSIST) and PCLMULQDQ: model, memory operands, every immediate, FIPS-197 vector, CPUID bits');
{ // speed (log only): our SHA code vs scalar C, and libcrypto (aes, chacha20, sha256, sha1) as is,
  // with SSSE3 masked (OpenSSL's code before x86-64-v2), with SHA-NI masked and with AES-NI masked
  const b = out.length;
  await step('/root/x86sha bench 64; /root/x86ssl 64\n', /x86ssl sha1: /, 'SHA speed: x86sha bench, libcrypto (x86ssl)');
  await step('OPENSSL_ia32cap=~0x20000000000 /root/x86ssl 64\n', /x86ssl sha1 \(ia32cap ~0x20000000000\)/, 'libcrypto speed with SSSE3 masked');
  await step('OPENSSL_ia32cap=:~0x20000000 /root/x86ssl 64\n', /x86ssl sha1 \(ia32cap :~0x20000000\)/, 'libcrypto speed with SHA-NI masked');
  await step('OPENSSL_ia32cap=~0x200000000000000 /root/x86ssl 64\n', /x86ssl sha1 \(ia32cap ~0x200000000000000\)/, 'libcrypto speed with AES-NI masked');
  { // same aes-128-cbc ciphertext with and without AES-NI (OpenSSL aesni vs vpaes code)
    const ct = (re) => (out.slice(b).match(re) || [])[1];
    const plain = ct(/x86ssl aes-128-cbc: .* ([0-9a-f]{8})\r?\n/), masked = ct(/x86ssl aes-128-cbc \(ia32cap ~0x200000000000000\): .* ([0-9a-f]{8})\r?\n/);
    const ok = !!plain && plain === masked;
    results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' aes-128-cbc ciphertext same with and without AES-NI (' + plain + ' / ' + masked + ')');
  }
  console.log(out.slice(b).split(/\r?\n/).filter((l) => /^x86s(sl|ha (bench|skip))/.test(l)).map((l) => '  ' + l).join('\n'));
}
await step('/root/stage1 threads\n', /threads 200000/, 'threads, mutex and condition variable (futex)');
await step('/root/stage1 signals\n', /signals 10 7 15/, 'signal handlers, pause, kill');
await step('/root/stage1 sockets\n', /sockets ping pong 0 tcp-ok/, 'socketpair, unix server, TCP on 127.0.0.1');
await step('/root/stage1 sockopt\n', /sockopt 1 2 6/, 'getsockopt SO_TYPE/SO_PROTOCOL on internet sockets (Python ssl)');
put(enc.encode('/mnt/t\nF\t/mnt/t/a.txt\t10\nD\t/mnt/t/sub\nF\t/mnt/t/sub/b.txt\t1')); x.linux_mount();
await step('stat -c %s /mnt/t/sub/b.txt; cat /mnt/t/a.txt; echo new > /mnt/t/n.txt; mv /mnt/t/sub/b.txt /mnt/t/c.txt; rm /mnt/t/a.txt; echo mount-done\n', /^1\s*$[\s\S]*hello-dev[\s\S]*mount-done/m, 'device folder: size before reading, read on open, write, move, remove');
{
  put(enc.encode('/mnt/t')); const n = x.linux_mount_scan();
  const sc = dec.decode(new Uint8Array(mem.buffer, x.out_ptr(), n).slice());
  const ok = /F\t\/mnt\/t\/n\.txt\t4\t1/.test(sc) && /F\t\/mnt\/t\/c\.txt\t1\t0/.test(sc) && !/a\.txt/.test(sc);
  results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' device folder: changes listed for the page' + (ok ? '' : '\n' + sc));
}
await step('/root/x86vfork\n', /x86vfork ok 11/, 'vfork: parent waits; child that does not exec leaves its writes (busybox wget https); socketpair + execvp + shutdown');
await step('/root/x86pwrite && /root/x86pwrite /mnt/t/pw.bin\n', /x86pwrite ok 26\s[\s\S]*x86pwrite ok 26/, 'pwrite64, preadv/pwritev(2): offset kept, 3 MB file, 2 iovecs, pipe ESPIPE (also in a device folder)');
await step('/root/stage1 epoll\n', /epoll 0 1 22 1 11 5 select 0 1/, 'epoll, eventfd, select');
await step('/root/stage1 timers\n', /timers 14 1 fd 10 14/, 'alarm, setitimer, timerfd, timer_create; SIGALRM ends a process');
await step('/root/stage1 pty\n', /pty size tty line \^C sig 2/, 'pseudo-terminal: size, tty name, line mode, Ctrl+C');
if (hasWasi) {
  await step('echo piped | /root/hello.wasm A > /tmp/w.out; echo rc=$?; cat /tmp/w.out /tmp/wasi-made.txt\n', /rc=3[\s\S]*wasi argc=2 arg1=A in=piped[\s\S]*made-by-wasm/, 'WebAssembly program: args, pipe in, redirect out, file, exit code');
  if (hasWasiPw) await step('/root/pw.wasm\n', /wasipwrite ok 012345AB89/, 'WebAssembly program: pwrite / pread (fd_pwrite, fd_pread)');
  await step('/root/hello.wasm B < /dev/null | tr a-z A-Z\n', /WASI ARGC=2 ARG1=B IN=\(EOF\)/, 'WebAssembly program in a pipeline');
  // WebAssembly catalog: a local entry (file:// mirror) for the test program; apk add installs it, other names go to Alpine's apk (--no-network: the test runs offline)
  const hb = fs.readFileSync(wasiHello), hsum = crypto.createHash('sha256').update(hb).digest('hex');
  await step(`sudo sh -c "printf 'hello-wasm\\tfile:///root/hello.wasm\\t${hsum}\\t${hb.length}\\tMIT\\t/usr/local/bin/hello-wasm\\ttest program\\n' > /etc/inksoc/wasm-catalog.local"\n`, /Password/, 'catalog: local entry (sudo asks)');
  await step('pw1\n', /tester@inksoc/, 'catalog: local entry written');
  await step('apk search hello-w\n', /hello-wasm \[wasm\] test program/, 'catalog: apk search lists [wasm]');
  await step('apk add --no-network hello-wasm zz-no-such-pkg; echo add-rc=$?\n', /Password/, 'catalog: apk add asks sudo');
  await step('pw1\n', /hello-wasm: \d+\/\d+ KB 100%[\s\S]*OK: hello-wasm installed[\s\S]*(no such package|unable to select)[\s\S]*add-rc=[1-9]/, 'catalog: apk add shows progress, installs WebAssembly build, other name reaches real apk');
  await step('hello-wasm X < /dev/null; echo rc=$?\n', /wasi argc=2 arg1=X in=\(eof\)[\s\S]*rc=3/, 'catalog: installed program runs from PATH');
  await step('apk del hello-wasm; test -e /usr/local/bin/hello-wasm || echo gone\n', /Password/, 'catalog: apk del asks sudo');
  await step('pw1\n', /WebAssembly build removed[\s\S]*gone/, 'catalog: apk del removes it');
  // item 62: a download that fails is retried (resume) and shows wget's own message, not just "download failed"
  await step(`sudo sh -c "printf 'bad-wasm\\thttp://127.0.0.1:9/bad.wasm\\t${hsum}\\t10\\tMIT\\t/usr/local/bin/bad-wasm\\tunreachable\\n' >> /etc/inksoc/wasm-catalog.local"\n`, /Password/, 'catalog: unreachable entry (sudo asks)');
  await step('pw1\n', /tester@inksoc/, 'catalog: unreachable entry written');
  await step('sudo sh -c "INKSOC_RETRY_WAIT=0 apk add --no-network bad-wasm"; echo bad-rc=$?\n', /Password/, 'catalog: failing download asks sudo');
  await step('pw1\n', /continuing \(3\/3\)[\s\S]*ERROR: bad-wasm: download failed: http:\/\/127\.0\.0\.1:9\/bad\.wasm\s+\S*wget[^\n]*(refused|connect)[\s\S]*bad-rc=1/i, 'catalog: failed download retries 3 times and shows the wget message');
  if (hasPy) { // python3 from the catalog (local file:// mirror), run in the terminal
    const psum = crypto.createHash('sha256').update(pyBytes).digest('hex');
    await step(`sudo sh -c "printf 'python3\\tfile:///root/python.wasm\\t${psum}\\t${pyBytes.length}\\tPSF-2.0\\t/usr/local/bin/python3,/usr/local/bin/python\\tPython\\n' >> /etc/inksoc/wasm-catalog.local"\n`, /Password/, 'python3: local catalog entry (sudo asks)');
    await step('pw1\n', /tester@inksoc/, 'python3: local catalog entry written');
    await step('apk add --no-network python3; echo add-rc=$?\n', /Password/, 'python3: apk add asks sudo');
    await step('pw1\n', /OK: python3 installed[\s\S]*add-rc=0/, 'python3: apk add installs the WebAssembly build');
    const py0 = cwdStats.length;
    await step('python3 -c "print(6*7)"\n', /^42\s*$/m, 'python3: -c prints 42');
    await step(`mkdir -p /tmp/t && printf '%s\\n' 'import json, re' 'open("/tmp/t/d.json", "w").write(json.dumps({"a": [1, 2]}))' 'd = json.load(open("/tmp/t/d.json"))' 'print("py-file", d["a"][1], re.sub(r"[0-9]+", "N", "x12y3"))' > /tmp/t/s.py && (cd /tmp/t && python3 s.py)\n`, /py-file 2 xNyN/, 'python3: script by relative name, file in /tmp, json and re');
    await step('echo abc | python3 -c "import sys; print(sys.stdin.read().upper())"\n', /^ABC\s*$/m, 'python3: reads a pipe');
    await step('python3 -c "raise SystemExit(5)"; echo py-rc=$?\n', /py-rc=5/, 'python3: exit code');
    // relative paths follow the shell's folder (wasi-libc's cwd is set to it), absolute paths the real root
    await step(`mkdir -p /tmp/rel && cd /tmp/rel && python3 -c "import os; open('rel.txt', 'w').write('rel-' + 'ok'); print(open('rel.txt').read().upper(), sorted(os.listdir('.')), open('/tmp/t/d.json').read()[:5])"; cd; cat /tmp/rel/rel.txt; echo\n`, /REL-OK \['rel\.txt'\] \{"a":[\s\S]*rel-ok/, 'python3: relative path in the shell folder, absolute path still works');
    await step(`cd /tmp/rel && python3 -c "import os; print('cwd=' + os.getcwd(), 'etc' in os.listdir('/'), 'alpine=' + open('/etc/alpine-release').read().strip()[:1], open('rel.txt').read())"; cd\n`, /cwd=\/tmp\/rel True alpine=\d rel-ok/, 'python3: getcwd() is the shell folder, "/" is the real root');
    { // the cwd-pointer search runs once per module: 1st python3 run searches, the next ones reuse it
      const py = cwdStats.slice(py0), f = (v) => v.toFixed(1);
      console.log(`cwd detection (python3, ${py.length} runs): 1st ${py[0] ? f(py[0].ms) + ' ms' + (py[0].hit ? ' (hit)' : '') : '-'}, next ${py.slice(1).map((e) => f(e.ms) + (e.hit ? '' : '(miss)')).join(' ')} ms`);
      const ok = py.length >= 2 && !py[0].hit && py.slice(1).every((e) => e.hit && e.ms < py[0].ms);
      results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + 'python3: cwd detection cached after the 1st run');
    }
  }
  if (tools.length) { // 7-Zip, qpdf, ImageMagick, ffmpeg, sqlite, jq, lua, zip, unzip from the catalog (local file:// mirrors), one apk add
    const lines = tools.map((t) => `${t.name}\\tfile:///root/${t.file}.wasm\\t${crypto.createHash('sha256').update(t.bytes).digest('hex')}\\t${t.bytes.length}\\tlicense\\t${t.progs.split(',').map((p) => '/usr/local/bin/' + p).join(',')}\\t${t.name}\\n`);
    // a few entries per command line (the terminal line has a length limit), then one sudo appends them
    for (let i = 0; i < lines.length; i += 3) await step(`printf '${lines.slice(i, i + 3).join('')}' >> /tmp/wcat; echo wcat-$((${i} + 1))\n`, new RegExp(`wcat-${i + 1}\\s`), `tools: catalog entries ${i + 1}-${Math.min(i + 3, lines.length)} in /tmp/wcat`);
    await step('sudo sh -c "cat /tmp/wcat >> /etc/inksoc/wasm-catalog.local"; rm /tmp/wcat\n', /Password/, 'tools: local catalog entries (sudo asks)');
    await step('pw1\n', /tester@inksoc/, 'tools: local catalog entries written');
    await step(`apk add --no-network ${tools.map((t) => t.name).join(' ')}; echo add-rc=$?\n`, /Password/, 'tools: apk add asks sudo');
    await step('pw1\n', new RegExp(tools.map((t) => `OK: ${t.name} installed`).join('[\\s\\S]*') + '[\\s\\S]*add-rc=0'), `tools: apk add installs ${tools.map((t) => t.name).join(', ')}`);
  }
  if (hasTool('7zip')) { // 7-Zip: create, list, extract, compare (7z and zip)
    await step('mkdir -p /tmp/sz/in/sub && cd /tmp/sz && echo one > in/a.txt && seq 1 3000 > in/sub/n.txt && 7zz a -bd t.7z in > /dev/null && 7z l t.7z | grep -c "\\.txt$"; mkdir x && cd x && 7z x -bd ../t.7z > /dev/null && diff -r ../in in && echo 7z-same; cd /tmp/sz && 7zz a -bd -tzip t.zip in > /dev/null && unzip -l t.zip | grep -c "\\.txt$" && 7zz t t.zip | grep -c "Everything is Ok"; cd\n',
      /^2\s+7z-same\s+2\s+1\s*$/m, '7-Zip: 7z archive create, list, extract same files; zip readable by unzip');
    await step('7zz x -bd /root/hello.wasm; echo 7z-rc=$?\n', /7z-rc=2/, '7-Zip: not an archive (C++ exception path) exits 2');
  }
  if (hasTool('qpdf')) { // qpdf: check, linearize round trip, error on a non-PDF (C++ exceptions)
    await step('qpdf --check /root/t.pdf; mkdir -p /tmp/q && cd /tmp/q && qpdf --linearize /root/t.pdf l.pdf && qpdf --check-linearization l.pdf && qpdf --show-npages l.pdf; qpdf --check /root/hello.wasm > /dev/null 2>&1; echo q-rc=$?; cd\n',
      /No syntax or stream encoding errors found[\s\S]*no linearization errors[\s\S]*^1\s+q-rc=2/m, 'qpdf: check, linearize and check it, page count; not a PDF exits 2');
  }
  if (hasTool('imagemagick')) { // ImageMagick: PPM to PNG to JPEG, identify, pixel colour
    await step("mkdir -p /tmp/m && cd /tmp/m && printf 'P3\\n2 2\\n255\\n255 0 0 0 255 0\\n0 0 255 255 255 255\\n' > a.ppm && magick a.ppm -scale 400% b.png && od -An -c -N4 b.png && identify -format '%m %wx%h\\n' b.png && convert b.png c.jpg && magick identify -format '%m %wx%h\\n' c.jpg && magick b.png -format '%[pixel:p{7,0}]\\n' info:; cd\n",
      /P\s+N\s+G[\s\S]*^PNG 8x8\s[\s\S]*^JPEG 8x8\s+^(lime|green|srgb\(0,255,0\))\s*$/m, 'ImageMagick: PPM to PNG to JPEG (convert link warns it is deprecated), identify, pixel colour');
  }
  if (hasTool('ffmpeg')) { // ffmpeg: LGPL build; 1 s WAV made by a filter, to FLAC and back, a short MPEG-4 video
    await step('ffmpeg -hide_banner -L | grep -c "Lesser General Public"; ffmpeg -hide_banner -buildconf | grep -c enable-gpl\n', /^[1-9]\d*\s+^0\s*$/m, 'ffmpeg: LGPL build (no --enable-gpl)');
    await step('mkdir -p /tmp/f && cd /tmp/f && ffmpeg -nostdin -hide_banner -loglevel error -filter_complex "sine=frequency=440:sample_rate=8000:duration=1" t.wav && ffmpeg -nostdin -hide_banner -loglevel error -i t.wav t.flac && ffmpeg -nostdin -hide_banner -loglevel error -i t.flac -ar 16000 u.wav && stat -c %s t.wav u.wav && echo ff-done; cd\n',
      /^160\d\d\s+^3[12]\d{3}\s+ff-done/m, 'ffmpeg: WAV made by a filter, to FLAC, back to WAV at 16 kHz');
    await step('cd /tmp/f && ffmpeg -nostdin -hide_banner -loglevel error -filter_complex "color=c=red:s=32x32:d=1:r=5" -c:v mpeg4 v.mp4 && echo mp4-ok; cd\n', /mp4-ok/, 'ffmpeg: 1 s MPEG-4 video in MP4');
    if (hasTool('ffprobe')) await step('cd /tmp/f && ffprobe -v error -show_entries stream=codec_name,sample_rate -of csv=p=0 t.flac && ffprobe -v error -show_entries stream=codec_name,width,height,nb_frames -of csv=p=0 v.mp4; cd\n',
      /^flac,8000\s+^mpeg4,32,32,5\s*$/m, 'ffprobe: FLAC 8 kHz, MPEG-4 32x32 with 5 frames');
  }
  if (hasTool('sqlite')) { // SQLite: table in a .db file (dot-file locks), queried by a second run; SQL from a pipe
    await step('mkdir -p /tmp/sq && cd /tmp/sq && sqlite3 t.db "create table t(a, b); insert into t values (1, \'x\'), (2, \'y\');" && sqlite3 t.db "select sum(a) || \'-\' || group_concat(b) from t;" && echo "select 6 * 7;" | sqlite3 && [ -s t.db ] && echo db-ok; cd\n',
      /^3-x,y\s+^42\s+^db-ok/m, 'sqlite3: create, insert, query a .db file; SQL from a pipe');
  }
  if (cacheLen) { // the compiled Module is kept by file version: a program written over another one (same size, same path) runs the new one
    cwdStats.splice(0);
    await step(`mkdir -p /tmp/cm && cd /tmp/cm && cp /root/cache-a.wasm prog && chmod +x prog && ./prog --version | cut -c1-6; ./prog --version | cut -c1-6; cat /root/cache-b.wasm > prog && stat -c %s prog && ./prog --version; cd\n`,
      new RegExp(`^3\\.\\d+\\.\\d+\\s+^3\\.\\d+\\.\\d+\\s+^${cacheLen}\\s+^jq-1\\.`, 'm'), 'Module cache: sqlite3 twice, jq written over it (same size, same path) runs jq');
    const cs = cwdStats.slice(), ok = cs.length === 3 && !cs[0].hit && cs[1].hit && !cs[2].hit;
    results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ` Module cache: key hit on the 2nd run, new key after the file changed (${cs.map((e) => e.hit ? 'hit' : 'miss').join(' ')})`);
  }
  if (tools.length) { // the catalog tools are linked with wasi-libc's cwd support: wasi.js finds the pointer (no path guessing)
    const found = tools.map((t) => [t.file, !!cwdSlot(t.bytes)]), need = found.filter(([f]) => f === 'jq' || f === 'rg');
    const ok = need.length > 0 && need.every(([, s]) => s);
    results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ` wasi-libc cwd pointer found (jq, rg required): ${found.map(([f, s]) => f + (s ? '+' : '-')).join(' ')}`);
  }
  if (hasTool('jq')) { // jq: filter JSON from a pipe, @csv, bad JSON fails
    await step('echo \'{"a":[1,2,3],"b":"hi"}\' | jq -cM \'{n: (.a | add), b, k: (keys | length)}\'; echo \'[{"x":1},{"x":5}]\' | jq -r \'map(.x * 2) | @csv\'; echo \'{\' | jq . > /dev/null 2>&1; echo jq-rc=$?\n',
      /^\{"n":6,"b":"hi","k":2\}\s+^2,10\s+^jq-rc=[1-9]/m, 'jq: filter JSON from a pipe, @csv; bad JSON exits non-zero');
    // "/tmp/x.json" is the real /tmp, "tmp/y.json" the shell's folder (which has its own tmp)
    await step("printf '{\"k\":7}' > /tmp/x.json && mkdir -p /tmp/jqd/tmp && printf '{\"k\":1}' > /tmp/jqd/tmp/y.json && cd /tmp/jqd && jq -cM .k /tmp/x.json tmp/y.json; cd /tmp && jq -cM .k x.json; cd /etc && jq -cM .k /tmp/x.json; echo jq-cwd-done; cd\n",
      /^7\s+^1\s+^7\s+^7\s+^jq-cwd-done/m, 'jq: absolute path is the real root, relative path the shell folder (even a name that is also a top-level folder)');
    // the same path absolute and relative in one command: the real /tmp/z.json and the folder's ./tmp/z.json (no guessing could tell them apart)
    await step("printf '{\"k\":\"out\"}' > /tmp/z.json && mkdir -p /tmp/jq2/tmp && printf '{\"k\":\"in\"}' > /tmp/jq2/tmp/z.json && cd /tmp/jq2 && jq -cM .k /tmp/z.json ./tmp/z.json; echo jq-same-done; cd\n",
      /^"out"\s+^"in"\s+^jq-same-done/m, 'jq: /tmp/z.json and ./tmp/z.json in the same command each open the right file');
  }
  if (hasTool('ripgrep')) { // ripgrep: count, line number, list files of a folder, no match exits 1, stdin with "-"
    await step("mkdir -p /tmp/rg/s && cd /tmp/rg && printf 'alpha\\nbeta\\ngamma\\n' > s/a.txt && printf 'beta2\\n' > b.txt && rg --color never -c beta s/a.txt; rg --color never -n gam s/a.txt; rg --color never -l beta . | sort; rg --color never zzz s/a.txt; echo rg-rc=$?; printf 'x1\\ny\\n' | rg --color never x -; cd\n",
      /^1\s+^3:gamma\s+^(\.\/)?b\.txt\s+^(\.\/)?s\/a\.txt\s+^rg-rc=1\s+^x1\s*$/m, 'ripgrep: count, line number, files of a folder, no match exits 1, stdin with -');
    await step("mkdir -p /tmp/rg/etc && printf 'root-here\\n' > /tmp/rg/etc/f.txt && cd /tmp/rg && rg --color never -l root-here etc; rg --color never -l '^root:' /etc | grep -x /etc/passwd; cd /etc && rg --color never -c '^root:' /etc/passwd passwd | sort; rg --color never -l '^root:x' /etc | grep -x /etc/passwd; echo rg-cwd-done; cd\n",
      /^etc\/f\.txt\s+^\/etc\/passwd\s+^\/etc\/passwd:1\s+^passwd:1\s+^\/etc\/passwd\s+^rg-cwd-done/m, 'ripgrep: relative folder named like a top-level one is the shell folder; absolute paths are the real root, in /etc too');
    // real cwd: no path lists the shell folder (relative names); /etc/passwd and ./etc/passwd in one command are two files
    await step("rm -rf /tmp/rq && mkdir -p /tmp/rq/etc/d && cd /tmp/rq && printf 'root:x:0\\nroot:x:0\\n' > etc/passwd && printf 'xmark\\n' > a.txt && printf 'xmark\\n' > etc/d/b.txt && rg --color never -l xmark | sort; rg --color never -c '^root:x:0' /etc/passwd ./etc/passwd; cd /tmp && rg --color never -l xmark /etc/passwd ./rq/a.txt; echo rg-same-done; cd\n",
      /^(\.\/)?a\.txt\s+^(\.\/)?etc\/d\/b\.txt\s+^\/etc\/passwd:1\s+^\.\/etc\/passwd:2\s+^\.\/rq\/a\.txt\s+^rg-same-done/m, 'ripgrep: lists the shell folder relative to it; absolute and relative paths in the same command each go to the right place');
  }
  if (hasTool('sed') && hasTool('findutils') && hasTool('onetrue-awk')) { // item 67: uutils sed, uutils find, one-true-awk (WebAssembly, ahead of busybox in PATH)
    await step(`cd /tmp && printf 'a b\\nc d\\ne f\\n' > sed-in.txt && sed -E 's/(\\w) (\\w)/\\2 \\1/' sed-in.txt | busybox tr '\\n' ,; echo; sed -n 2p sed-in.txt; sed -i 's/e/E/' sed-in.txt && busybox cat sed-in.txt | busybox tr '\\n' ,; echo; printf 'x\\n' | sed 's/x/y/;s/y/z/'; sed p nofile-sed; echo sed-rc=$?; echo sed-done\n`,
      /^b a,d c,f e,\s+^c d\s+^a b,c d,E f,\s+^z\s+.*nofile-sed.*\s+^sed-rc=[1-9]\s+^sed-done/m, 'sed: -E, -n, -i on a relative path in the shell folder, two commands, error exit code');
    await step(`cd /tmp && printf '1,x\\n2,y\\n3,x\\n' > awk-in.csv && awk -F, '{s += $1; c[$2]++} END {print s, c["x"], length("hello"), toupper("ab")}' awk-in.csv; printf 'a b c\\n' | awk '{print $2, NF; printf "%5.2f|%d\\n", 3.14159, "12ab"}'; awk 'BEGIN { exit 3 }'; echo awk-rc=$?; echo awk-done\n`,
      /^6 2 5 AB\s+^b 3\s+^ 3\.14\|12\s+^awk-rc=3\s+^awk-done/m, 'awk: -F, sums and arrays on a relative file, length, fields, printf, exit status');
    await step(`cd /tmp && rm -rf ft && mkdir -p ft/a/b ft/c && touch ft/a/one.txt ft/a/b/two.txt ft/c/three.log && find ft -name '*.txt' | sort | busybox tr '\\n' ' '; echo; find ft -type d | sort | busybox tr '\\n' ' '; echo; find ft -type f | busybox wc -l; find /tmp/ft -name 'three*' ; cd ft && find . -name '*.log'; cd; echo find-done\n`,
      /^ft\/a\/b\/two\.txt ft\/a\/one\.txt\s+^ft ft\/a ft\/a\/b ft\/c\s+^3\s+^\/tmp\/ft\/c\/three\.log\s+^\.\/c\/three\.log\s+^find-done/m, 'find: -name, -type d/f, relative and absolute paths, from inside a folder');
  }
  if (hasTool('tar') && hasTool('gzip') && hasTool('xz')) { // item 68: bsdtar (libarchive), gzip (zlib) and xz (liblzma), WebAssembly, ahead of busybox in PATH; busybox is the other side of every round trip
    const seq = (n) => { let t = ''; for (let i = 1; i <= n; i++) t += i + '\n'; return t; };
    const md5 = (t) => crypto.createHash('md5').update(t).digest('hex');
    const E = (l) => (l instanceof RegExp ? l.source : l.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'));
    const lines = (...ls) => new RegExp(ls.map(E).join('\\s+^'), 'm'); // consecutive output lines, literal text or a RegExp
    await step(`for c in gzip gunzip zcat tar xz unxz xzcat; do command -v $c; done | busybox tr '\\n' ' '; echo; cd /tmp && rm -rf gz1 && mkdir gz1 && cd gz1 && busybox seq 1 50000 > a.txt && busybox cp a.txt b.txt && gzip a.txt && busybox ls a.txt* | busybox tr '\\n' ' '; echo; gzip -t a.txt.gz && echo t-ok; gunzip -c a.txt.gz | busybox md5sum | busybox cut -c1-32; gzip -k b.txt && busybox ls b.txt* | busybox tr '\\n' ' '; echo; gzip -l b.txt.gz | busybox tail -1 | busybox awk '{print $2}'; echo gz-done\n`,
      lines('/usr/local/bin/gzip /usr/local/bin/gunzip /usr/local/bin/zcat /usr/local/bin/tar /usr/local/bin/xz /usr/local/bin/unxz /usr/local/bin/xzcat ', 'a.txt.gz ', 't-ok', md5(seq(50000)), 'b.txt b.txt.gz ', String(seq(50000).length), 'gz-done'),
      'gzip: gzip a.txt (file removed), -t, gunzip -c, -k, -l; the links are in /usr/local/bin before busybox');
    await step(`cd /tmp/gz1 && printf 'x\\n' | timeout 20 gzip -c | busybox gunzip -c; echo gz-pipe1-rc=$?\n`, lines('x', 'gz-pipe1-rc=0'), 'gzip: stdin to stdout, read back by busybox');
    await step(`cd /tmp/gz1 && printf 'y\\n' | busybox gzip -c | timeout 20 gunzip -c; echo gz-pipe2-rc=$?\n`, lines('y', 'gz-pipe2-rc=0'), 'gunzip: busybox gzip from a pipe');
    await step(`cd /tmp/gz1 && busybox gzip -c b.txt > m1.gz; timeout 20 gzip -c b.txt > m2.gz; busybox cat m1.gz m2.gz | timeout 20 zcat | busybox wc -l; echo notgz > n.gz; timeout 20 gunzip n.gz; echo gz-bad-rc=$?; busybox head -c 100 b.txt.gz > t.gz; timeout 20 gzip -t t.gz; echo gz-trunc-rc=$?\n`,
      lines('100000', /.*not in gzip format/, 'gz-bad-rc=1', /.*unexpected end of file/, 'gz-trunc-rc=1'), 'gzip: two members, not-gzip and truncated input fail with exit 1');
    await step(`cd /tmp/gz1 && timeout 20 gzip -9 -c b.txt | busybox gunzip | busybox wc -l; cd /tmp; timeout 20 gzip -c gz1/b.txt | busybox gunzip | busybox wc -l; echo gz2-done\n`, lines('50000', '50000', 'gz2-done'), 'gzip: -9, relative path from /tmp');
    await step(`cd /tmp && rm -rf xz1 && mkdir xz1 && cd xz1 && busybox seq 1 100000 > a.txt && busybox cp a.txt b.txt && xz -k a.txt && busybox ls a.txt* | busybox tr '\\n' ' '; echo; xz -t a.txt.xz && echo xt-ok; busybox xz -dc a.txt.xz | busybox md5sum | busybox cut -c1-32; unxz -c a.txt.xz | busybox wc -l; xzcat a.txt.xz | busybox head -2 | busybox tr '\\n' ,; echo; xz --format=lzma -c b.txt | busybox unlzma | busybox wc -l; xz -c b.txt | xz -dc | busybox md5sum | busybox cut -c1-32; busybox cp b.txt c.txt && xz c.txt && unxz c.txt.xz && busybox cmp b.txt c.txt && echo unxz-same; echo junk > j.xz; xz -t j.xz; echo xz-bad-rc=$?; xz -dc nofile-xz; echo xz-nofile-rc=$?; echo xz-done\n`,
      lines('a.txt a.txt.xz ', 'xt-ok', md5(seq(100000)), '100000', '1,2,', '100000', md5(seq(100000)), 'unxz-same', /.*j\.xz.*/, 'xz-bad-rc=1', /.*nofile-xz.*/, 'xz-nofile-rc=1', 'xz-done'),
      'xz: compress -k, -t, busybox reads our .xz, unxz, xzcat, .lzma, pipe round trip, bad and missing input exit 1');
    await step(`cd /tmp && rm -rf tr1 && mkdir -p tr1/src/a/b tr1/src/c && cd tr1 && printf 'hello\\n' > src/a/one.txt && busybox seq 1 3000 > src/a/b/two.txt && printf 'x\\n' > src/c/three.log && ln -s a/one.txt src/sl && tar -cf t.tar src && busybox tar -tf t.tar | busybox grep -v '/$' | busybox sort | busybox tr '\\n' ' '; echo; busybox tar -cf b.tar src && tar -tf b.tar | busybox grep -v '/$' | busybox sort | busybox tr '\\n' ' '; echo; busybox mkdir x1 x2 && tar -xf t.tar -C x1 && tar -xf b.tar -C x2 && busybox diff -r src x1/src && echo same1; busybox diff -r src x2/src && echo same2; busybox readlink x1/src/sl; busybox readlink x2/src/sl; echo tar-done\n`,
      lines('src/a/b/two.txt src/a/one.txt src/c/three.log src/sl ', 'src/a/b/two.txt src/a/one.txt src/c/three.log src/sl ', 'same1', 'same2', 'a/one.txt', 'a/one.txt', 'tar-done'),
      'tar: create a tree (relative paths), busybox lists it; busybox creates, tar lists and extracts both; folders, files and a symlink are identical');
    await step(`cd /tmp/tr1 && tar -czf t.tgz src && busybox tar -tzf t.tgz | busybox wc -l; tar -cJf t.txz src && tar -tJf t.txz | busybox wc -l; busybox mkdir y1 y2 y3 y4 && tar -xzf t.tgz -C y1 && busybox diff -r src y1/src && echo same-z; tar -xJf t.txz -C y2 && busybox diff -r src y2/src && echo same-J; busybox cat t.tar | tar -xf - -C y3 && busybox diff -r src y3/src && echo same-stdin; tar -cf - -C src a | busybox tar -xf - -C y4 && busybox cat y4/a/one.txt; tar -xf t.tar -C y4 --strip-components=1 src/c; busybox ls y4 | busybox tr '\\n' ' '; echo; tar -tf nofile-tar >/dev/null 2>&1; echo tar-rc=$?; echo junk > j.tar; tar -tf j.tar >/dev/null 2>&1; echo tar-bad-rc=$?; echo tar2-done\n`,
      lines('8', '8', 'same-z', 'same-J', 'same-stdin', 'hello', 'a c ', 'tar-rc=1', 'tar-bad-rc=1', 'tar2-done'),
      'tar: -z and -J in the process, busybox reads them back, stdin and stdout, -C, --strip-components, a missing or non-tar file exits 1');
  }
  if (hasTool('bzip2') && hasTool('zstd')) { // item 70: bzip2 (libbz2) and zstd (libzstd), WebAssembly, ahead of busybox in PATH; busybox bzip2 is the other side of the round trips (it has no zstd)
    const seq = (n) => { let t = ''; for (let i = 1; i <= n; i++) t += i + '\n'; return t; };
    const md5 = (t) => crypto.createHash('md5').update(t).digest('hex');
    const E = (l) => (l instanceof RegExp ? l.source : l.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'));
    const lines = (...ls) => new RegExp(ls.map(E).join('\\s+^'), 'm');
    await step(`for c in bzip2 bunzip2 bzcat zstd unzstd zstdcat; do command -v $c; done | busybox tr '\\n' ' '; echo; cd /tmp && rm -rf bz1 && mkdir bz1 && cd bz1 && busybox seq 1 50000 > a.txt && busybox cp a.txt b.txt && bzip2 a.txt && busybox ls a.txt* | busybox tr '\\n' ' '; echo; bzip2 -t a.txt.bz2 && echo t-ok; busybox bunzip2 -c a.txt.bz2 | busybox md5sum | busybox cut -c1-32; bunzip2 -c a.txt.bz2 | busybox md5sum | busybox cut -c1-32; bzcat a.txt.bz2 | busybox wc -l; bzip2 -k b.txt && busybox ls b.txt* | busybox tr '\\n' ' '; echo; busybox bzip2 -c b.txt | bunzip2 | busybox md5sum | busybox cut -c1-32; bzip2 -c b.txt | busybox bunzip2 | busybox wc -l; echo notbz > n.bz2; bunzip2 n.bz2 2>/dev/null; echo bz-bad-rc=$?; busybox head -c 100 b.txt.bz2 | bzcat 2>/dev/null > /dev/null; echo bz-trunc-rc=$?; echo bz-done\n`,
      lines('/usr/local/bin/bzip2 /usr/local/bin/bunzip2 /usr/local/bin/bzcat /usr/local/bin/zstd /usr/local/bin/unzstd /usr/local/bin/zstdcat ', 'a.txt.bz2 ', 't-ok', md5(seq(50000)), md5(seq(50000)), '50000', 'b.txt b.txt.bz2 ', md5(seq(50000)), '50000', 'bz-bad-rc=2', 'bz-trunc-rc=2', 'bz-done'),
      'bzip2: compress, -t, busybox reads our .bz2 and we read busybox\'s, bunzip2, bzcat, -k, pipe round trip; the links are in /usr/local/bin before busybox; bad and truncated input fail');
    await step(`cd /tmp && rm -rf zs1 && mkdir zs1 && cd zs1 && busybox seq 1 100000 > a.txt && busybox cp a.txt b.txt && zstd -q a.txt && busybox ls a.txt* | busybox tr '\\n' ' '; echo; zstd -tq a.txt.zst && echo zt-ok; zstd -dc a.txt.zst | busybox md5sum | busybox cut -c1-32; unzstd -c a.txt.zst | busybox wc -l; zstdcat a.txt.zst | busybox head -2 | busybox tr '\\n' ,; echo; zstd -q -1 -c b.txt | zstd -dc | busybox md5sum | busybox cut -c1-32; zstd -q -19 -c b.txt | unzstd | busybox wc -l; busybox cp b.txt c.txt && zstd -q --rm c.txt && unzstd -q --rm c.txt.zst && busybox cmp b.txt c.txt && echo unzstd-same; echo junk > j.zst; zstd -tq j.zst 2>/dev/null; echo zst-bad-rc=$?; zstd -dc nofile-zst 2>/dev/null; echo zst-nofile-rc=$?; echo zst-done\n`,
      lines('a.txt a.txt.zst ', 'zt-ok', md5(seq(100000)), '100000', '1,2,', md5(seq(100000)), '100000', 'unzstd-same', 'zst-bad-rc=1', 'zst-nofile-rc=1', 'zst-done'),
      'zstd: compress (source removed), -t, -d, unzstd, zstdcat, levels 1 and 19, --rm round trip, bad and missing input exit 1');
  }
  if (hasTool('bc')) { // item 72: Gavin Howard's bc (bc and dc are one program, picked by argv[0]), WebAssembly, ahead of busybox in PATH
    const E = (l) => l.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
    const lines = (...ls) => new RegExp(ls.map(E).join('\\s+^'), 'm');
    await step(`for c in bc dc; do command -v $c; done | busybox tr '\\n' ' '; echo; echo 'scale=50; 4*a(1)' | bc -l; echo 2^100 | bc; echo '2 100 ^ p' | dc; bc -e 'scale=5; 1/3'; echo 'define f(n){ if(n<2) return 1; return n*f(n-1) }; f(20)' | bc; echo 'sqrt(16' | bc > /dev/null 2>&1 || echo bc-bad-ok; echo bc-done\n`,
      lines('/usr/local/bin/bc /usr/local/bin/dc ', '3.14159265358979323846264338327950288419716939937508', '1267650600228229401496703205376', '1267650600228229401496703205376', '.33333', '2432902008176640000', 'bc-bad-ok', 'bc-done'),
      'bc: -l with a(), exponent, dc by its name, -e, functions, a syntax error exits non-zero; the links are in /usr/local/bin before busybox');
  }
  if (hasTool('file')) { // item 72: file/libmagic, the compiled magic database is inside the program
    const E = (l) => l.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
    const lines = (...ls) => new RegExp(ls.map(E).join('\\s+^'), 'm');
    await step(`command -v file; cd /tmp && rm -rf fl1 && mkdir fl1 && cd fl1 && printf 'hello text\\n' > t.txt && printf '\\211PNG\\r\\n\\032\\n\\0\\0\\0\\rIHDR\\0\\0\\0\\020\\0\\0\\0\\020\\010\\002\\0\\0\\0' > p.png && busybox gzip -c t.txt > g.gz && busybox cp /bin/busybox elf && printf '#!/bin/sh\\necho hi\\n' > s.sh; file -b t.txt; file -b p.png; file -b g.gz | busybox cut -d, -f1; file -b elf | busybox cut -c1-3; file -bi t.txt; file -b s.sh | busybox cut -d, -f1; file -b - < t.txt; file t.txt p.png | busybox tr '\\n' '|'; echo; file nonexist.x 2>&1 | busybox cut -c1-24; echo file-done\n`,
      lines('/usr/local/bin/file', 'ASCII text', 'PNG image data, 16 x 16, 8-bit/color RGB, non-interlaced', 'gzip compressed data', 'ELF', 'text/plain; charset=us-ascii', 'POSIX shell script', 'ASCII text', 't.txt: ASCII text|p.png: PNG image data, 16 x 16, 8-bit/color RGB, non-interlaced|', 'nonexist.x: cannot open ', 'file-done'),
      'file: a text file, PNG, gzip, ELF, shell script, -b, -i (MIME), stdin, several files, a missing file (magic database built in)');
  }
  if (hasTool('hashtools')) { // md5sum, sha1sum, sha224/256/384/512sum, b2sum (one WebAssembly program, picked by its name)
    const abc = Buffer.from('abc');
    await step(`cd /tmp && printf abc > abc.txt && for h in ${HASHES.map(([h]) => h).join(' ')}; do \${h}sum abc.txt; done; printf abc | sha256sum; sha256sum --tag abc.txt; b2sum -l 256 --tag abc.txt; echo abc-done; cd\n`,
      new RegExp(HASHES.map(([, a]) => `^${dig(a, abc)}  abc\\.txt\\s+`).join('') + `^${dig('sha256', abc)}  -\\s+^SHA256 \\(abc\\.txt\\) = ${dig('sha256', abc)}\\s+^BLAKE2b-256 \\(abc\\.txt\\) = [0-9a-f]{64}\\s+^abc-done`, 'm'),
      'hashtools: md5, sha1, sha224, sha256, sha384, sha512, b2 of "abc" match node; stdin; --tag; b2sum -l 256');
    await step(`cd /root && for h in ${HASHES.map(([h]) => h).join(' ')}; do \${h}sum h8.bin; done; [ "$(sha256sum < h8.bin)" = "$(busybox sha256sum < h8.bin)" ] && [ "$(md5sum h8.bin)" = "$(busybox md5sum h8.bin)" ] && echo bb-same; cd\n`,
      new RegExp(HASHES.map(([, a]) => `^${dig(a, h8)}  h8\\.bin\\s+`).join('') + '^bb-same', 'm'),
      'hashtools: the 8 MB file (1 MB reads) matches node for every hash, and busybox sha256sum/md5sum byte for byte');
    await step('cd /tmp && sha256sum abc.txt /root/h8.bin > s.sum && sha256sum -c s.sum && b2sum --tag abc.txt | b2sum -c && echo x >> abc.txt && sha256sum -c s.sum; echo c-rc=$?; sha256sum --status -c s.sum; echo st-rc=$?; md5sum nofile; echo nf-rc=$?; cd\n',
      /^abc\.txt: OK\s+^\/root\/h8\.bin: OK\s+^abc\.txt: OK\s+^abc\.txt: FAILED\s+^\/root\/h8\.bin: OK[\s\S]*WARNING: 1 computed checksum did NOT match\s+^c-rc=1\s+^st-rc=1\s+^md5sum: nofile: No such file or directory\s+^nf-rc=1/m,
      'hashtools: sha256sum -c (OK, FAILED, warning, exit 1), --status, b2sum -c of a --tag line, missing file');
  }
  if (cu) { // uutils coreutils: install from a local catalog entry (the real links), compare with busybox, then remove
    const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await step('sudo sh -c "cat /root/cucat.txt >> /etc/inksoc/wasm-catalog.local"\n', /Password/, 'coreutils: local catalog entry (sudo asks)');
    await step('pw1\n', /tester@inksoc/, 'coreutils: local catalog entry written');
    await step('apk add --no-network coreutils; echo cu-add-rc=$?\n', /Password/, 'coreutils: apk add asks sudo');
    await step('pw1\n', /OK: coreutils installed[\s\S]*cu-add-rc=0/, 'coreutils: apk add installs the multicall program and its links');
    const linked = ['sort', 'wc', 'cut', 'tr', 'uniq', 'paste', 'od', 'seq', 'join'];
    await step(`hash -r; for n in ${linked.join(' ')} sh cat; do command -v $n; done; coreutils ls --version | head -n 1; coreutils --help | busybox grep -c ls; echo cu-res\n`,
      new RegExp(linked.map((n) => '^/usr/local/bin/' + n + '\\s+').join('') + '^/bin/sh\\s+^/bin/cat\\s+ls \\(uutils coreutils\\) 0\\.8\\.0[\\s\\S]*cu-res', 'm'),
      'coreutils: PATH picks the linked WebAssembly programs, sh and cat stay busybox, multicall form "coreutils ls" works');
    await step(`cd /tmp && rm -rf cu && mkdir cu && cd cu && busybox seq 1 3000 | busybox awk '{printf "%d w%d\\n", ($1*7919)%1009, $1%37}' > d.txt && echo made-$(busybox wc -l < d.txt)\n`, /made-3000/, 'coreutils: test data');
    // the first ones must match busybox byte for byte; the others only print (formats may differ)
    const crit = ['sort d.txt', 'sort -n d.txt', 'sort -u d.txt', 'cut -d" " -f2 d.txt', 'tr a-z A-Z < d.txt', 'seq 3 3 30', 'wc -l < d.txt', 'wc -c < d.txt', 'uniq -c d.txt', 'paste d.txt d.txt'];
    const more = ['sort -k2,2 -s d.txt', 'sort -nr d.txt', 'tr -d 0-4 < d.txt', 'nl d.txt', 'fold -w 3 d.txt', 'expand d.txt', 'comm d.txt d.txt', 'od -c d.txt', 'head -n 7 d.txt', 'tail -n 7 d.txt', 'cat -n d.txt', 'tail -n +2990 d.txt', 'basename /a/b/c.txt .txt', 'dirname /a/b/c.txt', 'wc d.txt'];
    {
      const before = out.length;
      await step(`for c in ${[...crit, ...more].map((c) => `'${c}'`).join(' ')}; do a=$(eval "coreutils $c" | busybox md5sum); b=$(eval "busybox $c" | busybox md5sum); [ "$a" = "$b" ] && echo "same: $c" || echo "DIFF: $c"; done; echo cmp-done\n`,
        new RegExp(crit.map((c) => '^same: ' + esc(c) + '\\s+').join('') + '[\\s\\S]*cmp-done', 'm'), 'coreutils: sort, sort -n/-u, cut, tr, seq, wc, uniq -c, paste give the same bytes as busybox');
      console.log(out.slice(before).split('\n').filter((l) => /^(same|DIFF): /.test(l.trim())).map((l) => '  ' + l.trim()).join('\n'));
    }
    {
      const before = out.length;
      await step('cd /tmp/cu && C=coreutils; $C mkdir -p a/b/c; echo hi > a/f1; $C cp a/f1 a/b/f2; echo cp=$?; $C cp -r a a2; echo cp-r=$?; $C mv a2 a3; echo mv=$?; $C ln -s f1 a/sl; echo ln-s=$?; $C ln a/f1 a/hl; echo ln=$?; $C touch a/new; echo touch=$?; $C ls a | busybox tr "\\n" " "; echo; $C ls -R a3 | busybox tr "\\n" " "; echo; $C ls -l a/f1; $C readlink a/sl; echo info1-done\n', /info1-done/, 'coreutils: file operations by "coreutils NAME" (information only)');
      console.log('  ' + out.slice(before).split('\n').slice(0, 24).join('\n  '));
    }
    {
      const before = out.length;
      await step('cd /tmp/cu && C=coreutils; $C rm -r a3; echo rm-r=$?; $C ls a3; $C rmdir a/b/c; echo rmdir=$?; $C truncate -s 5000 a/t; busybox stat -c %s a/t; $C cp -p a/f1 a/p; echo cp-p=$?; $C touch -d 2020-01-02 a/f1; echo touch-d=$?; busybox stat -c %h a/f1; $C ls -la a | busybox head -n 5; echo info2-done\n', /info2-done/, 'coreutils: more file operations (information only)');
      console.log('  ' + out.slice(before).split('\n').slice(0, 24).join('\n  '));
    }
    await step(`cd /tmp/cu && busybox seq 1 300000 > big.txt && wc -l < big.txt && sort -nr big.txt | busybox head -n 2 | busybox tr '\\n' ' '; echo; [ "$(sort big.txt | busybox md5sum)" = "$(busybox sort big.txt | busybox md5sum)" ] && echo sort-same; printf 'b\\na\\nb\\n' | sort | uniq -c; sort /nonexistent; echo rc=$?; wc /nonexistent; echo rc=$?; cd\n`,
      /^300000\s+300000 299999 \s+sort-same\s+^\s*1 a\s+^\s*2 b\s+sort: .*nonexistent.*No such file or directory\s+rc=2\s+wc: .*nonexistent.*No such file or directory\s+rc=1/m,
      'coreutils: 300000 lines (sort -nr, sort vs busybox byte for byte), stdin pipe, error messages and exit codes');
    await step('apk del coreutils; echo cu-del-rc=$?\n', /Password/, 'coreutils: apk del asks sudo');
    await step('pw1\n', /\(coreutils\) WebAssembly build removed[\s\S]*cu-del-rc=0/, 'coreutils: apk del removes the links');
    await step('hash -r; command -v sort; ls /usr/local/bin/sort 2>&1 | head -n 1; echo cu-gone\n', /\/bin\/sort\s+ls: \/usr\/local\/bin\/sort: No such file or directory\s+cu-gone/, 'coreutils: busybox sort is back in PATH');
  }
  if (hasTool('quickjs')) { // QuickJS-ng (item 57): -e, a script file, qjs:std / qjs:os reading a file of the shell folder, JSON of ~3 MB, errors exit 1
    await step(`cd /tmp && qjs -e 'print(1+1)'; qjs --version | head -n 1; printf '%s\\n' 'import * as std from "qjs:std";' 'import * as os from "qjs:os";' 'const t = std.loadFile("in.txt");' 'print("qjs-file", t.trim(), os.getcwd()[0], scriptArgs.slice(-2).join(","));' > s.js && echo kjs-in > in.txt && qjs s.js a b; echo qjs-s-done; cd\n`,
      /^2\s+^\d+\.\d+\.\d+\s+^qjs-file kjs-in \S+ a,b\s+^qjs-s-done/m, 'quickjs: -e, --version, script with qjs:std loadFile and qjs:os getcwd on a relative path (the shell folder)');
    await step(`cd /tmp && qjs --std -e 'const a = []; for (let i = 0; i < 60000; i++) a.push({ id: i, name: "n" + i, t: [1, 2, 3], ok: i % 2 == 0 }); const f = std.open("big.json", "w"); f.puts(JSON.stringify(a)); f.close()'; busybox wc -c < big.json | busybox awk '{print "big", ($1 > 2000000)}'; printf '%s\\n' '(function () { const t = std.loadFile("big.json"); const a = JSON.parse(t); let n = 0; for (const o of a) n += o.t[2] + (o.ok ? 1 : 0); print("json", a.length, a[59999].name, n); })()' > j.js && qjs --std j.js; qjs -e 'throw new Error("boom")' 2> /dev/null; echo qjs-rc=$?; cd\n`,
      /^big 1\s+^json 60000 n59999 210000\s+^qjs-rc=1/m, 'quickjs: JSON.stringify/parse of a ~3 MB file written and read in the shell folder, uncaught error exits 1');
  }
  if (hasTool('lua5.4')) { // Lua: script file, pcall/error (setjmp/longjmp), uncaught error exits 1
    await step('printf \'%s\\n\' \'local t = {}\' \'for i = 1, 10 do t[#t + 1] = i * i end\' \'print("lua-ok", #t, t[10], _VERSION, pcall(error, "boom"))\' > /tmp/t.lua && lua /tmp/t.lua; lua5.4 -e "error(\'x\')" 2> /dev/null; echo lua-rc=$?\n',
      /lua-ok\s+10\s+100\s+Lua 5\.4\s+false\s+boom[\s\S]*lua-rc=1/, 'lua: script, pcall/error, uncaught error exits 1');
  }
  if (hasTool('zip') && hasTool('unzip')) { // Info-ZIP: zip a folder, list, extract, compare, test
    await step('mkdir -p /tmp/iz/in/sub && cd /tmp/iz && echo one > in/a.txt && seq 1 3000 > in/sub/n.txt && zip -qr t.zip in && unzip -l t.zip | grep -c "\\.txt$" && mkdir x && cd x && unzip -q ../t.zip && diff -r ../in in && echo zip-same; cd /tmp/iz && unzip -tq t.zip; cd\n',
      /^2\s+zip-same\s+No errors detected/m, 'zip/unzip: zip a folder, list, extract same files, test archive');
    await step('mkdir -p /tmp/zb && cd /tmp/zb && unzip -o /root/bomb.zip; echo uz-rc=$?; cd\n',
      /overlapped components \(possible zip bomb\)[\s\S]*uz-rc=12/, 'unzip: rejects a zip with overlapped entries (CVE-2019-13232 patch)');
  }
  // inkvideo: WebCodecs of the page (node has none): exit 69 and a clear message; decode falls back to ffmpeg
  await step('inkvideo info; echo iv-rc=$?; inkvideo transcode a.mov b.h264; echo iv-rc=$?; inkvideo bogus 2>&1 | head -1; inkvideo; echo iv-rc=$?\n',
    /WebCodecs: no[\s\S]*fallback: [\s\S]*iv-rc=69[\s\S]*needs WebCodecs[\s\S]*iv-rc=69[\s\S]*unknown command: bogus[\s\S]*usage: inkvideo info[\s\S]*iv-rc=2/, 'inkvideo: no WebCodecs here -> exit 69 with a clear message; usage');
  if (hasTool('ffmpeg')) await step('cd /tmp/f && inkvideo decode v.mp4 v.y4m; echo iv-rc=$?; head -1 v.y4m | cut -c1-17; h=$(head -1 v.y4m | wc -c); echo iv-frames=$(( ($(stat -c %s v.y4m) - h) / 1542 )); cd\n',
    /using ffmpeg[\s\S]*iv-rc=0[\s\S]*YUV4MPEG2 W32 H32[\s\S]*iv-frames=5/, 'inkvideo: decode falls back to ffmpeg (Y4M, 5 frames)');
} else console.log('(engine without WebAssembly programs: published engine.wasm older than the kernel source)');
await step('trap "echo caught-usr1" USR1; kill -USR1 $$\n', /caught-usr1/, 'shell trap');
await step('(nc -l -p 8098 > /tmp/nc.txt &) ; sleep 0.3; echo over-nc | nc 127.0.0.1 8098; sleep 0.3; cat /tmp/nc.txt\n', /^over-nc/m, 'nc server and client on this machine');
if (x.linux_save_next) { // big files: 4 KB blocks in swap slots (lxdata.rs), not in the engine's heap
  const MB = 1048576, h0 = x.heap_used();
  await step('dd if=/dev/zero of=/tmp/z bs=1M count=3 2>/dev/null; printf ABC | dd of=/tmp/z bs=1 seek=2000000 conv=notrunc 2>/dev/null; dd if=/tmp/z bs=1 skip=1999999 count=5 2>/dev/null | od -c; stat -c %s /tmp/z; truncate -s 4000 /tmp/z; stat -c %s /tmp/z; truncate -s 2000002 /tmp/z; dd if=/tmp/z bs=1 skip=1999999 count=3 2>/dev/null | od -c; rm /tmp/z\n',
    /\\0\s+A\s+B\s+C\s+\\0[\s\S]*^3145728\s[\s\S]*^4000\s[\s\S]*\\0\s+\\0\s+\\0/m, 'file in blocks: write in the middle, read back, shrink, grow with zeros');
  // cp (sendfile) shares the blocks (copy-on-write): changing a copy leaves the original as it was
  await step('dd if=/dev/urandom of=/tmp/c1 bs=1M count=3 2>/dev/null; printf tail >> /tmp/c1; s0=$(md5sum < /tmp/c1); cp /tmp/c1 /tmp/c2; cp /tmp/c1 /tmp/c3; printf XYZ | dd of=/tmp/c2 bs=1 seek=70000 conv=notrunc 2>/dev/null; truncate -s 100000 /tmp/c3; echo abc >> /tmp/c3; [ "$s0" = "$(md5sum < /tmp/c1)" ] && echo orig-same; cmp -s /tmp/c1 /tmp/c2 || echo copy-differs; dd if=/tmp/c2 bs=1 skip=70000 count=3 2>/dev/null; echo; stat -c %s /tmp/c2 /tmp/c3; dd if=/tmp/c3 bs=1 skip=100000 count=4 2>/dev/null | od -c | head -1; rm /tmp/c1 /tmp/c2 /tmp/c3\n',
    /orig-same[\s\S]*copy-differs[\s\S]*XYZ[\s\S]*^3145732\s+^100004\s[\s\S]*a\s+b\s+c\s+\\n/m, 'copies share blocks: changing the copy (write, truncate, append) keeps the original');
  // ln: a hard link is the same file (inode): same st_ino, st_nlink counts names, a change by one name shows
  // by the other, removing one name keeps the file; small file (in memory) and one in blocks (> 1 MB)
  await step('mkdir -p /tmp/hl && cd /tmp/hl; rm -f f g h; echo a > f; ln f g; echo hl1:$(stat -c "%i %h" f g); echo b >> g; echo hl2:$(cat f); mv g h; echo hl3:$(stat -c %h f); rm f; echo hl4:$(cat h):$(stat -c %h h); rm h; cd\n',
    /hl1:(\d+) 2 \1 2\s[\s\S]*hl2:a b\s[\s\S]*hl3:2\s[\s\S]*hl4:a b:1\s/, 'hard link (small file): same inode, nlink 2, append by one name seen by the other, rm one keeps it');
  await step('dd if=/dev/urandom of=/tmp/B1 bs=1M count=2 2>/dev/null; ln /tmp/B1 /tmp/B2; echo bh1:$(stat -c "%i %h" /tmp/B1 /tmp/B2); printf XYZ | dd of=/tmp/B2 bs=1 seek=1500000 conv=notrunc 2>/dev/null; echo bh2:$(dd if=/tmp/B1 bs=1 skip=1500000 count=3 2>/dev/null); truncate -s 5 /tmp/B1; echo bh3:$(stat -c %s /tmp/B2); rm /tmp/B1; echo bh4:$(stat -c "%s %h" /tmp/B2); rm /tmp/B2\n',
    /bh1:(\d+) 2 \1 2\s[\s\S]*bh2:XYZ\s[\s\S]*bh3:5\s[\s\S]*bh4:5 1\s/, 'hard link (file in blocks): same inode, write and truncate by one name seen by the other');
  // kept in the saved tar (type 1): restored as one file with two names (hl0 sorts before its file hl1)
  await step('echo keep > ~/hl1; ln ~/hl1 ~/hl0; echo hs:$(stat -c %h ~/hl0)\n', /hs:2\s/, 'hard link made for the saved tar');
  await step('dd if=/dev/urandom of=/tmp/big bs=1M count=64 2>/dev/null; sha256sum /tmp/big; cp /tmp/big ~/big2; sha256sum ~/big2; stat -c %s ~/big2; rm /tmp/big; echo big-done\n',
    /^([0-9a-f]{64})  \/tmp\/big\s[\s\S]*^\1  \/home\/tester\/big2\s[\s\S]*^67108864\s[\s\S]*big-done/m, 'big file (64 MB, more than the 24 MB RAM pool): write, copy, same sha256');
  const sum = (out.match(/^([0-9a-f]{64})  \/home\/tester\/big2/m) || [])[1];
  const grow = (x.heap_used() - h0) / MB;
  results.push(grow < 16); console.log((grow < 16 ? 'PASS' : 'FAIL') + ` big file: engine heap grew ${grow.toFixed(1)} MB (heap ${(x.heap_used() / MB).toFixed(1)} MB)`);
  if (x.linux_mount_data) { // a big device file is read in pieces (File.slice on the page), never whole in the engine
    const big = crypto.randomBytes(64 * MB), want = crypto.createHash('sha256').update(big).digest('hex'), h1 = x.heap_used();
    for (const n of ['big.bin', 'mid.bin', 'w.bin']) devBig.set('/mnt/b/' + n, big);
    const eb = Buffer.from(big); devBig.set('/mnt/b/e.bin', eb); // its own copy: the page's write back is applied to it below
    put(enc.encode('/mnt/b\nF\t/mnt/b/big.bin\t' + big.length + '\nF\t/mnt/b/mid.bin\t' + big.length + '\nF\t/mnt/b/w.bin\t' + big.length + '\nF\t/mnt/b/e.bin\t' + big.length)); x.linux_mount();
    const hex = (o, n) => [...big.subarray(o, o + n)].map((c) => c.toString(16).padStart(2, '0')).join('\\s+');
    await step('stat -c %s /mnt/b/big.bin; sha256sum /mnt/b/big.bin; dd if=/mnt/b/mid.bin bs=1 skip=40000003 count=8 2>/dev/null | od -An -tx1; printf Z | dd of=/mnt/b/w.bin bs=1 seek=3 conv=notrunc 2>/dev/null; dd if=/mnt/b/w.bin bs=1 skip=60000000 count=4 2>/dev/null | od -An -tx1; dd if=/mnt/b/w.bin bs=1 count=4 2>/dev/null | od -An -c; echo mnt-big-done\n',
      new RegExp(`^67108864\\s[\\s\\S]*^${want}  /mnt/b/big\\.bin\\s[\\s\\S]*${hex(40000003, 8)}[\\s\\S]*${hex(60000000, 4)}[\\s\\S]*Z[\\s\\S]*mnt-big-done`, 'm'),
      'device folder: big file (64 MB) read in pieces: size, sha256, dd skip in the middle, write keeps the rest');
    const g = (x.heap_used() - h1) / MB, mid = devServed.get('/mnt/b/mid.bin') || 0;
    const ok = g < 16 && mid <= 4 * MB && devPiece <= 4 * MB && devServed.get('/mnt/b/big.bin') >= big.length;
    results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ` device folder big file: engine heap grew ${g.toFixed(1)} MB; served ${(devServed.get('/mnt/b/big.bin') / MB).toFixed(0)} MB for sha256, ${(mid / MB).toFixed(1)} MB for dd skip, pieces <= ${(devPiece / MB).toFixed(0)} MB`);
    // 1 MB written in the middle (not on 64 KB extent edges): only the extents it changes in part
    // are read from the device, and the scan lists just the changed ranges for the page to write back
    { put(enc.encode('/mnt/b')); x.linux_mount_scan(); } // the marks of the step above
    const r0 = devServed.get('/mnt/b/e.bin') || 0;
    await step('dd if=/dev/zero of=/mnt/b/e.bin bs=1000 seek=33554 count=1049 conv=notrunc 2>/dev/null; sync; echo mnt-part-done\n', /mnt-part-done/, 'device folder: 1 MB written in the middle of a 64 MB file');
    put(enc.encode('/mnt/b')); const sn = x.linux_mount_scan();
    const sc = dec.decode(new Uint8Array(mem.buffer, x.out_ptr(), sn).slice());
    const parts = (sc.match(/^F\t\/mnt\/b\/e\.bin\t67108864\t1\t(\S+)$/m) || [])[1];
    if (!parts && wasmPath === 'engine.wasm') console.log('SKIP device folder write back by ranges (published engine.wasm is older)');
    else {
      let wrote = 0;
      for (const r of parts && parts !== '*' && parts !== '-' ? parts.split(',') : []) { // the page: each range read from Linux, written at its place
        const [a, n] = r.split('+').map(Number);
        for (let off = a; off < a + n;) {
          const nm = enc.encode('/mnt/b/e.bin'), b = new Uint8Array(nm.length + 17), v = new DataView(b.buffer);
          b.set(nm); v.setBigUint64(nm.length + 1, BigInt(off), true); v.setBigUint64(nm.length + 9, BigInt(Math.min(4 * MB, a + n - off)), true); put(b);
          const k = x.linux_get_range();
          if (k <= 8) break;
          const d = Buffer.from(new Uint8Array(mem.buffer, x.out_ptr() + 8, k - 8));
          d.copy(eb, off); off += d.length; wrote += d.length;
        }
      }
      const exp = Buffer.from(big); exp.fill(0, 33554000, 33554000 + 1049000);
      const rd = (devServed.get('/mnt/b/e.bin') || 0) - r0, same = eb.equals(exp);
      const ok = !!parts && same && wrote >= 1049000 && rd + wrote <= 5 * MB;
      results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ` device folder: 1 MB written in a 64 MB file moves read ${(rd / MB).toFixed(2)} MB + written ${(wrote / MB).toFixed(2)} MB (whole file: 128 MB); file same as expected: ${same}` + (ok ? '' : '\n' + sc));
    }
    put(enc.encode('/mnt/b')); x.linux_remove(); devBig.clear();
  }
  // the saved tar (what the page writes to OPFS) comes in pieces: the 64 MB file never sits whole in the heap
  x.linux_save_begin();
  const parts = []; let peak = 0;
  for (let n; (n = x.linux_save_next()) > 0;) { parts.push(Buffer.from(new Uint8Array(mem.buffer, x.out_ptr(), n))); peak = Math.max(peak, x.heap_used()); }
  const tar = Buffer.concat(parts); let got = null;
  for (let o = 0; o + 512 <= tar.length;) {
    const name = tar.toString('latin1', o, o + 100).replace(/\0.*$/s, ''), size = parseInt(tar.toString('latin1', o + 124, o + 136), 8) || 0;
    if (!name) break;
    if (name === 'home/tester/big2') got = crypto.createHash('sha256').update(tar.subarray(o + 512, o + 512 + size)).digest('hex');
    o += 512 + Math.ceil(size / 512) * 512;
  }
  const sgrow = (peak - h0) / MB, sok = !!sum && got === sum && sgrow < 16;
  results.push(sok); console.log((sok ? 'PASS' : 'FAIL') + ` saved tar in pieces (${parts.length}, ${(tar.length / MB).toFixed(0)} MB): big file same sha256, heap peak +${sgrow.toFixed(1)} MB` + (sok ? '' : ` (${sum} vs ${got})`));
  if (x.linux_load_chunk) { // restore: a new engine boots from that tar fed in 4 MB pieces; big files go straight to blocks
    let small = 0, big = 0;
    for (let o = 0; o + 512 <= tar.length;) {
      const name = tar.toString('latin1', o, o + 100).replace(/\0.*$/s, ''), size = parseInt(tar.toString('latin1', o + 124, o + 136), 8) || 0;
      if (!name) break;
      if (size > MB) big += size; else small += size;
      o += 512 + Math.ceil(size / 512) * 512;
    }
    const r = await bootSaved(tar, 'sha256sum /home/tester/big2; stat -c %s /home/tester/big2; cat /etc/inksoc/user; echo rh:$(stat -c "%i %h" /home/tester/hl0 /home/tester/hl1); echo x >> /home/tester/hl0; echo rh2:$(tail -1 /home/tester/hl1); echo restore-done\n');
    const rok = r.out.includes(`${sum}  /home/tester/big2`) && /^67108864\s/m.test(r.out) && /^tester\s/m.test(r.out) && /restore-done/.test(r.out) && /rh:(\d+) 2 \1 2\s[\s\S]*rh2:x\s/.test(r.out) && r.grow < small / MB + 16;
    results.push(rok); console.log((rok ? 'PASS' : 'FAIL') + ` restore from the saved tar in pieces: big file same sha256, heap +${r.grow.toFixed(1)} MB while loading (small files ${(small / MB).toFixed(1)} MB, big ${(big / MB).toFixed(0)} MB)` + (rok ? '' : '\n' + r.out.slice(-600)));
  }
  await step('rm ~/big2; ls ~/big2 2>&1 | grep -c "No such"\n', /^1\s*$/m, 'big file removed');
  if (x.linux_load_chunk) { // a file put by the page over a file in blocks gives its blocks back (they are used again)
    await step('dd if=/dev/zero of=~/leak bs=1M count=8 2>/dev/null; echo leak-made\n', /leak-made/, 'file in blocks made (8 MB)');
    const b = enc.encode('leak\0x'); put(b); x.linux_put_file();
    const c0 = swap.size;
    await step('cat ~/leak; echo; dd if=/dev/zero of=~/leak2 bs=1M count=8 2>/dev/null; rm ~/leak ~/leak2; echo leak2-made\n', /^x\s[\s\S]*leak2-made/m, 'page puts a small file over it');
    const g = swap.size - c0;
    results.push(g < 64); console.log((g < 64 ? 'PASS' : 'FAIL') + ` its blocks were given back: swap grew ${g} chunks of 64 KB for a new 8 MB file (128 if they leaked)`);
  }
}
{ // Ctrl+C stops a running program and the shell comes back
  const before = out.length;
  send('sleep 30; echo after-sleep\n'); await settle(1500);
  x.linux_interrupt(); const t1 = Date.now(); await settle(10000);
  send('echo back-$((1+1))\n'); await settle(10000);
  const got = out.slice(before), ok = /back-2/.test(got) && Date.now() - t1 < 10000;
  results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' Ctrl+C stops sleep' + (ok ? '' : '\n' + got.slice(-400)));
}
console.log('\n' + enosysReport(x, mem, 'system calls answered ENOSYS (number name ×times)'));
const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s · swap chunks used: ${swap.size}`);
process.exit(pass === results.length ? 0 : 1);
