// inkvideo: video decode/transcode with the page's WebCodecs (VideoDecoder/VideoEncoder: H.264/HEVC by
// the device's hardware when it has it). It is a "JS program" of the terminal: /usr/local/libexec/
// inkvideo-webcodecs is a tiny WebAssembly module with only a custom section "inkshell.js" = "inkvideo",
// so the kernel starts it like any WASI program (stub process, wasi.js) and wasi.js runs main() below
// instead of instantiating it. Files go through the same Linux calls (open, pread, write) in pieces:
// never a whole file in memory. Without WebCodecs (node, CI, an old browser, or the engine's own thread)
// it exits 69 and /usr/local/bin/inkvideo falls back to ffmpeg (software) where it can.
// Input: MP4/MOV (H.264 avc1/avc3, HEVC hvc1/hev1) or a raw Annex B stream (.h264/.264/.265/.hevc).
// Output: decode -> YUV4MPEG2 (.y4m, I420) or only a count + fps; transcode -> raw Annex B H.264/HEVC.
export const NO_WEBCODECS = 69;
const USAGE = `usage: inkvideo info                      WebCodecs and codecs here (hw = hardware)
       inkvideo decode IN [OUT.y4m]       decode (no OUT: count frames, show fps)
       inkvideo transcode IN OUT [--codec h264|hevc] [--bitrate BPS] [--sw]
       inkvideo selftest [OUT]            encode + decode 30 frames here (OUT: the H.264/HEVC stream)
IN: .mp4/.mov (H.264/HEVC) or raw .h264/.265; OUT of transcode: raw .h264/.265
(put it in MP4 with: ffmpeg -i out.h264 -c copy out.mp4)\n`;
const enc = new TextEncoder();
const hex2 = (n) => n.toString(16).padStart(2, '0');

