/* Alpine Linux terminal: the engine (engine.wasm, a fixed copy of InkSoC kept for this app)
   runs Alpine's programs; this worker feeds it keys, saves the files in OPFS and carries
   the sockets over a wisp tunnel: the public one first, the Hub's own relay
   (/net/wisp/ on hub.inkdos.workers.dev) when the public one cannot be reached. */
'use strict';
const NETS = { wisp: 'wss://wisp.mercurywork.shop/v86/', off: null };
// The Hub's relay: a Cloudflare Worker, so it cannot reach sites hosted on Cloudflare;
// that is why it is the fallback and not the first choice.
const HUB_WISP = 'wss://hub.inkdos.workers.dev/net/wisp/';
let wsUrl = null;
const SAVE = 'alpine-fs.tar';
const out = (t) => postMessage({ type: 'out', text: t });
let x, mem, lx = null, keys = [], net = 'wisp';
const pendingPuts = []; // files sent before Linux is up (from InkOS or the upload button)
const enc = new TextEncoder(), dec = new TextDecoder();
const put = (b) => { const p = x.buffer(b.length); new Uint8Array(mem.buffer, p, b.length).set(b); };

async function opfs() { try { return await navigator.storage.getDirectory(); } catch (e) { return null; } }
/* the saved files (a File: an engine with linux_load_chunk reads it in pieces, never whole) */
async function loadSaved() {
  const root = await opfs(); if (!root) return null;
  try { const f = await (await root.getFileHandle(SAVE)).getFile(); return f.size ? f : null; } catch (e) { return null; }
}
let saving = false;
async function save() {
  if (saving) return; saving = true;
  let w = null, h = null;
  try {
    const root = await opfs();
    if (root) {
      const fh = await root.getFileHandle(SAVE, { create: true });
      if (fh.createWritable) w = await fh.createWritable(); else { h = await fh.createSyncAccessHandle(); h.truncate(0); }
    }
    // the tar comes in pieces of about 4 MB (big files are in blocks, never whole in memory)
    let at = 0;
    const piece = async (n) => {
      const data = new Uint8Array(mem.buffer, x.out_ptr(), n).slice();
      if (w) await w.write(data); else if (h) h.write(data, { at });
      at += n;
    };
    if (x.linux_save_next) { x.linux_save_begin(); for (let n; (n = x.linux_save_next()) > 0;) await piece(n); }
    else await piece(x.linux_save_tar());
    if (w) { await w.close(); w = null; }
    if (h) { h.flush(); h.close(); h = null; }
    info(at);
  } catch (e) {
    out('\r\n\x1b[2m[could not save the files: ' + e.message + ']\x1b[0m\r\n');
    try { if (w) await w.abort(); if (h) h.close(); } catch (e2) {}
  }
  saving = false;
}

