// inkvideo: video decode/transcode with the page's WebCodecs (VideoDecoder/VideoEncoder: H.264/HEVC by
// the device's hardware when it has it). It is a "JS program" of the terminal: /usr/local/libexec/
// inkvideo-webcodecs is a tiny WebAssembly module with only a custom section "inkshell.js" = "inkvideo",
// so the kernel starts it like any WASI program (stub process, wasi.js) and wasi.js runs main() below
// instead of instantiating it. Files go through the same Linux calls (open, pread, write) in pieces:
// never a whole file in memory. Without WebCodecs (node, CI, an old browser, or the engine's own thread)
// it exits 69 and /usr/local/bin/inkvideo falls back to ffmpeg (software) where it can.
// Input: MP4/MOV (H.264 avc1/avc3, HEVC hvc1/hev1, VP9 vp09, VP8 vp08, AV1 av01) or a raw Annex B stream.
// Output: decode -> YUV4MPEG2 (.y4m, I420) or only a count + fps; transcode -> MP4 (.mp4/.mov/.m4v: the
// small ISO BMFF muxer at the end of this file, own code: mdat written sample by sample, its size patched
// with pwrite, moov at the end; the audio track of an MP4 input is copied as is, no re-encode) or a raw
// Annex B H.264/HEVC stream (.h264/.265). --scale WxH resizes each frame (OffscreenCanvas drawImage of the
// VideoFrame, then a VideoFrame of the canvas: works in Safari 16.4+ Workers and Chrome).
export const NO_WEBCODECS = 69;
const USAGE = `usage: inkvideo info [FILE]                WebCodecs and codecs here (hw = hardware); FILE: its tracks
       inkvideo decode IN [OUT.y4m] [-s WxH]  decode (no OUT: count frames, show fps)
       inkvideo transcode IN OUT [--codec h264|hevc|vp9|av1] [-s WxH] [--bitrate BPS] [--sw] [--no-audio]
       inkvideo selftest [OUT]             encode + decode 30 frames here (OUT: .mp4 or the raw stream)
IN: .mp4/.mov (H.264/HEVC/VP9/AV1) or raw .h264/.265
OUT of transcode: .mp4/.mov (audio of an MP4 IN copied) or raw .h264/.265
-s, --scale WxH: resize (1280x720; 1280x-1 keeps the aspect)\n`;
const enc = new TextEncoder();
const hex2 = (n) => n.toString(16).padStart(2, '0');
const dec2 = (n) => String(n).padStart(2, '0');
const isMp4 = (p) => /\.(mp4|mov|m4v)$/i.test(p);

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
    pwrite: (fd, data, off) => { // by lseek + write (the kernel here has no pwrite64), then back where it was
      const cur = sys(8, [fd, 0, 1]).r; if (cur < 0 || sys(8, [fd, off, 0]).r !== off) return false;
      const ok = write(fd, data); return sys(8, [fd, cur, 0]).r === cur && ok;
    },
    write, close: (fd) => sys(3, [fd]),
  };
  const cmd = args[1] || '';
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { say(USAGE); return cmd ? 0 : 2; }
  if (!['info', 'decode', 'transcode', 'selftest'].includes(cmd)) { err('unknown command: ' + cmd); write(2, enc.encode(USAGE)); return 2; }
  if (!has()) { err('no WebCodecs here (VideoDecoder/VideoEncoder: Safari 16.4+, Chrome 94+)'); return NO_WEBCODECS; }
  if (inline) { err('WebCodecs needs the service worker (reload the page)'); return NO_WEBCODECS; }
  const run = { info: () => (args[2] ? probe(args[2]) : info()), decode: () => decode(false), transcode: () => decode(true), selftest }[cmd];
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

  async function probe(path) { // the tracks of a file, from its boxes (no decoding)
    const fd = io.open(path, 0);
    if (fd < 0) { err(`${path}: cannot open (${fd})`); return 1; }
    const src = openSource(io, fd); io.close(fd);
    if (!src) { err(`${path}: not MP4/MOV with H.264/HEVC/VP9/AV1 nor a raw H.264/HEVC stream`); return 1; }
    let s = `${path}: ${src.mp4 ? 'MP4' : 'raw stream'}, video ${src.codec}`;
    if (src.width) s += ` ${src.width}x${src.height}`;
    if (src.count != null) s += `, ${src.count} frames, ${src.fps.toFixed(2)} fps`;
    if (src.audio) s += `, audio ${src.audio.etype} ${src.audio.scale} Hz ${src.audio.count} samples`;
    say(s + '\n');
    return 0;
  }

  async function selftest() {
    const W = 320, H = 240, N = 30, out = args[2], mp4out = out && isMp4(out);
    let codec = null;
    for (const c of ['avc1.42001f', 'avc1.42e01f', 'hvc1.1.6.L93.90', 'vp09.00.10.08', 'vp8']) if (await support(VideoEncoder, { codec: c, width: W, height: H, bitrate: 5e5, framerate: 30 }) !== 'no') { codec = c; break; }
    if (!codec) { err('selftest: no encoder here'); return 1; }
    const chunks = []; let config = null, fail = null;
    const e = new VideoEncoder({ output: (c, m) => { chunks.push(c); if (m && m.decoderConfig) config = config || m.decoderConfig; }, error: (x) => { fail = x; } });
    const fmt = mp4out ? null : 'annexb';
    e.configure({ codec, width: W, height: H, bitrate: 5e5, framerate: 30, ...(codec.startsWith('avc1') ? { avc: { format: fmt || 'avc' } } : codec.startsWith('hvc1') ? { hevc: { format: fmt || 'hevc' } } : {}) });
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
    if (out && (mp4out || !codec.startsWith('vp'))) {
      const o = io.open(out, 0x41 | 0x200); if (o < 0) { err(`${out}: cannot create (${o})`); return 1; }
      const mux = mp4out ? mp4Mux(io, o) : null, t = mux && mux.track('vide', 90000, W, H);
      if (t) t.entry = sampleEntry({ codec, ...(config || {}) }, W, H);
      for (const c of chunks) { const b = new Uint8Array(c.byteLength); c.copyTo(b); if (mux) mux.sample(t, b, Math.round(c.timestamp * 0.09), c.type === 'key'); else write(o, b); }
      if (mux) mux.finish();
      io.close(o);
    }
    say(`selftest ${codec}: encoded ${chunks.length}, decoded ${n}/${N}\n`);
    return n === N ? 0 : 1;
  }

  async function decode(trans) {
    const opt = { codec: 'h264', bitrate: 0, hw: 'prefer-hardware', scale: null, audio: true }, pos = [];
    for (let i = 2; i < args.length; i++) {
      const a = args[i];
      if (a === '--codec') opt.codec = args[++i]; else if (a === '--bitrate') opt.bitrate = +args[++i]; else if (a === '--sw') opt.hw = 'prefer-software';
      else if (a === '--scale' || a === '-s') opt.scale = args[++i] || '';
      else if (a === '--no-audio' || a === '-an') opt.audio = false;
      else pos.push(a);
    }
    if (!pos[0] || (trans && !pos[1])) { write(2, enc.encode(USAGE)); return 2; }
    let sc = null;
    if (opt.scale != null) { const m = /^(-?\d+)[x:](-?\d+)$/.exec(opt.scale); if (!m || (+m[1] <= 0 && +m[2] <= 0)) { err('--scale WxH (e.g. 1280x720 or 1280x-1)'); return 2; } sc = [+m[1], +m[2]]; }
    if (trans && !['h264', 'hevc', 'vp9', 'av1'].includes(opt.codec)) { err('--codec h264, hevc, vp9 or av1'); return 2; }
    const mp4out = trans && isMp4(pos[1]);
    if (trans && !mp4out && (opt.codec === 'vp9' || opt.codec === 'av1')) { err(`--codec ${opt.codec} goes only in MP4 (OUT.mp4)`); return 2; }
    const fd = io.open(pos[0], 0);
    if (fd < 0) { err(`${pos[0]}: cannot open (${fd})`); return 1; }
    const src = openSource(io, fd);
    if (!src) { err(`${pos[0]}: not MP4/MOV with H.264/HEVC/VP9/AV1 nor a raw H.264/HEVC stream`); return 1; }
    let ofd = -1;
    if (pos[1]) { ofd = io.open(pos[1], 0x41 | 0x200); if (ofd < 0) { err(`${pos[1]}: cannot create (${ofd})`); return 1; } }
    const mux = mp4out ? mp4Mux(io, ofd) : null;
    const t0 = performance.now();
    let fail = null, frames = 0, w = 0, h = 0, sw = 0, sh = 0, encoder = null, ecodec = '', ecfg = null, vt = null, outBytes = 0, wrote = 0, hwUsed = '', cv = null, cx = null;
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
    const startEncoder = async () => {
      const px = w * h, lv = hex2(px > 2228224 ? 0x33 : px > 983040 ? 0x28 : 0x1f);
      const codecs = {
        hevc: ['hvc1.1.6.L' + (px > 2073600 ? 153 : px > 983040 ? 123 : 93) + '.90'],
        h264: ['avc1.6400' + lv, 'avc1.4d00' + lv, 'avc1.42e0' + lv],
        vp9: ['vp09.00.' + (px > 2228224 ? '50' : px > 983040 ? '40' : px > 552960 ? '31' : px > 245760 ? '30' : '21') + '.08', 'vp09.00.10.08'],
        av1: ['av01.0.' + (px > 2228224 ? '12' : px > 983040 ? '08' : '04') + 'M.08', 'av01.0.08M.08'],
      }[opt.codec];
      const fmt = mp4out ? null : 'annexb';
      let c = null;
      for (const hw of opt.hw === 'prefer-software' ? [opt.hw, 'no-preference'] : ['prefer-hardware', 'no-preference']) {
        for (const codec of codecs) {
          const t = { codec, width: w, height: h, bitrate: opt.bitrate || Math.round(w * h * fps * 0.12), framerate: fps, hardwareAcceleration: hw,
            ...(opt.codec === 'hevc' ? { hevc: { format: fmt || 'hevc' } } : opt.codec === 'h264' ? { avc: { format: fmt || 'avc' } } : {}) };
          if ((await VideoEncoder.isConfigSupported(t).catch(() => ({}))).supported) { c = t; break; }
        }
        if (c) break;
      }
      if (!c) throw new Error(`${opt.codec} ${w}x${h}: this browser cannot encode it`);
      ecodec = c.codec;
      encoder = new VideoEncoder({ output: (ch, m) => { encoded.push(ch); if (m && m.decoderConfig && !ecfg) ecfg = m.decoderConfig; }, error: (x) => { fail = fail || x; kick(); } });
      encoder.configure(c);
      if (encoder.ondequeue !== undefined) encoder.ondequeue = kick;
      if (mux) vt = mux.track('vide', 90000, w, h);
    };
    const scaled = (f) => { // the frame at w x h: drawn on an OffscreenCanvas (GPU scaling), a VideoFrame of it
      if (!cv) { cv = new OffscreenCanvas(w, h); cx = cv.getContext('2d', { alpha: false }); }
      cx.drawImage(f, 0, 0, w, h);
      const init = { timestamp: f.timestamp }; if (f.duration != null) init.duration = f.duration;
      return new VideoFrame(cv, init);
    };
    let yuv = null;
    const drain = async () => {
      while (ready.length) {
        const f = ready.shift();
        if (!w) {
          sw = f.visibleRect ? f.visibleRect.width : f.displayWidth; sh = f.visibleRect ? f.visibleRect.height : f.displayHeight;
          w = sw; h = sh;
          if (sc) { // even sizes (4:2:0); <= 0 keeps the aspect
            w = sc[0] > 0 ? sc[0] : Math.round(sw * sc[1] / sh); h = sc[1] > 0 ? sc[1] : Math.round(sh * sc[0] / sw);
            w = Math.max(2, w + (w & 1)); h = Math.max(2, h + (h & 1));
          }
          if (trans) await startEncoder();
          else if (ofd >= 0) write(ofd, enc.encode(`YUV4MPEG2 W${w} H${h} F${Math.round(fps * 1000)}:1000 Ip A1:1 C420jpeg\n`));
        }
        frames++;
        const g = w !== sw || h !== sh ? scaled(f) : f;
        if (trans) encoder.encode(g, { keyFrame: frames % Math.max(1, Math.round(fps * 2)) === 1 });
        else if (ofd >= 0) { yuv = await i420(g, w, h, yuv); write(ofd, enc.encode('FRAME\n')); write(ofd, yuv); wrote += yuv.length; }
        if (g !== f) g.close();
        f.close();
      }
      while (encoded.length) {
        const ch = encoded.shift(), b = new Uint8Array(ch.byteLength); ch.copyTo(b);
        if (mux) { if (!vt.entry) vt.entry = sampleEntry({ codec: ecodec, ...(ecfg || {}) }, w, h); mux.sample(vt, b, Math.round(ch.timestamp * 0.09), ch.type === 'key'); }
        else if (!write(ofd, b)) throw new Error(`${pos[1]}: write failed (disk full?)`);
        outBytes += b.length;
      }
    };
    for (let s; (s = src.next());) {
      if (fail) throw fail;
      dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.ts, data: s.data }));
      await drain();
      while (!fail && (dec.decodeQueueSize > 6 || (encoder && encoder.encodeQueueSize > 6))) { await idle(); await drain(); }
    }
    await dec.flush(); await drain();
    if (encoder) { await encoder.flush(); await drain(); encoder.close(); }
    dec.close();
    if (fail) throw fail;
    let acount = 0;
    if (mux && vt && vt.n) {
      if (src.audio && opt.audio) { // copy the audio track as it is (AAC, Opus...): sample entry, sizes, durations
        const at = mux.track('soun', src.audio.scale, 0, 0, src.audio.stsd);
        for (let s; (s = src.audio.next());) { mux.sample(at, s.data, s.dur, true); acount++; }
      }
      mux.finish();
    }
    io.close(fd); if (ofd >= 0) io.close(ofd);
    const s = (performance.now() - t0) / 1000;
    say(`${trans ? 'transcoded' : 'decoded'} ${frames} frames ${sw}x${sh}${w !== sw || h !== sh ? ` -> ${w}x${h}` : ''} ${src.codec} (${hwUsed}) in ${s.toFixed(2)} s: ${(frames / Math.max(s, 1e-3)).toFixed(1)} fps`
      + (trans ? `, ${ecodec} ${outBytes} bytes${mux ? ' in MP4' : ''}${acount ? `, audio ${src.audio.etype} copied (${acount} samples)` : ''}` : ofd >= 0 ? `, ${wrote} bytes of I420` : '') + '\n');
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

