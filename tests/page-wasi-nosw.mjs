// Browser test (CI, Chromium): the real page WITHOUT a service worker. A WebAssembly program then runs
// inside the engine's worker (blocked), so the page's pieces of a big /mnt file cannot arrive by
// postMessage: the worker reads the shared File objects itself (FileReaderSync). sha256sum (WASM) over a 64 MB file.
// usage: node tests/page-wasi-nosw.mjs tests/hashsum.wasm   (from the repo root; serves it on :8124)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
const wasm = fs.readFileSync(process.argv[2] || 'tests/hashsum.wasm').toString('base64');
const srv = spawn('python3', ['-m', 'http.server', '8124'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1000));
const browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: 'block' });
const p = await ctx.newPage();
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
  await p.goto('http://localhost:8124/index.html');
  check(await p.evaluate(() => !swOn()), 'no service worker controls the page');
  await p.evaluate(() => { if (!w) start(); });
  check(await until(/New UNIX username/), 'Linux starts on the page');
  await send('tester\r'); await until(/New password/);
  await send('pw1\r'); await until(/Retype/);
  await send('pw1\r');
  check(await until(/tester@inksoc/), 'shell as the new user');
  await p.evaluate((b64) => { const d = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); w.postMessage({ type: 'put', name: 'sha256sum', data: d.buffer }, [d.buffer]); }, wasm);
  await p.waitForTimeout(500);
  await send('chmod +x sha256sum; printf abc | ./sha256sum; echo abc-rc=$?\r');
  check(await until(/ba7816bf8f01cfea[0-9a-f]{48}  -\s+abc-rc=0/, 60000), 'WebAssembly program runs inline (no service worker)');
  const MB = 1048576, BIGN = 64 * MB;
  const big = crypto.randomBytes(BIGN), want = crypto.createHash('sha256').update(big).digest('hex');
  const tmp = fs.mkdtempSync('/tmp/inp-'), idir = tmp + '/inpdir';
  fs.mkdirSync(idir); fs.writeFileSync(idir + '/big.bin', big);
  await p.setInputFiles('#mountdir', idir);
  check(await until(/\/mnt\/inpdir: 1 files/, 30000), 'mount (folder input): 64 MB file listed');
  await send('./sha256sum /mnt/inpdir/big.bin; echo big-rc=$?\r');
  check(await until(new RegExp(want + '  /mnt/inpdir/big\\.bin\\s+big-rc=0'), 240000), 'sha256sum (WebAssembly, inline) of the 64 MB /mnt file matches');
} catch (e) { check(false, 'page test', e.stack); }
await browser.close(); srv.kill();
const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