/* ---- network: wisp v1 ([type][stream u32 LE][payload]; 1 CONNECT, 2 DATA, 3 CONTINUE, 4 CLOSE) ---- */
let ws = null, wsq = [], got = new Set();
function wsSend(b) { if (ws && ws.readyState === 1) ws.send(b); else wsq.push(b); }
function packet(t, id, body) { const b = new Uint8Array(5 + body.length); b[0] = t; new DataView(b.buffer).setUint32(1, id, true); b.set(body, 5); return b; }
function netIn(id, kind, d) { put(d || new Uint8Array(0)); x.linux_net_in(id, kind); }
function openWs() {
  wsUrl = wsUrl || NETS[net];
  const sock = ws = new WebSocket(wsUrl); ws.binaryType = 'arraybuffer';
  let opened = false;
  ws.onopen = () => { opened = true; for (const b of wsq) ws.send(b); wsq = []; };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') return;
    const b = new Uint8Array(ev.data); if (b.length < 5) return;
    const id = new DataView(b.buffer).getUint32(1, true);
    if (b[0] === 2) { got.add(id); netIn(id, 1, b.subarray(5)); }
    else if (b[0] === 4) netIn(id, got.has(id) || b[5] === 2 ? 2 : 3);
  };
  const lost = () => {
    if (ws !== sock) return;
    ws = null;
    // the public tunnel is down or blocked: the queued packets go through the Hub's relay
    if (!opened && wsUrl !== HUB_WISP) { wsUrl = HUB_WISP; out('\r\n\x1b[2m[network: public wisp unreachable, using the InkDOS Hub relay]\x1b[0m\r\n'); openWs(); return; }
    wsq = [];
  };
  ws.onclose = lost; ws.onerror = lost;
}
function pumpNet() {
  const n = x.linux_net_poll(); if (!n) return;
  const b = new Uint8Array(mem.buffer, x.out_ptr(), n).slice(), v = new DataView(b.buffer);
  for (let o = 0; o < n;) {
    const op = b[o], id = v.getUint32(o + 1, true), len = v.getUint32(o + 5, true), d = b.subarray(o + 9, o + 9 + len); o += 9 + len;
    if (op === 1) {
      if (!NETS[net]) { netIn(id, 3); continue; }
      if (!ws) openWs();
      const s = dec.decode(d), k = s.lastIndexOf(':'), host = enc.encode(s.slice(0, k)), body = new Uint8Array(3 + host.length);
      body[0] = 1; new DataView(body.buffer).setUint16(1, +s.slice(k + 1), true); body.set(host, 3);
      wsSend(packet(1, id, body));
    } else if (op === 2) wsSend(packet(2, id, d));
    else if (op === 3) { got.delete(id); wsSend(packet(4, id, new Uint8Array([2]))); }
  }
}

const yieldNow = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

/* swap file in OPFS (sync access in this worker); RAM if the browser has none */
async function openSwap() {
  try {
    const root = await navigator.storage.getDirectory();
    const h = await (await root.getFileHandle('alpine-swap.bin', { create: true })).createSyncAccessHandle();
    h.truncate(0);
    return h;
  } catch (e) { return null; }
}

/* the user name and the size of the saved files, for the start panel */
function info(bytes) {
  const u = lx && lx.get('/etc/inksoc/user');
  postMessage({ type: 'info', user: u ? dec.decode(u).trim() : '', bytes });
}