const u32 = (b, o) => new DataView(b.buffer, b.byteOffset).getUint32(o);

/** Sample walker of one track (stbl boxes): next() -> { data, key, ts (µs, presentation), dur (track units) } */
function walker(io, fd, st, scale) {
  const one = (ty) => st[ty] && st[ty][0];
  const stsz = one('stsz'), uni = u32(stsz, 4), count = u32(stsz, 8);
  const sz = (i) => uni || u32(stsz, 12 + 4 * i);
  const stco = one('stco'), co64 = one('co64');
  const nch = u32(stco || co64, 4), chunk = (i) => stco ? u32(stco, 8 + 4 * i) : Number(new DataView(co64.buffer, co64.byteOffset).getBigUint64(8 + 8 * i));
  const stsc = one('stsc'), nsc = u32(stsc, 4);
  const stts = one('stts'), nts = u32(stts, 4), ctts = one('ctts'), stss = one('stss');
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
    const n = sz(i), s = { data: io.pread(fd, off, n), key: keys ? keys.has(i) : true, ts: Math.round((dts + coff) * 1e6 / scale), dur: tdelta };
    off += n; dts += tdelta; tleft--; i++;
    if (++k >= per) { k = 0; c++; }
    return s;
  };
  return { count, first, next };
}

function mp4(io, fd, size) {
  const box = (off) => { const b = io.pread(fd, off, 16); if (b.length < 8) return null; const d = new DataView(b.buffer); let n = d.getUint32(0); const ty = String.fromCharCode(...b.subarray(4, 8)); let hd = 8; if (n === 1) { n = Number(d.getBigUint64(8)); hd = 16; } else if (n === 0) n = size - off; return { n, ty, hd }; };
  let moov = null;
  for (let off = 0, b; off < size && (b = box(off)); off += b.n) { if (b.n < 8) return null; if (b.ty === 'moov') { if (b.n > 256 << 20) return null; moov = io.pread(fd, off + b.hd, b.n - b.hd); break; } }
  if (!moov) return null;
  const kids = (u8) => { const out = {}, d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); for (let o = 0; o + 8 <= u8.length;) { let n = d.getUint32(o), hd = 8; const ty = String.fromCharCode(...u8.subarray(o + 4, o + 8)); if (n === 1) { n = Number(d.getBigUint64(o + 8)); hd = 16; } else if (n === 0) n = u8.length - o; if (n < hd) break; (out[ty] = out[ty] || []).push(u8.subarray(o + hd, o + n)); o += n; } return out; };
  const one = (m, ty) => m[ty] && m[ty][0];
  let video = null, audio = null;
  for (const trak of kids(moov).trak || []) {
    const mdia = one(kids(trak), 'mdia'); if (!mdia) continue;
    const md = kids(mdia), hdlr = one(md, 'hdlr'), ht = hdlr && String.fromCharCode(...hdlr.subarray(8, 12));
    if (ht !== 'vide' && ht !== 'soun') continue;
    const mdhd = one(md, 'mdhd'), mv = new DataView(mdhd.buffer, mdhd.byteOffset);
    const scale = mdhd[0] === 1 ? mv.getUint32(20) : mv.getUint32(12);
    const st = kids(one(kids(one(md, 'minf')), 'stbl'));
    const stsd = one(st, 'stsd'), entry = stsd.subarray(8), etype = String.fromCharCode(...entry.subarray(4, 8));
    if (ht === 'soun') { if (!audio) { const wk = walker(io, fd, st, scale); audio = { etype, scale, stsd: stsd.slice(), count: wk.count, next: wk.next }; } continue; }
    if (video) continue;
    const kind = { avc1: 'avc', avc3: 'avc', hvc1: 'hevc', hev1: 'hevc', vp09: 'vp9', vp08: 'vp8', av01: 'av1' }[etype]; if (!kind) continue;
    const ex = kids(entry.subarray(8 + 78, u32(entry, 0)));
    const cfg = one(ex, { avc: 'avcC', hevc: 'hvcC', vp9: 'vpcC', vp8: 'vpcC', av1: 'av1C' }[kind]);
    let codec;
    if (kind === 'avc' || kind === 'hevc') { if (!cfg) continue; codec = codecString(kind, cfg); }
    else if (kind === 'vp8') codec = 'vp8';
    else if (kind === 'vp9') codec = cfg ? 'vp09.' + dec2(cfg[4]) + '.' + dec2(cfg[5]) + '.' + dec2(cfg[6] >> 4) : 'vp09.00.10.08';
    else codec = cfg ? 'av01.' + (cfg[1] >> 5) + '.' + dec2(cfg[1] & 31) + (cfg[2] & 0x80 ? 'H' : 'M') + '.' + (cfg[2] & 0x40 ? (cfg[2] & 0x20 ? '12' : '10') : '08') : 'av01.0.04M.08';
    const wk = walker(io, fd, st, scale), ed = new DataView(entry.buffer, entry.byteOffset);
    video = { codec, description: kind === 'avc' || kind === 'hevc' ? cfg.slice() : null, fps: wk.first ? scale / wk.first : 30, next: wk.next,
      count: wk.count, width: ed.getUint16(32), height: ed.getUint16(34) };
  }
  return video ? { ...video, mp4: true, audio } : null;
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

