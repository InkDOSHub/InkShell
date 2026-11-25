// Item 55 (measurement only): replays real x86 JIT modules (dumped by jitsplit-worker.js) in this browser and
// times compile / instantiate / first call, one module per region (as the engine does today) or N regions
// merged into one module (option C, batching). Receives { url }, posts { res, err }.
// A JIT module is: types, imports env.memory + rd/wr/step/cond, one function `f` of type 0, export "f",
// optional "metadata.code.branch_hint" custom section, code section (jit.rs `finish`). Merging N keeps the
// types and imports and puts the N bodies side by side (exports f0..f{N-1}; bodies only call imports 0..3).
// Every build gets a nonce custom section so no browser can hand back a cached compile of the same bytes.
const leb = (a, v) => { do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; a.push(b); } while (v); };
const rd = (b, p) => { let v = 0, s = 0, x; do { x = b[p.i++]; v |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return v >>> 0; };
function parse(b) {
  const p = { i: 8 }, o = { hints: null };
  while (p.i < b.length) {
    const id = b[p.i++], n = rd(b, p), s = p.i, e = s + n;
    if (id === 1) o.types = b.subarray(s, e);
    else if (id === 2) o.imports = b.subarray(s, e);
    else if (id === 10) { const q = { i: s }; rd(b, q); const len = rd(b, q); o.body = b.subarray(q.i, q.i + len); }
    else if (id === 0) {
      const q = { i: s }, nl = rd(b, q), nm = new TextDecoder().decode(b.subarray(q.i, q.i + nl)); q.i += nl;
      if (nm === 'metadata.code.branch_hint') { rd(b, q); rd(b, q); o.hints = b.subarray(q.i, e); } // count 1, func 4, rest
    }
    p.i = e;
  }
  return o;
}
let nonce = 0;
function build(ps) { // ps: parsed modules -> one module with ps.length functions
  const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const sec = (id, data) => { out.push(id); leb(out, data.length); for (const x of data) out.push(x); };
  const name = (a, s) => { leb(a, s.length); for (const c of s) a.push(c.charCodeAt(0)); };
  sec(1, ps[0].types); sec(2, ps[0].imports);
  const fn = []; leb(fn, ps.length); for (let k = 0; k < ps.length; k++) fn.push(0); sec(3, fn);
  const ex = []; leb(ex, ps.length); for (let k = 0; k < ps.length; k++) { name(ex, 'f' + k); ex.push(0); leb(ex, 4 + k); } sec(7, ex);
  const hs = ps.map((p, k) => [k, p.hints]).filter(([, h]) => h);
  if (hs.length) { const h = []; name(h, 'metadata.code.branch_hint'); leb(h, hs.length); for (const [k, r] of hs) { leb(h, 4 + k); for (const x of r) h.push(x); } sec(0, h); }
  const c = []; leb(c, ps.length); for (const p of ps) { leb(c, p.body.length); for (const x of p.body) c.push(x); } sec(10, c);
  const nc = []; name(nc, 'n'); leb(nc, ++nonce); sec(0, nc);
  return new Uint8Array(out);
}
const batches = (ps, n) => { const r = []; for (let i = 0; i < ps.length; i += n) r.push(build(ps.slice(i, i + n))); return r; };
const now = () => performance.now();
self.onmessage = async (ev) => {
  try {
    postMessage({ log: 'start' });
    const buf = new Uint8Array(await (await fetch(ev.data.url)).arrayBuffer());
    const raw = [];
    for (let i = 0; i < buf.length;) { const n = new DataView(buf.buffer, i, 4).getUint32(0, true); raw.push(buf.subarray(i + 4, i + 4 + n)); i += 4 + n; }
    const ps = raw.map(parse);
    const res = { n: raw.length, kb: raw.reduce((s, b) => s + b.length, 0) / 1024, coi: self.crossOriginIsolated === true };
    // timer resolution
    let tick = 1e9; for (let k = 0; k < 20; k++) { const a = now(); let b; while ((b = now()) === a); tick = Math.min(tick, b - a); }
    res.tick = tick;
    // the engine's imports, with no engine behind them, and a 1-page memory: the function traps at its first
    // access to the cpu struct (well above 64 KB in the engine), so a first call = entry + lazy tier compile
    // (V8 compiles a function on its first call) + trap, and never runs guest code
    let mem = new WebAssembly.Memory({ initial: 1 });
    const imp = () => ({ env: { memory: mem, rd: () => 0n, wr: () => {}, step: () => 0, cond: () => 0 } });
    try { new WebAssembly.Instance(new WebAssembly.Module(build([ps[0]])), imp()); }
    catch (e) { mem = new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true }); res.shared = true; }
    // warm the compilers (not counted)
    for (const b of batches(ps.slice(0, 64), 1)) new WebAssembly.Module(b);
    for (const b of batches(ps.slice(0, 64), 16)) await WebAssembly.compile(b);
    res.reps = [];
    for (let rep = 0; rep < 2; rep++) {
      const r = {};
      res.reps.push(r);
      for (const N of [1, 4, 16, 64]) {
        const o = {};
        let bs = batches(ps, N);
        let t = now(); const ms = bs.map((b) => new WebAssembly.Module(b)); o.sync = now() - t;
        t = now(); const is = ms.map((m) => new WebAssembly.Instance(m, imp())); o.inst = now() - t;
        let traps = 0;
        t = now(); for (const i of is) for (const f of Object.values(i.exports)) { try { f(); } catch (e) { traps++; } } o.call1 = now() - t;
        t = now(); for (const i of is) for (const f of Object.values(i.exports)) { try { f(); } catch (e) { } } o.call2 = now() - t;
        o.traps = traps; o.modules = bs.length;
        bs = batches(ps, N);
        t = now(); for (const b of bs) await WebAssembly.compile(b); o.async = now() - t;
        bs = batches(ps, N);
        t = now(); await Promise.all(bs.map((b) => WebAssembly.compile(b))); o.asyncPar = now() - t;
        r['n' + N] = o;
        postMessage({ part: res, log: `rep ${rep} N ${N} ${JSON.stringify(o)}` });
      }
      // a + b*KB: modules sorted by size, 16 buckets, sync compile of each bucket one module at a time
      const ord = ps.map((p, k) => k).sort((x, y) => raw[x].length - raw[y].length), B = 16, pts = [];
      for (let k = 0; k < B; k++) {
        const ix = ord.slice(Math.floor(k * ord.length / B), Math.floor((k + 1) * ord.length / B));
        const bs = ix.map((i) => build([ps[i]])), kb = bs.reduce((s, b) => s + b.length, 0) / 1024;
        const t = now(); for (const b of bs) new WebAssembly.Module(b); pts.push([ix.length, kb, now() - t]);
      }
      // least squares T = a*count + b*KB (no intercept)
      let s11 = 0, s12 = 0, s22 = 0, y1 = 0, y2 = 0;
      for (const [c, kb, ms] of pts) { s11 += c * c; s12 += c * kb; s22 += kb * kb; y1 += c * ms; y2 += kb * ms; }
      const d = s11 * s22 - s12 * s12;
      r.fit = { a: (y1 * s22 - y2 * s12) / d, b: (s11 * y2 - s12 * y1) / d, pts: pts.map((p) => p.map((v) => +v.toFixed(2))) };
      postMessage({ part: res, log: `rep ${rep} fit ${JSON.stringify(r.fit)}` });
    }
    postMessage({ res, final: true });
  } catch (e) { postMessage({ err: String((e && e.stack) || e) }); }
};
