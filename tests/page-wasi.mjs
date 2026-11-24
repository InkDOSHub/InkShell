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
  // inkvideo: the page's WebCodecs in the program's Worker (Chromium here: software codecs, maybe no H.264)
  await send('inkvideo info; echo iv1-rc=$?\r');
  check(await until(/WebCodecs: yes[\s\S]*H\.264 1080p: decode (hw|sw|no), encode (hw|sw|no)[\s\S]*AV1 1080p[\s\S]*iv1-rc=0/, 60000), 'inkvideo info: WebCodecs and codecs');
  await send('inkvideo selftest /tmp/st.bin; echo iv2-rc=$?\r');
  check(await until(/selftest \S+: encoded \d+, decoded 30\/30[\s\S]*iv2-rc=0/, 60000), 'inkvideo selftest: encode + decode 30 frames');
  const stc = ((await text()).match(/selftest (\S+): encoded/) || [])[1] || '';
  console.log('inkvideo selftest codec: ' + stc);
  if (/^(avc1|hvc1)/.test(stc)) {
    await send('inkvideo decode /tmp/st.bin /tmp/st.y4m; echo iv3-rc=$?; head -c 9 /tmp/st.y4m; echo; stat -c iv3-%s /tmp/st.y4m\r');
    check(await until(/decoded 30 frames 320x240[\s\S]*iv3-rc=0\s+YUV4MPEG2\s+iv3-34\d{5}/, 60000), 'inkvideo decode: raw stream -> Y4M (30 frames)');
    await send(`inkvideo transcode /tmp/st.bin /tmp/t2.${stc.startsWith('avc1') ? 'h264' : '265'} --codec ${stc.startsWith('avc1') ? 'h264' : 'hevc'}; echo iv4-rc=$?\r`);
    check(await until(/transcoded 30 frames 320x240[\s\S]*iv4-rc=0/, 60000), 'inkvideo transcode: decode -> encode');
  }
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
  check(await p.evaluate((s) => { const r = document.querySelector(s); return r && r.dataset.pct === '100' && /hello-wasm: \d+\/\d+ KB 100%/.test($('st-log').textContent); }, row('hello-wasm')), 'store: download progress reaches 100%', await p.evaluate(() => $('st-log').textContent));
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
  // /mnt with a 64 MB file, through the page's own mount code: an OPFS folder handle goes through
  // mountDir (as showDirectoryPicker's would: read + write), a folder input through mountFiles
  // (read-only File objects, Safari on iPhone). Files over 1 MB are read in pieces (File.slice).
  const MB = 1048576, BIGN = 64 * MB;
  const fill = (u8, base) => { const u = new Uint32Array(u8.buffer, u8.byteOffset, u8.length >> 2); for (let i = 0; i < u.length; i++) { let v = (base + i) >>> 0; v = Math.imul(v ^ (v >>> 16), 0x45d9f3b) >>> 0; v = Math.imul(v ^ (v >>> 16), 0x45d9f3b) >>> 0; u[i] = (v ^ (v >>> 16)) >>> 0; } };
  const big = Buffer.alloc(BIGN);
  for (let c = 0; c < 64; c++) fill(big.subarray(c * MB, (c + 1) * MB), c * MB / 4);
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const hAll = sha(big), hMid = sha(big.subarray(8000 * 4096, 8002 * 4096));
  // the folder input (read-only copy): a real directory with the file, given to #mountdir
  const tmp = fs.mkdtempSync('/tmp/inp-'), idir = tmp + '/inpdir';
  fs.mkdirSync(idir); fs.writeFileSync(idir + '/big.bin', big);
  await p.setInputFiles('#mountdir', idir);
  check(await until(/\/mnt\/inpdir: 1 files/, 30000), 'mount (folder input): 64 MB file listed');
  await send('echo IS=$(stat -c %s /mnt/inpdir/big.bin) IM=$(dd if=/mnt/inpdir/big.bin bs=4096 skip=8000 count=2 2>/dev/null | sha256sum | cut -c1-16)\r');
  check(await until(new RegExp('IS=' + BIGN + ' IM=' + hMid.slice(0, 16)), 120000), 'mount (folder input): dd skip in the middle reads the right bytes');
  await send('echo IA=$(sha256sum /mnt/inpdir/big.bin | cut -c1-16)\r');
  check(await until(new RegExp('IA=' + hAll.slice(0, 16)), 300000), 'mount (folder input): sha256sum of the 64 MB file');
  // an OPFS folder (read-write handle like showDirectoryPicker's) through mountDir
  await p.evaluate(async (src) => {
    const fill = eval(src), MB = 1048576;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('bigdir', { create: true });
    const wr = await (await dir.getFileHandle('big.bin', { create: true })).createWritable();
    const b = new Uint8Array(MB);
    for (let c = 0; c < 64; c++) { fill(b, c * MB / 4); await wr.write(b); }
    await wr.close();
    // count the piece writes the page makes later (write back in pieces, not the file at once)
    const W = FileSystemWritableFileStream.prototype, ow = W.write;
    window.pieceWrites = 0; W.write = function (d) { if (d && d.type === 'write' && typeof d.position === 'number') window.pieceWrites++; return ow.call(this, d); };
    addMount(await mountDir(dir));
  }, fill.toString());
  check(await until(/\/mnt\/bigdir: 1 files, changes go back/, 30000), 'mount (folder handle): 64 MB file listed, read-write');
  await send('echo BM=$(dd if=/mnt/bigdir/big.bin bs=4096 skip=8000 count=2 2>/dev/null | sha256sum | cut -c1-16)\r');
  check(await until(new RegExp('BM=' + hMid.slice(0, 16)), 120000), 'mount (folder handle): dd skip in the middle reads the right bytes');
  // download (☰ Files) through the worker of a big mounted file not read whole yet: in pieces
  const dl = await p.evaluate(() => new Promise((res) => {
    const old = dlGot; const t = setTimeout(() => res('timeout'), 240000);
    dlGot = async (m) => { if (m.path !== '/mnt/bigdir/big.bin') return old(m); clearTimeout(t); dlGot = old; if (!m.data) return res('no data');
      const h = await crypto.subtle.digest('SHA-256', await new Blob([m.data]).arrayBuffer()); res(m.data.size + ' ' + [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('')); };
    w.postMessage({ type: 'get', path: '/mnt/bigdir/big.bin', to: 'dl' });
  }));
  check(dl === BIGN + ' ' + hAll, 'download of a big mounted file not read whole: all of it, in pieces', dl);
  // write back to the device folder in pieces: change 4 KB in the middle, the page writes the file
  await send('dd if=/dev/zero of=/mnt/bigdir/big.bin bs=4096 seek=100 count=1 conv=notrunc 2>/dev/null; echo wr-$((0+$?))x\r');
  check(await until(/wr-0x/, 120000), 'mount (folder handle): 4 KB written in the middle');
  big.fill(0, 100 * 4096, 101 * 4096);
  const hNew = sha(big);
  let back = '';
  for (let t0 = Date.now(); Date.now() - t0 < 120000; await p.waitForTimeout(2000)) {
    back = await p.evaluate(async () => {
      const f = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('bigdir')).getFileHandle('big.bin')).getFile();
      const h = await crypto.subtle.digest('SHA-256', await f.arrayBuffer());
      return f.size + ' ' + [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('') + ' ' + window.pieceWrites;
    });
    if (back.startsWith(BIGN + ' ' + hNew)) break;
  }
  check(back.startsWith(BIGN + ' ' + hNew + ' '), 'mount (folder handle): the change reaches the device folder', back);
  check(+back.split(' ')[2] >= 16, 'mount (folder handle): written back in 4 MB pieces', back);
} catch (e) { check(false, 'page test', e.stack); }
await browser.close(); srv.kill();
const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
