'use strict';
// Worker of rss-micro.html (item 65): reads a File in 4 MB pieces in different ways, copies each into a WebAssembly.Memory
let mem, h = null, cfg, file = null, sum = 0, swapAt = 0;
const Q = new URLSearchParams(self.location.search), PIECE = (+(Q.get('piece') || 4096)) << 10, DELAY = +(Q.get('delay') || 0), nm = new TextEncoder().encode('/mnt/x/big.bin');
// like worker.js lx.mdata + put(): a buffer "name\0 off len data" is built, then copied into wasm memory
function mdata(d) {
  const b = new Uint8Array(nm.length + 17 + d.length); b.set(nm); b.set(d, nm.length + 17);
  new Uint8Array(mem.buffer, 0, b.length).set(b);
  sum += d.length; return b.length;
}
function swapWrite(n) { if (h) h.write(new Uint8Array(mem.buffer, 0, n), { at: swapAt }); swapAt += n; }
onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      cfg = m; file = m.file; mem = new WebAssembly.Memory({ initial: 256 }); // 16 MB
      if (m.opfs || m.variant === 'opfs-only') {
        const root = await navigator.storage.getDirectory();
        h = await (await root.getFileHandle('micro-swap.bin', { create: true })).createSyncAccessHandle(); h.truncate(0);
      }
      postMessage({ ok: true });
    } else if (m.type === 'piece') {
      const n = mdata(new Uint8Array(m.d)); if (cfg.opfs) swapWrite(n); postMessage({ ok: true });
    } else if (m.type === 'blob') {
      const n = mdata(new Uint8Array(new FileReaderSync().readAsArrayBuffer(m.b))); if (cfg.opfs) swapWrite(n); postMessage({ ok: true });
    } else if (m.type === 'run') {
      const v = cfg.variant, total = cfg.total, frs = new FileReaderSync();
      for (let a = 0; a < total; a += PIECE) {
        const s = file ? file.slice(a, Math.min(a + PIECE, total)) : null; let n = 0;
        if (v === 'w-frs-new') n = mdata(new Uint8Array(new FileReaderSync().readAsArrayBuffer(s)));
        else if (v === 'w-frs-reuse') n = mdata(new Uint8Array(frs.readAsArrayBuffer(s)));
        else if (v === 'w-resp') n = mdata(new Uint8Array(await new Response(s).arrayBuffer()));
        else if (v === 'w-stream') {
          const rd = s.stream().getReader();
          for (;;) { const { done, value } = await rd.read(); if (done) break; new Uint8Array(mem.buffer, 0, value.length).set(value); sum += value.length; if (cfg.opfs) swapWrite(value.length); }
        } else if (v === 'opfs-only') {
          new Uint8Array(mem.buffer, 0, 1 << 20).fill(a & 255);
          for (let k = 0; k < 4; k++) h.write(new Uint8Array(mem.buffer, 0, 1 << 20), { at: swapAt + k * (1 << 20) });
          swapAt += PIECE;
        }
        if (cfg.opfs && v !== 'w-stream' && v !== 'opfs-only') swapWrite(n);
        if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
      }
      postMessage({ ok: true, extra: { sum, swap: h ? h.getSize() : 0 } });
    }
  } catch (e) { postMessage({ error: String((e && e.message) || e) }); }
};
