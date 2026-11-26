// Item 78: one small comparison in Chromium (1 size, 1 rep): python3 subprocess.run(['sort', file]) from the
// WebAssembly python3 (host channel /dev/inksoc) vs x86 python3; find -exec (200 files) WebAssembly find vs busybox.
// usage (repo root, CI): node tests/bench/procs-bench.mjs  needs out/zpkgs.tar (x86 python3), out/zpywasm.tar,
// out/find.wasm, tests/bench/procs-bench.sh. The engine runs in a module Worker (tests/bench/browser-worker.js:
// WebAssembly programs inline, so their children are x86 programs here: busybox sort/true).
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const PORT = 8125;
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/bench.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<!doctype html><title>bench</title>'); }
  const f = path.join(process.cwd(), path.normalize(u));
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
}).listen(PORT);
const files = [['zpkgs.tar', '/out/zpkgs.tar'], ['zpywasm.tar', '/out/zpywasm.tar'], ['find.wasm', '/out/find.wasm'], ['procs-bench.sh', '/tests/bench/procs-bench.sh']];
const b = await chromium.launch();
let res;
try {
  const p = await b.newPage();
  p.on('pageerror', (e) => console.log('[page error]', e.message));
  await p.goto(`http://localhost:${PORT}/bench.html`);
  res = await p.evaluate(({ files }) => new Promise((ok) => {
    const w = new Worker('/tests/bench/browser-worker.js', { type: 'module' });
    w.onmessage = (e) => ok(e.data);
    w.onerror = (e) => ok({ err: 'worker error: ' + e.message, lines: [], done: false });
    w.postMessage({ files, cmd: 'sh /root/procs-bench.sh', pool: 512 });
  }), { files });
  res.ver = b.version();
} finally { await b.close().catch(() => {}); srv.close(); }
console.log(res.lines.map(([t, l]) => `${t}\t${l}`).join('\n'));
if (res.err) console.log('ERR: ' + res.err);
const o = {}, ms = {};
for (const [t, l] of res.lines) { let m; if ((m = /^@@T begin:(\S+)/.exec(l))) o[m[1]] = t; else if ((m = /^@@T end:(\S+)/.exec(l)) && o[m[1]] != null) ms[m[1]] = t - o[m[1]]; }
const f = (v) => (v == null || Number.isNaN(v) ? 'n/a' : v.toFixed(0));
const L = [`## Item 78: processes from WebAssembly programs (Chromium ${res.ver}, 1 rep, ms)`, '',
  '| | x86 | WebAssembly (bridge) |', '|---|---|---|',
  `| python3 -c pass | ${f(ms['py-pass-x86'])} | ${f(ms['py-pass-wasm'])} |`,
  `| python3 subprocess.run(['sort', 20000 lines]) (whole run) | ${f(ms['py-sort-x86'])} | ${f(ms['py-sort-wasm'])} |`,
  `| same minus python3 start | ${f(ms['py-sort-x86'] - ms['py-pass-x86'])} | ${f(ms['py-sort-wasm'] - ms['py-pass-wasm'])} |`,
  `| find 200 files -exec true {} \\; | ${f(ms['find-busybox'])} (busybox) | ${f(ms['find-wasm'])} (uutils find) |`, ''];
console.log(L.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, L.join('\n') + '\n');
process.exit(res.done ? 0 : 1);