/** Runs inkvideo; returns its exit code, or a Promise of it when WebCodecs works here. */
export function main({ args, sys, base: BASE, size: SIZE, inline }) {
  const cstr = (s) => { const b = enc.encode(s), o = new Uint8Array(b.length + 1); o.set(b); return o; };
  const write = (fd, data) => { for (let o = 0; o < data.length;) { const c = data.subarray(o, o + Math.min(SIZE, data.length - o)); const { r } = sys(1, [fd, BASE, c.length], c); if (r <= 0) return false; o += r; } return true; };
  const say = (s) => write(1, enc.encode(s)), err = (s) => write(2, enc.encode('inkvideo: ' + s + '\n'));
  const io = {
    open: (p, fl, mode = 0o644) => sys(257, [-100, BASE, fl | 0x80000, mode], cstr(p)).r,
    size: (fd) => { const { r, out } = sys(5, [fd, BASE], null, 144); return r < 0 ? -1 : Number(new DataView(out.buffer, out.byteOffset).getBigUint64(48, true)); },
    pread: (fd, off, n) => {
      const b = new Uint8Array(n); let got = 0;
      while (got < n) { const want = Math.min(SIZE, n - got); const { r, out } = sys(17, [fd, BASE, want, off + got], null, want); if (r <= 0) break; b.set(out.subarray(0, r), got); got += r; }
      return got === n ? b : b.subarray(0, got);
    },
    write, close: (fd) => sys(3, [fd]),
  };
  const cmd = args[1] || '';
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { say(USAGE); return cmd ? 0 : 2; }
  if (!['info', 'decode', 'transcode', 'selftest'].includes(cmd)) { err('unknown command: ' + cmd); write(2, enc.encode(USAGE)); return 2; }
  if (!has()) { err('no WebCodecs here (VideoDecoder/VideoEncoder: Safari 16.4+, Chrome 94+)'); return NO_WEBCODECS; }
  if (inline) { err('WebCodecs needs the service worker (reload the page)'); return NO_WEBCODECS; }
  const run = { info, decode: () => decode(false), transcode: () => decode(true), selftest }[cmd];
  return run().catch((e) => { err(e && e.message || String(e)); return 1; });

  async function info() {
    say('WebCodecs: yes\n');
    for (const [name, codec] of [['H.264', 'avc1.640028'], ['HEVC', 'hvc1.1.6.L120.90'], ['VP9', 'vp09.00.40.08'], ['AV1', 'av01.0.08M.08']]) {
      const d = await support(VideoDecoder, { codec, codedWidth: 1920, codedHeight: 1080 });
      const e = await support(VideoEncoder, { codec, width: 1920, height: 1080, bitrate: 8e6, framerate: 30 });
      say(`${name} 1080p: decode ${d}, encode ${e}\n`);
    }
    return 0;
  }

  async function selftest() {
    const W = 320, H = 240, N = 30;
    let codec = null;
    for (const c of ['avc1.42001f', 'avc1.42e01f', 'hvc1.1.6.L93.90', 'vp8']) if (await support(VideoEncoder, { codec: c, width: W, height: H, bitrate: 5e5, framerate: 30 }) !== 'no') { codec = c; break; }
    if (!codec) { err('selftest: no encoder here'); return 1; }
    const chunks = []; let config = null, fail = null;
    const e = new VideoEncoder({ output: (c, m) => { chunks.push(c); if (m && m.decoderConfig) config = config || m.decoderConfig; }, error: (x) => { fail = x; } });
    e.configure({ codec, width: W, height: H, bitrate: 5e5, framerate: 30, ...(codec.startsWith('avc1') ? { avc: { format: 'annexb' } } : codec.startsWith('hvc1') ? { hevc: { format: 'annexb' } } : {}) });
    const y = new Uint8Array(W * H * 3 / 2);
    for (let i = 0; i < N; i++) {
      for (let p = 0; p < W * H; p++) y[p] = (p % W + i * 4) & 255;
      y.fill(128, W * H);
      const f = new VideoFrame(y, { format: 'I420', codedWidth: W, codedHeight: H, timestamp: i * 33333 });
      e.encode(f, { keyFrame: i === 0 }); f.close();
    }
    await e.flush(); e.close();
    if (fail) throw fail;
    let n = 0;
    const d = new VideoDecoder({ output: (f) => { n++; f.close(); }, error: (x) => { fail = x; } });
    d.configure(config || { codec });
    for (const c of chunks) d.decode(c);
    await d.flush(); d.close();
    if (fail) throw fail;
    if (args[2] && !codec.startsWith('vp8')) {
      const o = io.open(args[2], 0x41 | 0x200); if (o < 0) { err(`${args[2]}: cannot create (${o})`); return 1; }
      for (const c of chunks) { const b = new Uint8Array(c.byteLength); c.copyTo(b); write(o, b); }
      io.close(o);
    }
    say(`selftest ${codec}: encoded ${chunks.length}, decoded ${n}/${N}\n`);
    return n === N ? 0 : 1;
  }

  async function decode(trans) {
    const opt = { codec: 'h264', bitrate: 0, hw: 'prefer-hardware' }, pos = [];
    for (let i = 2; i < args.length; i++) {
      const a = args[i];
      if (a === '--codec') opt.codec = args[++i]; else if (a === '--bitrate') opt.bitrate = +args[++i]; else if (a === '--sw') opt.hw = 'prefer-software';
      else pos.push(a);
    }
    if (!pos[0] || (trans && !pos[1])) { write(2, enc.encode(USAGE)); return 2; }
    if (trans && !['h264', 'hevc'].includes(opt.codec)) { err('--codec h264 or hevc'); return 2; }
    if (trans && /\.(mp4|mov|m4v)$/i.test(pos[1])) { err('transcode writes a raw stream (.h264/.265); then: ffmpeg -i out.h264 -c copy out.mp4'); return 2; }
    const fd = io.open(pos[0], 0);
    if (fd < 0) { err(`${pos[0]}: cannot open (${fd})`); return 1; }
    const src = openSource(io, fd);
    if (!src) { err(`${pos[0]}: not MP4/MOV with H.264/HEVC nor a raw H.264/HEVC stream`); return 1; }
    let ofd = -1;
    if (pos[1]) { ofd = io.open(pos[1], 0x41 | 0x200); if (ofd < 0) { err(`${pos[1]}: cannot create (${ofd})`); return 1; } }
    const t0 = performance.now();
    let fail = null, frames = 0, w = 0, h = 0, encoder = null, outBytes = 0, wrote = 0, hwUsed = '';
    const ready = [], encoded = [];
    let wake = null; const kick = () => { if (wake) { const r = wake; wake = null; r(); } };
    const idle = () => new Promise((r) => { wake = r; setTimeout(kick, 4); });
    const dcfg = { codec: src.codec, hardwareAcceleration: opt.hw, optimizeForLatency: false, ...(src.description ? { description: src.description } : {}) };
    if (!(await VideoDecoder.isConfigSupported(dcfg).catch(() => ({}))).supported) { dcfg.hardwareAcceleration = 'no-preference'; }
    if (!(await VideoDecoder.isConfigSupported(dcfg).catch(() => ({}))).supported) { err(`${src.codec}: this browser cannot decode it`); return 1; }
    hwUsed = dcfg.hardwareAcceleration === 'prefer-hardware' ? 'hw' : 'any';
    const dec = new VideoDecoder({ output: (f) => { ready.push(f); kick(); }, error: (x) => { fail = fail || x; kick(); } });
    dec.configure(dcfg);
    if (dec.ondequeue !== undefined) dec.ondequeue = kick;
    const fps = src.fps || 30;
    const startEncoder = async (f) => {
      const lv = hex2(w * h > 2228224 ? 0x33 : w * h > 983040 ? 0x28 : 0x1f);
      const codecs = opt.codec === 'hevc' ? ['hvc1.1.6.L' + (w * h > 2073600 ? 153 : w * h > 983040 ? 123 : 93) + '.90'] : ['avc1.6400' + lv, 'avc1.4d00' + lv, 'avc1.42e0' + lv];
      let c = null;
      for (const hw of opt.hw === 'prefer-software' ? [opt.hw, 'no-preference'] : ['prefer-hardware', 'no-preference']) {
        for (const codec of codecs) {
          const t = { codec, width: w, height: h, bitrate: opt.bitrate || Math.round(w * h * fps * 0.12), framerate: fps, hardwareAcceleration: hw, ...(opt.codec === 'hevc' ? { hevc: { format: 'annexb' } } : { avc: { format: 'annexb' } }) };
          if ((await VideoEncoder.isConfigSupported(t).catch(() => ({}))).supported) { c = t; break; }
        }
        if (c) break;
      }
      if (!c) throw new Error(`${opt.codec} ${w}x${h}: this browser cannot encode it`);
      encoder = new VideoEncoder({ output: (ch) => { encoded.push(ch); }, error: (x) => { fail = fail || x; kick(); } });
      encoder.configure(c);
      if (encoder.ondequeue !== undefined) encoder.ondequeue = kick;
    };
    let yuv = null;
    const drain = async () => {
      while (ready.length) {
        const f = ready.shift();
        if (!w) {
          w = f.visibleRect ? f.visibleRect.width : f.displayWidth; h = f.visibleRect ? f.visibleRect.height : f.displayHeight;
          if (trans) await startEncoder(f);
          else if (ofd >= 0) write(ofd, enc.encode(`YUV4MPEG2 W${w} H${h} F${Math.round(fps * 1000)}:1000 Ip A1:1 C420jpeg\n`));
        }
        frames++;
        if (trans) encoder.encode(f, { keyFrame: frames % Math.max(1, Math.round(fps * 2)) === 1 });
        else if (ofd >= 0) { yuv = await i420(f, w, h, yuv); write(ofd, enc.encode('FRAME\n')); write(ofd, yuv); wrote += yuv.length; }
        f.close();
      }
      while (encoded.length) { const ch = encoded.shift(), b = new Uint8Array(ch.byteLength); ch.copyTo(b); write(ofd, b); outBytes += b.length; }
    };
    for (let s; (s = src.next());) {
      if (fail) throw fail;
      dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.ts, data: s.data }));
      await drain();
      while (!fail && (dec.decodeQueueSize > 6 || (encoder && encoder.encodeQueueSize > 6))) { await idle(); await drain(); }
    }
    await dec.flush(); await drain();
    if (encoder) { await encoder.flush(); await drain(); encoder.close(); }
    dec.close(); io.close(fd); if (ofd >= 0) io.close(ofd);
    if (fail) throw fail;
    const s = (performance.now() - t0) / 1000;
    say(`${trans ? 'transcoded' : 'decoded'} ${frames} frames ${w}x${h} ${src.codec} (${hwUsed}) in ${s.toFixed(2)} s: ${(frames / Math.max(s, 1e-3)).toFixed(1)} fps` + (trans ? `, ${opt.codec} ${outBytes} bytes` : ofd >= 0 ? `, ${wrote} bytes of I420` : '') + '\n');
    return frames ? 0 : 1;
  }
}

