// Item 91 (measurement only, CI, Chromium): where does the start of one WebAssembly (WASI) program go, in the real page
// (index.html?wasiprof=1: engine Worker + one Worker per program + service worker). Runs 50-spawn shell loops of small
// catalog programs (cut, true from coreutils; grep) and of busybox cut (x86 baseline), 2 reps each, and breaks every spawn
// into phases from the epoch-ms timestamps the page collects in window.__wprof / __wprofEng (off unless ?wasiprof=1).
// usage (repo root, CI): node tests/bench/wasi-spawn.mjs   needs out/tools/coreutils and out/tools/grep (catalog .wasm files).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const PORT = 8129, REPS = +(process.env.REPS || 2), N = +(process.env.N || 50);
const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1000));
const b = await chromium.launch();
const p = await b.newPage();
p.on('pageerror', (e) => console.log('[page error]', e.message));
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console ' + m.type() + ']', m.text().slice(0, 300)); });
const text = () => p.evaluate(() => { const t = term.buffer.active; let s = ''; for (let i = 0; i < t.length; i++) s += t.getLine(i).translateToString(true) + '\n'; return s; });
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
const fail = async (m) => { console.log('FAIL ' + m); await b.close().catch(() => {}); srv.kill(); process.exit(1); };
await p.goto(`http://localhost:${PORT}/index.html?wasiprof=1`);
if (!(await p.waitForFunction(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller), null, { timeout: 30000 }).then(() => true, () => false))) await fail('no service worker');
await p.evaluate(() => { if (!w) start(); });
if (!(await until(/New UNIX username/))) await fail('boot');
await send('tester\r'); await until(/New password/); await send('pw1\r'); await until(/Retype/); await send('pw1\r');
if (!(await until(/tester@inksoc/))) await fail('shell');
for (const [u, n] of [['/out/tools/coreutils', 'coreutils'], ['/out/tools/grep', 'grep']])
  await p.evaluate(async ([u, n]) => { const d = await (await fetch(u)).arrayBuffer(); w.postMessage({ type: 'put', name: n, data: d }, [d]); }, [u, n]);
