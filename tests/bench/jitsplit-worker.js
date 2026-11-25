// Item 55 (measurement only): tests/bench/browser-worker.js unchanged, plus a record of every x86 JIT module
// it compiles (host_jit is the only `new WebAssembly.Module` in an x86 run). Before the result goes back,
// the module bytes are POSTed to /dump (u32 length + bytes, in order) and their times (ms since the job
// started, same clock as the line stamps) to /dump.json.
import '/tests/bench/browser-worker.js';
const mods = [], times = [];
let T0 = performance.now();
const M = WebAssembly.Module;
WebAssembly.Module = function (b, ...r) {
  const m = new M(b, ...r);
  mods.push(b);
  times.push(+(performance.now() - T0).toFixed(2));
  return m;
};
WebAssembly.Module.prototype = M.prototype;
const onmsg = self.onmessage;
self.onmessage = (ev) => { T0 = performance.now(); return onmsg(ev); };
const post = self.postMessage.bind(self);
self.postMessage = (d) => {
  const parts = [];
  for (const b of mods) { const h = new Uint8Array(4); new DataView(h.buffer).setUint32(0, b.length, true); parts.push(h, b); }
  fetch('/dump', { method: 'POST', body: new Blob(parts) })
    .then(() => fetch('/dump.json', { method: 'POST', body: JSON.stringify(times) }))
    .then(() => post({ ...d, nmods: mods.length }), (e) => post({ ...d, err: 'dump: ' + e }));
};
