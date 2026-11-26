// Item 72: busybox x86 (JIT) bc/dc vs WebAssembly bc/dc (Gavin Howard's bc) in Chromium (V8), same run, 3 reps for WebAssembly, 1 for busybox.
// usage (repo root, CI): node tests/bench/browser-bc.mjs
// needs out/ztools.tar (usr/local/bin/{bc,dc}), out/tools/bc (the wasm file), out/browser-bc.sh.
// Prints markdown (and appends it to $GITHUB_STEP_SUMMARY). Exit 1 when the browser did not finish.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const PORT = 8128, POOL = +(process.env.POOL_MB || 512);
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm' };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/bench.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<!doctype html><title>bench</title>'); }
  const f = path.join(process.cwd(), path.normalize(u));
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
}).listen(PORT);
const job = { files: [['ztools.tar', '/out/ztools.tar'], ['browser-bc.sh', '/out/browser-bc.sh']], tools: ['bc'], cmd: 'sh /root/browser-bc.sh', mnt: [] };
const b = await chromium.launch();
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
const o = {}, reps = {}, rc = {}, vout = {};
for (const [t, l] of res.lines) {
  let m;
  if ((m = /^@@T begin:(\S+)\.(\d+)$/.exec(l))) o[m[1] + '.' + m[2]] = t;
  else if ((m = /^@@T end:(\S+)\.(\d+)$/.exec(l)) && o[m[1] + '.' + m[2]] != null) (reps[m[1]] ||= [])[+m[2] - 1] = t - o[m[1] + '.' + m[2]];
  else if ((m = /^@@RC (\S+)\.(\d+) (\d+)$/.exec(l))) (rc[m[1]] ||= [])[+m[2] - 1] = +m[3];
  else if ((m = /^@@V (\S+) ?(.*)$/.exec(l))) vout[m[1]] = m[2];
}
const med = (a) => { const s = (a || []).filter((v) => v != null).sort((x, y) => x - y); return s.length ? s[(s.length - 1) >> 1] : null; };
const f = (v) => (v == null ? 'n/a' : v.toFixed(0));
const rx = (r) => (!r || !isFinite(r) ? 'n/a' : r.toFixed(2) + 'x');
const L = ['## busybox x86 (JIT) bc/dc vs WebAssembly bc/dc (Gavin Howard 7.0.3), Chromium (V8)', '',
  `Chromium ${res.ver}; engine + Alpine in a module Worker, ${POOL} MB pool; busybox 1 rep, WebAssembly median of 3. busybox: ${vout.setup}`, '',
  '| step | busybox ms | WASM ms | speedup | same output | rc bb/wa |', '|---|---:|---:|---:|---|---|'];
for (const [k, label, chk] of [['pow', 'echo 2^100000 | bc (30103 digits)', 'pow'], ['sqrt', "scale=2000; sqrt(2) | bc", 'sqrt'], ['dc', "dc: 2 100000 ^ p", 'dc']]) {
  const bb = med(reps['bb-' + k]), wa = med(reps['wa-' + k]);
  L.push(`| ${label} | ${f(bb)} | ${f(wa)} | ${rx(bb / wa)} | ${vout[chk] || '?'} | ${(rc['bb-' + k] || []).join('')}/${(rc['wa-' + k] || []).join('')} |`);
}
L.push('', `WebAssembly only: scale=2000; 4*a(1) with bc -l: ${f(med(reps['wa-pi']))} ms (starts ${vout['pi-head']}); dc output equals bc output: ${vout['dc-vs-bc']}; 2^100000 digits ${vout['pow-digits']}.`);
L.push('', `Start (echo 1+1 | bc): busybox ${f(med(reps['bb-start']))} ms; WebAssembly 1st (cold) ${f((reps['wa-start'] || [])[0])} ms, median ${f(med(reps['wa-start']))} ms. bc.wasm ${((res.compile.bc?.[3] || 0) / 1048576).toFixed(2)} MB, WebAssembly.compile ${(res.compile.bc || []).slice(0, 3).join(' / ')} ms.`);
if (!res.done) L.push('', 'Did not finish: ' + (res.err || 'no @@T done'));
const md = L.join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
process.exit(res.done ? 0 : 1);
