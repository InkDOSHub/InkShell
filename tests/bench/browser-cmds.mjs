// Item 88: which everyday commands still run on x86 (busybox) in the VM, and how slow, vs the same command on the native runner.
// (round 1 of 2)
// Chromium only, 2 reps in the VM (1st = cold: WASM tools compile on first use; 2nd = warm), native = median of 5 runs of `sh -c`.
// usage (repo root, CI): node tests/bench/browser-cmds.mjs
// needs out/ztools.tar (usr/local/bin/<tool> + symlinks), out/browser-cmds.sh, out/cmds.tsv, out/cmds-setup.sh.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const PORT = 8127, POOL = +(process.env.POOL_MB || 512);
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm' };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/bench.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<!doctype html><title>bench</title>'); }
  const f = path.join(process.cwd(), path.normalize(u));
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
}).listen(PORT);
const job = { files: [['ztools.tar', '/out/ztools.tar'], ['browser-cmds.sh', '/out/browser-cmds.sh'], ['cmds.tsv', '/out/cmds.tsv'], ['cmds-setup.sh', '/out/cmds-setup.sh']],
  tools: [], cmd: 'sh /root/browser-cmds.sh', mnt: [['/mnt/b/s.csv', 'csv']] };
const rows = fs.readFileSync('tests/bench/cmds.tsv', 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
// native: same commands, sh = dash of the runner, GNU/procps tools
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));
const env = { ...process.env, D, BB: '' };
spawnSync('sh', ['tests/bench/cmds-setup.sh'], { env, stdio: 'ignore' });
const nat = {};
for (const [n, , c] of rows) {
  const ts = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); const r = spawnSync('sh', ['-c', c], { env, stdio: 'ignore', cwd: D, timeout: 60000 }); ts.push([performance.now() - t, r.status]); }
  ts.sort((a, b) => a[0] - b[0]); nat[n] = { ms: ts[2][0], rc: ts[2][1] };
}
const b = await chromium.launch();
let res;
try {
  const p = await b.newPage();
  p.on('pageerror', (e) => console.log('[page error]', e.message));
  await p.goto(`http://localhost:${PORT}/bench.html`);
  res = await p.evaluate(({ job, pool }) => new Promise((ok) => {
    const w = new Worker('/tests/bench/browser-tools-worker.js', { type: 'module' });
    w.onmessage = (e) => ok(e.data);
    w.onerror = (e) => ok({ err: 'worker error: ' + e.message, lines: [], done: false });
    w.postMessage({ ...job, pool, mb: 1 });
  }), { job, pool: POOL });
  res.ver = b.version();
} catch (e) { res = { err: String(e), lines: [], done: false, ver: '?' }; }
await b.close().catch(() => {});
srv.close();
console.log(res.lines.map(([t, l]) => `${t}\t${l}`).join('\n'));
if (res.err) console.log('ERR: ' + res.err);
const o = {}, reps = {}, rc = {}, which = {}; let setup = '';
for (const [t, l] of res.lines) {
  let m;
  if ((m = /^@@T begin:(\S+)\.(\d+)$/.exec(l))) o[m[1] + '.' + m[2]] = t;
  else if ((m = /^@@T end:(\S+)\.(\d+)$/.exec(l)) && o[m[1] + '.' + m[2]] != null) (reps[m[1]] ||= [])[+m[2] - 1] = t - o[m[1] + '.' + m[2]];
  else if ((m = /^@@RC (\S+)\.(\d+) (\d+)$/.exec(l))) (rc[m[1]] ||= [])[+m[2] - 1] = +m[3];
  else if ((m = /^@@V which-(\S+)(.*)$/.exec(l))) which[m[1]] = m[2].trim().split(/\s+/).filter(Boolean);
  else if ((m = /^@@V setup (.*)$/.exec(l))) setup = m[1];
}
// where a program runs: /usr/local/bin = WebAssembly; a bare name = shell builtin; anything else = x86 (busybox or Alpine binary)
const kind = (r) => { const v = r.split('=')[1]; return v === 'none' ? 'none' : v.startsWith('/usr/local/bin/') ? 'WASM' : v.includes('/') ? 'x86' : 'builtin'; };
const f = (v) => (v == null ? 'n/a' : v >= 100 ? v.toFixed(0) : v.toFixed(1));
const T = [];
for (const [n, , c] of rows) {
  const w = which[n] || [], ks = w.map(kind), vm = reps[n] || [];
  const where = ks.includes('x86') ? 'x86' : ks.includes('none') ? 'missing' : ks.includes('WASM') ? 'WASM' : 'builtin';
  const x = vm[1] != null ? vm[1] / Math.max(nat[n].ms, 0.5) : null;
  T.push({ n, c, w: w.map((r) => r.replace('/usr/local/bin/', 'W:').replace(/^(\S+)=\/(?:usr\/)?s?bin\/\S+$/, '$1=x86')).join(' '), where, cold: vm[0], warm: vm[1], nat: nat[n].ms, x, rc: (rc[n] || []).join(''), nrc: nat[n].rc });
}
const L = [`## Everyday commands: x86 (busybox) vs WASM vs native, Chromium ${res.ver}`, '',
  `Chromium (Playwright, ubuntu runner), engine + Alpine in a module Worker, ${POOL} MB pool, every small catalog WASM tool installed (coreutils, hashtools, sed, findutils, onetrue-awk, tar, gzip, xz, bzip2, grep, diffutils, cmp, patch, less, bc, file, jq, curl, zip, unzip). VM: 2 reps of \`sh -c CMD\` (cold = 1st, includes the WASM compile; warm = 2nd). Native: median of 5 \`sh -c CMD\` (dash + GNU tools) on the runner. "x native" = warm / native (native floored at 0.5 ms). Setup: ${setup}.`, '',
  '| command | runs on | programs | VM cold ms | VM warm ms | native ms | x native | rc VM/nat |', '|---|---|---|---:|---:|---:|---:|---|'];
for (const r of T) L.push(`| ${r.n} | ${r.where} | ${r.w} | ${f(r.cold)} | ${f(r.warm)} | ${f(r.nat)} | ${r.x == null ? 'n/a' : r.x.toFixed(0) + 'x'} | ${r.rc}/${r.nrc} |`);
const rank = T.filter((r) => r.where === 'x86' || r.where === 'builtin').sort((a, b) => (b.warm ?? 0) - (a.warm ?? 0));
L.push('', '### Ranked: slowest commands that do not run on WASM (x86 busybox or the x86 shell itself), by VM warm ms', '', '| # | command | runs on | VM warm ms | x native |', '|---:|---|---|---:|---:|');
rank.forEach((r, i) => L.push(`| ${i + 1} | ${r.n} | ${r.where} | ${f(r.warm)} | ${r.x == null ? 'n/a' : r.x.toFixed(0) + 'x'} |`));
if (!res.done) L.push('', 'Did not finish: ' + (res.err || 'timeout'));
const md = L.join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
fs.writeFileSync('out/cmds-result.md', md + '\n');
process.exit(res.done ? 0 : 1);