async function run({ rows, cols, network, poolMb, targetMb, sw }) {
  if (network in NETS) net = network;
  wasiSw = !!sw; wasiOpen(Math.random().toString(36).slice(2));
  if (!wasiSw) { try { wasiInline = await import('./wasi.js?v=4'); } catch (e) { wasiInline = null; } }
  const swap = await openSwap(), ram = new Map();
  const page = (p) => new Uint8Array(mem.buffer, p, 4096);
  const env = {
    host_console: (p, n) => out(dec.decode(new Uint8Array(mem.buffer, p, n).slice(), { stream: true })),
    host_now_ms: () => performance.now(),
    host_epoch_ms: () => Date.now(),
    host_swap_write: (slot, p) => { if (swap) swap.write(page(p), { at: slot * 4096 }); else ram.set(slot, page(p).slice()); },
    host_swap_read: (slot, p) => { if (swap) swap.read(page(p), { at: slot * 4096 }); else page(p).set(ram.get(slot) || new Uint8Array(4096)); },
    // n contiguous slots in one call (64 KB extents of big Linux files); never-written ones read as zeros
    host_swap_writev: (slot, n, p) => {
      const b = new Uint8Array(mem.buffer, p, n * 4096);
      if (swap) swap.write(b, { at: slot * 4096 }); else for (let i = 0; i < n; i++) ram.set(slot + i, b.slice(i * 4096, (i + 1) * 4096));
    },
    host_swap_readv: (slot, n, p) => {
      const b = new Uint8Array(mem.buffer, p, n * 4096);
      if (swap) { const k = swap.read(b, { at: slot * 4096 }); if (k < b.length) b.fill(0, k); }
      else for (let i = 0; i < n; i++) { const r = ram.get(slot + i); if (r) b.set(r, i * 4096); else b.fill(0, i * 4096, (i + 1) * 4096); }
    },
    wine_call: () => 0,
    host_random: (p, n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); new Uint8Array(mem.buffer, p, n).set(b); },
    host_audio: () => {}, host_gl: () => 0, host_drive_read: () => 0, host_drive_write: () => 0,
    host_jit: (p, n) => {
      try {
        const m = new WebAssembly.Module(new Uint8Array(mem.buffer, p, n).slice());
        const i = new WebAssembly.Instance(m, { env: { memory: mem, rd: x.jit_rd, wr: x.jit_wr, step: x.jit_step, cond: x.jit_cond } });
        const t = x.__indirect_function_table, k = t.grow(1);
        t.set(k, i.exports.f);
        return k;
      } catch (e) { return -1; }
    },
  };
  const get = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ': ' + r.status); return r; });
  const [wasm, busybox, overlay, saved] = await Promise.all([
    get('engine.wasm?v=29').then((r) => r.arrayBuffer()), get('busybox?v=1').then((r) => r.arrayBuffer()),
    get('overlay.tar?v=11').then((r) => r.arrayBuffer()), loadSaved()]);
  let rootfs = null;
  if (!saved) {
    out('\x1b[2mDownloading Alpine Linux 3.21 (3.5 MB)…\x1b[0m\r\n');
    const r = await get('alpine-rootfs.tar.gz?v=1');
    rootfs = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  x = (await WebAssembly.instantiate(wasm, { env })).instance.exports;
  mem = x.memory;
  const addFile = (name, data) => {
    const nm = enc.encode(name), d = new Uint8Array(data), b = new Uint8Array(nm.length + 1 + d.length);
    b.set(nm); b.set(d, nm.length + 1); put(b); x.add_file();
  };
  x.init(poolMb || 256, targetMb || 8192);
  addFile('busybox', busybox);
  if (saved && x.linux_load_chunk) { // the saved tar in 4 MB pieces: big files go straight to swap blocks
    x.linux_load_begin();
    for (let a = 0; a < saved.size; a += 4 << 20) { put(new Uint8Array(await saved.slice(a, a + (4 << 20)).arrayBuffer())); x.linux_load_chunk(); }
  } else addFile('rootfs.tar', rootfs || await saved.arrayBuffer());
  addFile('zoverlay.tar', overlay);
  put(enc.encode('busybox\0sh /etc/inksoc/start'));
  if (x.start() !== 0) { postMessage({ type: 'done', error: dec.decode(new Uint8Array(mem.buffer, x.msg_ptr(), x.msg_len()).slice()) }); return; }
  x.linux_winsize(rows || 30, cols || 100);
  x.linux_dirty(); // unpacking is not a change; the first save happens after the first real one
  info(saved ? saved.size : 0);
  let line = '', lastCr = false;
  const send = (t) => { const b = enc.encode(t); put(b); x.linux_stdin(b.length); };
  lx = {
    resize(r, c) { x.linux_winsize(r, c); },
    put(name, data) { const nm = enc.encode(name), d = new Uint8Array(data), b = new Uint8Array(nm.length + 1 + d.length); b.set(nm); b.set(d, nm.length + 1); put(b); x.linux_put_file(); },
    // a piece of a big mounted file (offset, length asked; the bytes may be fewer)
    mdata(name, off, len, data) {
      const nm = enc.encode(name), d = new Uint8Array(data), b = new Uint8Array(nm.length + 17 + d.length), v = new DataView(b.buffer);
      b.set(nm); v.setBigUint64(nm.length + 1, BigInt(off), true); v.setBigUint64(nm.length + 9, BigInt(len), true); b.set(d, nm.length + 17); put(b); x.linux_mount_data();
    },
    get(path) { put(enc.encode(path)); const n = x.linux_get_file(); return n < 0 ? null : new Uint8Array(mem.buffer, x.out_ptr(), n).slice(); },
    // a piece of a file: { size, data }, 'wait' (a mounted file still misses it: asked from the page) or null
    range(path, off, len) {
      if (!x.linux_get_range) return null;
      const nm = enc.encode(path), b = new Uint8Array(nm.length + 17), v = new DataView(b.buffer);
      b.set(nm); v.setBigUint64(nm.length + 1, BigInt(off), true); v.setBigUint64(nm.length + 9, BigInt(len), true); put(b);
      const n = x.linux_get_range();
      if (n === -2) return 'wait';
      if (n < 8) return null;
      const o = new Uint8Array(mem.buffer, x.out_ptr(), n);
      return { size: Number(new DataView(o.buffer, o.byteOffset, 8).getBigUint64(0, true)), data: o.slice(8) };
    },
    text(n) { return n ? dec.decode(new Uint8Array(mem.buffer, x.out_ptr(), n)) : ''; },
  };
  storeArm();
  while (pendingMounts.length) mount(pendingMounts.shift());
  while (pendingPuts.length) { const f = pendingPuts.shift(); lx.put(f.name, f.data); }
  if (pendingLs !== null) { postMessage({ type: 'ls', ...list(pendingLs) }); pendingLs = null; }
  if (pendingStore) { pendingStore = false; storeSend(); }
  const feed = () => {
    while (keys.length) {
      const s = keys.shift();
      const lf = x.linux_lflag(), canon = lf & 2, echo = lf & 8;
      if (!canon) { // raw mode: Ctrl+C still interrupts while the program keeps ISIG on (shells, python, readline)
        if ((lf & 1) && s.includes('\x03')) { const parts = s.split('\x03'); parts.forEach((p, i) => { if (p) send(p); if (i < parts.length - 1) x.linux_interrupt(); }); } else send(s);
        continue;
      }
      if (s.startsWith('\x1b[') && /R$/.test(s)) continue; // a cursor-position answer nobody asked for in line mode
      for (const ch of s) {
        const afterCr = lastCr; lastCr = ch === '\r';
        if (ch === '\n' && afterCr) continue; // \r\n from some keyboards is one Enter, not two
        if (ch === '\x03') { x.linux_interrupt(); line = ''; out('^C\r\n'); }
        else if (ch === '\r' || ch === '\n') { if (echo) out('\r\n'); send(line + '\n'); line = ''; }
        else if (ch === '\x7f' || ch === '\b') { if (line) { line = [...line].slice(0, -1).join(''); if (echo) out('\b \b'); } }
        else if (ch === '\x04') { if (line) { send(line); line = ''; } else x.linux_eof(); }
        else if (ch === '\x15') { if (echo) out('\b \b'.repeat([...line].length)); line = ''; }
        else if (ch >= ' ' || ch === '\t') { line += ch; if (echo) out(ch); }
      }
    }
  };
  let st, lastSave = performance.now(), lastSync = 0;
  while (true) {
    feed();
    st = x.run(2000000);
    pumpNet();
    if (x.wasi_next) wasiPump();
    { const n = x.linux_mount_fetch(); if (n) { const paths = lx.text(n).split('\n').filter((p) => p !== SREQ || !(storeIdle = true)); if (paths.length) postMessage({ type: 'mfetch', paths }); } }
    storePump();
    if (st === 1 || st === 2) break;
    if (st === 3) {
      const t = performance.now();
      if (mounts.size && t - lastSync > 1500) { lastSync = t; syncMounts(); }
      if (t - lastSave > 3000 && x.linux_dirty()) { lastSave = t; await save(); }
      await sleep(Math.min(30, Math.max(0, x.stat(17))));
    } else await yieldNow();
  }
  if (mounts.size) syncMounts();
  if (x.linux_dirty()) await save();
  lx = null;
  postMessage({ type: 'done', error: st === 2 ? dec.decode(new Uint8Array(mem.buffer, x.msg_ptr(), x.msg_len()).slice()) : '' });
}

