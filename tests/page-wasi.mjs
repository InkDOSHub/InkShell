// Browser test (CI, Chromium): the real page runs a WebAssembly program in its own Worker, with
// synchronous calls through the service worker; terminal input reaches it while it waits; Ctrl+C ends it.
// usage: node tests/page-wasi.mjs tests/wasihello.wasm   (from the repo root; serves it on :8123)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
const wasmBytes = fs.readFileSync(process.argv[2] || 'tests/wasihello.wasm'), wasm = wasmBytes.toString('base64');
const srv = spawn('python3', ['-m', 'http.server', '8123'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1000));
const browser = await chromium.launch();
const p = await browser.newPage();
p.on('pageerror', (e) => console.log('[page error]', e.message));
const results = [];
const check = (ok, name, extra = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '\n' + extra)); };
const text = () => p.evaluate(() => { const b = term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\n'; return s; });
async function until(re, ms = 120000) {
  const t0 = Date.now();
  for (;;) {
    const s = await text();
    if (re.test(s)) return true;
    if (Date.now() - t0 > ms) { console.log('---- terminal ----\n' + s.slice(-1500)); return false; }
    await p.waitForTimeout(300);
  }
}
const send = (t) => p.evaluate((t) => send(t), t);
try {
  await p.goto('http://localhost:8123/index.html');
  // the first visit installs the service worker; it takes control at once (clients.claim)
  const sw = await p.waitForFunction(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller), null, { timeout: 30000 }).then(() => true, () => false);
  check(sw, 'service worker controls the page');
  await p.evaluate(() => { if (!w) start(); });
  check(await until(/New UNIX username/), 'Linux starts on the page');
  await send('tester\r'); await until(/New password/);
  await send('pw1\r'); await until(/Retype/);
  await send('pw1\r');
  check(await until(/tester@inksoc/), 'shell as the new user');
  await p.evaluate((b64) => { const d = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); w.postMessage({ type: 'put', name: 'hello.wasm', data: d.buffer }, [d.buffer]); }, wasm);
  await p.waitForTimeout(500);
  await send('./hello.wasm P < /dev/null; echo rc=$?\r');
  check(await until(/arg1=P in=\(eof\)[\s\S]*rc=3/, 60000), 'WebAssembly program runs in its own Worker (exit code 3)');
  await send('./hello.wasm K; echo rc=$?\r');
  await p.waitForTimeout(1500);
  await send('typed-line\r');
  check(await until(/arg1=K in=typed-line[\s\S]*rc=3/, 60000), 'terminal input reaches a waiting WebAssembly program');
  await send('./hello.wasm Z\r');
  await p.waitForTimeout(1500);
  await send('\x03');
  await send('echo back-$((2+3))\r');
  check(await until(/back-5/, 30000), 'Ctrl+C ends a waiting WebAssembly program');
  await p.waitForTimeout(1000);
  check(await p.evaluate(() => wasiWorkers.size) === 0, 'its Worker is gone');
  // ☰ Store: lists the catalog; Install runs apk add in Linux through the worker, not in the shell.
  // hello-wasm comes from a local catalog entry (file:// in the home folder): no network needed.
  const hsum = crypto.createHash('sha256').update(wasmBytes).digest('hex');
  await send(`sudo sh -c "printf 'hello-wasm\\tfile:///home/tester/hello.wasm\\t${hsum}\\t${wasmBytes.length}\\tMIT\\t/usr/local/bin/hello-wasm\\ttest program\\n' > /etc/inksoc/wasm-catalog.local"; echo entry-$?\r`);
  await until(/Password/, 30000); await send('pw1\r');
  check(await until(/entry-0/, 30000), 'store: local catalog entry written');
  await p.click('#store');
  const row = (n) => '#st-list .pkg[data-name="' + n + '"]';
  check(await p.waitForSelector(row('python3'), { timeout: 30000 }).then(() => true, () => false), 'store: lists python3 from the catalog');
  const btn = (n) => p.evaluate((s) => { const b = document.querySelector(s + ' button'); return b ? b.textContent : ''; }, row(n));
  check(await btn('hello-wasm') === 'Install', 'store: hello-wasm shows Install');
  const shellBefore = await text();
  await p.click(row('hello-wasm') + ' button');
  const waitBtn = (n, want) => p.waitForFunction(([s, want]) => { const b = document.querySelector(s + ' button'); return b && b.textContent === want; }, [row(n), want], { timeout: 90000 }).then(() => true, () => false);
  check(await waitBtn('hello-wasm', 'Remove'), 'store: Install installs hello-wasm', await p.evaluate(() => $('st-msg').textContent + '\n' + $('st-log').textContent));
  check(/hello-wasm installed/.test(await p.evaluate(() => $('st-msg').textContent + $('st-log').textContent)), 'store: shows the result');
  check((await text()) === shellBefore, 'store: nothing typed into the shell');
  await p.click('#st-x');
  await send('hello-wasm S < /dev/null; echo rc=$?\r');
  check(await until(/arg1=S in=\(eof\)[\s\S]*rc=3/, 60000), 'store: installed program runs from PATH');
  await p.click('#store');
  await p.waitForSelector(row('hello-wasm'), { timeout: 30000 });
  await p.click(row('hello-wasm') + ' button');
  check(await waitBtn('hello-wasm', 'Install'), 'store: Remove removes it');
  await p.click('#st-x');
  await send('test -e /usr/local/bin/hello-wasm || echo gone-ok\r');
  check(await until(/gone-ok/, 30000), 'store: program gone from PATH');
} catch (e) { check(false, 'page test', e.stack); }
await browser.close(); srv.kill();
const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