export const has = () => typeof VideoDecoder === 'function' && typeof VideoEncoder === 'function' && typeof EncodedVideoChunk === 'function';

async function support(C, cfg) {
  for (const hw of ['prefer-hardware', 'no-preference']) {
    try { if ((await C.isConfigSupported({ ...cfg, hardwareAcceleration: hw })).supported) return hw === 'prefer-hardware' ? 'hw' : 'sw'; } catch {}
  }
  return 'no';
}

/** One frame as I420 (w x h), in `buf` when it fits. */
async function i420(f, w, h, buf) {
  const n = w * h + 2 * ((w + 1) >> 1) * ((h + 1) >> 1);
  if (!buf || buf.length !== n) buf = new Uint8Array(n);
  if (f.format === 'I420') { await f.copyTo(buf); return buf; }
  try { await f.copyTo(buf, { format: 'I420' }); return buf; } catch {}
  if (f.format !== 'NV12') throw new Error(`frame format ${f.format}: cannot write it as I420 here`);
  const t = new Uint8Array(f.allocationSize()), lay = await f.copyTo(t), cw = (w + 1) >> 1, ch = (h + 1) >> 1;
  for (let y = 0; y < h; y++) buf.set(t.subarray(lay[0].offset + y * lay[0].stride, lay[0].offset + y * lay[0].stride + w), y * w);
  const u = w * h, v = u + cw * ch;
  for (let y = 0; y < ch; y++) { const r = lay[1].offset + y * lay[1].stride; for (let x = 0; x < cw; x++) { buf[u + y * cw + x] = t[r + 2 * x]; buf[v + y * cw + x] = t[r + 2 * x + 1]; } }
  return buf;
}

