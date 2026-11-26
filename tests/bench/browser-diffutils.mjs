// Item 71: busybox x86 (JIT) diff/cmp vs WebAssembly uutils diffutils, same run, in Chromium (V8) and WebKit (JavaScriptCore),
// 3 reps, median (diff and diff -u of two 10 MB texts with 3 changes, diff -r of 2 trees of 2000 files, cmp of 64 MB) and the start
// (cold = 1st run compiles the module, warm). The 64 MB text is made by the host (unique prose-like words) and read in pieces.
// usage (repo root, CI): node tests/bench/browser-archivers.mjs
// needs out/ztools.tar (usr/local/bin/{diff,cmp}), out/tools/diffutils (the wasm file), out/browser-diffutils.sh.
// Prints markdown (and appends it to $GITHUB_STEP_SUMMARY). Exit 1 when a browser did not finish.
import { chromium, webkit } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const PORT = 8128, POOL = +(process.env.POOL_MB || 1024), MB = +(process.env.FILE_MB || 64);
const TOOLS = ['diffutils'];
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm' };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/bench.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<!doctype html><title>bench</title>'); }
  const f = path.join(process.cwd(), path.normalize(u));
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
}).listen(PORT);
const job = { files: [['ztools.tar', '/out/ztools.tar'], ['browser-diffutils.sh', '/out/browser-diffutils.sh']], tools: TOOLS, cmd: 'sh /root/browser-diffutils.sh',
  mnt: [['/mnt/b/big.txt', 'text']] };
async function run(type, name) {
  const b = await type.launch();
  try {
    const p = await b.newPage();
    p.on('pageerror', (e) => console.log(`[${name} page error]`, e.message));
    p.on('console', (m) => { if (m.type() === 'error') console.log(`[${name} console]`, m.text()); });
    await p.goto(`http://localhost:${PORT}/bench.html`);
    const ver = b.version();
    const res = await p.evaluate(({ job, pool, mb }) => new Promise((ok) => {
      const w = new Worker('/tests/bench/browser-tools-worker.js', { type: 'module' });
      w.onmessage = (e) => ok(e.data);
      w.onerror = (e) => ok({ err: 'worker error: ' + e.message, lines: [], compile: {}, done: false });
      w.postMessage({ ...job, pool, mb });
    }), { job, pool: POOL, mb: MB });
    return { ...res, ver };
  } catch (e) {
    return { err: String(e), lines: [], compile: {}, done: false, ver: '?' };
  } finally { await b.close().catch(() => {}); }
}
// "@@T begin:X.N" / "@@T end:X.N" -> ms per rep; "@@S begin:X.N pieces bytes ms" -> pieces/ms served inside the rep
function parse(lines) {
  const o = {}, so = {}, reps = {}, rc = {}, vout = {};
  for (const [t, l] of lines) {
    let m;
    if ((m = /^@@T begin:(\S+)\.(\d+)$/.exec(l))) o[m[1] + '.' + m[2]] = t;
    else if ((m = /^@@T end:(\S+)\.(\d+)$/.exec(l)) && o[m[1] + '.' + m[2]] != null) (reps[m[1]] ||= [])[+m[2] - 1] = { ms: t - o[m[1] + '.' + m[2]] };
    else if ((m = /^@@S begin:(\S+\.\d+) (\d+) (\d+) ([\d.]+)$/.exec(l))) so[m[1]] = [+m[2], +m[3], +m[4]];
    else if ((m = /^@@S end:(\S+)\.(\d+) (\d+) (\d+) ([\d.]+)$/.exec(l)) && so[m[1] + '.' + m[2]]) {
      const r = reps[m[1]]?.[+m[2] - 1], b = so[m[1] + '.' + m[2]];
      if (r) { r.pieces = +m[3] - b[0]; r.bytes = +m[4] - b[1]; r.serveMs = +m[5] - b[2]; }
    } else if ((m = /^@@RC (\S+)\.(\d+) (\d+)$/.exec(l))) (rc[m[1]] ||= [])[+m[2] - 1] = +m[3];
    else if ((m = /^@@V (\S+) ?(.*)$/.exec(l))) vout[m[1]] = m[2];
  }
  return { reps, rc, vout };
}
const med = (a) => { const s = a.filter((v) => v != null).sort((x, y) => x - y); return s.length ? s[(s.length - 1) >> 1] : null; };
const out = {};
for (const [n, t] of [['chromium', chromium], ['webkit', webkit]]) {
  console.log(`::group::${n}`);
  const res = await run(t, n);
  console.log(res.lines.map(([t, l]) => `${t}\t${l}`).join('\n'));
  if (res.err) console.log('ERR: ' + res.err);
  console.log(`done=${res.done} serve=${JSON.stringify(res.serve)} compile=${JSON.stringify(res.compile)} mem=${res.mem}MB version=${res.ver}`);
  console.log('::endgroup::');
  out[n] = { ...res, ...parse(res.lines) };
}
srv.close();
const f = (v) => (v == null ? 'n/a' : v.toFixed(0));
const rx = (r) => (r == null ? 'n/a' : r.toFixed(2) + 'x');
const C = out.chromium, W = out.webkit;
const L = [`## busybox x86 (JIT) vs WebAssembly diff/cmp (uutils diffutils), Chromium (V8) and WebKit (JavaScriptCore), same run`, '',
  `Chromium ${C.ver}, WebKit ${W.ver} (Playwright, ubuntu runner); engine + Alpine in a module Worker, ${POOL} MB pool; two 10 MB texts with 3 changed lines, a pair of trees of 2000 files (3 KB each), ${MB} MB text for cmp; 3 reps (big ones: 2), median (ms). speedup = busybox / WebAssembly (above 1 = WebAssembly faster). Same output = byte for byte, timestamps of the --- / +++ headers cut.`, ''];
