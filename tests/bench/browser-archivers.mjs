// Item 68: busybox x86 (JIT) vs WebAssembly gzip (zlib), xz (liblzma) and tar (bsdtar), same run, in Chromium (V8) and WebKit (JavaScriptCore),
// 3 reps, median (gzip -c and gunzip of a 64 MB text, xz -d of the xz of it, tar -c / -x of a tree of 4000 files, also with gzip) and the start
// (cold = 1st run compiles the module, warm). The 64 MB text is made by the host (unique prose-like words: no 1 MB repeat) and read in pieces.
// usage (repo root, CI): node tests/bench/browser-archivers.mjs
// needs out/ztools.tar (usr/local/bin/{gzip,gunzip,zcat,xz,unxz,xzcat,tar,md5sum}), out/tools/{gzip,xz,bsdtar} (the wasm files), out/browser-archivers.sh.
// Prints markdown (and appends it to $GITHUB_STEP_SUMMARY). Exit 1 when a browser did not finish.
import { chromium, webkit } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const PORT = 8127, POOL = +(process.env.POOL_MB || 1024), MB = +(process.env.FILE_MB || 64);
const BZ = process.env.ARCH_SET === 'bz'; // item 70: bzip2 + zstd (bench script browser-archivers-bz.sh); default = item 68 set
const TOOLS = BZ ? ['bzip2', 'zstd'] : ['gzip', 'xz', 'bsdtar'];
const SH = BZ ? 'browser-archivers-bz.sh' : 'browser-archivers.sh';
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm' };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/bench.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<!doctype html><title>bench</title>'); }
  const f = path.join(process.cwd(), path.normalize(u));
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
}).listen(PORT);
const job = { files: [['ztools.tar', '/out/ztools.tar'], [SH, '/out/' + SH]], tools: TOOLS, cmd: 'sh /root/' + SH,
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
const rx = (r) => (!r || !isFinite(r) ? 'n/a' : r.toFixed(2) + 'x');
const C = out.chromium, W = out.webkit;
const L = [`## busybox x86 (JIT) vs WebAssembly ${BZ ? 'bzip2/zstd' : 'gzip/xz/tar'}, Chromium (V8) and WebKit (JavaScriptCore), same run`, '',
  `Chromium ${C.ver}, WebKit ${W.ver} (Playwright, ubuntu runner); engine + Alpine in a module Worker, ${POOL} MB pool; ${MB} MB text in /mnt (read in pieces)${BZ ? '' : ', a tree of 4000 files (3 KB each) in /tmp'}; 3 reps (bzip2 -c: 1, busybox bunzip2: 2), median (ms). speedup = busybox / WebAssembly (above 1 = WebAssembly faster). Compressed bytes differ between encoders, so compression is checked by a round trip through the other side's decoder.`, ''];
const STEPS = BZ ? [['bzc', `bzip2 -c, ${MB} MB text`, ['bzc-rt-wa-reads-bb', 'bzc-rt-bb-reads-wa']], ['bzd', `bunzip2 -c > /dev/null, ${MB} MB text (bz2)`, ['bzd-bb', 'bzd-wa', 'bzcat-wa']],
  ['zsc', `zstd -c (level 3), ${MB} MB text (no busybox zstd)`, ['zsd-wa', 'zscat-wa', 'zst-t', 'zst-bad', 'zst-pipe']], ['zs1c', `zstd -1 -c, ${MB} MB text`, ['zs1-rt']], ['zsd', `zstd -dc > /dev/null, ${MB} MB text`, ['zsd-wa']]] : [['gzc', `gzip -c, ${MB} MB text`, ['gzc-rt-wa-reads-bb', 'gzc-rt-bb-reads-wa']], ['gzd', `gunzip -c > /dev/null, ${MB} MB text (gz)`, ['gzd-bb', 'gzd-wa']],
  ['xzd', `xz -dc > /dev/null, ${MB} MB text (xz -1)`, ['xzd-wa']], ['tarc', 'tar -cf, 4000 files', ['tarc-names']], ['tarx', 'tar -xf, 4000 files', ['tarx-bb', 'tarx-wa']],
  ['tgzc', 'tar -czf, 4000 files', ['tgzc-wa-reads-bb', 'tgzc-bb-reads-wa']], ['tgzx', 'tar -xzf, 4000 files', ['tgzx-bb', 'tgzx-wa']]];
L.push('### Work', '', '| step | busybox C ms | WASM C ms | speedup C | busybox W ms | WASM W ms | speedup W | same output | rc bb/wa C | rc bb/wa W |', '|---|---:|---:|---:|---:|---:|---:|---|---|---|');
const rcs = (b, k) => `${(b.rc['bb-' + k] || []).join('')}/${(b.rc['wa-' + k] || []).join('')}`;
const same = (b, ks) => (ks.every((k) => b.vout[k] === 'yes') ? 'yes' : ks.map((k) => b.vout[k] || '?').join(' ; '));
for (const [k, label, ks] of STEPS) {
  const g = (b, v) => med((b.reps[v + '-' + k] || []).map((r) => r?.ms));
  const cb = g(C, 'bb'), cw = g(C, 'wa'), wb = g(W, 'bb'), ww = g(W, 'wa');
  L.push(`| ${label} | ${f(cb)} | ${f(cw)} | ${rx(cb / cw)} | ${f(wb)} | ${f(ww)} | ${rx(wb / ww)} | ${same(C, ks)} / ${same(W, ks)} | ${rcs(C, k)} | ${rcs(W, k)} |`);
}
const xc = (b) => med((b.reps['wa-xzc'] || []).map((r) => r?.ms));
if (!BZ) L.push('', `xz -1 compress of ${MB} MB (WebAssembly only; busybox cannot compress xz): Chromium ${f(xc(C))} ms, WebKit ${f(xc(W))} ms.`);
L.push('', '### Start', '', '| step | busybox C | WASM C 1st (cold) | WASM C median | busybox W | WASM W 1st (cold) | WASM W median |', '|---|---:|---:|---:|---:|---:|---:|');
const per = (b, v, k) => (b.reps[v + '-' + k] || []).map((r) => r?.ms);
if (BZ) {
  const row = (label, bv, wv) => L.push(`| ${label} | ${bv ? f(med(per(C, 'bb', 'start'))) : 'n/a'} | ${f(per(C, wv, bv ? 'start' : 'zstart')[0])} | ${f(med(per(C, wv, bv ? 'start' : 'zstart')))} | ${bv ? f(med(per(W, 'bb', 'start'))) : 'n/a'} | ${f(per(W, wv, bv ? 'start' : 'zstart')[0])} | ${f(med(per(W, wv, bv ? 'start' : 'zstart')))} |`);
  row('bzip2 -c, bunzip2 -c in a pipe (tiny)', true, 'wa'); row('zstd -c, unzstd -c in a pipe (tiny)', false, 'wa');
} else L.push(`| gzip -c, gunzip -c in a pipe (tiny) | ${f(med(per(C, 'bb', 'start')))} | ${f(per(C, 'wa', 'start')[0])} | ${f(med(per(C, 'wa', 'start')))} | ${f(med(per(W, 'bb', 'start')))} | ${f(per(W, 'wa', 'start')[0])} | ${f(med(per(W, 'wa', 'start')))} |`);
for (const n of TOOLS) L.push('', `${n}.wasm: ${((C.compile[n]?.[3] || 0) / 1048576).toFixed(2)} MB; WebAssembly.compile Chromium ${(C.compile[n] || []).slice(0, 3).join(' / ')} ms, WebKit ${(W.compile[n] || []).slice(0, 3).join(' / ')} ms (3 reps).`);
if (BZ) L.push('', `Sizes: Chromium bzip2 -c ${C.vout['bzc-size']}; zstd -c ${C.vout['zsc-size']}; zstd -1 ${C.vout['zs1c-size']}. WebKit: bzip2 -c ${W.vout['bzc-size']}; zstd -c ${W.vout['zsc-size']}.`);
else L.push('', `Sizes: Chromium \`${C.vout.setup}\`; gzip -c ${C.vout['gzc-size']}; tar -cf ${C.vout['tarc-size']}; tar -czf ${C.vout['tgzc-size']}; ${C.vout['xzc-size']}. WebKit: gzip -c ${W.vout['gzc-size']}; tar -cf ${W.vout['tarc-size']}.`);
const bad = Object.entries(out).filter(([, v]) => !v.done).map(([k, v]) => `${k}: ${v.err || 'did not finish'}`);
if (bad.length) L.push('', 'Did not finish: ' + bad.join('; '));
const md = L.join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
process.exit(bad.length ? 1 : 0);
