// Item 51: the catalog's WebAssembly tools (sha256sum, zip, unzip, rg, sqlite3, jq) in Chromium (V8) and
// WebKit (JavaScriptCore), same run, 3 reps, median: cold start (--version) and the work on 64 MB files of
// a mounted /mnt (read in pieces). usage (repo root, CI): node tests/bench/browser-tools.mjs
// needs out/ztools.tar (usr/local/bin/<tool>), out/tools/<tool> (the same wasm files), out/browser-tools.sh.
// Prints markdown (and appends it to $GITHUB_STEP_SUMMARY). Exit 1 when a browser did not finish.
import { chromium, webkit } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const PORT = 8125, POOL = +(process.env.POOL_MB || 512), MB = +(process.env.FILE_MB || 64);
const TOOLS = ['sha256sum', 'zip', 'unzip', 'rg', 'sqlite3', 'jq'];
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm' };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/bench.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<!doctype html><title>bench</title>'); }
  const f = path.join(process.cwd(), path.normalize(u));
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
}).listen(PORT);
const job = { files: [['ztools.tar', '/out/ztools.tar'], ['browser-tools.sh', '/out/browser-tools.sh']], tools: TOOLS, cmd: 'sh /root/browser-tools.sh',
  mnt: [['/mnt/b/big.bin', 'bin'], ['/mnt/b/big.csv', 'csv'], ['/mnt/b/big.jsonl', 'jsonl']] };
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
const ratio = (c, w) => (c && w ? w / c : null);
const rx = (r) => (r == null ? 'n/a' : r.toFixed(2) + 'x');
const C = out.chromium, W = out.webkit;
const ms = (b, k, i) => b.reps[k]?.[i]?.ms;
const L = [`## WebAssembly catalog tools in Chromium (V8) vs WebKit (JavaScriptCore), same run`, '',
  `Chromium ${C.ver}, WebKit ${W.ver} (Playwright, ubuntu runner); engine + Alpine in a module Worker, ${POOL} MB pool; ${MB} MB files in /mnt (read in pieces); 3 reps, median (ms). 1st = first rep of the step.`, ''];
// cold start
const rows = [];
L.push('### Start (`--version`; the 1st run of each tool compiles its module)', '', '| tool | module KB | wasm compile Chromium / WebKit (ms, 1st of 3) | start 1st Chromium | start 1st WebKit | ratio 1st | median Chromium | median WebKit | ratio median |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const t of TOOLS) {
  const k = 'v-' + t, c1 = ms(C, k, 0), w1 = ms(W, k, 0), cm = med((C.reps[k] || []).map((r) => r?.ms)), wm = med((W.reps[k] || []).map((r) => r?.ms));
  const cc = C.compile[t], wc = W.compile[t];
  L.push(`| ${t} | ${cc ? (cc[3] / 1024).toFixed(0) : 'n/a'} | ${cc ? cc[0] : 'n/a'} / ${wc ? wc[0] : 'n/a'} | ${f(c1)} | ${f(w1)} | ${rx(ratio(c1, w1))} | ${f(cm)} | ${f(wm)} | ${rx(ratio(cm, wm))} |`);
  rows.push({ name: t + ' start (1st)', r: ratio(c1, w1) }, { name: t + ' start (median)', r: ratio(cm, wm) });
}
// work
const STEPS = [['sha256', 'sha256sum (hashsum), 64 MB bin'], ['zip', 'zip -1, 64 MB bin'], ['unzip', 'unzip, 32 MB zip'], ['rg', 'rg -c, 64 MB csv'], ['jq', 'jq select, 64 MB jsonl'], ['sqlite-ins', 'sqlite3 300k inserts + query'], ['sqlite-imp', 'sqlite3 .import 64 MB csv + query']];
L.push('', `### Work on /mnt files (${MB} MB)`, '', '| step | Chromium ms (reps) | WebKit ms (reps) | median Chromium | median WebKit | WebKit / Chromium | MB/s Chromium | MB/s WebKit | pieces (WebKit) | piece avg KB | serve ms (WebKit) | rc C / W |', '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|');
for (const [k, label] of STEPS) {
  const cr = (C.reps[k] || []).map((r) => r?.ms), wr = (W.reps[k] || []).map((r) => r?.ms), cm = med(cr), wm = med(wr);
  const mbps = (m) => (m ? (MB / (m / 1000)).toFixed(1) : 'n/a');
  const wp = (W.reps[k] || []).find((r) => r?.pieces != null) || {};
  const big = !k.startsWith('sqlite-ins');
  L.push(`| ${label} | ${cr.map(f).join(' / ')} | ${wr.map(f).join(' / ')} | ${f(cm)} | ${f(wm)} | ${rx(ratio(cm, wm))} | ${big ? mbps(cm) : '-'} | ${big ? mbps(wm) : '-'} | ${wp.pieces ?? 'n/a'} | ${wp.pieces ? (wp.bytes / wp.pieces / 1024).toFixed(0) : 'n/a'} | ${wp.serveMs != null ? wp.serveMs.toFixed(0) : 'n/a'} | ${(C.rc[k] || []).join(',')} / ${(W.rc[k] || []).join(',')} |`);
  rows.push({ name: label, r: ratio(cm, wm), cm, wm, wp, k });
}
L.push('', '### Last output of each step (Chromium | WebKit)', '', '| step | Chromium | WebKit |', '|---|---|---|');
for (const k of ['v-sha256sum', 'v-zip', 'v-unzip', 'v-rg', 'v-sqlite3', 'v-jq', 'sha256', 'zipsize', 'unzipsize', 'rg', 'jq', 'sqlite-ins', 'sqlite-imp']) L.push(`| ${k} | \`${(C.vout[k] || 'n/a').replace(/\|/g, '/')}\` | \`${(W.vout[k] || 'n/a').replace(/\|/g, '/')}\` |`);
const worst = rows.filter((x) => x.r != null).sort((a, b) => b.r - a.r).slice(0, 4);
L.push('', '### Worst WebKit / Chromium ratios', '', ...worst.map((x) => `- ${x.name}: ${rx(x.r)}${x.cm ? ` (${f(x.cm)} -> ${f(x.wm)} ms)` : ''}`));
L.push('', `Engine slice reads served to the program: Chromium ${C.serve?.n} pieces ${((C.serve?.bytes || 0) / 1048576).toFixed(0)} MB ${f(C.serve?.ms)} ms; WebKit ${W.serve?.n} pieces ${((W.serve?.bytes || 0) / 1048576).toFixed(0)} MB ${f(W.serve?.ms)} ms. Engine memory at the end: ${C.mem} / ${W.mem} MB.`);
const bad = Object.entries(out).filter(([, v]) => !v.done).map(([k, v]) => `${k}: ${v.err || 'did not finish'}`);
if (bad.length) L.push('', 'Did not finish: ' + bad.join('; '));
const md = L.join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
process.exit(bad.length ? 1 : 0);
