// WASI (preview1) programs on the InkShell kernel. When a process execs a .wasm file, the kernel
// turns it into a small stub process and lists it in wasi_next(); this file runs the module and
// makes each WASI call a Linux call of that stub (wasi_call / wasi_take), so the program uses the
// process's own files, pipes, terminal and /mnt, and the shell sees a normal process (pid, exit code).
// Calls are synchronous. In node (tests) the module runs in the engine's thread (runWasi); on the
// page it runs in its own Worker (wasi-worker.js) and each call is a synchronous request that the
// service worker (sw.js) passes to the engine's worker, which keeps running meanwhile.
// Folders: wasi-libc keeps its own working directory, always "/" at start (preview1 has no initial one).
// When the module has wasi-libc's chdir/getcwd (its cwd pointer, a word in the data that points at "/"
// and is used by the code, is found by cwdSlot), "/" is preopened as the real root and the pointer is set
// to the shell's folder (the "PWD=..." string that environ_get writes in the program's own memory): relative
// paths follow the shell's folder, absolute paths the real root, os.getcwd() is the shell's folder.
// The catalog tools (tools/wasm-tools/build.sh) are linked with chdir forced in, so they all take this path.
// Otherwise (a third-party module without chdir: wasi-libc then sends "x.txt" and "/x.txt" alike to the "/"
// preopen as "x.txt") each path on the "/" preopen goes to the shell's folder or to the real root (pick):
// the argument it comes from ("/etc" or "etc") says which, else the side that has its first name.
// Limits: getcwd() says "/"; a name in both places that no argument names goes to the folder. No sockets.
import { main as inkvideo } from './inkvideo.js?v=2';
const E = { 1: 63, 2: 44, 4: 27, 5: 29, 9: 8, 11: 6, 12: 48, 13: 2, 17: 20, 18: 75, 20: 54, 21: 31, 22: 28, 24: 33, 28: 51, 29: 70, 30: 69, 32: 64, 36: 37, 38: 52, 39: 55, 40: 32, 95: 58 };
const errno = (v) => E[-v] ?? 29;
const ftype = (mode) => ({ 0o040000: 3, 0o100000: 4, 0o020000: 2, 0o060000: 1, 0o120000: 7, 0o140000: 6 })[mode & 0o170000] ?? 0;
const dtype = { 1: 0, 2: 2, 4: 3, 6: 1, 8: 4, 10: 7, 12: 6 };
export class Exit { constructor(code) { this.code = code; } }

/** The "path\0args\0\0env" description (wasi_info) as { args, envs }. */
export function parseInfo(bytes) {
  const parts = new TextDecoder().decode(bytes).split('\0');
  const sep = parts.indexOf('', 1);
  return { path: parts[0], args: parts.slice(1, sep), envs: parts.slice(sep + 1).filter((s) => s) };
}

/** Runs WebAssembly process `pid` (from x.wasi_next()) to its end inside the engine's own thread;
 *  returns its exit code. x = engine exports; opts.wait(n) is called when every process waits;
 *  opts.serve() after each engine slice, to answer what the kernel asks the host meanwhile (pieces of
 *  a device folder's file, linux_mount_fetch): a read of a big /mnt file waits on them. */
export function runWasi(x, pid, opts = {}) {
  const emem = () => new Uint8Array(x.memory.buffer);
  const k = x.wasi_info(pid);
  const { path, args, envs } = parseInfo(emem().slice(x.out_ptr(), x.out_ptr() + k));
  const bytes = (() => { const n = x.wasi_module(pid); return emem().slice(x.out_ptr(), x.out_ptr() + n); })();
  const key = genKey(x, pid, path, bytes.length);
  // one Linux call of the stub: data goes to BASE first, `outLen` bytes come back
  function sys(nr, a = [], data, outLen = 0) {
    const d = data || new Uint8Array(0);
    const p = x.buffer(d.length); emem().set(d, p);
    const q = [...a, 0, 0, 0, 0, 0, 0].slice(0, 6);
    if (x.wasi_call(pid, nr, q[0], q[1], q[2], q[3], q[4], q[5], outLen) !== 0) throw new Exit(-1);
    let n, idle = 0;
    while ((n = x.wasi_take(pid)) === -1) {
      const st = x.run(500000);
      if (opts.serve) opts.serve();
      if (st === 1 || st === 2) throw new Exit(-1);
      if (st === 3 && opts.wait) opts.wait(++idle); else idle = 0;
    }
    if (n === -2) throw new Exit(-1); // the process was killed (Ctrl+C, kill)
    const out = n > 0 ? emem().slice(x.out_ptr(), x.out_ptr() + n) : null;
    return { r: x.wasi_ret(), out };
  }
  return runModule({ bytes, key, args, envs, base: x.wasi_base(), size: x.wasi_buf_size(), sys, inline: true });
}

