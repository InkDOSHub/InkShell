// Runs a script in Alpine on this engine (node 18+, no network) and stamps its output lines.
// usage: node tests/bench-engine.mjs ENGINE.wasm [NAME=FILE ...] -- sh /root/bench.sh cpu py
// NAME=FILE puts FILE at /root/NAME; a NAME ending in .tar is unpacked at / (extra packages).
// WebAssembly (WASI) programs the script starts run through ../wasi.js (runWasi).
// Output: "MS<TAB>line<TAB>wasmMB<TAB>swapMB" per line (format of tests/bench/stamp.mjs plus memory),
// then "@@MEM wasm=MB rss=MB" with the peaks. Exit 0 when the script printed "@@T done".
import fs from 'node:fs';
import zlib from 'node:zlib';
import { runWasi } from '../wasi.js';
import { swapStore } from './swap-store.mjs';
import { report as enosysReport } from './enosys.mjs';
const argv = process.argv.slice(2), sep = argv.indexOf('--');
const wasmPath = argv[0], files = argv.slice(1, sep), cmd = argv.slice(sep + 1).join(' ');
const POOL = +(process.env.POOL_MB || 512), LIMIT = +(process.env.LIMIT_MS || 1800000);
const dec = new TextDecoder(), enc = new TextEncoder();
let mem, x, out = '', line = '', jitErr = 0;
const sw = swapStore(() => mem); // the page's OPFS swap file, in memory here
const t0 = performance.now();
let peakRss = 0, done = false;
// PROFILE_JSON=FILE (engine built with --features ophist): counters after each output line, for tests/bench/profile.mjs
const PROF = process.env.PROFILE_JSON, prof = [];
// INKSOC_WASI_PROFILE=1: phases of each WebAssembly program (read, compile, instantiate, WASI calls), to
// WASI_PROFILE_JSON (default wasiprof.json), for tests/bench/wasiprof.mjs; off = nothing is loaded
const WP = process.env.INKSOC_WASI_PROFILE === '1' ? await import('./bench/wasiprof-hook.mjs') : null;
// JITLOG=FILE: every region handed to host_jit (output line before it, wasm bytes, Module and Instance ms;
// with a --features jitprobe engine also guest block heads, instructions, translate ms), for tests/bench/jitwarm.mjs.
// INKSOC_HOT=N (jitprobe engine): visits before a block is compiled (default 40)
const JL = process.env.JITLOG, jl = [];
let lastLine = '';
const snap = () => ({ ctr: Array.from({ length: 32 }, (_, i) => x.prof_ctr(i)), op: Array.from({ length: 512 }, (_, i) => x.ophist(i)) });
const mb = (b) => (b / 1048576).toFixed(0);
function emit(s) {
  line += s;
  for (let k; (k = line.indexOf('\n')) >= 0; line = line.slice(k + 1)) {
    const l = line.slice(0, k).replace(/\r/g, '');
    console.log(`${(performance.now() - t0).toFixed(1)}\t${l}\t${mb(mem.buffer.byteLength)}\t${mb(sw.chunks.size * 65536)}`);
    if (l === '@@T done') done = true;
    lastLine = l;
    if (PROF && x.prof_ctr) prof.push({ line: l, ms: performance.now() - t0, c: snap() });
  }
}
const env = {
  host_console: (p, n) => emit(dec.decode(new Uint8Array(mem.buffer, p, n).slice(), { stream: true })),
  host_now_ms: () => performance.now(), host_epoch_ms: () => Date.now(),
  ...sw.imports,
  wine_call: () => 0,
  host_random: (p, n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); new Uint8Array(mem.buffer, p, n).set(b); },
  host_audio: () => {}, host_gl: () => 0, host_drive_read: () => 0, host_drive_write: () => 0,
  host_jit: (p, n) => {
    try {
      const t1 = performance.now();
      const m = new WebAssembly.Module(new Uint8Array(mem.buffer, p, n).slice());
      const t2 = performance.now();
      const i = new WebAssembly.Instance(m, { env: { memory: mem, rd: x.jit_rd, wr: x.jit_wr, step: x.jit_step, cond: x.jit_cond } });
      const t = x.__indirect_function_table, k = t.grow(1); t.set(k, i.exports.f);
      if (JL) jl.push({ t: t1 - t0, at: lastLine, bytes: n, mod: t2 - t1, inst: performance.now() - t2,
        ...(x.jit_probe ? { ins: x.jit_probe(1), tr: x.jit_probe(2), heads: Array.from({ length: x.jit_probe(0) }, (_, h) => x.jit_probe_head(h)) } : {}) });
      return k;
    } catch (e) { if (!jitErr) { jitErr = 1; console.error('host_jit: ' + e.message); } return -1; }
  },
};
x = (await WebAssembly.instantiate(fs.readFileSync(wasmPath), { env })).instance.exports;
mem = x.memory;
if (process.env.INKSOC_HOT && x.set_jit_hot) x.set_jit_hot(+process.env.INKSOC_HOT);
if (process.env.INKSOC_CHAIN === '0' && x.set_jit_chain) x.set_jit_chain(0); // A/B: JIT exits not chained
if (process.env.INKSOC_STACK === '0' && x.set_jit_stack) x.set_jit_stack(0); // A/B: no stack window (item 59)
const put = (b) => { const p = x.buffer(b.length); new Uint8Array(mem.buffer, p, b.length).set(b); };
const add = (name, data) => { const nm = enc.encode(name), d = new Uint8Array(data), b = new Uint8Array(nm.length + 1 + d.length); b.set(nm); b.set(d, nm.length + 1); put(b); x.add_file(); };
x.init(POOL, 8192);
add('busybox', fs.readFileSync('busybox'));
add('rootfs.tar', zlib.gunzipSync(fs.readFileSync('alpine-rootfs.tar.gz')));
add('zoverlay.tar', fs.readFileSync('overlay.tar'));
for (const f of files) { const k = f.indexOf('='); add(f.slice(0, k), fs.readFileSync(f.slice(k + 1))); }
put(enc.encode('busybox\0' + cmd));
if (x.start() !== 0) { console.log('FAIL start:', dec.decode(new Uint8Array(mem.buffer, x.msg_ptr(), x.msg_len()))); process.exit(1); }
x.linux_winsize(30, 100);
let st = 0;
try {
  for (let idle = 0; !done && performance.now() - t0 < LIMIT;) {
    const ts = performance.now();
    st = x.run(2000000);
    const slice = performance.now() - ts;
    // WebAssembly (WASI) programs run here, in the engine's thread, as in tests/linux-test.mjs
    if (x.wasi_next) for (let pid; (pid = x.wasi_next());) {
      if (!WP) { runWasi(x, pid); continue; }
      WP.begin(x, pid, slice); WP.end(runWasi(WP.wrap(x), pid));
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (st === 1 || st === 2) break;
    if (st === 3) { const ms = x.stat(17); if (ms >= 30 && !(x.linux_timer_ms?.() >= 0) && ++idle > 200) break; await new Promise((r) => setTimeout(r, Math.min(ms, 30) || 2)); } else idle = 0;
  }
} catch (e) { console.log(`${(performance.now() - t0).toFixed(1)}\t@@ERR ${e.message}`); }
if (line) emit('\n');
if (st === 2) console.log(`${(performance.now() - t0).toFixed(1)}\t@@ERR engine stopped: ${dec.decode(new Uint8Array(mem.buffer, x.msg_ptr(), x.msg_len()))}`);
if (!done && performance.now() - t0 >= LIMIT) console.log(`${(performance.now() - t0).toFixed(1)}\t@@ERR time limit ${LIMIT} ms`);
if (JL) fs.writeFileSync(JL, JSON.stringify({ jitMs: x.stat(14), regions: jl }));
if (PROF) fs.writeFileSync(PROF, JSON.stringify(prof));
if (WP) fs.writeFileSync(process.env.WASI_PROFILE_JSON || 'wasiprof.json', JSON.stringify(WP.data(t0)));
console.log('@@ENOSYS ' + enosysReport(x, mem, 'syscalls'));
console.log(`@@MEM wasm=${mb(mem.buffer.byteLength)} rss=${mb(peakRss)}`);
process.exit(done ? 0 : 1);
