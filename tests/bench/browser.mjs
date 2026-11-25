// Item 47: the engine in Chromium (V8) and WebKit (JavaScriptCore) in the same run, same inputs.
// usage (repo root, CI): node tests/bench/browser.mjs   needs out/cpubench, out/zpkgs.tar (x86 python3),
// out/zpywasm.tar (the catalog's python3 WebAssembly), out/browser.sh. Prints a markdown table
// (and appends it to $GITHUB_STEP_SUMMARY). Exit 1 when a browser did not finish a run.
// HOTS=10,40,100 (item 48): also runs the x86 subset once per JIT hot threshold (set_jit_hot) in each
// browser and adds a sweep table; the main table stays the engine default (no set_jit_hot call).
// REGIONS=16,32,64 (item 52): the sweep becomes HOTS x REGIONS (set_jit_region = max blocks per region).
import { chromium, webkit } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const PORT = 8124, POOL = +(process.env.POOL_MB || 512);
const HOTS = (process.env.HOTS || '').split(',').map(Number).filter((n) => n > 0);
const REGIONS = (process.env.REGIONS || '').split(',').map(Number).filter((n) => n > 0);
const RS = REGIONS.length ? REGIONS : [0]; // 0 = engine default (no set_jit_region call)
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm' };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/bench.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<!doctype html><title>bench</title>'); }
  const f = path.join(process.cwd(), path.normalize(u));
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
}).listen(PORT);
const RUNS = [
  { id: 'x86', files: [['cpubench', '/out/cpubench'], ['zpkgs.tar', '/out/zpkgs.tar'], ['browser.sh', '/out/browser.sh']], cmd: 'sh /root/browser.sh cpu py' },
  { id: 'wasm', files: [['zpywasm.tar', '/out/zpywasm.tar'], ['browser.sh', '/out/browser.sh']], cmd: 'sh /root/browser.sh py' },
];
async function run(type, name, r, hot = 0, region = 0) {
  const b = await type.launch();
  try {
    const p = await b.newPage();
    p.on('pageerror', (e) => console.log(`[${name} page error]`, e.message));
    p.on('console', (m) => { if (m.type() === 'error') console.log(`[${name} console]`, m.text()); });
    await p.goto(`http://localhost:${PORT}/bench.html`);
    const ver = b.version();
    const res = await p.evaluate(({ files, cmd, pool, hot, region }) => new Promise((ok) => {
      const w = new Worker('/tests/bench/browser-worker.js', { type: 'module' });
      w.onmessage = (e) => ok(e.data);
      w.onerror = (e) => ok({ err: 'worker error: ' + e.message, lines: [], jit: {}, done: false });
      w.postMessage({ files, cmd, pool, hot, region });
    }), { files: r.files, cmd: r.cmd, pool: POOL, hot, region });
    return { ...res, ver };
  } catch (e) {
    return { err: String(e), lines: [], jit: {}, done: false, ver: '?' };
  } finally { await b.close().catch(() => {}); }
}
// "@@T begin:X" / "@@T end:X" -> ms by name; cpubench "name   123.4 ms" lines -> ms by name
function parse(lines) {
  const o = {}, ms = {};
  for (const [t, l] of lines) {
    let m;
    if ((m = /^@@T begin:(\S+)/.exec(l))) o[m[1]] = t;
    else if ((m = /^@@T end:(\S+)/.exec(l)) && o[m[1]] != null) ms[m[1]] = t - o[m[1]];
    else if ((m = /^(int|calls|sort|string|float|total)\s+([\d.]+) ms/.exec(l))) ms['cpu.' + m[1]] = +m[2];
  }
  return ms;
}
const out = {};
const jobs = [];
for (const r of RUNS) for (const n of ['chromium', 'webkit']) jobs.push([r, n, 0, 0, `${r.id}/${n}`]);
for (const h of HOTS) for (const g of RS) for (const n of ['chromium', 'webkit']) jobs.push([RUNS[0], n, h, g, `hot${h}r${g}/${n}`]);
for (const [r, n, hot, region, key] of jobs) {
  const t = n === 'chromium' ? chromium : webkit;
  console.log(`::group::${key}`);
  const res = await run(t, n, r, hot, region);
  console.log(res.lines.map(([t, l]) => `${t}\t${l}`).join('\n'));
  if (res.err) console.log('ERR: ' + res.err);
  console.log(`done=${res.done} jit=${JSON.stringify(res.jit)} mem=${res.mem}MB version=${res.ver}`);
  console.log('::endgroup::');
  out[key] = { ms: parse(res.lines), ...res };
}
srv.close();
const f = (v) => (v == null ? 'n/a' : v.toFixed(0));
const row = (label, key, a, b) => {
  const c = out[`${a}/chromium`]?.ms[key], w = out[`${a}/webkit`]?.ms[key];
  return `| ${label} | ${f(c)} | ${f(w)} | ${c && w ? (w / c).toFixed(2) + 'x' : 'n/a'} |`;
};
const L = [`## Engine in Chromium (V8) vs WebKit (JavaScriptCore), same run`, '',
  `Chromium ${out['x86/chromium'].ver}, WebKit ${out['x86/webkit'].ver} (Playwright, ubuntu runner); engine + Alpine in a module Worker, ${POOL} MB pool.`, '',
  '| item (ms) | Chromium | WebKit | WebKit / Chromium |', '|---|---:|---:|---:|'];