await p.waitForTimeout(1500);
await send('chmod +x coreutils grep; ls -l coreutils grep; echo setup-$((6*7))\r');
if (!(await until(/setup-42/))) await fail('setup');
// sanity first (a hung program must not burn the job): each form once, with its exit code and what the page collected
const dump = async (why) => { console.log(`---- ${why}: terminal tail ----\n` + (await text()).slice(-1500)); console.log('wprof so far: ' + JSON.stringify(await p.evaluate(() => ({ n: window.__wprof.length, eng: Object.keys(window.__wprofEng || {}).length })))); };
const tryCmd = async (n, cmd) => {
  await send(cmd + '; echo SAN-' + n + '-rc=$?\r');
  const ok = await until(new RegExp('SAN-' + n + '-rc=0'), 30000);
  console.log(`sanity ${n} (${cmd}): ${ok ? 'ok' : 'FAILED'}`);
  if (!ok) { await send('\x03'); await p.waitForTimeout(1500); await dump('sanity ' + n); }
  return ok;
};
const okG = await tryCmd(1, 'echo abc | ./grep -c b');
const okC = await tryCmd(2, 'echo abc | ./coreutils cut -c1-2');
const okT = await tryCmd(3, './coreutils true');
if (!okG && !okC && !okT) await fail('no WebAssembly program ran');
// one loop per row: the whole loop wall time is taken in the page (rAF polling of the terminal's last lines)
const loops = [
  ['wasm cut (coreutils 9 MB)', `i=0; while [ $i -lt ${N} ]; do echo abc | ./coreutils cut -c1-2 > /dev/null; i=$((i + 1)); done`],
  ['wasm true (coreutils 9 MB)', `i=0; while [ $i -lt ${N} ]; do ./coreutils true; i=$((i + 1)); done`],
  ['wasm grep (0.7 MB)', `i=0; while [ $i -lt ${N} ]; do echo abc | ./grep -c b > /dev/null; i=$((i + 1)); done`],
  ['busybox cut (x86)', `i=0; while [ $i -lt ${N} ]; do echo abc | busybox cut -c1-2 > /dev/null; i=$((i + 1)); done`],
  ['busybox true (x86)', `i=0; while [ $i -lt ${N} ]; do busybox true; i=$((i + 1)); done`],
];
const out = [];
let k = 0;
for (const [name, cmd] of loops) for (let rep = 1; rep <= REPS; rep++) {
  const tag = 'L' + (++k);
  await p.evaluate(() => { window.__wprof.length = 0; window.__wprofEng = {}; });
  const r = await p.evaluate(({ cmd, tag }) => new Promise((ok) => {
    const t0 = performance.now(), re = new RegExp('DONE-' + tag + '-0'), lim = t0 + 60000;
    const chk = () => {
      const t = term.buffer.active; let s = '';
      for (let i = Math.max(0, t.length - 8); i < t.length; i++) s += t.getLine(i).translateToString(true) + '\n';
      if (re.test(s)) return ok({ ms: performance.now() - t0 });
      if (performance.now() > lim) return ok({ ms: -1 });
      requestAnimationFrame(chk);
    };
    send(cmd + '; echo DONE-' + tag + '-$?\r'); requestAnimationFrame(chk);
  }), { cmd, tag });
  if (r.ms < 0) { await dump('loop ' + name + ' timed out'); await send('\x03'); await p.waitForTimeout(1500); }
  await p.waitForTimeout(500); // the last program's 'wasi-end' message
  const prof = await p.evaluate(() => ({ progs: window.__wprof, eng: window.__wprofEng || {} }));
  out.push({ name, rep, ms: r.ms, prof });
  console.log(`${name} rep ${rep}: ${r.ms.toFixed(0)} ms, ${prof.progs.length} WASM spawns`);
  if (r.ms < 0) break;
}
await b.close().catch(() => {}); srv.kill();
// ---- phases of one spawn (ms): all timestamps are epoch ms of different threads (same clock)
const med = (a) => { a = a.filter((v) => Number.isFinite(v)).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };
const mean = (a) => { a = a.filter((v) => Number.isFinite(v)); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; };
const f = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');
const ev = (list, n) => { const e = (list || []).find((q) => q[0] === n); return e ? e[1] : NaN; };
const PH = [
  ['engine: kernel lists the program -> bytes read + copied (wasi_info, wasi_module)', (s) => ev(s.e, 'read') - ev(s.e, 'next')],
  ['engine: copy done -> postMessage to the page', (s) => ev(s.e, 'posted') - ev(s.e, 'read')],
  ['message hop engine -> page (page busy? queue)', (s) => ev(s.pg, 'start-msg') - ev(s.e, 'posted')],
  ['page: new Worker(wasi-worker.js)', (s) => ev(s.pg, 'worker-new') - ev(s.pg, 'start-msg')],
  ['Worker boot: new Worker -> its onmessage (thread start + module graph load)', (s) => ev(s.w, 'onmessage') - ev(s.pg, 'worker-new')],
  ['  of which postMessage(bytes+module) page -> Worker after the Worker exists', (s) => ev(s.w, 'onmessage') - ev(s.pg, 'post-worker')],
  ['WASI setup: runModule entry -> preopens/cwd slot done (getcwd, opendir calls)', (s) => ev(s.w, 'setup') - ev(s.w, 'rm0')],
  ['module: get Module (msg / cache / compile)', (s) => ev(s.w, 'mod:msg') - ev(s.w, 'setup') || ev(s.w, 'mod:cache') - ev(s.w, 'setup') || ev(s.w, 'mod:compile') - ev(s.w, 'setup')],
  ['imports object + Module.imports()', (s) => ev(s.w, 'imports') - ev(s.w, 'mod:msg') || ev(s.w, 'imports') - ev(s.w, 'mod:cache') || ev(s.w, 'imports') - ev(s.w, 'mod:compile')],
  ['WebAssembly.Instance (instantiate)', (s) => ev(s.w, 'inst') - ev(s.w, 'imports')],
  ['program run (_start incl. its WASI calls and the exit call)', (s) => ev(s.w, 'ran') - ev(s.w, 'inst')],
  ['exit: Worker done -> page done-msg', (s) => ev(s.pg, 'done-msg') - ev(s.w, 'done')],
  ['page: worker.terminate()', (s) => ev(s.pg, 'terminated') - ev(s.pg, 'done-msg')],
  ['whole Worker side: page start-msg -> terminated', (s) => ev(s.pg, 'terminated') - ev(s.pg, 'start-msg')],
  ['engine: exit call -> kernel marks the process dead (pump sees !alive)', (s) => ev(s.e, 'dead') - ev(s.e, 'exit-call')],
];
const L = ['## Item 91: where one WebAssembly program start goes (real page, Chromium ' + b.version?.() + ')', '',
  `Real page (index.html?wasiprof=1) + service worker, 2 reps of ${N}-spawn shell loops (\`i=0; while [ $i -lt ${N} ]; ...\`). Wall = the whole loop from typing to the "done" line (rAF polling); per spawn = wall / ${N} (shell loop + fork + execve + program + wait included). Phases = median ms over the spawns of the 2nd rep (the 1st spawn of a file compiles/caches); timestamps are epoch ms from the engine Worker, the page and the program Worker.`, ''];