/* ---- WebAssembly (WASI) programs: the kernel lists them (wasi_next); each runs in its own Worker
   (wasi-worker.js, started by the page) whose calls come here through the service worker (sw.js) over
   a BroadcastChannel. Without a service worker the module runs here (wasi.js runWasi), blocking the
   terminal while it runs. ---- */
let wasiSid = '', wasiBc = null, wasiSw = false, wasiInline = null;
const wasiWait = new Map(), wasiLive = new Set();
let wake = null;
const sleep = (ms) => new Promise((r) => { const t = setTimeout(() => { wake = null; r(); }, ms); wake = () => { clearTimeout(t); wake = null; r(); }; });
function wpack(h, data) {
  const j = enc.encode(JSON.stringify(h)), d = data || new Uint8Array(0), b = new Uint8Array(4 + j.length + d.length);
  new DataView(b.buffer).setUint32(0, j.length, true); b.set(j, 4); b.set(d, 4 + j.length); return b;
}
function wasiReply(id, h, data) { const b = wpack(h, data); wasiBc.postMessage({ id, body: b.buffer }, [b.buffer]); }
function wasiOpen(sid) {
  if (wasiBc) wasiBc.close();
  wasiSid = sid; wasiBc = new BroadcastChannel('inkshell-wasi-' + sid);
  wasiBc.onmessage = (e) => {
    if (!x || !x.wasi_call) return;
    const b = new Uint8Array(e.data.body), n = new DataView(b.buffer).getUint32(0, true);
    const h = JSON.parse(dec.decode(b.subarray(4, 4 + n))), data = b.subarray(4 + n);
    if (h.op === 'call') {
      put(data);
      const a = [...(h.a || []), 0, 0, 0, 0, 0, 0];
      if (x.wasi_call(h.pid, h.nr, a[0], a[1], a[2], a[3], a[4], a[5], h.outLen || 0) !== 0) { wasiReply(e.data.id, { gone: 1 }); return; }
    }
    wasiWait.set(h.pid, { id: e.data.id, t: performance.now() });
    if (wake) wake();
  };
}
function wasiPump() {
  for (let pid; (pid = x.wasi_next());) {
    const k = x.wasi_info(pid), info = new Uint8Array(mem.buffer, x.out_ptr(), k).slice();
    if (wasiSw) {
      const m = x.wasi_module(pid), bytes = new Uint8Array(mem.buffer, x.out_ptr(), m).slice();
      wasiLive.add(pid);
      postMessage({ type: 'wasi-start', pid, sid: wasiSid, info, bytes, base: x.wasi_base(), size: x.wasi_buf_size() }, [bytes.buffer]);
    } else if (wasiInline) wasiInline.runWasi(x, pid);
    else { out('\r\n\x1b[2m[WebAssembly programs need a newer browser]\x1b[0m\r\n'); put(new Uint8Array(0)); x.wasi_call(pid, 231, 126, 0, 0, 0, 0, 0, 0); }
  }
  for (const [pid, q] of wasiWait) {
    const n = x.wasi_take(pid);
    if (n === -1) { if (performance.now() - q.t > 15000) { wasiWait.delete(pid); wasiReply(q.id, { pending: 1 }); } continue; }
    wasiWait.delete(pid);
    if (n === -2) wasiReply(q.id, { gone: 1 });
    else wasiReply(q.id, { r: x.wasi_ret() }, n > 0 ? new Uint8Array(mem.buffer, x.out_ptr(), n).slice() : null);
  }
  for (const pid of wasiLive) if (!x.wasi_alive(pid)) { wasiLive.delete(pid); postMessage({ type: 'wasi-end', pid }); }
}