// ---- input: next() -> { data, key, ts (µs) } | null, read in pieces ----
function openSource(io, fd) {
  const size = io.size(fd), head = io.pread(fd, 0, 16);
  const t = String.fromCharCode(...head.subarray(4, 8));
  if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(t)) return mp4(io, fd, size);
  if (head[0] === 0 && head[1] === 0 && (head[2] === 1 || (head[2] === 0 && head[3] === 1))) return annexb(io, fd, size, head);
  return null;
}

function codecString(kind, c) { // from avcC / hvcC bytes
  if (kind === 'avc') return 'avc1.' + hex2(c[1]) + hex2(c[2]) + hex2(c[3]);
  const space = c[1] >> 6, tier = (c[1] >> 5) & 1, prof = c[1] & 31;
  let flags = 0; for (let i = 0; i < 4; i++) flags |= c[2 + i] << (8 * (3 - i));
  let rev = 0; for (let i = 0; i < 32; i++) if (flags & (1 << i)) rev |= 1 << (31 - i);
  const cons = Array.from(c.subarray(6, 12)); while (cons.length && !cons[cons.length - 1]) cons.pop();
  return 'hvc1.' + ['', 'A', 'B', 'C'][space] + prof + '.' + (rev >>> 0).toString(16) + '.' + (tier ? 'H' : 'L') + c[12] + cons.map((b) => '.' + b.toString(16)).join('');
}

