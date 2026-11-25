// Item 58 (measurement only): our x86-64 engine (InkSoC, the committed engine.wasm) vs v86 (copy.sh/v86, BSD-2, 32-bit x86),
// same runner, same job, same browser (Chromium and WebKit via Playwright), same C source (tests/src/v86bench.c).
// CI inputs in out/: cb64 (x86-64 musl static, for our engine), cb32 (i386 musl static, for v86), initrd.cpio (cb32 as /init),
// v86/{libv86.js,v86.wasm,v86-fallback.wasm,seabios.bin,vgabios.bin,bzImage} (downloaded by the workflow, never served by the app).
// usage (repo root): node tests/bench/v86-compare.mjs      REPS=3 (runs per engine/browser, median)
// Times are host-side (performance.now() at the line arrival), never the guest clock.
import { chromium, webkit } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const PORT = 8125, POOL = +(process.env.POOL_MB || 256), REPS = +(process.env.REPS || 3), LIMIT = +(process.env.LIMIT_MS || 420000);
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm' };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/bench.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<!doctype html><title>bench</title><script src="/out/v86/libv86.js"></script>'); }
  const f = path.join(process.cwd(), path.normalize(u));
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
}).listen(PORT);

// ---- one run per engine/browser: returns { lines:[[ms,text]], done, err, ver }
async function runOurs(type) {
  const b = await type.launch();
  try {
    const p = await b.newPage();
    p.on('pageerror', (e) => console.log('[ours page error]', e.message));
    await p.goto(`http://localhost:${PORT}/bench.html`);
    const res = await p.evaluate(({ pool }) => new Promise((ok) => {
      const w = new Worker('/tests/bench/v86-compare-worker.js', { type: 'module' });
      w.onmessage = (e) => ok(e.data);
      w.onerror = (e) => ok({ err: 'worker error: ' + e.message, lines: [], done: false });
      w.postMessage({ files: [['cb', '/out/cb64']], cmd: '/root/cb', pool });
    }), { pool: POOL });
    return { ...res, ver: b.version() };
  } catch (e) { return { err: String(e), lines: [], done: false, ver: '?' }; } finally { await b.close().catch(() => {}); }
}
async function runV86(type) {
  const b = await type.launch();
  try {
    const p = await b.newPage();
    p.on('pageerror', (e) => console.log('[v86 page error]', e.message));
    p.on('console', (m) => { if (m.type() === 'error') console.log('[v86 console]', m.text()); });
    await p.goto(`http://localhost:${PORT}/bench.html`);
    const res = await p.evaluate(({ limit }) => new Promise((ok) => {
      const lines = [], bytes = [];
      let cur = '', t0 = 0, fin = false;
      const end = (err) => { if (fin) return; fin = true; try { em.stop(); } catch (e) {} ok({ lines, done: !err, err: err || '', bytes: bytes.length }); };
      let em;
      try {
        em = new V86({
          wasm_path: '/out/v86/v86.wasm', wasm_fallback_path: '/out/v86/v86-fallback.wasm',
          bios: { url: '/out/v86/seabios.bin' }, vga_bios: { url: '/out/v86/vgabios.bin' },
          bzimage: { url: '/out/v86/bzImage' }, initrd: { url: '/out/initrd.cpio' },
          cmdline: 'console=ttyS0 rdinit=/init tsc=reliable mitigations=off random.trust_cpu=on',
          memory_size: 256 * 1024 * 1024, vga_memory_size: 2 * 1024 * 1024, autostart: false,
          disable_keyboard: true, disable_mouse: true, disable_speaker: true,
        });
      } catch (e) { return end('V86 ctor: ' + (e && e.stack || e)); }
      em.add_listener('serial0-output-byte', (c) => {
        const t = performance.now() - t0;
        if (bytes.length === 0) lines.push([+t.toFixed(1), '@@T firstbyte']);
        bytes.push(1);
        if (c === 10) { const l = cur.replace(/\r/g, ''); cur = ''; lines.push([+t.toFixed(1), l]); if (l === '@@T done') end(''); }
        else cur += String.fromCharCode(c);
      });
      em.add_listener('emulator-ready', () => { t0 = performance.now(); lines.push([0, '@@T start']); em.run(); setTimeout(() => end('timeout after ' + limit + ' ms'), limit); });
      setTimeout(() => end('no emulator-ready in 120 s'), 120000);
    }), { limit: LIMIT });
    return { ...res, ver: b.version() };
  } catch (e) { return { err: String(e), lines: [], done: false, ver: '?' }; } finally { await b.close().catch(() => {}); }
}
// native: run the same binaries on the runner (x86-64 build and i386 build), host-stamped lines
function runNative(bin) {
  return new Promise((ok) => {
    const lines = []; let buf = '', t0 = performance.now(), err = '';
    let c;
    try { c = spawn(bin); } catch (e) { return ok({ lines, done: false, err: String(e) }); }
    c.on('error', (e) => { err = String(e); });
    c.stdout.on('data', (d) => { buf += d; for (let k; (k = buf.indexOf('\n')) >= 0; buf = buf.slice(k + 1)) lines.push([+(performance.now() - t0).toFixed(1), buf.slice(0, k)]); });
    c.on('close', () => ok({ lines, done: lines.some(([, l]) => l === '@@T done'), err }));
  });
}
// "@@T begin:X" / "@@T end:X" -> ms by name; "@@T start" -> "@@T boot:init" = boot; sum for checking
function parse(lines) {
  const o = {}, ms = {}; let st = null;
  for (const [t, l] of lines) {
    let m;
    if (l === '@@T start') st = t;
    else if (l === '@@T boot:init' && st != null) ms.boot = t - st;
    else if (l === '@@T firstbyte' && st != null) ms.firstbyte = t - st;
    else if ((m = /^@@T begin:(\S+)/.exec(l))) o[m[1]] = t;
    else if ((m = /^@@T end:(\S+)/.exec(l)) && o[m[1]] != null) ms[m[1]] = t - o[m[1]];
    else if ((m = /^@@T sum:(\d+)/.exec(l))) ms.sum = +m[1];
  }
  const w = ['int', 'calls', 'sort', 'string', 'float'];
  if (w.every((k) => ms[k] != null)) ms.total = w.reduce((a, k) => a + ms[k], 0);
  return ms;
}
const med = (a) => { a = a.filter((v) => v != null).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
const KEYS = ['int', 'calls', 'sort', 'string', 'float', 'total', 'boot'];
async function reps(label, fn) {
  const all = [], logs = [];
  for (let i = 0; i < REPS; i++) {
    console.log(`::group::${label} rep ${i + 1}`);
    const r = await fn();
    console.log(r.lines.map(([t, l]) => `${t}\t${l}`).filter((s, k) => k < 400).join('\n'));
    if (r.err) console.log('ERR: ' + r.err);
    console.log(`done=${r.done} version=${r.ver || ''}`);
    console.log('::endgroup::');
    all.push({ ms: parse(r.lines), done: r.done, err: r.err, ver: r.ver });
  }
  const m = {}; for (const k of KEYS) m[k] = med(all.filter((a) => a.done).map((a) => a.ms[k]));
  const sums = [...new Set(all.filter((a) => a.done).map((a) => a.ms.sum))];
  return { m, ok: all.filter((a) => a.done).length, n: all.length, sums, err: all.map((a) => a.err).find(Boolean) || '', ver: all[0]?.ver, all };
}

const R = {};
R.native64 = await reps('native x86-64', () => runNative('out/cb64'));
R.native32 = await reps('native i386', () => runNative('out/cb32'));
for (const [n, t] of [['chromium', chromium], ['webkit', webkit]]) {
  R[`ours/${n}`] = await reps(`ours ${n}`, () => runOurs(t));
  R[`v86/${n}`] = await reps(`v86 ${n}`, () => runV86(t));
}
srv.close();

const f = (v) => (v == null ? 'n/a' : v >= 100 ? v.toFixed(0) : v.toFixed(1));
const x = (a, b) => (a != null && b != null && b > 0 ? (a / b).toFixed(2) + 'x' : 'n/a');
const L = [`## Our x86 engine (InkSoC, engine.wasm) vs v86, same runner, same job, same C source`, '',
  `Chromium ${R['ours/chromium'].ver}, WebKit ${R['ours/webkit'].ver} (Playwright 1.49, ubuntu-24.04). Median of ${REPS} cold runs (fresh browser each), host-side timestamps. Ours: x86-64 musl static build running on the real Alpine rootfs/Linux kernel of the engine (Worker, ${POOL} MB pool, default JIT HOT). v86: i386 musl static build (SSE2 floats) as /init of a Linux initramfs on v86's own buildroot kernel (main thread, 256 MB). "native" = the same binary on the runner. Lower is better; v86/ours > 1 means ours is faster.`, ''];
for (const n of ['chromium', 'webkit']) {
  const o = R[`ours/${n}`], v = R[`v86/${n}`];
  L.push(`### ${n}`, '', '| workload | native x86-64 | ours | ours x native | native i386 | v86 | v86 x native | v86 / ours |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const k of KEYS.filter((k) => k !== 'boot')) {
    L.push(`| ${k} (ms) | ${f(R.native64.m[k])} | ${f(o.m[k])} | ${x(o.m[k], R.native64.m[k])} | ${f(R.native32.m[k])} | ${f(v.m[k])} | ${x(v.m[k], R.native32.m[k])} | ${x(v.m[k], o.m[k])} |`);
  }
  L.push(`| boot to first user process (ms) | n/a | ${f(o.m.boot)} | | n/a | ${f(v.m.boot)} | | ${x(v.m.boot, o.m.boot)} |`, '',
    `Finished runs: ours ${o.ok}/${o.n}, v86 ${v.ok}/${v.n}, native64 ${R.native64.ok}/${R.native64.n}, native32 ${R.native32.ok}/${R.native32.n}. v86 first serial byte (kernel start): ${f(v.m.firstbyte)} ms.`, '');
}
const sums = new Set(Object.values(R).flatMap((r) => r.sums));
L.push(`Checksum of the workloads (must be one value on every engine): ${[...sums].join(', ') || 'n/a'} ${sums.size === 1 ? '(equal)' : '(DIFFERENT or missing)'}.`, '',
  'Boot: ours = x.start() to the first line of the program as the first process (kernel of the engine, Alpine rootfs unpacked from the already loaded tar); v86 = run() to the program as PID 1 (SeaBIOS + buildroot kernel + small initramfs). Not the same system image, so read it as order of magnitude. Workloads: int = 40M xorshift32 rounds, calls = fib(32), sort = qsort of 1M uint32, string = 32 x (memcpy+strlen+memchr) over 1 MB, float = 15M double 1/(i*i) (SSE2).');
const bad = Object.entries(R).filter(([, v]) => v.ok < v.n).map(([k, v]) => `${k}: ${v.ok}/${v.n} finished ${v.err}`);
if (bad.length) L.push('', 'Did not finish: ' + bad.join('; '));
const md = L.join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
fs.writeFileSync('out/v86-compare.json', JSON.stringify(R, null, 1));
process.exit(bad.length ? 1 : 0);