for (const k of ['int', 'calls', 'sort', 'string', 'float', 'total']) L.push(row(`x86 cpubench ${k}`, 'cpu.' + k, 'x86'));
L.push(row('python3 x86 -c pass (1st)', 'py-start-1', 'x86'), row('python3 x86 -c pass (2nd)', 'py-start-2', 'x86'), row('python3 x86 sum loop (1M)', 'py-loop', 'x86'));
L.push(row('python3 WASM -c pass (1st)', 'py-start-1', 'wasm'), row('python3 WASM -c pass (2nd)', 'py-start-2', 'wasm'), row('python3 WASM sum loop (1M)', 'py-loop', 'wasm'));
const j = (k) => { const v = out[k]?.jit; return v && v.n != null ? `${v.n} modules, ${(v.bytes / 1024).toFixed(0)} KB, ${v.ms.toFixed(0)} ms` : 'n/a'; };
L.push('', '| JIT compile+instantiate (x86 run / WASM run) | Chromium | WebKit |', '|---|---|---|',
  `| host_jit | ${j('x86/chromium')} / ${j('wasm/chromium')} | ${j('x86/webkit')} / ${j('wasm/webkit')} |`);
if (HOTS.length) {
  L.push('', '### x86 JIT sweep: hot threshold (set_jit_hot) x region blocks (set_jit_region)', '',
    '| browser | HOT | region blocks | cpu calls | cpu sort | cpu float | cpu int | cpu total | py -c pass 1st | py -c pass 2nd | py 1M loop | JIT modules | JIT KB | compile ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const n of ['chromium', 'webkit']) for (const h of HOTS) for (const g of RS) {
    const o = out[`hot${h}r${g}/${n}`], m = o?.ms || {}, v = o?.jit || {};
    const c = ['cpu.calls', 'cpu.sort', 'cpu.float', 'cpu.int', 'cpu.total', 'py-start-1', 'py-start-2', 'py-loop'].map((k) => f(m[k]));
    L.push(`| ${n} | ${h} | ${g || 'default'} | ${c.join(' | ')} | ${v.n ?? 'n/a'} | ${v.bytes != null ? (v.bytes / 1024).toFixed(0) : 'n/a'} | ${v.ms != null ? v.ms.toFixed(0) : 'n/a'} |`);
  }
}
const bad = Object.entries(out).filter(([, v]) => !v.done).map(([k, v]) => `${k}: ${v.err || 'did not finish'}`);
if (bad.length) L.push('', 'Did not finish: ' + bad.join('; '));
const md = L.join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
process.exit(bad.length ? 1 : 0);