function mp4(io, fd, size) {
  const box = (off) => { const b = io.pread(fd, off, 16); if (b.length < 8) return null; const d = new DataView(b.buffer); let n = d.getUint32(0); const ty = String.fromCharCode(...b.subarray(4, 8)); let hd = 8; if (n === 1) { n = Number(d.getBigUint64(8)); hd = 16; } else if (n === 0) n = size - off; return { n, ty, hd }; };
  let moov = null;
  for (let off = 0, b; off < size && (b = box(off)); off += b.n) { if (b.n < 8) return null; if (b.ty === 'moov') { if (b.n > 256 << 20) return null; moov = io.pread(fd, off + b.hd, b.n - b.hd); break; } }
  if (!moov) return null;
  const kids = (u8) => { const out = {}, d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); for (let o = 0; o + 8 <= u8.length;) { let n = d.getUint32(o), hd = 8; const ty = String.fromCharCode(...u8.subarray(o + 4, o + 8)); if (n === 1) { n = Number(d.getBigUint64(o + 8)); hd = 16; } else if (n === 0) n = u8.length - o; if (n < hd) break; (out[ty] = out[ty] || []).push(u8.subarray(o + hd, o + n)); o += n; } return out; };
  const one = (m, ty) => m[ty] && m[ty][0];
  for (const trak of kids(moov).trak || []) {
    const mdia = one(kids(trak), 'mdia'); if (!mdia) continue;
    const md = kids(mdia), hdlr = one(md, 'hdlr');
    if (!hdlr || String.fromCharCode(...hdlr.subarray(8, 12)) !== 'vide') continue;
    const mdhd = one(md, 'mdhd'), mv = new DataView(mdhd.buffer, mdhd.byteOffset);
    const scale = mdhd[0] === 1 ? mv.getUint32(20) : mv.getUint32(12);
    const st = kids(one(kids(one(md, 'minf')), 'stbl'));
    const stsd = one(st, 'stsd'), entry = stsd.subarray(8), etype = String.fromCharCode(...entry.subarray(4, 8));
    const kind = { avc1: 'avc', avc3: 'avc', hvc1: 'hevc', hev1: 'hevc' }[etype]; if (!kind) continue;
    const ex = kids(entry.subarray(8 + 78, new DataView(entry.buffer, entry.byteOffset).getUint32(0)));
    const cfg = one(ex, kind === 'avc' ? 'avcC' : 'hvcC'); if (!cfg) continue;
    const u32 = (b, o) => new DataView(b.buffer, b.byteOffset).getUint32(o);
    const stsz = one(st, 'stsz'), uni = u32(stsz, 4), count = u32(stsz, 8);
    const sz = (i) => uni || u32(stsz, 12 + 4 * i);
    const stco = one(st, 'stco'), co64 = one(st, 'co64');
    const nch = u32(stco || co64, 4), chunk = (i) => stco ? u32(stco, 8 + 4 * i) : Number(new DataView(co64.buffer, co64.byteOffset).getBigUint64(8 + 8 * i));
    const stsc = one(st, 'stsc'), nsc = u32(stsc, 4);
    const stts = one(st, 'stts'), nts = u32(stts, 4), ctts = one(st, 'ctts'), stss = one(st, 'stss');
    const keys = stss ? new Set(Array.from({ length: u32(stss, 4) }, (_, i) => u32(stss, 8 + 4 * i) - 1)) : null;
    // walk: chunk c, its sample k of `per`, sample index i; time runs (stts) and offsets (ctts)
    let i = 0, c = 0, sc = 0, per = 0, k = 0, off = 0, dts = 0, ti = 0, tleft = 0, tdelta = 0, ci = 0, cleft = 0, coff = 0;
    const first = nts ? u32(stts, 12) : 0;
    const next = () => {
      if (i >= count) return null;
      if (k === 0) {
        if (c >= nch) return null;
        while (sc + 1 < nsc && u32(stsc, 8 + 12 * (sc + 1)) - 1 <= c) sc++;
        per = u32(stsc, 8 + 12 * sc + 4); off = chunk(c);
      }
      while (!tleft && ti < nts) { tleft = u32(stts, 8 + 8 * ti); tdelta = u32(stts, 12 + 8 * ti); ti++; }
      if (ctts) { while (!cleft && ci < u32(ctts, 4)) { cleft = u32(ctts, 8 + 8 * ci); coff = new DataView(ctts.buffer, ctts.byteOffset).getInt32(12 + 8 * ci); ci++; } cleft--; }
      const n = sz(i), s = { data: io.pread(fd, off, n), key: keys ? keys.has(i) : true, ts: Math.round((dts + coff) * 1e6 / scale) };
      off += n; dts += tdelta; tleft--; i++;
      if (++k >= per) { k = 0; c++; }
      return s;
    };
    return { codec: codecString(kind, cfg), description: cfg.slice(), fps: first ? scale / first : 30, next };
  }
  return null;
}