/** JS programs: a module that is only a custom section "inkshell.js" whose content names the program
 *  (e.g. /usr/local/libexec/inkvideo-webcodecs = "inkvideo"); it runs as JS with the same calls. */
const JS = { inkvideo };
export function jsProgram(bytes) {
  if (bytes.length > 64 || bytes[8] !== 0 || bytes[9] !== bytes.length - 10) return null;
  const d = new TextDecoder(), n = bytes[10];
  return d.decode(bytes.subarray(11, 11 + n)) === 'inkshell.js' ? JS[d.decode(bytes.subarray(11 + n))] || null : null;
}

/** wasi-libc's working-directory pointer (__wasilibc_cwd, initially the address of a "/" string):
 *  { ptr, lit } when exactly one word of the active data segments points at a "/\0" string and that
 *  address is an i32.const in the code (or, when none is, the offset of an "i32.const 0; i32.load"); null otherwise (then the module keeps the fallback folders). */
export function cwdSlot(b) {
  let p = 8, code = null; const segs = [];
  const leb = () => { let r = 0, s = 0, c; do { c = b[p++]; r += (c & 127) * 2 ** s; s += 7; } while (c & 128); return r; };
  try {
    while (p < b.length) {
      const id = b[p++], len = leb(), end = p + len;
      if (id === 10) code = [p, end];
      if (id === 11) for (let n = leb(); n > 0; n--) {
        const fl = leb();
        if (fl === 1) { p += leb(); continue; }
        if (fl === 2) leb();
        if (b[p++] !== 0x41) return null;
        const off = leb(); p++; const l = leb(); // i32.const (a positive value reads the same as unsigned), end
        segs.push([off, p, l]); p += l;
      }
      p = end;
    }
  } catch { return null; }
  const top = segs.reduce((t, [o, , l]) => Math.max(t, o + l), 0);
  if (!code || top > 1 << 28) return null;
  const m = new Uint8Array(top + 1); // the data as it is in memory at start
  for (const [o, q, l] of segs) m.set(b.subarray(q, q + l), o);
  const at = (a) => (a < top ? m[a] : 0);
  const found = [];
  for (const [o, q, l] of segs) {
    for (let i = (4 - o % 4) % 4; i + 4 <= l; i += 4) {
      const v = b[q + i] | b[q + i + 1] << 8 | b[q + i + 2] << 16 | b[q + i + 3] << 24;
      if (v > 0 && at(v) === 47 && at(v + 1) === 0) found.push({ ptr: o + i, lit: v });
      if (found.length > 64) return null;
    }
  }
  const want = new Map(found.map((f) => [f.ptr, f])), used = new Set();
  for (let i = code[0]; i < code[1] - 5; i++) { // every i32.const that names one of them
    if (b[i] !== 0x41) continue;
    let v = 0, k = 0, c;
    do { c = b[i + 1 + k]; v += (c & 127) * 2 ** (7 * k); k++; } while (c & 128 && k < 5);
    if (!(c & 64) && want.has(v)) used.add(want.get(v));
  }
  if (!used.size) for (let i = code[0]; i < code[1] - 8; i++) { // newer clang: "i32.const 0; i32.load offset=ptr"
    if (b[i] !== 0x41 || b[i + 1] !== 0 || b[i + 2] !== 0x28) continue;
    let j = i + 3, v = 0, k = 0, c;
    while (b[j++] & 128); // alignment
    do { c = b[j++]; v += (c & 127) * 2 ** (7 * k); k++; } while (c & 128 && k < 5);
    if (want.has(v)) used.add(want.get(v));
  }
  return used.size === 1 ? [...used][0] : null;
}