onmessage = async (ev) => {
  const d = ev.data;
  if (d.type === 'key') { keys.push(d.data); return; }
  if (d.type === 'resize') { if (lx) lx.resize(d.rows, d.cols); return; }
  if (d.type === 'put') { if (lx) { lx.put(d.name, d.data); loaded(d.name, d.data.byteLength); } else pendingPuts.push({ name: d.name, data: d.data }); return; }
  if (d.type === 'mdata') { if (lx && x.linux_mount_data) { lx.mdata(d.name, d.off, d.len, d.data); loaded(d.name, (held.get(d.name) || 0) + d.len); } return; }
  if (d.type === 'mount') { if (lx) mount(d); else pendingMounts.push(d); return; }
  if (d.type === 'get') {
    const r = lx ? lx.range(d.path, 0, 0) : null;
    if (r && r.size > PIECE / 4) { postMessage({ type: 'file', path: d.path, data: await readAll(d.path), to: d.to }); return; } // in pieces, never whole
    const data = lx ? lx.get(d.path) : null; postMessage({ type: 'file', path: d.path, data, to: d.to }, data ? [data.buffer] : []); return;
  }
  if (d.type === 'range') { const data = await readRange(d.path, d.off, d.len); postMessage({ type: 'range', id: d.id, size: data ? data.size : -1, data: data ? data.data.buffer : null }, data ? [data.data.buffer] : []); return; }
  if (d.type === 'rm') { // the Files view: only your own files (home, /root, /tmp, mounted folders), never the system
    if (!lx) return;
    const parent = d.path.replace(/\/[^/]*$/, '') || '/';
    let ok = 0;
    if (userPath(d.path)) { put(enc.encode(d.path)); ok = x.linux_remove(); for (const p of [...held.keys()]) if (p === d.path || p.startsWith(d.path + '/')) held.delete(p); }
    postMessage({ type: 'ls', ...list(parent), removed: ok ? d.path : null });
    return;
  }
  if (d.type === 'ls') { if (lx) postMessage({ type: 'ls', ...list(d.path) }); else pendingLs = d.path || ''; return; }
  if (d.type === 'store') { if (lx) storeSend(); else pendingStore = true; return; }
  if (d.type === 'store-do') { if ((d.op === 'add' || d.op === 'del') && /^[A-Za-z0-9._+][A-Za-z0-9._+-]*$/.test(d.name || '')) storeQ.push({ op: d.op, name: d.name }); if (lx) storeSend(); return; }
  if (d.type === 'net') { net = d.network; wsUrl = null; if (ws) { try { ws.close(); } catch (e) {} ws = null; } return; }
  if (d.type === 'save') { if (lx) { if (mounts.size) syncMounts(); await save(); } postMessage({ type: 'saved' }); return; }
  if (d.type === 'reset') { const root = await opfs(); if (root) { try { await root.removeEntry(SAVE); } catch (e) {} } postMessage({ type: 'reset' }); return; }
  if (d.type === 'calibrate') { calibrate(); return; }
  if (d.type === 'wasi-sw') { wasiSw = !!d.on; return; }
  if (d.type === 'start') { try { await run(d); } catch (e) { postMessage({ type: 'done', error: e.message }); } }
};

