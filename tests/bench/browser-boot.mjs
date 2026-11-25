// Item 50: boot of the REAL page (index.html + app.js + worker.js) in Chromium and WebKit, same run, same files:
// page load -> worker start -> fetch -> (rootfs download+gunzip) -> engine.wasm instantiate -> unpack -> start -> kernel
// first output -> first prompt, then the first command (ls /). REPS runs per browser; the table has the median.
// Cold = first visit (nothing saved; asks the new user); warm = reload after a save (rootfs from OPFS, HTTP cache warm).
// The marks come from worker.js ('mark' messages, epoch ms), the prompt from the text the worker sends the page.
// usage (repo root, CI): node tests/bench/browser-boot.mjs     env REPS=3
import { chromium, webkit } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const PORT = 8125, REPS = +(process.env.REPS || 3);
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  const f = path.join(process.cwd(), path.normalize(u === '/' ? '/index.html' : u));
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d);
  });
}).listen(PORT);
const sizes = Object.fromEntries(['engine.wasm', 'busybox', 'overlay.tar', 'alpine-rootfs.tar.gz'].map((n) => [n, fs.statSync(n).size]));
// in the page, before anything: remember the engine Worker, its 'mark' messages and the terminal text (ANSI stripped)
const INIT = () => {
  const T = (window.__T = { marks: {}, text: '', hits: {}, navStart: performance.timeOrigin });
  const W = window.Worker;
  const hit = (k, re) => { if (!(k in T.hits) && re.test(T.text)) T.hits[k] = performance.timeOrigin + performance.now(); };
  window.Worker = function (url, o) {
    const w = new W(url, o);
    if (/worker\.js/.test(String(url)) && !/wasi/.test(String(url)) && !T.marks.created) {
      T.marks.created = performance.timeOrigin + performance.now();
      w.addEventListener('message', (ev) => {
        const m = ev.data;
        if (m.type === 'mark') T.marks[m.name] = m.t;
        else if (m.type === 'out') {
          T.text += m.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
          hit('user', /New UNIX username/); hit('shell', /tester@inksoc/); hit('ls', /DONE2/);
        }
      });
    }
    return w;
  };
  window.Worker.prototype = W.prototype;
};
async function visit(p, tag, newUser) {
  const T = () => p.evaluate(() => window.__T);
  const until = async (k, ms = 180000) => {
    const t0 = Date.now();
    for (;;) { const t = await T(); if (k in t.hits) return t; if (Date.now() - t0 > ms) throw new Error(`${tag}: no '${k}'; text: ${t.text.slice(-400)}`); await p.waitForTimeout(50); }
  };
  await p.evaluate(() => { if (!w) start(); });
  if (newUser) {
    await until('user');
    const send = (t) => p.evaluate((t) => send(t), t);
    const rd = (re) => p.waitForFunction((s) => new RegExp(s).test(window.__T.text), re.source, { timeout: 60000 });
    await send('tester\r'); await rd(/New password/);
    await send('pw1\r'); await rd(/Retype/);
    await send('pw1\r');
  }
  await until('shell');
  await p.waitForTimeout(500); // let the prompt settle before the first command
  const sent = await p.evaluate(() => { const t = performance.timeOrigin + performance.now(); send('ls /; echo DONE$((1+1))\r'); return t; });
  const t = await until('ls', 60000);
  return { t, sent };
}
async function one(type, name) {
  const b = await type.launch();
  try {
    const p = await (await b.newContext()).newPage();
    await p.addInitScript(INIT);
    p.on('pageerror', (e) => console.log(`[${name} page error]`, e.message));
    const t0 = Date.now();
    await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });
    const loaded = await p.evaluate(() => performance.timeOrigin + performance.getEntriesByType('navigation')[0].loadEventEnd);
    const c = await visit(p, `${name} cold`, true);
    const cold = { ...c.t.marks, loaded, navStart: c.t.navStart, user: c.t.hits.user, shell: c.t.hits.shell, sent: c.sent, ls: c.t.hits.ls };
    await p.evaluate(() => new Promise((ok) => { w.addEventListener('message', (e) => e.data.type === 'saved' && ok()); w.postMessage({ type: 'save' }); setTimeout(ok, 15000); }));
    await p.waitForTimeout(500);
    await p.reload({ waitUntil: 'load' });
    const loaded2 = await p.evaluate(() => performance.timeOrigin + performance.getEntriesByType('navigation')[0].loadEventEnd);
    let warm = null;
    try {
      const h = await visit(p, `${name} warm`, false);
      warm = { ...h.t.marks, loaded: loaded2, navStart: h.t.navStart, shell: h.t.hits.shell, sent: h.sent, ls: h.t.hits.ls };
    } catch (e) { console.log(String(e)); }
    return { cold, warm, ver: b.version(), wall: Date.now() - t0 };
  } catch (e) { console.log(`[${name}] ERR ${e.stack || e}`); return { err: String(e), ver: '?' }; } finally { await b.close().catch(() => {}); }
}
const med = (a) => { a = a.filter((v) => v != null && !isNaN(v)).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
// chunks in ms from the marks of one visit
const chunks = (m, cold) => {
  const d = (a, b) => (m[a] != null && m[b] != null ? m[b] - m[a] : null);
  const c = [['page load (nav -> worker created)', m.created - m.navStart], ['worker start (-> run)', d('created', 'run')], ['fetch engine.wasm + busybox + overlay.tar', d('run', 'fetched')]];
  if (cold) c.push(['rootfs download (3.5 MB gz)', d('fetched', 'rootfs-dl')], ['rootfs gunzip', d('rootfs-dl', 'rootfs')]);
  c.push(['engine.wasm instantiate', d(cold ? 'rootfs' : 'fetched', 'instantiated')], ['init + unpack rootfs/overlay (add_file)', d('instantiated', 'loaded')],
    ['kernel start() (x.start)', d('loaded', 'started')], ['kernel boot -> first output', d('started', 'firstout')]);
  c.push([cold ? 'first output -> "New UNIX username" prompt' : 'first output -> shell prompt', d('firstout', cold ? 'user' : 'shell')]);
  c.push(['TOTAL nav -> usable prompt', (cold ? m.user : m.shell) - m.navStart]);
  if (cold) c.push(['(then create user -> shell prompt)', m.shell - m.user]);
  c.push(['first command `ls /` (send -> output)', m.ls - m.sent]);
  return c;
};
const res = { chromium: [], webkit: [] };
for (let i = 0; i < REPS; i++) for (const [n, t] of [['chromium', chromium], ['webkit', webkit]]) {
  console.log(`::group::${n} rep ${i + 1}`);
  const r = await one(t, n); res[n].push(r);
  console.log(JSON.stringify(r)); console.log('::endgroup::');
}
srv.close();
const L = ['## Page boot to prompt (real page), Chromium vs WebKit', '',
  `Chromium ${res.chromium[0]?.ver}, WebKit ${res.webkit[0]?.ver} (Playwright, ubuntu runner, localhost server: download time ~0, so the sizes matter). ${REPS} runs each, median ms.`,
  `Sizes: ${Object.entries(sizes).map(([k, v]) => `${k} ${(v / 1048576).toFixed(2)} MB`).join(', ')}.`];
for (const [cold, label] of [[true, 'Cold (first visit: rootfs downloaded + gunzipped, user created)'], [false, 'Warm (reload after save: rootfs from OPFS, files in HTTP cache)']]) {
  const key = cold ? 'cold' : 'warm';
  const ok = (k) => res[k].filter((r) => r[key]);
  const first = ok('chromium')[0] || ok('webkit')[0];
  if (!first) { L.push('', `### ${label}`, '', 'no run finished'); continue; }
  const rows = chunks(first[key], cold).map((c) => c[0]);
  const col = (k) => {
    const per = ok(k).map((r) => chunks(r[key], cold).map((c) => c[1]));
    return rows.map((_, j) => med(per.map((p) => p[j])));
  };
  const c = col('chromium'), w = col('webkit');
  const f = (v) => (v == null ? 'n/a' : v.toFixed(0));
  L.push('', `### ${label}`, '', '| chunk (ms) | Chromium | WebKit | WebKit / Chromium |', '|---|---:|---:|---:|');
  rows.forEach((r, j) => L.push(`| ${r} | ${f(c[j])} | ${f(w[j])} | ${c[j] && w[j] ? (w[j] / c[j]).toFixed(2) + 'x' : 'n/a'} |`));
  L.push('', `runs ok: Chromium ${ok('chromium').length}/${REPS}, WebKit ${ok('webkit').length}/${REPS}`);
}
const md = L.join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
process.exit(Object.values(res).some((v) => v.every((r) => !r.cold)) ? 1 : 0);
