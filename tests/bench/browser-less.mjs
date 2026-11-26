// Item 73: busybox x86 (JIT) less vs WebAssembly less (less 692) in Chromium (V8): one size, one rep (the 2nd WebAssembly run is warm).
// usage (repo root, CI): node tests/bench/browser-less.mjs
// needs out/ztools.tar (usr/local/bin/less), out/tools/less (the wasm file), out/browser-less.sh.
// Prints markdown (and appends it to $GITHUB_STEP_SUMMARY). Exit 1 when the browser did not finish.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const PORT = 8129, POOL = +(process.env.POOL_MB || 512);
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm' };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/bench.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<!doctype html><title>bench</title>'); }
  const f = path.join(process.cwd(), path.normalize(u));
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
}).listen(PORT);
const job = { files: [['ztools.tar', '/out/ztools.tar'], ['browser-less.sh', '/out/browser-less.sh']], tools: ['less'], cmd: 'sh /root/browser-less.sh', mnt: [] };
// less.wasm uses setjmp/longjmp with the standard (exnref) exception handling: Chromium 131 (Playwright 1.49) needs the flag
const b = await chromium.launch({ args: ['--js-flags=--experimental-wasm-exnref'] });
let res;
try {
  const p = await b.newPage();
  p.on('pageerror', (e) => console.log('[page error]', e.message));
  await p.goto(`http://localhost:${PORT}/bench.html`);
  res = await p.evaluate(({ job, pool }) => new Promise((ok) => {
    const w = new Worker('/tests/bench/browser-tools-worker.js', { type: 'module' });
    w.onmessage = (e) => ok(e.data);
    w.onerror = (e) => ok({ err: 'worker error: ' + e.message, lines: [], compile: {}, done: false });
    w.postMessage({ ...job, pool, mb: 1 });
  }), { job, pool: POOL });
  res.ver = b.version();
} catch (e) { res = { err: String(e), lines: [], compile: {}, done: false, ver: '?' }; } finally { await b.close().catch(() => {}); }
srv.close();
console.log(res.lines.map(([t, l]) => `${t}\t${l}`).join('\n'));
if (res.err) console.log('ERR: ' + res.err);
const o = {}, ms = {}, rc = {}, vout = {};
for (const [t, l] of res.lines) {
  let m;
  if ((m = /^@@T begin:(\S+)\.1$/.exec(l))) o[m[1]] = t;
  else if ((m = /^@@T end:(\S+)\.1$/.exec(l)) && o[m[1]] != null) ms[m[1]] = t - o[m[1]];
  else if ((m = /^@@RC (\S+)\.1 (\d+)$/.exec(l))) rc[m[1]] = +m[2];
  else if ((m = /^@@V (\S+) ?(.*)$/.exec(l))) vout[m[1]] = m[2];
}
const f = (v) => (v == null ? 'n/a' : v.toFixed(0));
const rx = (r) => (!r || !isFinite(r) ? 'n/a' : r.toFixed(2) + 'x');
const L = ['## busybox x86 (JIT) less vs WebAssembly less (less 692), Chromium (V8)', '',
  `Chromium ${res.ver}; engine + Alpine in a module Worker, ${POOL} MB pool; one size, one rep each (output to a file: both copy the file through). ${vout.setup}`, '',
  '| step | busybox ms | WASM ms | WASM 2nd (warm) ms | busybox/WASM | same output | rc bb/wa |', '|---|---:|---:|---:|---:|---|---|'];
L.push(`| less -F 20 lines (start) | ${f(ms['bb-start'])} | ${f(ms['wa-start'])} | ${f(ms['wa-start2'])} | ${rx(ms['bb-start'] / ms['wa-start2'])} | ${vout.small || '?'} | ${rc['bb-start']}/${rc['wa-start']} |`);
L.push(`| less 2.6 MB file (400000 lines) | ${f(ms['bb-big'])} | ${f(ms['wa-big'])} | ${f(ms['wa-big2'])} | ${rx(ms['bb-big'] / ms['wa-big2'])} | ${vout.big || '?'} | ${rc['bb-big']}/${rc['wa-big']} |`);
L.push('', `less.wasm ${((res.compile.less?.[3] || 0) / 1048576).toFixed(2)} MB, WebAssembly.compile ${(res.compile.less || []).slice(0, 3).join(' / ')} ms.`);
if (!res.done) L.push('', 'Did not finish: ' + (res.err || 'no @@T done'));
const md = L.join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
process.exit(res.done ? 0 : 1);
