// Linux test for the Alpine terminal's engine (node 18+, no network needed).
// usage: node tests/linux-test.mjs [engine.wasm]   (run from apps/alpine)
// Boots Alpine like the page does, creates a user, and checks sudo, files, fork/exec, apk,
// /proc, and the swap (small real RAM, so pages of several processes go out and come back).
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { runWasi } from '../wasi.js';
import { swapStore } from './swap-store.mjs';
const wasmPath = process.argv[2] || 'engine.wasm';
const POOL = 24; // MB of real RAM: small on purpose
const dec = new TextDecoder(), enc = new TextEncoder();
let mem, x, out = '';
const sw = swapStore(() => mem), swap = sw.chunks; // 64 KB chunks of swap slots
const env = {
  host_console: (p, n) => { out += dec.decode(new Uint8Array(mem.buffer, p, n).slice(), { stream: true }); },
  host_now_ms: () => performance.now(), host_epoch_ms: () => Date.now(),
  ...sw.imports,
  wine_call: () => 0,
    host_random: (p, n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); new Uint8Array(mem.buffer, p, n).set(b); },
    host_audio: () => {}, host_gl: () => 0, host_drive_read: () => 0, host_drive_write: () => 0,
  host_jit: (p, n) => {
    try {
      const m = new WebAssembly.Module(new Uint8Array(mem.buffer, p, n).slice());
      const i = new WebAssembly.Instance(m, { env: { memory: mem, rd: x.jit_rd, wr: x.jit_wr, step: x.jit_step, cond: x.jit_cond } });
      const t = x.__indirect_function_table, k = t.grow(1); t.set(k, i.exports.f); return k;
    } catch (e) { return -1; }
  },
};
x = (await WebAssembly.instantiate(fs.readFileSync(wasmPath), { env })).instance.exports;
mem = x.memory;
const put = (b) => { const p = x.buffer(b.length); new Uint8Array(mem.buffer, p, b.length).set(b); };
const add = (name, data) => { const nm = enc.encode(name), d = new Uint8Array(data), b = new Uint8Array(nm.length + 1 + d.length); b.set(nm); b.set(d, nm.length + 1); put(b); x.add_file(); };
x.init(POOL, 8192);
add('busybox', fs.readFileSync('busybox'));
add('rootfs.tar', zlib.gunzipSync(fs.readFileSync('alpine-rootfs.tar.gz')));
add('zoverlay.tar', fs.readFileSync('overlay.tar'));
add('stage1', fs.readFileSync(new URL('./stage1', import.meta.url))); // tests/src/stage1.c, built static
// WebAssembly programs (kernel with wasi_next; the published engine.wasm may be older)
const wasiHello = new URL('./wasihello.wasm', import.meta.url); // tests/src/wasihello.c, built in CI (wasi-sdk)
const hasWasi = !!x.wasi_next;
if (hasWasi) add('hello.wasm', fs.readFileSync(wasiHello));
// CPython for WASI from the catalog (test.yml downloads it to tests/python.wasm, sha256 checked)
const pyWasm = new URL('./python.wasm', import.meta.url);
const hasPy = hasWasi && fs.existsSync(pyWasm);
const pyBytes = hasPy ? fs.readFileSync(pyWasm) : null;
if (hasPy) add('python.wasm', pyBytes);
put(enc.encode('busybox\0sh /etc/inksoc/start'));
if (x.start() !== 0) { console.log('FAIL start:', dec.decode(new Uint8Array(mem.buffer, x.msg_ptr(), x.msg_len()))); process.exit(1); }
x.linux_winsize(30, 100);
const send = (t) => { const b = enc.encode(t); put(b); x.linux_stdin(b.length); };
// run until the program waits for the terminal again (or ends)
async function settle(maxMs = 120000) {
  const t0 = Date.now();
  for (let idle = 0; Date.now() - t0 < maxMs;) {
    const st = x.run(2000000);
    serveMount();
    if (hasWasi) for (let pid; (pid = x.wasi_next());) runWasi(x, pid);
    if (st === 1 || st === 2) return st;
    // waiting: a timer due soon (sleep, a timeout) is not idle; only waiting for the terminal is
    if (st === 3) { const ms = x.stat(17); if (ms >= 30 && !(x.linux_timer_ms?.() >= 0) && ++idle > 20) return 3; await new Promise((r) => setTimeout(r, Math.min(ms, 30) || 2)); } else idle = 0;
  }
  return 0;
}
// a device folder mounted at /mnt/t (the page's part: files are sent when a program opens them)
const devFiles = new Map([['/mnt/t/a.txt', 'hello-dev\n'], ['/mnt/t/sub/b.txt', 'B']]);
function serveMount() {
  const n = x.linux_mount_fetch();
  if (!n) return;
  for (const p of dec.decode(new Uint8Array(mem.buffer, x.out_ptr(), n).slice()).split('\n')) {
    const nm = enc.encode(p), d = enc.encode(devFiles.get(p) || ''), b = new Uint8Array(nm.length + 1 + d.length);
    b.set(nm); b.set(d, nm.length + 1); put(b); x.linux_put_file();
  }
}
// A second engine that boots from a saved tar fed in 4 MB pieces (linux_load_begin/linux_load_chunk,
// as the page reads alpine-fs.tar from OPFS) and runs `script` as root. Its own memory and swap.
async function bootSaved(tar, script) {
  let m2, x2, o2 = '';
  const s2 = swapStore(() => m2);
  const env2 = {
    ...env, ...s2.imports,
    host_console: (p, n) => { o2 += dec.decode(new Uint8Array(m2.buffer, p, n).slice(), { stream: true }); },
    host_random: (p, n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); new Uint8Array(m2.buffer, p, n).set(b); },
    host_jit: (p, n) => {
      try {
        const m = new WebAssembly.Module(new Uint8Array(m2.buffer, p, n).slice());
        const i = new WebAssembly.Instance(m, { env: { memory: m2, rd: x2.jit_rd, wr: x2.jit_wr, step: x2.jit_step, cond: x2.jit_cond } });
        const t = x2.__indirect_function_table, k = t.grow(1); t.set(k, i.exports.f); return k;
      } catch (e) { return -1; }
    },
  };
  x2 = (await WebAssembly.instantiate(fs.readFileSync(wasmPath), { env: env2 })).instance.exports;
  m2 = x2.memory;
  const put2 = (b) => { const p = x2.buffer(b.length); new Uint8Array(m2.buffer, p, b.length).set(b); };
  const add2 = (name, data) => { const nm = enc.encode(name), d = new Uint8Array(data), b = new Uint8Array(nm.length + 1 + d.length); b.set(nm); b.set(d, nm.length + 1); put2(b); x2.add_file(); };
  x2.init(POOL, 8192);
  add2('busybox', fs.readFileSync('busybox'));
  const h0 = x2.heap_used(); let peak = h0;
  x2.linux_load_begin();
  for (let a = 0; a < tar.length; a += 4 << 20) { put2(tar.subarray(a, a + (4 << 20))); x2.linux_load_chunk(); peak = Math.max(peak, x2.heap_used()); }
  add2('zoverlay.tar', fs.readFileSync('overlay.tar'));
  add2('chk.sh', enc.encode(script));
  put2(enc.encode('busybox\0sh /root/chk.sh'));
  if (x2.start() !== 0) return { out: 'start failed: ' + dec.decode(new Uint8Array(m2.buffer, x2.msg_ptr(), x2.msg_len())), grow: 0 };
  for (const t1 = Date.now(); Date.now() - t1 < 180000;) {
    const st = x2.run(2000000);
    if (st === 1 || st === 2) break;
    if (st === 3) await new Promise((r) => setTimeout(r, 2));
  }
  return { out: o2, grow: (peak - h0) / 1048576 };
}
const results = [];
async function step(input, expect, name) {
  const before = out.length;
  send(input);
  const st = await settle();
  const got = out.slice(before);
  const ok = expect.test(got);
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '\n---- output ----\n' + got.slice(-600) + '\n----------------'));
  if (st === 2) { console.log('engine stopped:', dec.decode(new Uint8Array(mem.buffer, x.msg_ptr(), x.msg_len()))); process.exit(1); }
}
const t0 = Date.now();
await settle();
results.push(/New UNIX username/.test(out)); console.log((results[0] ? 'PASS' : 'FAIL') + ' first start asks for a user');
await step('tester\n', /New password/, 'user name accepted');
await step('pw1\n', /Retype/, 'password asked twice');
await step('pw1\n', /tester@inksoc/, 'shell as the new user');
await step('id -un; echo $HOME\n', /tester\s+\/home\/tester/, 'id and home');
await step('sudo id -u\n', /Password/, 'sudo asks the password');
await step('pw1\n', /^\s*0\s*$/m, 'sudo runs as root');
await step('echo hello > f.txt && cat f.txt\n', /hello/, 'files');
await step('sh -c "for i in 1 2 3 4 5; do /bin/true; done; echo forked-ok"\n', /forked-ok/, 'fork and exec');
await step('apk info | wc -l\n', /^\s*1[0-9]\s*$/m, 'apk (dynamic program, shared libraries)');
await step('free -m | grep Mem\n', /Mem:\s+8192/, '/proc and sysinfo: programs see 8 GB');
await step('awk \'BEGIN{for(i=0;i<400000;i++)a[i]="item number " i; print length(a)}\'\n', /400000/, 'a program using more than the real RAM');
results.push(swap.size > 0); console.log((swap.size > 0 ? 'PASS' : 'FAIL') + ' pages went to swap (' + swap.size + ' chunks)');
await step('sh -c \'awk "BEGIN{for(i=0;i<200000;i++)a[i]=i; print 1}" & awk "BEGIN{for(i=0;i<200000;i++)b[i]=i; print 2}"; wait\' | sort | tr "\\n" " "; echo\n', /1 2/, 'two processes swapping at once');
await step('/root/stage1 threads\n', /threads 200000/, 'threads, mutex and condition variable (futex)');
await step('/root/stage1 signals\n', /signals 10 7 15/, 'signal handlers, pause, kill');
await step('/root/stage1 sockets\n', /sockets ping pong 0 tcp-ok/, 'socketpair, unix server, TCP on 127.0.0.1');
await step('/root/stage1 sockopt\n', /sockopt 1 2 6/, 'getsockopt SO_TYPE/SO_PROTOCOL on internet sockets (Python ssl)');
put(enc.encode('/mnt/t\nF\t/mnt/t/a.txt\t10\nD\t/mnt/t/sub\nF\t/mnt/t/sub/b.txt\t1')); x.linux_mount();
await step('stat -c %s /mnt/t/sub/b.txt; cat /mnt/t/a.txt; echo new > /mnt/t/n.txt; mv /mnt/t/sub/b.txt /mnt/t/c.txt; rm /mnt/t/a.txt; echo mount-done\n', /^1\s*$[\s\S]*hello-dev[\s\S]*mount-done/m, 'device folder: size before reading, read on open, write, move, remove');
{
  put(enc.encode('/mnt/t')); const n = x.linux_mount_scan();
  const sc = dec.decode(new Uint8Array(mem.buffer, x.out_ptr(), n).slice());
  const ok = /F\t\/mnt\/t\/n\.txt\t4\t1/.test(sc) && /F\t\/mnt\/t\/c\.txt\t1\t0/.test(sc) && !/a\.txt/.test(sc);
  results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' device folder: changes listed for the page' + (ok ? '' : '\n' + sc));
}
await step('/root/stage1 epoll\n', /epoll 0 1 22 1 11 5 select 0 1/, 'epoll, eventfd, select');
await step('/root/stage1 timers\n', /timers 14 1 fd 10 14/, 'alarm, setitimer, timerfd, timer_create; SIGALRM ends a process');
await step('/root/stage1 pty\n', /pty size tty line \^C sig 2/, 'pseudo-terminal: size, tty name, line mode, Ctrl+C');
if (hasWasi) {
  await step('echo piped | /root/hello.wasm A > /tmp/w.out; echo rc=$?; cat /tmp/w.out /tmp/wasi-made.txt\n', /rc=3[\s\S]*wasi argc=2 arg1=A in=piped[\s\S]*made-by-wasm/, 'WebAssembly program: args, pipe in, redirect out, file, exit code');
  await step('/root/hello.wasm B < /dev/null | tr a-z A-Z\n', /WASI ARGC=2 ARG1=B IN=\(EOF\)/, 'WebAssembly program in a pipeline');
  // WebAssembly catalog: a local entry (file:// mirror) for the test program; apk add installs it, other names go to Alpine's apk (--no-network: the test runs offline)
  const hb = fs.readFileSync(wasiHello), hsum = crypto.createHash('sha256').update(hb).digest('hex');
  await step(`sudo sh -c "printf 'hello-wasm\\tfile:///root/hello.wasm\\t${hsum}\\t${hb.length}\\tMIT\\t/usr/local/bin/hello-wasm\\ttest program\\n' > /etc/inksoc/wasm-catalog.local"\n`, /Password/, 'catalog: local entry (sudo asks)');
  await step('pw1\n', /tester@inksoc/, 'catalog: local entry written');
  await step('apk search hello-w\n', /hello-wasm \[wasm\] test program/, 'catalog: apk search lists [wasm]');
  await step('apk add --no-network hello-wasm zz-no-such-pkg; echo add-rc=$?\n', /Password/, 'catalog: apk add asks sudo');
  await step('pw1\n', /OK: hello-wasm installed[\s\S]*(no such package|unable to select)[\s\S]*add-rc=[1-9]/, 'catalog: apk add installs WebAssembly build, other name reaches real apk');
  await step('hello-wasm X < /dev/null; echo rc=$?\n', /wasi argc=2 arg1=X in=\(eof\)[\s\S]*rc=3/, 'catalog: installed program runs from PATH');
  await step('apk del hello-wasm; test -e /usr/local/bin/hello-wasm || echo gone\n', /Password/, 'catalog: apk del asks sudo');
  await step('pw1\n', /WebAssembly build removed[\s\S]*gone/, 'catalog: apk del removes it');
  if (hasPy) { // python3 from the catalog (local file:// mirror), run in the terminal
    const psum = crypto.createHash('sha256').update(pyBytes).digest('hex');
    await step(`sudo sh -c "printf 'python3\\tfile:///root/python.wasm\\t${psum}\\t${pyBytes.length}\\tPSF-2.0\\t/usr/local/bin/python3,/usr/local/bin/python\\tPython\\n' >> /etc/inksoc/wasm-catalog.local"\n`, /Password/, 'python3: local catalog entry (sudo asks)');
    await step('pw1\n', /tester@inksoc/, 'python3: local catalog entry written');
    await step('apk add --no-network python3; echo add-rc=$?\n', /Password/, 'python3: apk add asks sudo');
    await step('pw1\n', /OK: python3 installed[\s\S]*add-rc=0/, 'python3: apk add installs the WebAssembly build');
    await step('python3 -c "print(6*7)"\n', /^42\s*$/m, 'python3: -c prints 42');
    await step(`mkdir -p /tmp/t && printf '%s\\n' 'import json, re' 'open("/tmp/t/d.json", "w").write(json.dumps({"a": [1, 2]}))' 'd = json.load(open("/tmp/t/d.json"))' 'print("py-file", d["a"][1], re.sub(r"[0-9]+", "N", "x12y3"))' > /tmp/t/s.py && (cd /tmp/t && python3 s.py)\n`, /py-file 2 xNyN/, 'python3: script by relative name, file in /tmp, json and re');
    await step('echo abc | python3 -c "import sys; print(sys.stdin.read().upper())"\n', /^ABC\s*$/m, 'python3: reads a pipe');
    await step('python3 -c "raise SystemExit(5)"; echo py-rc=$?\n', /py-rc=5/, 'python3: exit code');
    // relative paths follow the shell's folder (the host preopens it as "/" and each top-level folder on its own)
    await step(`mkdir -p /tmp/rel && cd /tmp/rel && python3 -c "import os; open('rel.txt', 'w').write('rel-' + 'ok'); print(open('rel.txt').read().upper(), sorted(os.listdir('.')), open('/tmp/t/d.json').read()[:5])"; cd; cat /tmp/rel/rel.txt; echo\n`, /REL-OK \['rel\.txt'\] \{"a":[\s\S]*rel-ok/, 'python3: relative path in the shell folder, absolute path still works');
  }
} else console.log('(engine without WebAssembly programs: published engine.wasm older than the kernel source)');
await step('trap "echo caught-usr1" USR1; kill -USR1 $$\n', /caught-usr1/, 'shell trap');
await step('(nc -l -p 8098 > /tmp/nc.txt &) ; sleep 0.3; echo over-nc | nc 127.0.0.1 8098; sleep 0.3; cat /tmp/nc.txt\n', /^over-nc/m, 'nc server and client on this machine');
if (x.linux_save_next) { // big files: 4 KB blocks in swap slots (lxdata.rs), not in the engine's heap
  const MB = 1048576, h0 = x.heap_used();
  await step('dd if=/dev/zero of=/tmp/z bs=1M count=3 2>/dev/null; printf ABC | dd of=/tmp/z bs=1 seek=2000000 conv=notrunc 2>/dev/null; dd if=/tmp/z bs=1 skip=1999999 count=5 2>/dev/null | od -c; stat -c %s /tmp/z; truncate -s 4000 /tmp/z; stat -c %s /tmp/z; truncate -s 2000002 /tmp/z; dd if=/tmp/z bs=1 skip=1999999 count=3 2>/dev/null | od -c; rm /tmp/z\n',
    /\\0\s+A\s+B\s+C\s+\\0[\s\S]*^3145728\s[\s\S]*^4000\s[\s\S]*\\0\s+\\0\s+\\0/m, 'file in blocks: write in the middle, read back, shrink, grow with zeros');
  await step('dd if=/dev/urandom of=/tmp/big bs=1M count=64 2>/dev/null; sha256sum /tmp/big; cp /tmp/big ~/big2; sha256sum ~/big2; stat -c %s ~/big2; rm /tmp/big; echo big-done\n',
    /^([0-9a-f]{64})  \/tmp\/big\s[\s\S]*^\1  \/home\/tester\/big2\s[\s\S]*^67108864\s[\s\S]*big-done/m, 'big file (64 MB, more than the 24 MB RAM pool): write, copy, same sha256');
  const sum = (out.match(/^([0-9a-f]{64})  \/home\/tester\/big2/m) || [])[1];
  const grow = (x.heap_used() - h0) / MB;
  results.push(grow < 16); console.log((grow < 16 ? 'PASS' : 'FAIL') + ` big file: engine heap grew ${grow.toFixed(1)} MB (heap ${(x.heap_used() / MB).toFixed(1)} MB)`);
  // the saved tar (what the page writes to OPFS) comes in pieces: the 64 MB file never sits whole in the heap
  x.linux_save_begin();
  const parts = []; let peak = 0;
  for (let n; (n = x.linux_save_next()) > 0;) { parts.push(Buffer.from(new Uint8Array(mem.buffer, x.out_ptr(), n))); peak = Math.max(peak, x.heap_used()); }
  const tar = Buffer.concat(parts); let got = null;
  for (let o = 0; o + 512 <= tar.length;) {
    const name = tar.toString('latin1', o, o + 100).replace(/\0.*$/s, ''), size = parseInt(tar.toString('latin1', o + 124, o + 136), 8) || 0;
    if (!name) break;
    if (name === 'home/tester/big2') got = crypto.createHash('sha256').update(tar.subarray(o + 512, o + 512 + size)).digest('hex');
    o += 512 + Math.ceil(size / 512) * 512;
  }
  const sgrow = (peak - h0) / MB, sok = !!sum && got === sum && sgrow < 16;
  results.push(sok); console.log((sok ? 'PASS' : 'FAIL') + ` saved tar in pieces (${parts.length}, ${(tar.length / MB).toFixed(0)} MB): big file same sha256, heap peak +${sgrow.toFixed(1)} MB` + (sok ? '' : ` (${sum} vs ${got})`));
  if (x.linux_load_chunk) { // restore: a new engine boots from that tar fed in 4 MB pieces; big files go straight to blocks
    let small = 0, big = 0;
    for (let o = 0; o + 512 <= tar.length;) {
      const name = tar.toString('latin1', o, o + 100).replace(/\0.*$/s, ''), size = parseInt(tar.toString('latin1', o + 124, o + 136), 8) || 0;
      if (!name) break;
      if (size > MB) big += size; else small += size;
      o += 512 + Math.ceil(size / 512) * 512;
    }
    const r = await bootSaved(tar, 'sha256sum /home/tester/big2; stat -c %s /home/tester/big2; cat /etc/inksoc/user; echo restore-done\n');
    const rok = r.out.includes(`${sum}  /home/tester/big2`) && /^67108864\s/m.test(r.out) && /^tester\s/m.test(r.out) && /restore-done/.test(r.out) && r.grow < small / MB + 16;
    results.push(rok); console.log((rok ? 'PASS' : 'FAIL') + ` restore from the saved tar in pieces: big file same sha256, heap +${r.grow.toFixed(1)} MB while loading (small files ${(small / MB).toFixed(1)} MB, big ${(big / MB).toFixed(0)} MB)` + (rok ? '' : '\n' + r.out.slice(-600)));
  }
  await step('rm ~/big2; ls ~/big2 2>&1 | grep -c "No such"\n', /^1\s*$/m, 'big file removed');
  if (x.linux_load_chunk) { // a file put by the page over a file in blocks gives its blocks back (they are used again)
    await step('dd if=/dev/zero of=~/leak bs=1M count=8 2>/dev/null; echo leak-made\n', /leak-made/, 'file in blocks made (8 MB)');
    const b = enc.encode('leak\0x'); put(b); x.linux_put_file();
    const c0 = swap.size;
    await step('cat ~/leak; echo; dd if=/dev/zero of=~/leak2 bs=1M count=8 2>/dev/null; rm ~/leak ~/leak2; echo leak2-made\n', /^x\s[\s\S]*leak2-made/m, 'page puts a small file over it');
    const g = swap.size - c0;
    results.push(g < 64); console.log((g < 64 ? 'PASS' : 'FAIL') + ` its blocks were given back: swap grew ${g} chunks of 64 KB for a new 8 MB file (128 if they leaked)`);
  }
}
{ // Ctrl+C stops a running program and the shell comes back
  const before = out.length;
  send('sleep 30; echo after-sleep\n'); await settle(1500);
  x.linux_interrupt(); const t1 = Date.now(); await settle(10000);
  send('echo back-$((1+1))\n'); await settle(10000);
  const got = out.slice(before), ok = /back-2/.test(got) && Date.now() - t1 < 10000;
  results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' Ctrl+C stops sleep' + (ok ? '' : '\n' + got.slice(-400)));
}
const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s · swap chunks used: ${swap.size}`);
process.exit(pass === results.length ? 0 : 1);
