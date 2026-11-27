/* One WebAssembly (WASI) program of the terminal, in its own Worker (started by app.js when the engine
   lists it). Each WASI call is a synchronous request through the service worker (sw.js) to the engine's
   worker, which makes it a Linux call of the program's process: the engine keeps running meanwhile.
   A JS program (wasi.js jsProgram: inkvideo, which uses this Worker's WebCodecs) may end asynchronously.
   Item 94: on a cross-origin isolated page the start message brings a MessagePort to the engine's worker and a
   SharedArrayBuffer: a call goes on the port and this Worker waits on the buffer (Atomics.wait), ~10x cheaper than
   the synchronous XHR through the service worker (the fallback: first visit, Hub iframe, older browsers). */
import { runModule, parseInfo, pack, unpack, Exit } from './wasi.js?v=24';

onmessage = async (ev) => {
  const { pid, sid, info, bytes, key, module, base, size, slots, spawn, prof: dbg, port, sab } = ev.data;
  // item 91 (debug, page ?wasiprof=1): epoch-ms timestamps of this Worker's phases + count/time of its synchronous calls
  const P = dbg ? [] : null, calls = { n: 0, ms: 0 }, now = () => performance.timeOrigin + performance.now();
  // the marks go to the page at 'exit' (before the exit call: the engine's 'wasi-end' may end this Worker right after it)
  const prof = dbg ? (e) => { P.push([e, now()]); if (e === 'exit') postMessage({ type: 'prof', pid, prof: P, calls }); } : null;
  prof && prof('onmessage');
  const { args, envs } = parseInfo(info);
  const url = new URL('__wasi?s=' + encodeURIComponent(sid), self.location).href;
  const i32 = port && sab ? new Int32Array(sab, 0, 2) : null;
  const post = i32 ? (h, data) => {
    const t0 = dbg ? performance.now() : 0, b = pack(h, data);
    Atomics.store(i32, 0, 0);
    port.postMessage(b.buffer, [b.buffer]);
    if (Atomics.wait(i32, 0, 0, 30000) === 'timed-out' && Atomics.load(i32, 0) === 0) throw new Exit(-1); // engine gone
    const r = unpack(new Uint8Array(sab, 8, Atomics.load(i32, 1)).slice());
    if (dbg) { calls.n++; calls.ms += performance.now() - t0; }
    return r;
  } : (h, data) => {
    const t0 = dbg ? performance.now() : 0, q = new XMLHttpRequest();
    q.open('POST', url, false);
    q.responseType = 'arraybuffer';
    try { q.send(pack(h, data)); } catch (e) { throw new Exit(-1); }
    if (q.status !== 200) throw new Exit(-1);
    if (dbg) { calls.n++; calls.ms += performance.now() - t0; }
    return unpack(new Uint8Array(q.response));
  };
  const sys = (nr, a = [], data, outLen = 0, to = pid) => { // to: a child this program forked (item 78)
    let r = post({ op: 'call', pid: to, nr, a, outLen }, data);
    while (r.h.pending) r = post({ op: 'wait', pid: to });
    if (r.h.gone) { if (to !== pid) return { r: -3, out: null }; throw new Exit(-1); }
    return { r: r.h.r, out: r.out };
  };
  const code = await runModule({ bytes, key, module, args, envs, base, size, sys, spawn: spawn ? 2 : 0,
    slots: new Map(slots || []), prof, onSlot: (k, slot) => postMessage({ type: 'slot', key: k, slot }),
    // the compiled module goes back to the page, which hands it to the next Worker of the same file
    onModule: (k, mod) => { try { postMessage({ type: 'module', key: k, module: mod }); } catch {} } });
  postMessage({ type: 'done', pid, code });
};