L.push('| loop | rep | wall ms | ms per spawn | WASM spawns seen |', '|---|---:|---:|---:|---:|');
for (const o of out) L.push(`| ${o.name} | ${o.rep} | ${f(o.ms)} | ${f(o.ms / N)} | ${o.prof.progs.length} |`);
const rows = (o) => o.prof.progs.map((s) => ({ pg: s.page, w: s.worker, e: (o.prof.eng[s.pid] || {}).P, svcN: (o.prof.eng[s.pid] || {}).svcN, svcMs: (o.prof.eng[s.pid] || {}).svcMs, calls: s.calls, bytes: s.bytes, mod: s.mod, pid: s.pid }));
for (const name of loops.map((l) => l[0]).filter((n) => !n.startsWith('busybox'))) {
  const o = out.filter((q) => q.name === name).pop(); if (!o) continue;
  const S = rows(o).slice(1); if (!S.length) continue;
  L.push('', `### ${name}: phases of one spawn (median ms over ${S.length} spawns, rep ${o.rep})`, '', '| phase | ms |', '|---|---:|');
  for (const [n, fn] of PH) L.push(`| ${n} | ${f(med(S.map(fn)))} |`);
  const gap = []; const all = rows(o); for (let i = 1; i < all.length; i++) gap.push(ev(all[i].e, 'next') - ev(all[i - 1].e, 'exit-call'));
  L.push(`| shell + x86 side: previous exit call -> next program listed (wait wake-up, loop, fork, execve, pipe) | ${f(med(gap))} |`);
  L.push(`| WASI calls per spawn (count) / sync XHR round trips total ms in the Worker | ${f(med(S.map((s) => s.calls.n)))} / ${f(med(S.map((s) => s.calls.ms)))} |`);
  L.push(`| engine-side handling of those calls (x.wasi_call etc.), total ms | ${f(med(S.map((s) => s.svcMs)))} |`);
  L.push(`| program bytes copied per spawn (MB) / Module passed by the page (share of spawns) | ${f(med(S.map((s) => s.bytes)) / 1048576)} / ${f(S.filter((s) => s.mod).length / S.length)} |`);
  L.push(`| Module source (msg = page cache, cache = Worker cache, compile) | ${['msg', 'cache', 'compile'].map((m) => m + ' ' + S.filter((s) => (s.w || []).some((q) => q[0] === 'mod:' + m)).length).join(', ')} |`);
  const first = rows(o)[0]; if (first) L.push(`| 1st spawn of the loop: Worker side ms / module phase ms | ${f(ev(first.pg, 'terminated') - ev(first.pg, 'start-msg'))} / ${f(ev(first.w, 'imports') - ev(first.w, 'setup'))} |`);
}
const md = L.join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/wasi-spawn.md', md + '\n');
fs.writeFileSync('out/wasi-spawn.json', JSON.stringify(out.map((o) => ({ ...o, prof: { progs: o.prof.progs, eng: o.prof.eng } }))));
process.exit(out.every((o) => o.ms > 0) ? 0 : 1);