/** A key for the module's content (length + two 32-bit hashes of all of it; a few ms for python's 26 MB). */
export function moduleKey(b) {
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9, i = 0;
  if (b.byteOffset % 4 === 0) {
    const w = new Uint32Array(b.buffer, b.byteOffset, b.length >>> 2);
    for (; i < w.length; i++) {
      const v = w[i];
      h1 = Math.imul(h1 ^ v, 0x01000193); h1 = h1 << 13 | h1 >>> 19;
      h2 = Math.imul(h2 + v | 0, 0x85ebca6b); h2 ^= h2 >>> 15;
    }
    i *= 4;
  }
  for (; i < b.length; i++) { h1 = Math.imul(h1 ^ b[i], 0x01000193); h2 = Math.imul(h2 + b[i] | 0, 0x85ebca6b) ^ h2 >>> 15; }
  return b.length + ':' + (h1 >>> 0).toString(16) + ':' + (h2 >>> 0).toString(16);
}
/** A cheap key for the module file of process `pid`: the kernel's version of the file (wasi_module_gen,
 *  new at each change of it) with this engine's id, path and length; null when the file has none (a
 *  small file kept in memory, or an engine without the export): then moduleKey (a hash) is used. */
const engIds = new WeakMap();
export function genKey(x, pid, path, len, id) {
  const g = typeof x.wasi_module_gen === 'function' ? x.wasi_module_gen(pid) : 0;
  if (!g) return null;
  if (id == null) { if (!engIds.has(x)) engIds.set(x, Math.random().toString(36).slice(2)); id = engIds.get(x); }
  return id + ':' + g + ':' + len + ':' + path;
}
/** Compiled modules by key (genKey): a program run again is not compiled again (V8/JSC also keep the
 *  functions compiled lazily by the earlier runs). A few only: each holds the module's machine code. */
const modCache = new Map();
const MODS = 4;
export function cacheModule(cache, key, mod) {
  cache.delete(key); cache.set(key, mod);
  while (cache.size > MODS) cache.delete(cache.keys().next().value);
}
/** A cheap key (length + FNV of the first and last 4 KB: ~0 ms) for the catalog modules whose cwdSlot is
 *  shipped in KNOWN (tools/wasm-tools/known-slots.mjs computes them from the catalog files). */
export function fastKey(b) {
  let h = 0x811c9dc5;
  for (const [a, e] of [[0, Math.min(4096, b.length)], [Math.max(0, b.length - 4096), b.length]])
    for (let i = a; i < e; i++) h = Math.imul(h ^ b[i], 0x01000193);
  return b.length + ':' + (h >>> 0).toString(16);
}
/** Shipped cwdSlot of the catalog modules, by fastKey (no search, no hash on the first run). */
export const KNOWN = {};
KNOWN['26267204:5b797def'] = { ptr: 4728288, lit: 751636 }; // python3.wasm
KNOWN['24470606:a4a50657'] = { ptr: 20570696, lit: 16866701 }; // ruby.wasm
KNOWN['2115894:7d0408b4'] = { ptr: 8487468, lit: 8416887 }; // 7zip.wasm
KNOWN['6583149:19625083'] = { ptr: 8667268, lit: 8443918 }; // qpdf.wasm
KNOWN['5469573:e8cd6eaa'] = { ptr: 9171104, lit: 8562254 }; // imagemagick.wasm
KNOWN['17376451:e7f4e40a'] = { ptr: 12030692, lit: 8676883 }; // ffmpeg.wasm
KNOWN['17281341:329057e6'] = { ptr: 12010836, lit: 8674218 }; // ffprobe.wasm
KNOWN['2073786:fbfb418b'] = { ptr: 8533592, lit: 8436761 }; // sqlite.wasm
KNOWN['1013105:144787f'] = { ptr: 8464392, lit: 8403573 }; // jq.wasm
KNOWN['719943:9afa8bef'] = { ptr: 8420180, lit: 8395242 }; // lua5.4.wasm
KNOWN['574467:8f66d51c'] = { ptr: 8436172, lit: 8412357 }; // zip.wasm
KNOWN['503577:8ecea3b'] = { ptr: 8426140, lit: 8395007 }; // unzip.wasm
KNOWN['3403081:6d06aeea'] = { ptr: 2222148, lit: 1072918 }; // ripgrep.wasm
KNOWN['321558:454cc1c1'] = { ptr: 72444, lit: 65857 }; // hashtools.wasm
/** cwdSlot results by moduleKey: the search (~135 ms for python3) runs once per module in this thread.
 *  On the page each program has a new Worker, so app.js keeps the results and hands them over (slots, onSlot). */
