// Item 55 (measurement only): x86 JIT compile cost in WebKit (JSC) vs Chromium (V8), split into a fixed
// cost per module and a cost per KB, and the gain of merging N JIT regions into one module (option C).
// usage (repo root, CI): node tests/bench/jitsplit.mjs   needs out/zpkgs.tar (x86 python3), out/browser.sh.
// 1. Chromium runs `sh browser.sh py` (python3 x86 -c pass x2 + 1M loop) with the engine default
//    (HOT 500, region 16) and dumps every JIT module (jitsplit-worker.js); modules compiled between the
//    py-start-2 markers = set "py2", all of the run = set "py".
// 2. Each browser replays each set (jitsplit-replay.js): N = 1, 4, 16, 64 regions per module.
// Prints markdown (and appends it to $GITHUB_STEP_SUMMARY). Exit 1 when a step fails.
import { chromium, webkit } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const PORT = 8125, POOL = +(process.env.POOL_MB || 512);
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm' };
const hdr = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
fs.mkdirSync('out', { recursive: true });
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (q.method === 'POST') {
    const parts = [];
    q.on('data', (d) => parts.push(d));
    q.on('end', () => { fs.writeFileSync(u === '/dump' ? 'out/jitmods.bin' : 'out/jitmods.json', Buffer.concat(parts)); r.writeHead(200); r.end(); });
    return;
  }
  if (u === '/bench.html') { r.writeHead(200, { 'content-type': 'text/html', ...hdr }); return r.end('<!doctype html><title>bench</title>'); }
  const f = path.join(process.cwd(), path.normalize(u));
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', ...hdr }); r.end(d); });
}).listen(PORT);
async function inPage(type, name, script, msg) {
  const b = await type.launch();
  try {
    const p = await b.newPage();
    p.on('pageerror', (e) => console.log(`[${name} page error]`, e.message));
    p.on('console', (m) => { if (m.type() === 'error') console.log(`[${name} console]`, m.text()); });
    await p.goto(`http://localhost:${PORT}/bench.html`);
    const res = await p.evaluate(({ script, msg }) => new Promise((ok) => {
      const w = new Worker(script, { type: 'module' });
      w.onmessage = (e) => ok(e.data);
      w.onerror = (e) => ok({ err: 'worker error: ' + e.message });
      w.postMessage(msg);
    }), { script, msg });
    return { ...res, ver: b.version() };
  } catch (e) { return { err: String(e), ver: '?' }; } finally { await b.close().catch(() => {}); }
}
const fail = [];
// 1. capture
console.log('::group::capture (chromium)');
const cap = await inPage(chromium, 'capture', '/tests/bench/jitsplit-worker.js',
  { files: [['zpkgs.tar', '/out/zpkgs.tar'], ['browser.sh', '/out/browser.sh']], cmd: 'sh /root/browser.sh py', pool: POOL });