const STEPS = [['d', 'diff a b, 10 MB'], ['u', 'diff -u a b, 10 MB'], ['eq', 'diff a a (equal), 10 MB'], ['r', 'diff -r, 2000 files'], ['ru', 'diff -ru, 2000 files'], ['rq', 'diff -rq, 2000 files'], ['cmpeq', `cmp equal, ${MB} MB`], ['cmpne', `cmp differs near the end, ${MB} MB`]];
L.push('### Work', '', '| step | busybox C ms | WASM C ms | speedup C | busybox W ms | WASM W ms | speedup W | same output C / W | rc bb/wa C | rc bb/wa W |', '|---|---:|---:|---:|---:|---:|---:|---|---|---|');
const rcs = (b, k) => `${(b.rc['bb-' + k] || []).join('')}/${(b.rc['wa-' + k] || []).join('')}`;
for (const [k, label] of STEPS) {
  const g = (b, v) => med((b.reps[v + '-' + k] || []).map((r) => r?.ms));
  const cb = g(C, 'bb'), cw = g(C, 'wa'), wb = g(W, 'bb'), ww = g(W, 'wa');
  L.push(`| ${label} | ${f(cb)} | ${f(cw)} | ${rx(cb / cw)} | ${f(wb)} | ${f(ww)} | ${rx(wb / ww)} | ${C.vout['same-' + k] ?? '(rc only)'} / ${W.vout['same-' + k] ?? '(rc only)'} | ${rcs(C, k)} | ${rcs(W, k)} |`);
}
L.push('', `Checks: wasm \`diff -u\` applied with busybox patch gives b.txt: Chromium ${C.vout['patch-wa']}, WebKit ${W.vout['patch-wa']}; cmp (differs) first line: Chromium \`${C.vout['cmpne-out']}\`; missing file exit status: Chromium ${C.vout['rc-missing']}, WebKit ${W.vout['rc-missing']}.`);
L.push('', '### Start', '', '| step | busybox C | WASM C 1st (cold) | WASM C median | busybox W | WASM W 1st (cold) | WASM W median |', '|---|---:|---:|---:|---:|---:|---:|');
const per = (b, v, k) => (b.reps[v + '-' + k] || []).map((r) => r?.ms);
L.push(`| diff of 2 tiny files | ${f(med(per(C, 'bb', 'start')))} | ${f(per(C, 'wa', 'start')[0])} | ${f(med(per(C, 'wa', 'start')))} | ${f(med(per(W, 'bb', 'start')))} | ${f(per(W, 'wa', 'start')[0])} | ${f(med(per(W, 'wa', 'start')))} |`);
for (const n of TOOLS) L.push('', `${n}.wasm: ${((C.compile[n]?.[3] || 0) / 1048576).toFixed(2)} MB; WebAssembly.compile Chromium ${(C.compile[n] || []).slice(0, 3).join(' / ')} ms, WebKit ${(W.compile[n] || []).slice(0, 3).join(' / ')} ms (3 reps).`);
L.push('', `Setup: Chromium \`${C.vout.setup}\` ${C.vout['setup-files']} ${C.vout['setup-tree']} ${C.vout['setup-cmp']}.`);
const bad = Object.entries(out).filter(([, v]) => !v.done).map(([k, v]) => `${k}: ${v.err || 'did not finish'}`);
if (bad.length) L.push('', 'Did not finish: ' + bad.join('; '));
const md = L.join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
process.exit(bad.length ? 1 : 0);