/* ---- Store (the page's ☰ Store): packages of the WebAssembly catalog, installed or removed with
   "apk add/del NAME" in Linux but never typed into your shell. A root helper started by
   /etc/inksoc/start (/usr/local/sbin/inksoc-store) reads SREQ, a file of a mount made here that stays
   empty and keeps the reader waiting (a stub) until there is a request; the kernel lists the wait
   (linux_mount_fetch), so storeIdle says the helper is ready. The answer comes back in /run/inksoc;
   then the file is made to wait again (storeArm). */
const STORE = '/mnt/.inksoc', SREQ = STORE + '/req';
let storeIdle = false, storeJob = null, storeLog = '', storeDone = null, storeT = 0, pendingStore = false;
const storeQ = [];
function storeArm() { put(enc.encode(STORE + '\nF\t' + SREQ + '\t0')); x.linux_mount(); }
function storeText(p) { const b = lx.get(p); return b ? dec.decode(b) : ''; }
function storeList() {
  const seen = new Set(), items = [];
  for (const f of ['/etc/inksoc/wasm-catalog.local', '/etc/inksoc/wasm-catalog']) {
    for (const ln of storeText(f).split('\n')) {
      const c = ln.split('\t');
      if (ln[0] === '#' || c.length < 6 || seen.has(c[0])) continue;
      seen.add(c[0]);
      items.push({ name: c[0], size: +c[3] || 0, license: c[4], desc: c[6] || '', installed: !!lx.get('/var/lib/inksoc-wasm/' + c[0]) });
    }
  }
  return items;
}
function storeSend() {
  const busy = storeQ.map((j) => j.name); if (storeJob) busy.unshift(storeJob.name);
  postMessage({ type: 'store', items: storeList(), job: storeJob && { op: storeJob.op, name: storeJob.name }, busy, log: storeLog, done: storeDone, ready: storeIdle });
}
function storePump() {
  if (storeJob) {
    const t = performance.now();
    if (t - storeT < 500) return;
    storeT = t;
    const rc = storeText('/run/inksoc/store.rc').trim().split(' ');
    const log = storeText('/run/inksoc/store.log');
    if (rc[0] === storeJob.id) {
      storeLog = log; storeDone = { op: storeJob.op, name: storeJob.name, rc: +rc[1] };
      storeJob = null; storeArm(); storeSend();
    } else if (log !== storeLog) { storeLog = log; storeSend(); }
    return;
  }
  if (storeQ.length && storeIdle) {
    storeJob = storeQ.shift();
    storeJob.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    storeIdle = false; storeLog = ''; storeDone = null; storeT = performance.now();
    for (const f of ['/run/inksoc/store.rc', '/run/inksoc/store.log']) { put(enc.encode(f)); x.linux_remove(); }
    lx.put(SREQ, enc.encode(storeJob.id + ' ' + storeJob.op + ' ' + storeJob.name));
    storeSend();
  }
}

