// WASI (preview1) programs on the InkShell kernel. When a process execs a .wasm file, the kernel
// turns it into a small stub process and lists it in wasi_next(); this file runs the module and
// makes each WASI call a Linux call of that stub (wasi_call / wasi_take), so the program uses the
// process's own files, pipes, terminal and /mnt, and the shell sees a normal process (pid, exit code).
// Calls are synchronous. In node (tests) the module runs in the engine's thread (runWasi); on the
// page it runs in its own Worker (wasi-worker.js) and each call is a synchronous request that the
// service worker (sw.js) passes to the engine's worker, which keeps running meanwhile.
// Limits: relative paths resolve from "/"; no sockets.
const E = { 1: 63, 2: 44, 4: 27, 5: 29, 9: 8, 11: 6, 12: 48, 13: 2, 17: 20, 18: 75, 20: 54, 21: 31, 22: 28, 24: 33, 28: 51, 29: 70, 30: 69, 32: 64, 36: 37, 38: 52, 39: 55, 40: 32, 95: 58 };
const errno = (v) => E[-v] ?? 29;
const ftype = (mode) => ({ 0o040000: 3, 0o100000: 4, 0o020000: 2, 0o060000: 1, 0o120000: 7, 0o140000: 6 })[mode & 0o170000] ?? 0;
const dtype = { 1: 0, 2: 2, 4: 3, 6: 1, 8: 4, 10: 7, 12: 6 };
export class Exit { constructor(code) { this.code = code; } }

/** The "path\0args\0\0env" description (wasi_info) as { args, envs }. */
export function parseInfo(bytes) {
  const parts = new TextDecoder().decode(bytes).split('\0');
  const sep = parts.indexOf('', 1);
  return { args: parts.slice(1, sep), envs: parts.slice(sep + 1).filter((s) => s) };
}

/** Runs WebAssembly process `pid` (from x.wasi_next()) to its end inside the engine's own thread;
 *  returns its exit code. x = engine exports; opts.wait(n) is called when every process waits. */
export function runWasi(x, pid, opts = {}) {
  const emem = () => new Uint8Array(x.memory.buffer);
  const k = x.wasi_info(pid);
  const { args, envs } = parseInfo(emem().slice(x.out_ptr(), x.out_ptr() + k));
  const bytes = (() => { const n = x.wasi_module(pid); return emem().slice(x.out_ptr(), x.out_ptr() + n); })();
  // one Linux call of the stub: data goes to BASE first, `outLen` bytes come back
  function sys(nr, a = [], data, outLen = 0) {
    const d = data || new Uint8Array(0);
    const p = x.buffer(d.length); emem().set(d, p);
    const q = [...a, 0, 0, 0, 0, 0, 0].slice(0, 6);
    if (x.wasi_call(pid, nr, q[0], q[1], q[2], q[3], q[4], q[5], outLen) !== 0) throw new Exit(-1);
    let n, idle = 0;
    while ((n = x.wasi_take(pid)) === -1) {
      const st = x.run(500000);
      if (st === 1 || st === 2) throw new Exit(-1);
      if (st === 3 && opts.wait) opts.wait(++idle); else idle = 0;
    }
    if (n === -2) throw new Exit(-1); // the process was killed (Ctrl+C, kill)
    const out = n > 0 ? emem().slice(x.out_ptr(), x.out_ptr() + n) : null;
    return { r: x.wasi_ret(), out };
  }
  return runModule({ bytes, args, envs, base: x.wasi_base(), size: x.wasi_buf_size(), sys });
}

/** Runs a WASI module whose calls go through `sys(nr, args, data, outLen) -> { r, out }`
 *  (a Linux call of the stub process; throws Exit when the process is gone). */
export function runModule({ bytes, args, envs, base: BASE, size: SIZE, sys }) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  const cstr = (s) => { const b = enc.encode(s), o = new Uint8Array(b.length + 1); o.set(b); return o; };
  // WASI fd -> Linux fd; 3 = "/" (preopened)
  const fds = new Map([[0, 0], [1, 1], [2, 2]]);
  const pre = new Map();
  try { const { r } = sys(257, [-100, BASE, 0x10000 | 0x80000], cstr('/')); if (r >= 0) { fds.set(3, r); pre.set(3, '/'); } } catch { return -1; } // ended before it started
  let nextFd = 4;
  const dirs = new Map(); // fd -> entries read by fd_readdir
  let inst, mem;
  const dv = () => new DataView(mem.buffer);
  const u8 = () => new Uint8Array(mem.buffer);
  const L = (fd) => fds.get(fd);
  const str = (p, n) => dec.decode(u8().slice(p, p + n));
  const pathCall = (nr, fd, p, n, extra = [], outLen = 0) => {
    const lfd = L(fd); if (lfd == null) return { r: -9 };
    return sys(nr, [lfd, BASE, ...extra], cstr(str(p, n)), outLen);
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
    environ_get: (a, b) => strings(envs, a, b), environ_sizes_get: (a, b) => sizes(envs, a, b),
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
      d.setUint32(p + 4, 0, true); d.setBigUint64(p + 8, 0x1fffffffn, true); d.setBigUint64(p + 16, 0x1fffffffn, true);
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
      const a = L(fd), b = L(fd2); if (a == null || b == null) return 8;
      const s1 = cstr(str(p, n)), s2 = cstr(str(p2, n2)), d = new Uint8Array(4096 + s2.length); d.set(s1); d.set(s2, 4096);
      const { r } = sys(264, [a, BASE, b, BASE + 4096], d); return r < 0 ? errno(r) : 0;
    },
    path_readlink: (fd, p, n, buf, len, np) => { const { r, out } = pathCall(267, fd, p, n, [BASE + 4096, len], 4096 + len); if (r < 0) return errno(r); u8().set(out.subarray(4096, 4096 + r), buf); dv().setUint32(np, r, true); return 0; },
    path_symlink: (p, n, fd, p2, n2) => {
      const b = L(fd); if (b == null) return 8;
      const s1 = cstr(str(p, n)), s2 = cstr(str(p2, n2)), d = new Uint8Array(4096 + s2.length); d.set(s1); d.set(s2, 4096);
      const { r } = sys(266, [BASE, b, BASE + 4096], d); return r < 0 ? errno(r) : 0;
    },
    path_link: () => 52,
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
    const mod = new WebAssembly.Module(bytes);
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