console.log((cap.lines || []).map(([t, l]) => `${t}\t${l}`).join('\n'));
console.log(`done=${cap.done} nmods=${cap.nmods} jit=${JSON.stringify(cap.jit)} err=${cap.err || ''}`);
console.log('::endgroup::');
if (!cap.done || cap.err || !fs.existsSync('out/jitmods.bin')) { console.log('capture failed'); srv.close(); process.exit(1); }
const at = {};
for (const [t, l] of cap.lines) { const m = /^@@T (begin|end):(\S+)/.exec(l); if (m) at[m[1] + ':' + m[2]] = t; }
const times = JSON.parse(fs.readFileSync('out/jitmods.json', 'utf8')), all = fs.readFileSync('out/jitmods.bin');
const mods = [];
for (let i = 0; i < all.length;) { const n = all.readUInt32LE(i); mods.push(all.subarray(i, i + 4 + n)); i += 4 + n; }
const sets = {
  py2: mods.filter((m, k) => times[k] >= at['begin:py-start-2'] && times[k] <= at['end:py-start-2']),
  py: mods,
};
for (const [k, v] of Object.entries(sets)) fs.writeFileSync(`out/jitset-${k}.bin`, Buffer.concat(v));
// the live engine's own Module time for py2 (Chromium, inside host_jit, sync compile only) is not split out;
// jit.ms of the capture is compile+instantiate for the whole run
// 2. replay
const R = {};
for (const s of Object.keys(sets)) for (const [n, t] of [['chromium', chromium], ['webkit', webkit]]) {
  console.log(`::group::replay ${s}/${n}`);
  const r = await inPage(t, n, '/tests/bench/jitsplit-replay.js', { url: `/out/jitset-${s}.bin` });
  console.log(JSON.stringify(r));
  console.log('::endgroup::');
  if (r.err || !r.res) fail.push(`${s}/${n}: ${r.err}`);
  R[`${s}/${n}`] = r;
}
srv.close();
const f = (v, d = 0) => (v == null || !isFinite(v) ? 'n/a' : v.toFixed(d));
const L = ['## Item 55: x86 JIT compile cost, fixed per module vs per KB (Chromium V8 vs WebKit JSC)', '',
  `Chromium ${R['py/chromium']?.ver}, WebKit ${R['py/webkit']?.ver}. Real JIT modules of \`python3 -c pass\` x2 + 1M loop (x86, engine default HOT 500 / region 16), dumped from Chromium, replayed in each browser. ` +
  `Set py2 = modules compiled during the 2nd \`python3 -c pass\`; py = whole run. Capture: ${cap.jit.n} modules, ${f(cap.jit.bytes / 1024)} KB, live compile+instantiate ${f(cap.jit.ms)} ms (Chromium). ` +
  'Times = 2nd of 2 reps (1st in parentheses), ms for the whole set. sync = `new WebAssembly.Module` one after another (what host_jit does), async = `await WebAssembly.compile` one after another, par = all `compile` at once, inst = `new Instance`, call1 = first call of every function (stub imports, zeroed memory: runs to the first exit/trap; includes lazy tier compile), call2 = second call.', ''];
for (const s of Object.keys(sets)) {
  const c0 = R[`${s}/chromium`]?.res, w0 = R[`${s}/webkit`]?.res;
  L.push(`### set ${s}: ${c0?.n ?? w0?.n} modules, ${f(c0?.kb ?? w0?.kb)} KB (timer tick Chromium ${f(c0?.tick, 3)} ms, WebKit ${f(w0?.tick, 3)} ms; crossOriginIsolated ${c0?.coi}/${w0?.coi})`, '',
    '| browser | regions/module | modules | sync | async | par | inst | call1 | call2 | sync+inst+call1 | vs N=1 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const n of ['chromium', 'webkit']) {
    const res = R[`${s}/${n}`]?.res; if (!res) continue;
    const [r1, r2] = res.reps, tot = (o) => o.sync + o.inst + o.call1, base = tot(r2.n1);
    for (const N of [1, 4, 16, 64]) {
      const o = r2['n' + N], p = r1['n' + N];
      const cell = (k) => `${f(o[k])} (${f(p[k])})`;
      L.push(`| ${n} | ${N} | ${o.modules} | ${cell('sync')} | ${cell('async')} | ${cell('asyncPar')} | ${cell('inst')} | ${cell('call1')} | ${cell('call2')} | ${f(tot(o))} (${f(tot(p))}) | ${f((tot(o) / base - 1) * 100)}% |`);
    }
  }
  L.push('', '| browser | fit a (ms/module) | fit b (ms/KB) | a x modules | b x KB | fixed share | fixed from batching: (sync N=1 - sync N=64) / modules |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const n of ['chromium', 'webkit']) {
    const res = R[`${s}/${n}`]?.res; if (!res) continue;
    for (const [i, r] of res.reps.entries()) {
      const { a, b } = r.fit, A = a * res.n, Bk = b * res.kb;
      L.push(`| ${n} rep ${i + 1} | ${f(a, 4)} | ${f(b, 4)} | ${f(A)} | ${f(Bk)} | ${f(A / (A + Bk) * 100)}% | ${f((r.n1.sync - r.n64.sync) / res.n / (1 - 1 / 64), 4)} |`);
    }
  }
  L.push('');
}
if (fail.length) L.push('Failed: ' + fail.join('; '));
const md = L.join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
process.exit(fail.length ? 1 : 0);
