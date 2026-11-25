// Item 57: QuickJS-ng (catalog `quickjs`, qjs.wasm) start-up and a tiny loop, in node's WASI. Small and light: only reports ms.
// usage: node tests/bench/qjs-bench.mjs qjs.wasm      (median of 5; markdown table on stdout, also in the job summary)
// rows: compile (WebAssembly.compile, cold = first), start cold (new instance + `-e 0` after compile), start warm (the same compiled
// Module again), tiny loop (3M additions in qjs), and the same loop in node itself and an empty program as the "nothing" reference.
import fs from 'node:fs';
import { WASI } from 'node:wasi';

const file = process.argv[2];
const bytes = fs.readFileSync(file);
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const ms = (t0) => performance.now() - t0;
const run = async (mod, args) => {
  const wasi = new WASI({ version: 'preview1', args: ['qjs', ...args], returnOnExit: true });
  const t0 = performance.now();
  const inst = await WebAssembly.instantiate(mod, wasi.getImportObject());
  const code = wasi.start(inst);
  return [ms(t0), code];
};

const first = performance.now();
const mod = await WebAssembly.compile(bytes);
const compileCold = ms(first);
const compile = []; for (let i = 0; i < 5; i++) { const t0 = performance.now(); await WebAssembly.compile(bytes); compile.push(ms(t0)); }
const [coldStart, c0] = await run(mod, ['-e', '0']); // the first instance of this compiled Module
const warm = []; for (let i = 0; i < 5; i++) warm.push((await run(mod, ['-e', '0']))[0]);
const LOOP = 'let s = 0; for (let i = 0; i < 3000000; i++) s += i; if (s !== 4499998500000) throw 1';
const loop = []; let bad = c0; for (let i = 0; i < 5; i++) { const [t, c] = await run(mod, ['-e', LOOP]); loop.push(t); bad |= c; }
const nodeLoop = []; for (let i = 0; i < 5; i++) { const t0 = performance.now(); let s = 0; for (let k = 0; k < 3000000; k++) s += k; if (s !== 4499998500000) throw 1; nodeLoop.push(ms(t0)); }
const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); // "nothing": an empty module, instantiate only
const nothing = []; for (let i = 0; i < 5; i++) { const t0 = performance.now(); await WebAssembly.instantiate(empty, {}); nothing.push(ms(t0)); }

const row = (n, v) => `| ${n} | ${v.toFixed(1)} |`;
console.log(`## qjs.wasm (${(bytes.length / 1048576).toFixed(2)} MB), node ${process.version}, ms\n\n| what | ms |\n|---|---|`);
console.log(row('WebAssembly.compile, first (cold)', compileCold));
console.log(row('WebAssembly.compile, median of 5', med(compile)));
console.log(row('start `-e 0`, first instance (cold)', coldStart));
console.log(row('start `-e 0`, median of 5 (warm: Module already compiled)', med(warm)));
console.log(row('tiny loop in qjs (3M additions, includes start), median of 5', med(loop)));
console.log(row('same loop in node (V8 JIT), median of 5', med(nodeLoop)));
console.log(row('nothing: instantiate an empty module, median of 5', med(nothing)));
if (bad) { console.error('qjs exited with an error'); process.exit(1); }
