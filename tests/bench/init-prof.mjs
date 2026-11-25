// Item 53 (measurement only): where x.init's ~150 ms goes (item 50). Same code in node (V8) and, with
// playwright installed, in Chromium and WebKit (JavaScriptCore). Uses an engine built with
// `--features initprof` (export init_prof: time marks inside init) and the published engine.wasm.
// usage (repo root, CI): node tests/bench/init-prof.mjs out/engine-initprof.wasm [engine.wasm]
// Prints markdown (and appends it to $GITHUB_STEP_SUMMARY).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PROF = process.argv[2] || 'out/engine-initprof.wasm', PUB = process.argv[3] || 'engine.wasm';
const REPS = 5, BREPS = 3, POOLS = [256, 16]; // fewer reps in browsers: each instance keeps 256+ MB until GC

// Runs inside node or a page: fresh instance per rep (fresh memory, as on a page load).
async function measure({ prof, pub, reps, pools }) {
  const now = () => performance.now();
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
  const stub = (mod) => {
    const env = {};
    for (const i of WebAssembly.Module.imports(mod)) if (i.kind === 'function') env[i.name] = i.name === 'host_now_ms' ? () => performance.now() : i.name === 'host_epoch_ms' ? () => Date.now() : () => 0;
    return { env };
  };
  const out = { steps: {}, total: {}, pub: {}, base: {}, mem: {} };
  const names = [['shared', 0, 1], ['pool Vec (256 MB calloc)', 1, 2], ['frames Vec', 2, 3], ['free list', 3, 4], ['MmuShared box', 4, 5], ['TLB Vec', 5, 6], ['Cpu', 6, 7], ['Jit tables', 7, 9], ['inside init (0→9)', 0, 9]];
  const mods = { prof: await WebAssembly.compile(prof), pub: await WebAssembly.compile(pub) };
  for (const [k, m] of Object.entries(mods)) {
    for (const pool of pools) {
      const call = [], inst = [], per = names.map(() => []);
      let before = 0, after = 0;
      for (let r = 0; r < reps; r++) {
        let t = now();
        globalThis.gc?.();
        const x = (await WebAssembly.instantiate(m, stub(m))).exports;
        inst.push(now() - t);
        before = x.memory.buffer.byteLength;
        t = now();
        x.init(pool, 8192);
        call.push(now() - t);
        after = x.memory.buffer.byteLength;
        if (k === 'prof') names.forEach(([, a, b], i) => per[i].push(x.init_prof(b) - x.init_prof(a)));
      }
      (k === 'prof' ? out.total : out.pub)[pool] = { call: med(call), first: call[0], inst: med(inst) };
      if (k === 'prof' && pool === pools[0]) names.forEach(([n], i) => { out.steps[n] = { med: med(per[i]), first: per[i][0] }; });
      if (k === 'pub') out.mem[pool] = [before / 1048576, after / 1048576];
    }
  }
  // baselines: the browser's own cost for 256 MB of wasm memory, without the engine
  const g = [], touch = [], fill = [];
  for (let r = 0; r < reps; r++) {
    globalThis.gc?.();
    const mem = new WebAssembly.Memory({ initial: 17, maximum: 65536 });
    let t = now(); mem.grow(4096); g.push(now() - t);
    const u = new Uint8Array(mem.buffer);
    t = now(); for (let i = 17 * 65536; i < u.length; i += 4096) u[i] = 1; touch.push(now() - t);
    t = now(); u.fill(0); fill.push(now() - t);
  }
  out.base = { grow: med(g), touch: med(touch), fill: med(fill) };
  return out;
}

const prof = fs.readFileSync(PROF), pub = fs.readFileSync(PUB);
const results = {};
results.node = await measure({ prof, pub, reps: REPS, pools: POOLS });

let pw = null;
try { pw = await import('playwright'); } catch { console.log('(playwright not installed: node only)'); }
if (pw) {
  const PORT = 8126;
  const srv = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/p.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<!doctype html><title>p</title>'); }
    fs.readFile(path.join(process.cwd(), path.normalize(u)), (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': 'application/wasm' }); r.end(d); });
  }).listen(PORT);
  for (const n of ['chromium', 'webkit']) {
    const b = await pw[n].launch();
    try {
      const p = await b.newPage();
      await p.goto(`http://localhost:${PORT}/p.html`);
      results[`${n} ${b.version()}`] = await p.evaluate(async ({ src, a, c, reps, pools }) => {
        const f = (0, eval)('(' + src + ')');
        const ld = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
        return f({ prof: await ld(a), pub: await ld(c), reps, pools });
      }, { src: measure.toString(), a: '/' + PROF, c: '/' + PUB, reps: BREPS, pools: POOLS });
    } catch (e) { console.log(`[${n}] ${e}`); } finally { await b.close().catch(() => {}); }
  }
  srv.close();
}

const f = (v) => v == null ? '—' : v.toFixed(v < 10 ? 2 : 1);
const rt = Object.keys(results);
let md = `## x.init by sub-step (item 53), ms, median of fresh instances (node ${REPS}, browsers ${BREPS}; 1st in parentheses)\n\n`;
md += `| step (pool 256 MB) | ${rt.join(' | ')} |\n|---|${rt.map(() => '---').join('|')}|\n`;
for (const s of Object.keys(results.node.steps)) md += `| ${s} | ${rt.map((r) => `${f(results[r].steps[s]?.med)} (${f(results[r].steps[s]?.first)})`).join(' | ')} |\n`;
for (const pool of POOLS) {
  md += `| x.init call, initprof build, pool ${pool} | ${rt.map((r) => `${f(results[r].total[pool]?.call)} (${f(results[r].total[pool]?.first)})`).join(' | ')} |\n`;
  md += `| x.init call, published engine.wasm, pool ${pool} | ${rt.map((r) => `${f(results[r].pub[pool]?.call)} (${f(results[r].pub[pool]?.first)})`).join(' | ')} |\n`;
}
md += `| instantiate (published, pool 256 run) | ${rt.map((r) => f(results[r].pub[256]?.inst)).join(' | ')} |\n`;
md += `| wasm memory MB before → after init 256 | ${rt.map((r) => results[r].mem[256]?.map((v) => v.toFixed(0)).join(' → ')).join(' | ')} |\n`;
md += `| baseline: memory.grow 256 MB (no engine) | ${rt.map((r) => f(results[r].base.grow)).join(' | ')} |\n`;
md += `| baseline: touch 1 byte per 4 KB page of 256 MB | ${rt.map((r) => f(results[r].base.touch)).join(' | ')} |\n`;
md += `| baseline: fill(0) 256 MB (already touched) | ${rt.map((r) => f(results[r].base.fill)).join(' | ')} |\n`;
console.log(md);
console.log(JSON.stringify(results));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