const slotCache = new Map();
/** Each lookup: { hit, ms } (ms = key + search), for tests and benches. */
export const cwdStats = [];
function slotOf(bytes, slots, onSlot, k) {
  const t = performance.now(), fk = fastKey(bytes), known = KNOWN[fk], key = k || (known ? fk : moduleKey(bytes)), hit = slots.has(key);
  const s = hit ? slots.get(key) : known || cwdSlot(bytes);
  if (!hit) { slots.set(key, s); if (onSlot) onSlot(key, s); }
  cwdStats.push({ hit, ms: performance.now() - t });
  if (cwdStats.length > 64) cwdStats.shift();
  return s && { ptr: s.ptr, lit: s.lit };
}

/** Runs a WASI module whose calls go through `sys(nr, args, data, outLen) -> { r, out }`
 *  (a Linux call of the stub process; throws Exit when the process is gone). */
export function runModule({ bytes, key = null, module = null, args, envs, base: BASE, size: SIZE, sys, inline = false, slots = slotCache, onSlot, mods = modCache, onModule }) {
  const prog = jsProgram(bytes);
  if (prog) { // its exit code (a Promise of it when it works asynchronously, as WebCodecs does)
    const end = (c) => { try { sys(231, [c]); } catch {} return c; };
    let r; try { r = prog({ args, sys, base: BASE, size: SIZE, inline }); } catch { return end(1); }
    return typeof r === 'number' ? end(r) : r.then(end, () => end(1));
  }
  const dec = new TextDecoder(), enc = new TextEncoder();
  const cstr = (s) => { const b = enc.encode(s), o = new Uint8Array(b.length + 1); o.set(b); return o; };
  // WASI fd -> Linux fd; 3... = the preopens (see "Folders" above)
  const fds = new Map([[0, 0], [1, 1], [2, 2]]);
  const pre = new Map();
  let nextFd = 3;
  const opendir = (p) => sys(257, [-100, BASE, 0x10000 | 0x80000], cstr(p)).r;
  const preopen = (lfd, name) => { if (lfd >= 0) { fds.set(nextFd, lfd); pre.set(nextFd++, name); } };
  let slot = null, vroot = -1, cwdFd = -1, rootFd = -1;
  const hints = []; // { h: path without the leading "/" or "./", abs: it began with "/" }
  const strip = (x) => { for (;;) { if (x[0] === '/') x = x.slice(1); else if (x.startsWith('./')) x = x.slice(2); else if (x === '.') x = ''; else break; } return x.replace(/\/+$/, ''); };
  const has = (lfd, name) => sys(262, [lfd, BASE, BASE + 4096, 0x100], cstr(name), 4096 + 144).r === 0;
  /** Without chdir in the module wasi-libc sends "x" and "/x" alike, as "x" on the "/" preopen: true when the
   *  real root is meant. The longest argument path that contains it says which; else the one of the shell's
   *  folder and the real root that has its first name; else an argument "/" or "." (alone); else the folder. */
  const pick = (p) => {
    const q = strip(p); let best = 0, kinds = new Set(), zero = new Set();
    for (const { h, abs } of hints) {
      if (!h) { zero.add(abs); continue; }
      if (q !== h && !q.startsWith(h + '/')) continue;
      if (h.length > best) { best = h.length; kinds = new Set([abs]); } else if (h.length === best) kinds.add(abs);
    }
    if (kinds.size === 1) return [...kinds][0];
    const first = q.split('/')[0];
    if (first && first !== '..') { const r = has(rootFd, first); if (r !== has(cwdFd, first)) return r; }
    return zero.size === 1 && [...zero][0];
  };
  try {
    const { r, out } = sys(79, [BASE, 4096], null, 4096);
    const cwd = r > 1 ? dec.decode(out.subarray(0, r - 1)) : '/';
    slot = cwd !== '/' ? slotOf(bytes, slots, onSlot, key) : null;
    if (slot) { // real root at "/", the shell's folder becomes wasi-libc's cwd (see environ_get)
      envs = [...envs.filter((e) => !e.startsWith('PWD=')), 'PWD=' + cwd];
      slot.at = envs.slice(0, -1).reduce((n, e) => n + enc.encode(e).length + 1, 4);
    }
    if (cwd !== '/' && !slot) { // one "/" preopen for both: each path goes to the shell's folder or the real root (pick)
      cwdFd = opendir(cwd); rootFd = opendir('/');
      if (cwdFd >= 0 && rootFd >= 0) {
        vroot = nextFd;
        for (let i = 1; i < args.length; i++) { // the paths named in the arguments ("--out=x" too)
          let a = args[i]; if (!a || a.length > 1024) continue;
          if (a[0] === '-') { const e = a.indexOf('='); if (e < 0) continue; a = a.slice(e + 1); }
          const abs = a[0] === '/', h = strip(a), first = h.split('/')[0];
          if (!h || first === '..' || has(abs ? rootFd : cwdFd, first)) hints.push({ h, abs });
        }
      }
    }
    const c = slot ? -1 : vroot >= 0 ? cwdFd : opendir(cwd);
    preopen(c >= 0 ? c : opendir('/'), '/');
  } catch { return -1; } // ended before it started
  const dirs = new Map(); // fd -> entries read by fd_readdir
  let inst, mem;
  const dv = () => new DataView(mem.buffer);
  const u8 = () => new Uint8Array(mem.buffer);
  const L = (fd) => fds.get(fd);
  const str = (p, n) => dec.decode(u8().slice(p, p + n));
  const at = (fd, p) => (fd === vroot ? (pick(p) ? rootFd : cwdFd) : L(fd)); // the Linux fd for a path on fd
  const pathCall = (nr, fd, p, n, extra = [], outLen = 0) => {
    const s = str(p, n), lfd = at(fd, s); if (lfd == null) return { r: -9 };
    return sys(nr, [lfd, BASE, ...extra], cstr(s), outLen);
  };
  const filestat = (b, ptr) => {
    const s = new DataView(b.buffer, b.byteOffset), d = dv();
    const ns = (o) => BigInt(s.getUint32(o, true)) * 1000000000n + BigInt(s.getUint32(o + 8, true));
    d.setBigUint64(ptr, s.getBigUint64(0, true), true); d.setBigUint64(ptr + 8, s.getBigUint64(8, true), true);
    d.setUint8(ptr + 16, ftype(s.getUint32(24, true))); for (let k = 17; k < 24; k++) d.setUint8(ptr + k, 0);
    d.setBigUint64(ptr + 24, s.getBigUint64(16, true), true); d.setBigUint64(ptr + 32, s.getBigUint64(48, true), true);
    d.setBigUint64(ptr + 40, ns(72), true); d.setBigUint64(ptr + 48, ns(88), true); d.setBigUint64(ptr + 56, ns(104), true);
  };
  const strings = (list, ptrs, buf) => { const d = dv(); let o = buf; list.forEach((s, i) => { const b = cstr(s); d.setUint32(ptrs + 4 * i, o, true); u8().set(b, o); o += b.length; }); return 0; };
  const sizes = (list, a, b) => { dv().setUint32(a, list.length, true); dv().setUint32(b, list.reduce((t, s) => t + enc.encode(s).length + 1, 0), true); return 0; };
  const iovs = (p, n) => { const d = dv(), v = []; for (let i = 0; i < n; i++) v.push([d.getUint32(p + 8 * i, true), d.getUint32(p + 8 * i + 4, true)]); return v; };
  const write = (fd, iov, n, off) => {
    const lfd = L(fd); if (lfd == null) return [8, 0];
    let total = 0;
    const all = new Uint8Array(iovs(iov, n).reduce((t, [, l]) => t + l, 0));
    { let o = 0; for (const [p, l] of iovs(iov, n)) { all.set(u8().subarray(p, p + l), o); o += l; } }
    while (total < all.length) {
      const c = all.subarray(total, total + Math.min(SIZE, all.length - total));
      const { r } = off == null ? sys(1, [lfd, BASE, c.length], c) : sys(18, [lfd, BASE, c.length, off + total], c);
      if (r < 0) { if (total) break; return [errno(r), 0]; }
      if (r === 0) break;
      total += r;
    }
    return [0, total];
  };
  const read = (fd, iov, n, off) => {
    const lfd = L(fd); if (lfd == null) return [8, 0];
    let total = 0;
    for (const [p, l] of iovs(iov, n)) {
      let got = 0;
      while (got < l) {
        const want = Math.min(SIZE, l - got);
        const { r, out } = off == null ? sys(0, [lfd, BASE, want], null, want) : sys(17, [lfd, BASE, want, off + total], null, want);
        if (r < 0) return total ? [0, total] : [errno(r), 0];
        if (r === 0) return [0, total];
        u8().set(out.subarray(0, r), p + got); got += r; total += r;
        if (r < want) return [0, total]; // a short read (terminal line, pipe): give what came
      }
    }
    return [0, total];
  };
  const done = ([err, n], np) => { if (!err) dv().setUint32(np, n, true); return err; };
  // the process ends: exit_group in the stub (its parent gets `code`)
  const exit = (code) => { try { sys(231, [code]); } catch {} throw new Exit(code); };
  const w = {
    args_get: (a, b) => strings(args, a, b), args_sizes_get: (a, b) => sizes(args, a, b),
    environ_get: (a, b) => { // the "PWD=..." string, in the program's memory now, becomes its cwd
      strings(envs, a, b);
      if (slot && dv().getUint32(slot.ptr, true) === slot.lit) dv().setUint32(slot.ptr, b + slot.at, true);
      return 0;
    }, environ_sizes_get: (a, b) => sizes(envs, a, b),
    clock_res_get: (id, p) => { dv().setBigUint64(p, 1000n, true); return 0; },
    clock_time_get: (id, prec, p) => { dv().setBigUint64(p, id === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
    random_get: (p, n) => { const b = new Uint8Array(n); for (let o = 0; o < n; o += 65536) crypto.getRandomValues(b.subarray(o, Math.min(n, o + 65536))); u8().set(b, p); return 0; },
    sched_yield: () => 0,
    proc_exit: (code) => exit(code),
    proc_raise: () => 52,
    fd_write: (fd, iov, n, np) => done(write(fd, iov, n), np),
    fd_pwrite: (fd, iov, n, off, np) => done(write(fd, iov, n, Number(off)), np),
    fd_read: (fd, iov, n, np) => done(read(fd, iov, n), np),
    fd_pread: (fd, iov, n, off, np) => done(read(fd, iov, n, Number(off)), np),
    fd_close: (fd) => { const lfd = L(fd); if (lfd == null) return 8; const { r } = sys(3, [lfd]); fds.delete(fd); dirs.delete(fd); return r < 0 ? errno(r) : 0; },
    fd_seek: (fd, off, wh, p) => { const lfd = L(fd); if (lfd == null) return 8; const { r } = sys(8, [lfd, Number(off), wh]); if (r < 0) return errno(r); dv().setBigUint64(p, BigInt(r), true); return 0; },
    fd_tell: (fd, p) => w.fd_seek(fd, 0n, 1, p),
    fd_sync: () => 0, fd_datasync: () => 0, fd_advise: () => 0, fd_allocate: () => 0,
    fd_fdstat_get: (fd, p) => {
      const lfd = L(fd); if (lfd == null) return 8;
      const { r, out } = sys(5, [lfd, BASE], null, 144); if (r < 0) return errno(r);
      const fl = sys(72, [lfd, 3]).r;
      const d = dv(); d.setUint8(p, ftype(new DataView(out.buffer).getUint32(24, true))); d.setUint8(p + 1, 0);
      d.setUint16(p + 2, (fl > 0 && fl & 0x400 ? 1 : 0) | (fl > 0 && fl & 0x800 ? 4 : 0), true);
      d.setUint32(p + 4, 0, true);
      // a terminal (TCGETS works) has no seek/tell rights: that is how wasi-libc's isatty() tells (Python's prompt)
      d.setBigUint64(p + 8, d.getUint8(p) === 2 && sys(16, [lfd, 0x5401, BASE], null, 64).r === 0 ? 0x1fffffffn & ~0x24n : 0x1fffffffn, true); d.setBigUint64(p + 16, 0x1fffffffn, true);
      return 0;
    },
    fd_fdstat_set_flags: (fd, f) => { const lfd = L(fd); if (lfd == null) return 8; sys(72, [lfd, 4, (f & 1 ? 0x400 : 0) | (f & 4 ? 0x800 : 0)]); return 0; },
    fd_fdstat_set_rights: () => 0,
    fd_filestat_get: (fd, p) => { const lfd = L(fd); if (lfd == null) return 8; const { r, out } = sys(5, [lfd, BASE], null, 144); if (r < 0) return errno(r); filestat(out, p); return 0; },
    fd_filestat_set_size: (fd, n) => { const lfd = L(fd); if (lfd == null) return 8; const { r } = sys(77, [lfd, Number(n)]); return r < 0 ? errno(r) : 0; },
    fd_filestat_set_times: () => 0,
    fd_prestat_get: (fd, p) => { if (!pre.has(fd)) return 8; dv().setUint32(p, 0, true); dv().setUint32(p + 4, enc.encode(pre.get(fd)).length, true); return 0; },
    fd_prestat_dir_name: (fd, p, n) => { if (!pre.has(fd)) return 8; u8().set(enc.encode(pre.get(fd)).subarray(0, n), p); return 0; },
    fd_renumber: (a, b) => { const la = L(a), lb = L(b); if (la == null || lb == null) return 8; const { r } = sys(33, [la, lb]); if (r < 0) return errno(r); sys(3, [la]); fds.delete(a); return 0; },
    fd_readdir: (fd, buf, len, cookie, np) => {
      const lfd = L(fd); if (lfd == null) return 8;
      let list = dirs.get(fd);
      if (!list || cookie === 0n) {
        list = []; sys(8, [lfd, 0, 0]);
        for (;;) {
          const { r, out } = sys(217, [lfd, BASE, 65536], null, 65536);
          if (r < 0) return errno(r);
          if (r === 0) break;
          const s = new DataView(out.buffer);
          for (let o = 0; o < r;) {
            const rl = s.getUint16(o + 16, true), ty = s.getUint8(o + 18);
            let e = o + 19; while (e < o + rl && out[e]) e++;
            list.push({ ino: s.getBigUint64(o, true), type: dtype[ty] ?? 0, name: out.slice(o + 19, e) });
            o += rl;
          }
        }
        dirs.set(fd, list);
      }
      let used = 0;
      for (let i = Number(cookie); i < list.length && used < len; i++) {
        const e = list[i], h = new Uint8Array(24 + e.name.length), hv = new DataView(h.buffer);
        hv.setBigUint64(0, BigInt(i + 1), true); hv.setBigUint64(8, e.ino, true); hv.setUint32(16, e.name.length, true); hv.setUint8(20, e.type);
        h.set(e.name, 24);
        const c = h.subarray(0, Math.min(h.length, len - used));
        u8().set(c, buf + used); used += c.length;
      }
      dv().setUint32(np, used, true);
      return 0;
    },
    path_open: (fd, lookup, p, n, oflags, rb, ri, fdflags, fdp) => {
      const rd = (rb & 2n) !== 0n, wr = (rb & 0x40n) !== 0n || (fdflags & 1) !== 0;
      let fl = (oflags & 2) ? 0x10000 : wr ? (rd ? 2 : 1) : 0;
      if (oflags & 1) fl |= 0x40; if (oflags & 4) fl |= 0x80; if (oflags & 8) fl |= 0x200;
      if (fdflags & 1) fl |= 0x400; if (fdflags & 4) fl |= 0x800; if (!(lookup & 1)) fl |= 0x20000;
      fl |= 0x80000; // O_CLOEXEC: the module's files are not for programs the stub would start
      let { r } = pathCall(257, fd, p, n, [fl, 0o666]);
      if (r === -21 && !(oflags & 2)) r = pathCall(257, fd, p, n, [0x10000 | 0x80000, 0]).r; // a folder opened to read it
      if (r < 0) return errno(r);
      const nfd = nextFd++; fds.set(nfd, r); dv().setUint32(fdp, nfd, true); return 0;
    },
    path_filestat_get: (fd, lookup, p, n, sp) => { const { r, out } = pathCall(262, fd, p, n, [BASE + 4096, lookup & 1 ? 0 : 0x100], 4096 + 144); if (r < 0) return errno(r); filestat(out.subarray(4096), sp); return 0; },
    path_filestat_set_times: () => 0,
    path_create_directory: (fd, p, n) => { const { r } = pathCall(258, fd, p, n, [0o777]); return r < 0 ? errno(r) : 0; },
    path_unlink_file: (fd, p, n) => { const { r } = pathCall(263, fd, p, n, [0]); return r < 0 ? errno(r) : 0; },
    path_remove_directory: (fd, p, n) => { const { r } = pathCall(263, fd, p, n, [0x200]); return r < 0 ? errno(r) : 0; },
    path_rename: (fd, p, n, fd2, p2, n2) => {
      const a = at(fd, str(p, n)), b = at(fd2, str(p2, n2)); if (a == null || b == null) return 8;
      const s1 = cstr(str(p, n)), s2 = cstr(str(p2, n2)), d = new Uint8Array(4096 + s2.length); d.set(s1); d.set(s2, 4096);
      const { r } = sys(264, [a, BASE, b, BASE + 4096], d); return r < 0 ? errno(r) : 0;
    },
    path_readlink: (fd, p, n, buf, len, np) => { const { r, out } = pathCall(267, fd, p, n, [BASE + 4096, len], 4096 + len); if (r < 0) return errno(r); u8().set(out.subarray(4096, 4096 + r), buf); dv().setUint32(np, r, true); return 0; },
    path_symlink: (p, n, fd, p2, n2) => {
      const b = at(fd, str(p2, n2)); if (b == null) return 8;
      const s1 = cstr(str(p, n)), s2 = cstr(str(p2, n2)), d = new Uint8Array(4096 + s2.length); d.set(s1); d.set(s2, 4096);
      const { r } = sys(266, [BASE, b, BASE + 4096], d); return r < 0 ? errno(r) : 0;
    },
    path_link: (fd, fl, p, n, fd2, p2, n2) => { // hard link (cp -l, ln without -s): linkat
      const a = at(fd, str(p, n)), b = at(fd2, str(p2, n2)); if (a == null || b == null) return 8;
      const s1 = cstr(str(p, n)), s2 = cstr(str(p2, n2)), d = new Uint8Array(4096 + s2.length); d.set(s1); d.set(s2, 4096);
      const { r } = sys(265, [a, BASE, b, BASE + 4096, fl & 1 ? 0x400 : 0], d); return r < 0 ? errno(r) : 0;
    },
    poll_oneoff: (inp, outp, n, np) => {
      const d = dv(); let wait = -1;
      for (let i = 0; i < n; i++) {
        const s = inp + 48 * i, o = outp + 32 * i, tag = d.getUint8(s + 8);
        d.setBigUint64(o, d.getBigUint64(s, true), true); d.setUint16(o + 8, 0, true); d.setUint8(o + 10, tag);
        if (tag === 0) { let t = Number(d.getBigUint64(s + 24, true)); if (d.getUint16(s + 40, true) & 1) t = Math.max(0, t - (Date.now() * 1e6)); wait = wait < 0 ? t : Math.min(wait, t); }
      }
      if (wait > 0) { const ts = new Uint8Array(16), tv = new DataView(ts.buffer); tv.setBigUint64(0, BigInt(Math.floor(wait / 1e9)), true); tv.setBigUint64(8, BigInt(wait % 1e9), true); sys(35, [BASE, 0], ts); }
      d.setUint32(np, n, true); return 0;
    },
    sock_accept: () => 52, sock_recv: () => 52, sock_send: () => 52, sock_shutdown: () => 52,
  };
  let code = 0;
  try {
    let mod = module || (key && mods.get(key));
    if (!mod) { mod = new WebAssembly.Module(bytes); if (key) { cacheModule(mods, key, mod); if (onModule) onModule(key, mod); } }
    else if (key) cacheModule(mods, key, mod);
    const imports = { wasi_snapshot_preview1: w, wasi_unstable: w };
    for (const i of WebAssembly.Module.imports(mod)) if (!imports[i.module]) imports[i.module] = {};
    inst = new WebAssembly.Instance(mod, imports);
    mem = inst.exports.memory;
    if (inst.exports._start) inst.exports._start(); else if (inst.exports._initialize) inst.exports._initialize();
    exit(0);
  } catch (e) {
    if (e instanceof Exit) code = e.code;
    else { // a trap or a bad module: say why on stderr, exit 127 (134 for a trap, like an abort)
      code = e instanceof WebAssembly.RuntimeError ? 134 : 127;
      try { const m = enc.encode(`${args[0] || 'wasm'}: ${e.message}\n`); sys(1, [2, BASE, m.length], m); exit(code); } catch {}
    }
  }
  return code;
}

/** Message framing between wasi-worker.js and the engine's worker: [u32 header length][JSON header][data]. */
export function pack(h, data) {
  const j = new TextEncoder().encode(JSON.stringify(h)), d = data || new Uint8Array(0);
  const b = new Uint8Array(4 + j.length + d.length);
  new DataView(b.buffer).setUint32(0, j.length, true); b.set(j, 4); b.set(d, 4 + j.length);
  return b;
}
export function unpack(b) {
  const n = new DataView(b.buffer, b.byteOffset).getUint32(0, true);
  return { h: JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + n))), out: b.slice(4 + n) };
}