/* Memory calibration, the same as InkSoC's: grow a wasm memory 128 MB at a time, filled with
   random data (iOS compresses empty pages). The page saves each step; if the tab reloads,
   the last step saved is this device's limit. */
async function calibrate() {
  const step = 128, pagesPerStep = step * 16;
  const m = new WebAssembly.Memory({ initial: 16, maximum: 65536 });
  let mb = 1, seed = 2463534242;
  const touch = (fromMb, toMb) => {
    const u32 = new Uint32Array(m.buffer, fromMb * 1048576, (toMb - fromMb) * 262144);
    for (let i = 0; i < u32.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; u32[i] = seed; }
  };
  while (mb + step <= 4096) {
    try { m.grow(pagesPerStep); } catch (e) { postMessage({ type: 'calib', mb, done: true }); return; }
    touch(mb, mb + step);
    mb += step;
    postMessage({ type: 'calib', mb });
    await new Promise((r) => setTimeout(r, 50));
  }
  postMessage({ type: 'calib', mb, done: true });
}

/* Device folders mounted at /mnt/NAME (the page holds the folder; see app.js). The engine lists
   every file but reads one only when a program opens it (the page sends it); a file over 1 MB
   is read in pieces of up to 4 MB as programs reach them (File.slice), never whole. Every 1.5 s of
   quiet, what programs changed goes back to the page, which writes it into the real folder.
   Files only read are dropped again when more than MOUNT_RAM bytes are held. */