// ---- output: MP4 (ISO BMFF), own small muxer. ftyp, then an mdat with a 64-bit size patched at the end
// (pwrite), samples written as they come (one chunk per sample), moov at the end built from small tables
// (size, offset, time, key per sample: ~21 bytes per sample in memory, never the media). ----
const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
function box(type, ...parts) {
  const n = parts.reduce((a, p) => a + p.length, 8), b = new Uint8Array(n);
  new DataView(b.buffer).setUint32(0, n); b.set(str(type), 4);
  let o = 8; for (const p of parts) { b.set(p, o); o += p.length; }
  return b;
}
const u8of = (x) => (x instanceof ArrayBuffer ? new Uint8Array(x) : new Uint8Array(x.buffer, x.byteOffset, x.byteLength)).slice();
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
class Grow {
  constructor(T) { this.T = T; this.a = new T(1024); this.n = 0; }
  push(v) { if (this.n === this.a.length) { const b = new this.T(this.n * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  get v() { return this.a.subarray(0, this.n); }
}

/** Visual sample entry (avc1/hvc1/vp09/vp08/av01) from a VideoEncoder decoderConfig ({ codec, description }). */
function sampleEntry(cfg, w, h) {
  const c = cfg.codec, d = cfg.description ? u8of(cfg.description) : null;
  let type, conf;
  if (/^avc[13]\./.test(c)) { if (!d) throw new Error('the H.264 encoder gave no avcC'); type = 'avc1'; conf = box('avcC', d); }
  else if (/^(hvc1|hev1)\./.test(c)) { if (!d) throw new Error('the HEVC encoder gave no hvcC'); type = 'hvc1'; conf = box('hvcC', d); }
  else if (c === 'vp8' || c.startsWith('vp09')) { // vpcC v1: profile, level, bit depth | 4:2:0 (1) | range, colour unspecified (2)
    const p = c.split('.'), vp9 = c !== 'vp8';
    type = vp9 ? 'vp09' : 'vp08';
    conf = box('vpcC', new Uint8Array([1, 0, 0, 0, vp9 ? +p[1] : 0, vp9 ? +p[2] : 10, ((vp9 ? +p[3] : 8) << 4) | (1 << 1), 2, 2, 2, 0, 0]));
  } else if (c.startsWith('av01')) {
    type = 'av01';
    if (d && d[0] === 0x81) conf = box('av1C', d);
    else { const p = c.split('.'), bd = +p[3] || 8; conf = box('av1C', new Uint8Array([0x81, (+p[1] << 5) | parseInt(p[2], 10), (/H$/.test(p[2]) ? 0x80 : 0) | (bd > 8 ? 0x40 : 0) | (bd === 12 ? 0x20 : 0) | 0x0c, 0])); }
  } else throw new Error(`${c}: no MP4 sample entry for it here`);
  const b = new Uint8Array(78), v = new DataView(b.buffer);
  v.setUint16(6, 1); v.setUint16(24, w); v.setUint16(26, h); v.setUint32(28, 0x480000); v.setUint32(32, 0x480000);
  v.setUint16(40, 1); v.setUint16(74, 0x18); v.setInt16(76, -1);
  return box(type, b, conf);
}

function mp4Mux(io, fd) {
  const ftyp = box('ftyp', str('isom'), new Uint8Array([0, 0, 2, 0]), str('isomiso2iso6mp41'));
  const put = (b) => { if (!io.write(fd, b)) throw new Error('write failed (disk full?)'); };
  put(ftyp);
  const mdatAt = ftyp.length;
  put(new Uint8Array([0, 0, 0, 1, 109, 100, 97, 116, 0, 0, 0, 0, 0, 0, 0, 16]));
  let pos = mdatAt + 16;
  const tracks = [];
  return {
    /** kind 'vide' (time = presentation time) or 'soun' (time = duration; stsd = the source's stsd payload) */
    track(kind, scale, w = 0, h = 0, stsd = null) {
      const t = { kind, scale, w, h, stsd, entry: null, n: 0, size: new Grow(Uint32Array), off: new Grow(Float64Array), time: new Grow(Float64Array), key: new Grow(Uint8Array) };
      tracks.push(t); return t;
    },
    sample(t, data, time, key) { put(data); t.size.push(data.length); t.off.push(pos); t.time.push(time); t.key.push(key ? 1 : 0); t.n++; pos += data.length; },
    finish() {
      const sz = new Uint8Array(8); new DataView(sz.buffer).setBigUint64(0, BigInt(pos - mdatAt));
      if (!io.pwrite(fd, sz, mdatAt + 8)) throw new Error('pwrite of the mdat size failed');
      put(moov(tracks.filter((t) => t.n), pos > 0xffffffff));
    },
  };
}

function moov(tracks, big) {
  const MS = 1000; let mdur = 0;
  const traks = tracks.map((t, idx) => {
    const n = t.n, size = t.size.v, off = t.off.v, key = t.key.v, dur = new Float64Array(n), cto = new Float64Array(n);
    let shift = 0;
    if (t.kind === 'vide') { // decode times = the presentation times sorted; offsets (ctts) for reordered frames
      const pts = t.time.v, dts = Float64Array.from(pts).sort();
      for (let k = 0; k < n; k++) { cto[k] = pts[k] - dts[k]; if (-cto[k] > shift) shift = -cto[k]; }
      for (let k = 0; k < n; k++) { cto[k] += shift; dur[k] = k + 1 < n ? dts[k + 1] - dts[k] : n > 1 ? dur[k - 1] : Math.round(t.scale / 30); }
    } else dur.set(t.time.v);
    let tdur = 0; for (let k = 0; k < n; k++) tdur += dur[k];
    const mvdur = Math.round(tdur * MS / t.scale); if (mvdur > mdur) mdur = mvdur;
    const runs = (a) => { const r = []; for (let k = 0; k < n; k++) { const l = r[r.length - 1]; if (l && l[1] === a[k]) l[0]++; else r.push([1, a[k]]); } return r; };
    const pairs = (type, rs) => { const b = new Uint8Array(8 + 8 * rs.length), d = new DataView(b.buffer); d.setUint32(4, rs.length); rs.forEach(([c, v], k) => { d.setUint32(8 + 8 * k, c); d.setUint32(12 + 8 * k, v); }); return box(type, b); };
    const list = (type, vals, w8, head = []) => { // version/flags 0, [head...], count, values
      const b = new Uint8Array(4 + 4 * head.length + 4 + w8 * vals.length), d = new DataView(b.buffer); let o = 4;
      for (const x of head) { d.setUint32(o, x); o += 4; }
      d.setUint32(o, vals.length); o += 4;
      for (const x of vals) { if (w8 === 8) d.setBigUint64(o, BigInt(x)); else d.setUint32(o, x); o += w8; }
      return box(type, b);
    };
    const keys = []; for (let k = 0; k < n; k++) if (key[k]) keys.push(k + 1);
    const stsd = t.kind === 'vide' ? box('stsd', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), t.entry) : box('stsd', t.stsd);
    const stbl = box('stbl', stsd, pairs('stts', runs(dur)), ...(cto.some((x) => x) ? [pairs('ctts', runs(cto))] : []),
      ...(keys.length < n ? [list('stss', keys, 4)] : []),
      box('stsc', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])),
      list('stsz', size, 4, [0]), big ? list('co64', off, 8) : list('stco', off, 4));
    const vid = t.kind === 'vide';
    const tk = new Uint8Array(84), tv = new DataView(tk.buffer);
    tv.setUint32(0, 3); tv.setUint32(12, idx + 1); tv.setUint32(20, mvdur); tv.setUint16(36, vid ? 0 : 0x100);
    MATRIX.forEach((x, k) => tv.setUint32(40 + 4 * k, x)); tv.setUint32(76, t.w * 65536); tv.setUint32(80, t.h * 65536);
    const md = new Uint8Array(36), mv = new DataView(md.buffer);
    mv.setUint32(0, 0x01000000); mv.setUint32(20, t.scale); mv.setBigUint64(24, BigInt(tdur)); mv.setUint16(32, 0x55c4);
    const hd = new Uint8Array(24); hd.set(str(vid ? 'vide' : 'soun'), 8);
    const name = str(vid ? 'VideoHandler\0' : 'SoundHandler\0');
    const dinf = box('dinf', box('dref', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), box('url ', new Uint8Array([0, 0, 0, 1]))));
    const xmhd = vid ? box('vmhd', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])) : box('smhd', new Uint8Array(8));
    let edts = [];
    if (shift) { const e = new Uint8Array(20), ev = new DataView(e.buffer); ev.setUint32(4, 1); ev.setUint32(8, mvdur); ev.setInt32(12, shift); ev.setUint32(16, 0x10000); edts = [box('edts', box('elst', e))]; }
    return box('trak', box('tkhd', tk), ...edts, box('mdia', box('mdhd', md), box('hdlr', hd, name), box('minf', xmhd, dinf, stbl)));
  });
  const mh = new Uint8Array(100), mv = new DataView(mh.buffer);
  mv.setUint32(12, MS); mv.setUint32(16, mdur); mv.setUint32(20, 0x10000); mv.setUint16(24, 0x100);
  MATRIX.forEach((x, k) => mv.setUint32(36 + 4 * k, x)); mv.setUint32(96, tracks.length + 1);
  return box('moov', box('mvhd', mh), ...traks);
}
