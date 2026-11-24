/* One WebAssembly (WASI) program of the terminal, in its own Worker (started by app.js when the engine
   lists it). Each WASI call is a synchronous request through the service worker (sw.js) to the engine's
   worker, which makes it a Linux call of the program's process: the engine keeps running meanwhile.
   A JS program (wasi.js jsProgram: inkvideo, which uses this Worker's WebCodecs) may end asynchronously. */
import { runModule, parseInfo, pack, unpack, Exit } from './wasi.js?v=10';

onmessage = async (ev) => {
  const { pid, sid, info, bytes, key, module, base, size, slots } = ev.data;
  const { args, envs } = parseInfo(info);
  const url = new URL('__wasi?s=' + encodeURIComponent(sid), self.location).href;
  const post = (h, data) => {
    const q = new XMLHttpRequest();
    q.open('POST', url, false);
    q.responseType = 'arraybuffer';
    try { q.send(pack(h, data)); } catch (e) { throw new Exit(-1); }
    if (q.status !== 200) throw new Exit(-1);
    return unpack(new Uint8Array(q.response));
  };
  const sys = (nr, a = [], data, outLen = 0) => {
    let r = post({ op: 'call', pid, nr, a, outLen }, data);
    while (r.h.pending) r = post({ op: 'wait', pid });
    if (r.h.gone) throw new Exit(-1);
    return { r: r.h.r, out: r.out };
  };
  const code = await runModule({ bytes, key, module, args, envs, base, size, sys,
    slots: new Map(slots || []), onSlot: (k, slot) => postMessage({ type: 'slot', key: k, slot }),
    // the compiled module goes back to the page, which hands it to the next Worker of the same file
    onModule: (k, mod) => { try { postMessage({ type: 'module', key: k, module: mod }); } catch {} } });
  postMessage({ type: 'done', pid, code });
};
