// Item 61 (measurement, CI only): ~10 GB sparse file in /mnt, real page (index.html), WebKit or Chromium.
// Runs wc -c, dd (x86) in the middle, dd | sha256sum (WebAssembly) of a slice, WebAssembly sha256sum of a 1 GB file
// and of the whole big file (bounded budget). Samples RSS of the browser processes with ps every 1 s.
// env: BROWSER=webkit|chromium  SW=block|allow  DIR=<folder with big.bin + s1g.bin>  BIG_MB=<size>  SLICE_AT=<MB offset of the
// random 64 MB>  SLICE_SHA / FULL_SHA / S1G_SHA (hex)  HASHSUM=<hashsum.wasm>  FULL_BUDGET_S=600  OUT=<md file>
import { chromium, webkit } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const E = process.env, MB = 1048576;
const br = E.BROWSER || 'webkit', sw = E.SW || 'block', dir = E.DIR, bigMb = +E.BIG_MB, sliceAt = +E.SLICE_AT;
const wasm = fs.readFileSync(E.HASHSUM || 'tests/hashsum.wasm').toString('base64');
const budget = (+E.FULL_BUDGET_S || 600) * 1000;
const srv = spawn('python3', ['-m', 'http.server', '8125'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1000));
// RSS sampler: every process of the Playwright browser (WebKit: WebProcess, NetworkProcess, MiniBrowser; Chromium: renderer, gpu...)
let phase = 'start'; const stats = {}; const series = [];
const rssNow = () => {
  const o = execFileSync('ps', ['-eo', 'rss=,args=']).toString(); let sum = 0, n = 0;
  for (const l of o.split('\n')) { if (!/ms-playwright/.test(l) || /ps -eo/.test(l)) continue; sum += parseInt(l.trim(), 10) || 0; n++; }
  return { mb: sum / 1024, n };
};
const tick = () => { const r = rssNow(); const s = stats[phase] || (stats[phase] = { max: 0, n: 0 }); if (r.mb > s.max) s.max = r.mb; s.last = r.mb; s.n++; series.push(`${Math.round(Date.now() / 1000)} ${phase} ${r.mb.toFixed(0)} ${r.n}`); };
const samp = setInterval(tick, 1000);
const browser = await (br === 'chromium' ? chromium : webkit).launch();
const ctx = await browser.newContext(sw === 'block' ? { serviceWorkers: 'block' } : {});
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('[page error]', e.message));
const results = [], rows = [];
const check = (ok, name, extra = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '\n' + extra)); };
const text = () => p.evaluate(() => { const b = term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\n'; return s; });
async function until(re, ms = 120000) {
  const t0 = Date.now();
  for (;;) {
    const s = await text();
    if (re.test(s)) return true;
    if (Date.now() - t0 > ms) { console.log('---- terminal ----\n' + s.slice(-1200)); return false; }
    await p.waitForTimeout(300);
  }
}
const send = (t) => p.evaluate((t) => send(t), t);
// one shell command = one phase: time until `re` shows, RSS max in the phase
async function step(name, cmd, re, ms, bytes, expectOk = true) {
  phase = name; const t0 = Date.now(); await send(cmd + '\r');
  const ok = await until(re, ms); const s = (Date.now() - t0) / 1000; tick();
  if (!ok) { await send('\x03'); await p.waitForTimeout(2000); }
  const st = stats[name] || { max: 0 };
  rows.push({ name, ok, s, mbs: bytes && ok ? bytes / MB / s : null, rss: st.max });
  if (expectOk) check(ok, name + (ok ? '' : ' (not finished in ' + ms / 1000 + ' s)'));
  console.log(`  ${name}: ${s.toFixed(1)} s${bytes && ok ? ', ' + (bytes / MB / s).toFixed(0) + ' MB/s' : ''}, RSS max ${st.max.toFixed(0)} MB`);
  return ok;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
try {
  phase = 'boot'; const tb = Date.now();
  await p.goto('http://localhost:8125/index.html');
  if (sw === 'allow') check(await p.waitForFunction(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller), null, { timeout: 30000 }).then(() => true, () => false), 'service worker controls the page');
  else check(await p.evaluate(() => !swOn()), 'no service worker controls the page');
  await p.evaluate(() => { if (!w) start(); });
  await until(/New UNIX username/); await send('tester\r'); await until(/New password/);
  await send('pw1\r'); await until(/Retype/); await send('pw1\r');
  check(await until(/tester@inksoc/), 'shell as the new user');
  await p.evaluate((b64) => { const d = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); w.postMessage({ type: 'put', name: 'sha256sum', data: d.buffer }, [d.buffer]); }, wasm);
  await p.waitForTimeout(500); await send('chmod +x sha256sum\r'); await p.waitForTimeout(500);
  tick(); rows.push({ name: 'boot to prompt', ok: true, s: (Date.now() - tb) / 1000, mbs: null, rss: (stats.boot || { max: 0 }).max });
  phase = 'mount';
  await p.setInputFiles('#mountdir', dir);
  check(await until(/\/mnt\/\S+: 2 files/, 120000), 'mount (folder input): 2 files listed');
  tick(); rows.push({ name: 'mount (2 files)', ok: true, s: 0, mbs: null, rss: (stats.mount || { max: 0 }).max });
  const mp = (await text()).match(/(\/mnt\/\S+): 2 files/)[1];
  const big = mp + '/big.bin', s1g = mp + '/s1g.bin', bigB = bigMb * MB;
  await step('wc -c, whole file (x86 busybox)', `wc -c ${big}; echo wc-rc=$?`, new RegExp(`${bigB} ${esc(big)}\\s+wc-rc=0`), 400000, bigB);
  await step('dd 256 MB in the middle (x86)', `dd if=${big} bs=1M skip=${Math.floor(bigMb / 3)} count=256 of=/dev/null; echo dd-rc=$?`, /dd-rc=0/, 300000, 256 * MB);
  await step('dd 64 MB slice | sha256sum (WASM)', `dd if=${big} bs=1M skip=${sliceAt} count=64 2>/dev/null | ./sha256sum; echo sl-rc=$?`, new RegExp(E.SLICE_SHA + '  -\\s+sl-rc=0'), 300000, 64 * MB);
  await step('sha256sum 1 GB file (WASM)', `./sha256sum ${s1g}; echo s1-rc=$?`, new RegExp(E.S1G_SHA + '  ' + esc(s1g) + '\\s+s1-rc=0'), 600000, 1024 * MB);
  const full = await step('sha256sum whole file (WASM)', `./sha256sum ${big}; echo fu-rc=$?`, new RegExp(E.FULL_SHA + '  ' + esc(big) + '\\s+fu-rc=0'), budget, bigB, false);
  rows[rows.length - 1].note = full ? 'finished, hash matches' : `NOT finished in ${budget / 1000} s (stopped with Ctrl+C)`;
  phase = 'after'; await send('echo alive-$((6*7))\r');
  check(await until(/alive-42/, 60000), 'shell still alive after the big reads');
  await p.waitForTimeout(3000); tick();
} catch (e) { check(false, 'big-mnt', e.stack); }
clearInterval(samp);
await browser.close(); srv.kill();
const peak = Math.max(0, ...Object.values(stats).map((s) => s.max)), b0 = (stats.boot || { max: 0 }).max;
const md = [`### Big file in /mnt: ${br}${sw === 'allow' ? ' + service worker' : ' (no service worker)'}, file ${bigMb} MB (${(bigMb / 1024).toFixed(1)} GB)`, '',
  '| Step | Result | Time | MB/s | Browser RSS max (MB, sum of processes) |', '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.name} | ${r.note || (r.ok ? 'ok' : 'FAILED/timeout')} | ${r.s ? r.s.toFixed(1) + ' s' : '-'} | ${r.mbs ? r.mbs.toFixed(0) : '-'} | ${r.rss.toFixed(0)} |`), '',
  `Peak RSS ${peak.toFixed(0)} MB (boot phase: ${b0.toFixed(0)} MB). RSS is summed over processes, so shared pages count more than once.`, ''].join('\n');
console.log(md); if (E.OUT) fs.writeFileSync(E.OUT, md);
fs.writeFileSync((E.OUT || 'big-mnt') + '.rss.txt', series.join('\n') + '\n');
const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
