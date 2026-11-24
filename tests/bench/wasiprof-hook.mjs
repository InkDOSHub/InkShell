// Phase profile of WebAssembly (WASI) programs run by tests/bench-engine.mjs (INKSOC_WASI_PROFILE=1).
// Bench-only: nothing here is served or loaded in the normal path. It wraps WebAssembly.Module /
// WebAssembly.Instance (compile / instantiate time; each WASI import timed and counted) and hands
// runWasi a proxy of the engine exports (time of the .wasm read in wasi_module, engine time inside
// each Linux call). One record per program: tests/bench/wasiprof.mjs makes the tables.
import { cwdStats, parseInfo } from '../../wasi.js';
const now = () => performance.now();
const progs = [];
let cur = null, fn = 'setup'; // the program being run and the WASI call it is in
const M = WebAssembly.Module, I = WebAssembly.Instance;
function Module(b, ...r) {
  if (!cur || cur.compileMs != null || b.length !== cur.bytes) return new M(b, ...r);
  cur.setupEng = cur.engMs; const t = now(); const m = new M(b, ...r); cur.compileMs = now() - t; cur.tCompile = t; return m;
}
Object.assign(Module, { imports: M.imports, exports: M.exports, customSections: M.customSections });
Module.prototype = M.prototype;
function Instance(m, imp = {}, ...r) {
  const w = imp.wasi_snapshot_preview1 || imp.wasi_unstable;
  if (!cur || !w || cur.instMs != null) return new I(m, imp, ...r);
  const p = cur, calls = p.calls, wrapped = {};
  // the module came from wasi.js's cache (no new WebAssembly.Module): compile time 0
  if (p.compileMs == null) { p.setupEng = p.engMs; p.compileMs = 0; p.tCompile = now(); p.modCached = true; }
  for (const [k, f] of Object.entries(w)) {
    const io = k === 'fd_read' || k === 'fd_write' || k === 'fd_pread' || k === 'fd_pwrite';
    wrapped[k] = (...a) => {
      const c = (calls[k] ??= { n: 0, ms: 0, eng: 0, sys: 0 });
      // big files: bytes asked per read/write call (sum of the iovecs), and node's RSS now and then
      if (io && p.inst?.exports?.memory) {
        const d = new DataView(p.inst.exports.memory.buffer); let len = 0;
        for (let i = 0; i < a[2]; i++) len += d.getUint32(a[1] + 8 * i + 4, true);
        c.bytes = (c.bytes || 0) + len; c.max = Math.max(c.max || 0, len);
      }
      if ((++p.nCalls & 15) === 0) p.rssMax = Math.max(p.rssMax, process.memoryUsage.rss());
      const e0 = p.engMs, s0 = p.sysN, t = now(), prev = fn; fn = k;
      try { return f(...a); } finally { fn = prev; c.n++; c.ms += now() - t; c.eng += p.engMs - e0; c.sys += p.sysN - s0; }
    };
  }
  const imp2 = { ...imp };
  if (imp.wasi_snapshot_preview1) imp2.wasi_snapshot_preview1 = wrapped;
  if (imp.wasi_unstable) imp2.wasi_unstable = wrapped;
  const t = now(); const i = new I(m, imp2, ...r); p.instMs = now() - t; p.tRun = now();
  p.mem0 = i.exports.memory ? i.exports.memory.buffer.byteLength : 0; p.inst = i;
  return i;
}
Instance.prototype = I.prototype;
WebAssembly.Module = Module; WebAssembly.Instance = Instance;

/** The engine exports as runWasi should see them while a program runs (a copy: the exports object
 *  is frozen, so a Proxy may not hand out other functions). */
const wraps = new WeakMap(); // one wrapper per engine: wasi.js keys its caches by the engine object
export function wrap(x) {
  if (wraps.has(x)) return wraps.get(x);
  const o = { ...x }; wraps.set(x, o);
  o.run = (n) => { const a = now(); try { return x.run(n); } finally { if (cur) { cur.engMs += now() - a; cur.runs++; } } };
  o.wasi_module = (pid) => { const a = now(); const n = x.wasi_module(pid); if (cur) { cur.bytes = n; cur.readMs = now() - a; } return n; };
  o.wasi_call = (pid, nr, ...a) => {
    if (cur) { cur.sysN++; const key = fn + ':' + nr; cur.sys[key] = (cur.sys[key] || 0) + 1; if (fn === 'setup') cur.setupSys++; }
    return x.wasi_call(pid, nr, ...a);
  };
  return o;
}
/** Program `pid` starts now; `pickMs` = the engine slice (x.run) in which it was exec'd. */
export function begin(x, pid, pickMs) {
  let args = [];
  try { const k = x.wasi_info(pid); args = parseInfo(new Uint8Array(x.memory.buffer, x.out_ptr(), k).slice()).args; } catch {}
  cur = { pid, args, pickMs, nStats: cwdStats.length, tStart: now(), readMs: null, bytes: 0, compileMs: null, instMs: null, engMs: 0, runs: 0, sysN: 0, nCalls: 0, rssMax: process.memoryUsage.rss(), setupSys: 0, setupEng: 0, sys: {}, calls: {} };
  fn = 'setup';
}
export function end(code) {
  const p = cur; if (!p) return; cur = null;
  p.tEnd = now(); p.code = code;
  // one more cwdStats entry = this program searched (or hit) the cwd slot (the list keeps 64)
  const s = cwdStats[cwdStats.length - 1];
  if (s && cwdStats.length > p.nStats) { p.slotMs = s.ms; p.slotHit = s.hit; }
  if (p.inst?.exports?.memory) p.mem1 = p.inst.exports.memory.buffer.byteLength;
  p.rss1 = process.memoryUsage.rss(); p.rssMax = Math.max(p.rssMax, p.rss1); p.maxRss = process.resourceUsage().maxRSS * 1024;
  delete p.inst;
  progs.push(p);
}
export const data = (t0) => ({ t0, progs: progs.map((p) => ({ ...p, tStart: p.tStart - t0, tEnd: p.tEnd - t0, tCompile: p.tCompile - t0, tRun: p.tRun - t0 })) });