const mounts = new Map(); // root -> Map(path -> 'D' | size)
const pendingMounts = [];
let pendingLs = null; // the Download page asked for a list before Linux was up
const MOUNT_RAM = 192 * 1048576;
const PIECE = 4 * 1048576; // big files go to the page and back in pieces of this size
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// a piece of a file of Linux; for a big mounted file waits (up to 2 min) while the page reads what it misses
async function readRange(path, off, len) {
  for (let t0 = Date.now(); lx && Date.now() - t0 < 120000; await pause(40)) {
    const r = lx.range(path, off, len);
    if (r !== 'wait') return r;
  }
  return null;
}
async function readAll(path) { // a big file as a Blob, read piece by piece (the browser keeps big Blobs on disk)
  const parts = [];
  for (let off = 0, size = Infinity; off < size;) {
    const r = await readRange(path, off, PIECE);
    if (!r) return null;
    size = r.size;
    if (!r.data.length) break;
    parts.push(new Blob([r.data])); off += r.data.length;
  }
  return new Blob(parts);
}
let held = new Map(); // mounted files read into memory: path -> size (oldest first)
function mount(d) {
  put(enc.encode(d.root + '\n' + d.list)); x.linux_mount();
  mounts.set(d.root, scan(d.root));
}
function scan(root) {
  put(enc.encode(root));
  const m = new Map();
  for (const ln of lx.text(x.linux_mount_scan()).split('\n')) {
    const f = ln.split('\t');
    if (f[0] === 'D') m.set(f[1], 'D'); else if (f[0] === 'F') m.set(f[1], { size: +f[2], changed: f[3] === '1' });
  }
  return m;
}
function loaded(path, size) {
  for (const root of mounts.keys()) if (path.startsWith(root + '/')) { held.delete(path); held.set(path, size); return; }
}
function syncMounts() {
  for (const [root, prev] of mounts) {
    const cur = scan(root), ops = [], buf = [];
    const gone = [...prev.keys()].filter((p) => !cur.has(p));
    for (const [p, v] of cur) {
      if (v === 'D') { if (prev.get(p) !== 'D') ops.push({ op: 'mkdir', path: p }); continue; }
      const old = prev.get(p);
      if (!v.changed && old && old !== 'D') continue;
      if (!v.changed && !old) { // a file not read yet that moved (mv): the page moves it in the real folder
        const i = gone.findIndex((g) => prev.get(g) !== 'D' && prev.get(g).size === v.size);
        if (i >= 0) { ops.push({ op: 'move', from: gone[i], path: p }); gone.splice(i, 1); continue; }
      }
      if (v.size > PIECE / 4) { ops.push({ op: 'wbig', path: p, size: v.size }); loaded(p, v.size); continue; } // the page pulls it in pieces
      const data = lx.get(p);
      if (data) { ops.push({ op: 'write', path: p, data: data.buffer }); buf.push(data.buffer); loaded(p, data.length); }
    }
    for (const p of gone.sort((a, b) => b.length - a.length)) ops.push({ op: 'remove', path: p, dir: prev.get(p) === 'D' });
    for (const [p, v] of cur) if (v !== 'D') v.changed = false;
    mounts.set(root, cur);
    if (ops.length) postMessage({ type: 'msync', root, ops }, buf);
  }
  let total = 0; for (const v of held.values()) total += v;
  for (const [p, size] of held) {
    if (total <= MOUNT_RAM) break;
    put(enc.encode(p)); if (x.linux_mount_evict()) { held.delete(p); total -= size; }
  }
}

function homeDir() { const u = lx.get('/etc/inksoc/user'), n = u ? dec.decode(u).trim() : ''; return n && n !== 'root' ? '/home/' + n : '/root'; }
function userPath(p) {
  if (!p || p.includes('/../') || p.endsWith('/..')) return false;
  for (const r of mounts.keys()) if (p.startsWith(r + '/')) return true;
  return [homeDir(), '/root', '/tmp'].some((r) => p.startsWith(r + '/'));
}

/* The page's Download list: the folders and files right inside one folder (your home folder
   when none is given). scan() also clears the "changed" marks of mounted files, so what changed
   in mounted folders is sent to the page first. */
function list(path) {
  const home = homeDir();
  if (!path) path = home;
  path = path.replace(/\/+$/, '') || '/';
  const pre = path === '/' ? '/' : path + '/';
  if (mounts.size) syncMounts();
  let all = null;
  for (const [root, m] of mounts) if (path === root || path.startsWith(root + '/')) all = m;
  if (!all) all = scan(path === '/' ? '' : path);
  const items = [];
  for (const [p, v] of all) {
    if (!p.startsWith(pre) || p === STORE || p.startsWith(STORE + '/')) continue;
    const name = p.slice(pre.length);
    if (!name || name.includes('/')) continue;
    items.push(v === 'D' ? { name, dir: true } : { name, size: v.size });
  }
  if (path === '/' || path === '/mnt') for (const r of mounts.keys()) { const n = r.slice(pre.length); if (r.startsWith(pre) && n && !n.includes('/') && !items.some((i) => i.name === n)) items.push({ name: n, dir: true }); }
  items.sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || a.name.localeCompare(b.name));
  return { path, items, home };
}