function annexb(io, fd, size, head) {
  const S = 1 << 20;
  let buf = new Uint8Array(0), at = 0, eof = false, n = 0;
  const fill = () => { if (eof) return false; const b = io.pread(fd, at, S); at += b.length; if (b.length < S || at >= size) eof = true; const nb = new Uint8Array(buf.length + b.length); nb.set(buf); nb.set(b, buf.length); buf = nb; return b.length > 0; };
  fill();
  // which codec: the first NAL header
  let p = buf[2] === 1 ? 3 : 4;
  const hevc = [0x40, 0x42, 0x44, 0x46, 0x4e, 0x26, 0x28, 0x2a].includes(buf[p]) && buf[p + 1] === 1;
  // next NAL: [start, end) of its payload (without the start code); reads more as needed
  let pos = 0;
  const startAt = (i) => buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1;
  const nal = () => {
    for (;;) {
      let s = pos; while (s + 3 <= buf.length && !startAt(s)) s++;
      if (s + 3 > buf.length) { if (!fill()) return null; continue; }
      let e = s + 3; while (e + 3 <= buf.length && !startAt(e)) e++;
      if (e + 3 > buf.length && !eof) { if (pos > S) { buf = buf.slice(pos); s -= pos; e -= pos; pos = 0; } fill(); continue; }
      if (e + 3 > buf.length) e = buf.length;
      let end = e; while (end > s + 3 && buf[end - 1] === 0 && e < buf.length) end--;
      pos = e;
      return buf.subarray(s + 3, end);
    }
  };
  let sps = null, pend = null; // the NAL that starts the next access unit
  const sc = new Uint8Array([0, 0, 0, 1]);
  const next = () => {
    const parts = []; let vcl = false, key = false;
    for (;;) {
      const u = pend || nal(); pend = null;
      if (!u) break;
      const t = hevc ? (u[0] >> 1) & 63 : u[0] & 31;
      const isVcl = hevc ? t < 32 : t >= 1 && t <= 5;
      const first = isVcl && (hevc ? (u[2] & 0x80) : (u[1] & 0x80));
      const starts = hevc ? (t >= 32 && t <= 35) || t === 39 : t === 9 || t === 7 || t === 8 || t === 6;
      if (vcl && (first || starts)) { pend = u.slice(); break; }
      if (!sps && (hevc ? t === 33 : t === 7)) sps = u.slice();
      if (isVcl) { vcl = true; if (hevc ? t >= 16 && t <= 21 : t === 5) key = true; }
      parts.push(sc, u.slice());
    }
    if (!parts.length) return null;
    const len = parts.reduce((a, b) => a + b.length, 0), data = new Uint8Array(len);
    let o = 0; for (const x of parts) { data.set(x, o); o += x.length; }
    if (pos > S) { buf = buf.slice(pos); pos = 0; }
    return { data, key, ts: Math.round(n++ * 1e6 / 30) };
  };
  // the codec string comes from the SPS: look ahead to it
  const saved = { buf, at, eof, pos };
  for (let u, k = 0; !sps && k < 64 && (u = nal()); k++) if ((hevc ? (u[0] >> 1) & 63 : u[0] & 31) === (hevc ? 33 : 7)) sps = u.slice();
  ({ buf, at, eof, pos } = saved);
  if (!sps) return null;
  let codec;
  if (!hevc) codec = 'avc1.' + hex2(sps[1]) + hex2(sps[2]) + hex2(sps[3]);
  else { // profile_tier_level after the 2-byte header and 1 byte (vps id, sub layers): the hvcC layout from byte 1
    const r = []; for (let i = 2, z = 0; i < sps.length && r.length < 13; i++) { if (z >= 2 && sps[i] === 3) { z = 0; continue; } z = sps[i] === 0 ? z + 1 : 0; r.push(sps[i]); }
    const c = new Uint8Array(13); c.set(r.slice(0, 13)); codec = codecString('hevc', new Uint8Array([0, ...c.subarray(1, 13)]));
  }
  void head;
  return { codec, description: null, fps: 0, next };
}
